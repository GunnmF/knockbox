import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { HANDLE_CURSORS } from './constants'
import { clamp, handlePoints, pointInRect } from './geometry'
import type { Drag, Mark, Pt, Rect, Tool } from './types'

interface Options {
  /** HUD 画布是坐标换算的基准，所以要它的 ref。 */
  hudRef: RefObject<HTMLCanvasElement | null>
  /** 冻结帧尺寸（物理像素）。 */
  W: number
  H: number
  /** 物理像素 / CSS 像素。 */
  k: number
  busy: boolean
  tool: Tool | null
  sel: Rect | null
  color: string
  size: number
  textEdit: { at: Pt; value: string } | null
  commitText: () => void
  setSel: Dispatch<SetStateAction<Rect | null>>
  setMarks: Dispatch<SetStateAction<Mark[]>>
  setTextEdit: Dispatch<SetStateAction<{ at: Pt; value: string } | null>>
}

/**
 * 选区与标记的全部指针手势。
 *
 * 四种拖拽共用一个状态机（Drag），互斥关系都写在 onPointerDown 的分支里：
 * 有工具先画标记 → 否则命中手柄就改尺寸 → 否则在选区内就挪 → 否则建新选区。
 * 悬停光标形态也在这儿算，因为它依赖同一套命中判定。
 */
export function usePointerGestures({
  hudRef,
  W,
  H,
  k,
  busy,
  tool,
  sel,
  color,
  size,
  textEdit,
  commitText,
  setSel,
  setMarks,
  setTextEdit,
}: Options) {
  const [drag, setDrag] = useState<Drag | null>(null)
  const [cursor, setCursor] = useState<Pt | null>(null)
  const [preview, setPreview] = useState<Mark | null>(null)
  const [hoverCursor, setHoverCursor] = useState('crosshair')

  // 拖拽过程中每帧都要读**当前**的选区。放 ref 而不是直接闭包 sel，
  // 否则 pointerdown 记下的 startSel 会被后续渲染改掉，拖动手柄会跳。
  const selRef = useRef(sel)
  selRef.current = sel

  /** 屏幕坐标 → 冻结帧物理坐标。 */
  const toPhys = useCallback(
    (e: { clientX: number; clientY: number }): Pt => {
      const r = hudRef.current?.getBoundingClientRect()
      if (!r || r.width === 0) return { x: 0, y: 0 }
      return {
        x: clamp(((e.clientX - r.left) / r.width) * W, 0, W - 1),
        y: clamp(((e.clientY - r.top) / r.height) * H, 0, H - 1),
      }
    },
    [hudRef, W, H],
  )

  const inside = useCallback((p: Pt) => {
    const s = selRef.current
    return !!s && pointInRect(p, s)
  }, [])

  /** 点命中的手柄名，没命中返回 null。 */
  const handleAt = useCallback(
    (p: Pt): string | null => {
      const s = selRef.current
      if (!s) return null
      const tol = 6 * k
      for (const hp of handlePoints(s)) {
        if (Math.abs(p.x - hp.x) <= tol && Math.abs(p.y - hp.y) <= tol) return hp.name
      }
      return null
    },
    [k],
  )

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button === 2) return // 右键取消走 onContextMenu
    if (busy) return
    // 必须阻止原生默认行为：mousedown 默认会把焦点从刚创建的文字输入框
    // 抢回画布（我们的处理器在默认行为之前跑），输入框当场失焦 →
    // onBlur 空值提交 → 文字工具"点了没反应"。真机 trusted 事件才有
    // 这个问题，合成事件测试测不出来。
    e.preventDefault()
    const p = toPhys(e)
    // 指针捕获让拖出画布也能继续收 move；合成事件没有活跃指针会抛，
    // 那种情况下拖拽逻辑本身仍然成立，不该因此中断
    try {
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* 忽略 */
    }

    // 点别处时正在编辑的文字直接落盘
    if (textEdit) commitText()

    const s = selRef.current
    if (tool && s) {
      if (tool === 'text') {
        if (pointInRect(p, s)) setTextEdit({ at: p, value: '' })
        return
      }
      // 标记只允许落在选区内，不然画完导出时被裁掉，像丢了
      if (!pointInRect(p, s)) return
      setDrag({ type: 'draw' })
      setPreview(
        tool === 'pen'
          ? { kind: 'pen', color, size, pts: [p] }
          : tool === 'rect'
            ? { kind: 'rect', color, size, r: { x: p.x, y: p.y, w: 0, h: 0 } }
            : { kind: 'arrow', color, size, from: p, to: p },
      )
      return
    }

    const handle = handleAt(p)
    if (s && handle) {
      setDrag({ type: 'resize', edges: handle, startSel: { ...s }, start: p })
      return
    }
    if (s && pointInRect(p, s)) {
      setDrag({ type: 'move', offset: { x: p.x - s.x, y: p.y - s.y } })
      return
    }
    setDrag({ type: 'create', start: p })
    setSel({ x: p.x, y: p.y, w: 0, h: 0 })
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toPhys(e)
    setCursor(p)

    if (!drag) {
      // 悬停光标形态：手柄 > 选区内移动 > 十字
      if (tool) setHoverCursor('crosshair')
      else {
        const h = handleAt(p)
        setHoverCursor(h ? HANDLE_CURSORS[h] : inside(p) ? 'move' : 'crosshair')
      }
      return
    }

    if (drag.type === 'create') {
      setSel({
        x: Math.min(drag.start.x, p.x),
        y: Math.min(drag.start.y, p.y),
        w: Math.abs(p.x - drag.start.x),
        h: Math.abs(p.y - drag.start.y),
      })
    } else if (drag.type === 'move' && selRef.current) {
      const s = selRef.current
      setSel({
        ...s,
        x: clamp(p.x - drag.offset.x, 0, W - s.w),
        y: clamp(p.y - drag.offset.y, 0, H - s.h),
      })
    } else if (drag.type === 'resize') {
      const s = drag.startSel
      const dx = p.x - drag.start.x
      const dy = p.y - drag.start.y
      let { x, y, w, h } = s
      if (drag.edges.includes('w')) {
        x = s.x + dx
        w = s.w - dx
      }
      if (drag.edges.includes('e')) w = s.w + dx
      if (drag.edges.includes('n')) {
        y = s.y + dy
        h = s.h - dy
      }
      if (drag.edges.includes('s')) h = s.h + dy
      // 拖过对面时翻转，免得出现负宽高
      if (w < 0) {
        x += w
        w = -w
      }
      if (h < 0) {
        y += h
        h = -h
      }
      setSel({
        x: clamp(x, 0, W),
        y: clamp(y, 0, H),
        w: Math.min(w, W - clamp(x, 0, W)),
        h: Math.min(h, H - clamp(y, 0, H)),
      })
    } else if (drag.type === 'draw') {
      setPreview((prev) => {
        if (!prev) return prev
        if (prev.kind === 'pen') return { ...prev, pts: [...prev.pts, p] }
        if (prev.kind === 'rect') {
          return {
            ...prev,
            r: {
              x: Math.min(prev.r.x, p.x),
              y: Math.min(prev.r.y, p.y),
              w: Math.abs(p.x - prev.r.x),
              h: Math.abs(p.y - prev.r.y),
            },
          }
        }
        return { ...prev, to: p }
      })
    }
  }

  const onPointerUp = () => {
    if (!drag) return
    const s = selRef.current
    if (drag.type === 'create' && s && s.w < 4 * k && s.h < 4 * k) {
      setSel(null) // 误触的小框不算选区
    }
    if (drag.type === 'draw' && preview) {
      // 太小的笔画当成误触丢掉（比如单击了一下）
      const tiny =
        (preview.kind === 'pen' && preview.pts.length < 3) ||
        (preview.kind === 'rect' && preview.r.w < 2 * k && preview.r.h < 2 * k) ||
        (preview.kind === 'arrow' &&
          Math.hypot(preview.to.x - preview.from.x, preview.to.y - preview.from.y) < 4 * k)
      if (!tiny) setMarks((ms) => [...ms, preview])
      setPreview(null)
    }
    setDrag(null)
  }

  return { drag, cursor, preview, hoverCursor, setCursor, onPointerDown, onPointerMove, onPointerUp }
}
