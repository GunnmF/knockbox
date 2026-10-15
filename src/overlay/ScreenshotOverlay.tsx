/**
 * 截图覆盖层（Snipaste 式）：冻结帧 + 拖框选区 + 标记 + 放大镜取色。
 *
 * 这是宿主自己的页面（index.html?overlay=1），跑在独立的全屏窗口里，
 * 不在插件沙箱中。与 Rust 侧的会话状态机配合：
 *   screenshot_begin  → 拿冻结帧和设置（窗口此时才被显示）
 *   screenshot_finish → 保存/复制，随后窗口被 Rust 销毁
 *   screenshot_cancel → Esc/右键取消
 *   screenshot_copy_color → 复制光标处颜色
 *
 * 坐标模型：一切内部坐标都是**物理像素**（冻结帧的原始尺寸），
 * 只有 DOM 元素（工具栏/放大镜/文字输入框）定位时除以 k 换回 CSS 像素。
 *
 * 演示模式：脱离 Tauri 直接用浏览器打开时，invoke 会失败，此时加载一张
 * 合成的测试图，除了保存/复制外的交互都能跑 —— 开发和 UI 自测都靠它。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  overlayLog,
  screenshotBegin,
  screenshotCancel,
  screenshotCopyColor,
  screenshotFinish,
} from '../ipc'
import './overlay.css'

interface Pt {
  x: number
  y: number
}
interface Rect {
  x: number
  y: number
  w: number
  h: number
}

type Tool = 'pen' | 'rect' | 'arrow' | 'text'

type Mark =
  | { kind: 'pen'; color: string; size: number; pts: Pt[] }
  | { kind: 'rect'; color: string; size: number; r: Rect }
  | { kind: 'arrow'; color: string; size: number; from: Pt; to: Pt }
  | { kind: 'text'; color: string; size: number; at: Pt; text: string }

type Drag =
  | { type: 'create'; start: Pt }
  | { type: 'move'; offset: Pt }
  | { type: 'resize'; edges: string; startSel: Rect; start: Pt }
  | { type: 'draw' }

const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2', '#ffffff', '#000000']
const SIZES = [3, 6, 10] // CSS 像素，绘制时乘 k
const HANDLE_CURSORS: Record<string, string> = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', w: 'ew-resize', e: 'ew-resize',
}
/** 取色快捷键的候选范围（与 plugin.json 的 select options 保持一致） */
const COPY_KEYS = ['C', 'X', 'B']

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, Math.round(l * 100)]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)]
}

function formatColor(r: number, g: number, b: number, format: string): string {
  if (format === 'RGB') return `rgb(${r}, ${g}, ${b})`
  if (format === 'HSL') {
    const [h, s, l] = rgbToHsl(r, g, b)
    return `hsl(${h}, ${s}%, ${l}%)`
  }
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** 浏览器演示模式用的合成测试图：渐变底 + 色块 + 网格 + 文字，取色才有东西可取 */
function makeDemoImage(): Promise<HTMLImageElement> {
  const c = document.createElement('canvas')
  c.width = 2560
  c.height = 1440
  const x = c.getContext('2d')!
  const grad = x.createLinearGradient(0, 0, 2560, 1440)
  grad.addColorStop(0, '#1c2541')
  grad.addColorStop(0.5, '#3a506b')
  grad.addColorStop(1, '#5bc0be')
  x.fillStyle = grad
  x.fillRect(0, 0, 2560, 1440)
  const swatches = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2', '#ffffff', '#000000']
  swatches.forEach((color, i) => {
    x.fillStyle = color
    x.fillRect(200 + i * 270, 500, 220, 220)
  })
  x.strokeStyle = 'rgba(255,255,255,.18)'
  for (let gx = 0; gx < 2560; gx += 128) {
    x.beginPath(); x.moveTo(gx, 0); x.lineTo(gx, 1440); x.stroke()
  }
  for (let gy = 0; gy < 1440; gy += 128) {
    x.beginPath(); x.moveTo(0, gy); x.lineTo(2560, gy); x.stroke()
  }
  x.fillStyle = '#fff'
  x.font = '80px -apple-system, "PingFang SC", sans-serif'
  x.fillText('Knockbox 截图 · 演示模式', 200, 320)
  x.font = '44px -apple-system, "PingFang SC", sans-serif'
  x.fillText('拖拽框选 · 悬停看颜色 · C 复制颜色 · Esc 取消', 200, 860)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('演示图生成失败'))
    img.src = c.toDataURL('image/png')
  })
}

export default function ScreenshotOverlay() {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [demo, setDemo] = useState(false)
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [sel, setSel] = useState<Rect | null>(null)
  const [marks, setMarks] = useState<Mark[]>([])
  const [preview, setPreview] = useState<Mark | null>(null)
  const [tool, setTool] = useState<Tool | null>(null)
  const [color, setColor] = useState(COLORS[0])
  const [size, setSize] = useState(SIZES[1])
  const [cursor, setCursor] = useState<Pt | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [textEdit, setTextEdit] = useState<{ at: Pt; value: string } | null>(null)
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState(false)
  const [hoverCursor, setHoverCursor] = useState('crosshair')
  const [tbWidth, setTbWidth] = useState(600) // 实测工具栏宽，用于贴边时不跑出屏幕

  const baseRef = useRef<HTMLCanvasElement>(null)
  const hudRef = useRef<HTMLCanvasElement>(null)
  const magRef = useRef<HTMLCanvasElement>(null)
  const tbObserver = useRef<ResizeObserver | null>(null)
  const pristineRef = useRef<HTMLCanvasElement | null>(null) // 只含冻结帧，取色专用
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * 工具栏是选区创建后才挂载的，所以观察它的时机只能挂在节点挂载那一刻 ——
   * 用普通 effect 的话依赖怎么写都不对：依赖 img 时节点还不存在，
   * 依赖 sel 又会在拖拽的每一帧重建观察器。
   */
  const observeToolbar = useCallback((el: HTMLDivElement | null) => {
    tbObserver.current?.disconnect()
    if (!el) return
    setTbWidth(el.offsetWidth)
    tbObserver.current = new ResizeObserver(() => setTbWidth(el.offsetWidth))
    tbObserver.current.observe(el)
  }, [])

  useEffect(() => () => tbObserver.current?.disconnect(), [])

  const W = img?.naturalWidth ?? 0
  const H = img?.naturalHeight ?? 0
  const k = W > 0 ? W / window.innerWidth : 1 // 物理像素 / CSS 像素

  const fmt = settings.format === 'jpg' ? 'jpg' : 'png'
  const colorFormat = ['HEX', 'RGB', 'HSL'].includes(String(settings.colorFormat))
    ? String(settings.colorFormat)
    : 'HEX'
  const copyKey = COPY_KEYS.includes(String(settings.copyColorKey).toUpperCase())
    ? String(settings.copyColorKey).toUpperCase()
    : 'C'
  const copyAfterCapture = settings.copyAfterCapture !== false

  const say = useCallback((text: string) => {
    setToast(text)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 1600)
  }, [])

  // ———————————————————————————— 加载冻结帧 ————————————————————————————

  useEffect(() => {
    let dead = false
    const load = (image: HTMLImageElement, demoMode: boolean) => {
      if (dead) return
      // 取色要采冻结帧原图，不能被标记污染 —— 留一份纯净副本
      const pristine = document.createElement('canvas')
      pristine.width = image.naturalWidth
      pristine.height = image.naturalHeight
      pristine.getContext('2d', { willReadFrequently: true })!.drawImage(image, 0, 0)
      pristineRef.current = pristine
      setImg(image)
      setDemo(demoMode)
    }
    screenshotBegin()
      .then((info) => {
        setSettings(info.settings ?? {})
        void overlayLog(`begin 完成 hasFocus=${document.hasFocus()}`)
        return new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve(image)
          image.onerror = () => reject(new Error('冻结帧解码失败'))
          image.src = info.dataUrl
        }).then((image) => load(image, false))
      })
      .catch(async () => {
        // 不在 Tauri 里（浏览器直接打开）→ 演示模式
        load(await makeDemoImage(), true)
      })
    return () => {
      dead = true
    }
  }, [])

  // ———————————————————————————— 绘制 ————————————————————————————

  const renderMark = useCallback((ctx: CanvasRenderingContext2D, m: Mark) => {
    ctx.strokeStyle = m.color
    ctx.fillStyle = m.color
    ctx.lineWidth = m.size * k
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (m.kind === 'pen') {
      if (m.pts.length < 2) return
      ctx.beginPath()
      ctx.moveTo(m.pts[0].x, m.pts[0].y)
      for (const p of m.pts.slice(1)) ctx.lineTo(p.x, p.y)
      ctx.stroke()
    } else if (m.kind === 'rect') {
      ctx.strokeRect(m.r.x, m.r.y, m.r.w, m.r.h)
    } else if (m.kind === 'arrow') {
      const a = Math.atan2(m.to.y - m.from.y, m.to.x - m.from.x)
      const head = Math.max(10 * k, m.size * k * 4)
      ctx.beginPath()
      ctx.moveTo(m.from.x, m.from.y)
      ctx.lineTo(m.to.x, m.to.y)
      ctx.moveTo(m.to.x, m.to.y)
      ctx.lineTo(m.to.x - head * Math.cos(a - Math.PI / 7), m.to.y - head * Math.sin(a - Math.PI / 7))
      ctx.moveTo(m.to.x, m.to.y)
      ctx.lineTo(m.to.x - head * Math.cos(a + Math.PI / 7), m.to.y - head * Math.sin(a + Math.PI / 7))
      ctx.stroke()
    } else if (m.kind === 'text') {
      ctx.font = `${(12 + m.size * 2) * k}px -apple-system, "PingFang SC", sans-serif`
      ctx.textBaseline = 'top'
      ctx.fillText(m.text, m.at.x, m.at.y)
    }
  }, [k])

  // 底层：冻结帧 + 已提交的标记（导出时就裁这块画布）
  useEffect(() => {
    const cv = baseRef.current
    if (!cv || !img) return
    cv.width = W
    cv.height = H
    const ctx = cv.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    for (const m of marks) renderMark(ctx, m)
  }, [img, marks, W, H, renderMark])

  // 上层 HUD：选区外的暗化、边框、手柄、尺寸标签、正在拖的预览
  useEffect(() => {
    const cv = hudRef.current
    if (!cv || !img) return
    cv.width = W
    cv.height = H
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, W, H)

    // 暗化：有选区时露出选区，没选区整屏稍暗
    ctx.fillStyle = 'rgba(0, 0, 0, .38)'
    if (sel) {
      ctx.beginPath()
      ctx.rect(0, 0, W, H)
      ctx.rect(sel.x, sel.y, sel.w, sel.h)
      ctx.fill('evenodd')
    } else {
      ctx.fillRect(0, 0, W, H)
    }

    // 还没选区时的十字参考线，帮助对齐
    if (!sel && cursor) {
      ctx.strokeStyle = 'rgba(255,255,255,.35)'
      ctx.lineWidth = k
      ctx.setLineDash([4 * k, 4 * k])
      ctx.beginPath()
      ctx.moveTo(0, cursor.y); ctx.lineTo(W, cursor.y)
      ctx.moveTo(cursor.x, 0); ctx.lineTo(cursor.x, H)
      ctx.stroke()
      ctx.setLineDash([])
    }

    if (sel) {
      // 边框 + 八向手柄
      ctx.strokeStyle = '#0a84ff'
      ctx.lineWidth = Math.max(1.5 * k, 2)
      ctx.strokeRect(sel.x, sel.y, sel.w, sel.h)
      const hs = 5 * k
      ctx.fillStyle = '#fff'
      ctx.strokeStyle = 'rgba(0,0,0,.4)'
      ctx.lineWidth = k
      for (const p of handlePoints(sel)) {
        ctx.beginPath()
        ctx.rect(p.x - hs, p.y - hs, hs * 2, hs * 2)
        ctx.fill()
        ctx.stroke()
      }
      // 尺寸标签：选区上方，没地方就贴进选区里
      const label = `${Math.round(sel.w / k)} × ${Math.round(sel.h / k)}`
      ctx.font = `${12 * k}px -apple-system, "PingFang SC", sans-serif`
      ctx.textBaseline = 'middle'
      const tw = ctx.measureText(label).width
      const pad = 6 * k
      const ly = sel.y - 26 * k >= 0 ? sel.y - 26 * k : sel.y + 6 * k
      ctx.fillStyle = 'rgba(0,0,0,.72)'
      ctx.beginPath()
      ctx.roundRect(sel.x, ly, tw + pad * 2, 20 * k, 4 * k)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.fillText(label, sel.x + pad, ly + 10 * k)
    }

    if (preview) renderMark(ctx, preview)
  }, [img, sel, preview, cursor, W, H, k, renderMark])

  // 放大镜：光标周围 11×11 物理像素放大 12 倍 + 颜色值
  useEffect(() => {
    const cv = magRef.current
    const pristine = pristineRef.current
    if (!cv || !pristine || !cursor || drag?.type === 'draw' || textEdit) return
    const cells = 11
    const zoom = 12
    cv.width = cells * zoom
    cv.height = cells * zoom
    const ctx = cv.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    const half = Math.floor(cells / 2)
    const sx = clamp(Math.round(cursor.x) - half, 0, Math.max(0, W - cells))
    const sy = clamp(Math.round(cursor.y) - half, 0, Math.max(0, H - cells))
    ctx.drawImage(pristine, sx, sy, cells, cells, 0, 0, cells * zoom, cells * zoom)
    // 中心格描边 = 当前取到的像素
    ctx.strokeStyle = 'rgba(255,255,255,.9)'
    ctx.lineWidth = 2
    ctx.strokeRect(half * zoom + 1, half * zoom + 1, zoom - 2, zoom - 2)
  }, [cursor, drag, textEdit, W, H])

  // ———————————————————————————— 坐标与命中 ————————————————————————————

  const toPhys = useCallback((e: { clientX: number; clientY: number }): Pt => {
    const r = hudRef.current?.getBoundingClientRect()
    if (!r || r.width === 0) return { x: 0, y: 0 }
    return {
      x: clamp(((e.clientX - r.left) / r.width) * W, 0, W - 1),
      y: clamp(((e.clientY - r.top) / r.height) * H, 0, H - 1),
    }
  }, [W])

  const inSel = useCallback((p: Pt) => {
    if (!sel) return false
    return p.x >= sel.x && p.x <= sel.x + sel.w && p.y >= sel.y && p.y <= sel.y + sel.h
  }, [sel])

  const handleAt = useCallback((p: Pt): string | null => {
    if (!sel) return null
    const tol = 6 * k
    for (const hp of handlePoints(sel)) {
      if (Math.abs(p.x - hp.x) <= tol && Math.abs(p.y - hp.y) <= tol) return hp.name
    }
    return null
  }, [sel, k])

  // ———————————————————————————— 指针交互 ————————————————————————————

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

    if (tool && sel) {
      if (tool === 'text') {
        if (inSel(p)) setTextEdit({ at: p, value: '' })
        return
      }
      if (!inSel(p)) return // 标记只允许落在选区内，不然画完导出时被裁掉，像丢了
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
    if (sel && handle) {
      setDrag({ type: 'resize', edges: handle, startSel: { ...sel }, start: p })
      return
    }
    if (sel && inSel(p)) {
      setDrag({ type: 'move', offset: { x: p.x - sel.x, y: p.y - sel.y } })
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
        setHoverCursor(h ? HANDLE_CURSORS[h] : inSel(p) ? 'move' : 'crosshair')
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
    } else if (drag.type === 'move' && sel) {
      setSel({
        ...sel,
        x: clamp(p.x - drag.offset.x, 0, W - sel.w),
        y: clamp(p.y - drag.offset.y, 0, H - sel.h),
      })
    } else if (drag.type === 'resize') {
      const s = drag.startSel
      const dx = p.x - drag.start.x
      const dy = p.y - drag.start.y
      let { x, y, w, h } = s
      if (drag.edges.includes('w')) { x = s.x + dx; w = s.w - dx }
      if (drag.edges.includes('e')) { w = s.w + dx }
      if (drag.edges.includes('n')) { y = s.y + dy; h = s.h - dy }
      if (drag.edges.includes('s')) { h = s.h + dy }
      // 拖过对面时翻转，免得出现负宽高
      if (w < 0) { x += w; w = -w }
      if (h < 0) { y += h; h = -h }
      setSel({ x: clamp(x, 0, W), y: clamp(y, 0, H), w: Math.min(w, W - clamp(x, 0, W)), h: Math.min(h, H - clamp(y, 0, H)) })
    } else if (drag.type === 'draw') {
      setPreview((prev) => {
        if (!prev) return prev
        if (prev.kind === 'pen') return { ...prev, pts: [...prev.pts, p] }
        if (prev.kind === 'rect') {
          return { ...prev, r: { x: Math.min(prev.r.x, p.x), y: Math.min(prev.r.y, p.y), w: Math.abs(p.x - prev.r.x), h: Math.abs(p.y - prev.r.y) } }
        }
        return { ...prev, to: p }
      })
    }
  }

  const onPointerUp = () => {
    if (!drag) return
    if (drag.type === 'create' && sel && sel.w < 4 * k && sel.h < 4 * k) {
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

  // ———————————————————————————— 文字标记 ————————————————————————————

  // 文字输入框的焦点探针：真机上"文字不行"的头号嫌疑就是焦点进不了窗口，
  // 这里把开关输入框时的焦点状态全部打点到宿主日志
  useEffect(() => {
    if (!textEdit) return
    void overlayLog('textEdit 打开')
    // autoFocus 之外再补一次：输入框是在 pointerdown 里挂载的，
    // 万一那时窗口还没成为 key 窗，focus() 会失败（探针里见过
    // is_focused=false），挂载后再抢一次更稳
    const refocus = setTimeout(() => {
      const el = document.querySelector('.ovl-text-input') as HTMLInputElement | null
      if (el && document.activeElement !== el) el.focus()
    }, 0)
    const t = setTimeout(() => {
      const el = document.activeElement
      void overlayLog(
        `textEdit 100ms 后 activeElement=${el?.tagName}.${el?.className} hasFocus=${document.hasFocus()}`,
      )
    }, 100)
    return () => {
      clearTimeout(refocus)
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textEdit?.at])

  // probe=text：免点击自测。真实点击没法在无头环境模拟，直接程序化
  // 建选区 + 开文字框，把焦点问题复现成一条日志
  useEffect(() => {
    if (!img || textEdit || sel) return
    if (new URLSearchParams(window.location.search).get('probe') !== 'text') return
    const cx = W / 2
    const cy = H / 2
    setSel({ x: W / 4, y: H / 4, w: cx, h: cy })
    setTool('text')
    setTextEdit({ at: { x: cx, y: cy }, value: '' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img])

  const commitText = () => {
    if (!textEdit) return
    const t = textEdit.value.trim()
    if (t) setMarks((ms) => [...ms, { kind: 'text', color, size, at: textEdit.at, text: t }])
    setTextEdit(null)
  }

  // ———————————————————————————— 取色 ————————————————————————————

  const colorAt = useCallback((p: Pt): [number, number, number] | null => {
    const pristine = pristineRef.current
    if (!pristine) return null
    const ctx = pristine.getContext('2d', { willReadFrequently: true })!
    const d = ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data
    return [d[0], d[1], d[2]]
  }, [])

  const copyColorAtCursor = useCallback(async () => {
    if (!cursor || busy) return
    const rgb = colorAt(cursor)
    if (!rgb) return
    const text = formatColor(rgb[0], rgb[1], rgb[2], colorFormat)
    if (demo) {
      say(`演示模式：${text}（在应用内会复制到剪贴板）`)
      return
    }
    setBusy(true)
    try {
      await screenshotCopyColor(text)
      // 按 C 的语义就是"我只要这个颜色"：复制完直接结束截图会话，
      // 不落盘、不进图片剪贴板（和 Snipaste 一致）。先闪一下提示再关。
      say(`已复制 ${text}`)
      setTimeout(() => void screenshotFinish({}).catch(() => {}), 400)
    } catch (e) {
      say(`复制失败：${String(e)}`)
      setBusy(false)
    }
  }, [cursor, colorAt, colorFormat, demo, say, busy])

  // ———————————————————————————— 完成 / 取消 ————————————————————————————

  const finish = async (action: 'save' | 'copy') => {
    if (!sel || busy) return
    if (textEdit) commitText()
    setBusy(true)

    // 裁出选区：底层画布已是 冻结帧+标记，直接裁
    const base = baseRef.current!
    const out = document.createElement('canvas')
    out.width = Math.round(sel.w)
    out.height = Math.round(sel.h)
    out.getContext('2d')!.drawImage(base, sel.x, sel.y, sel.w, sel.h, 0, 0, out.width, out.height)

    const args: { saveDataUrl?: string; copyDataUrl?: string } = {}
    if (action === 'save') {
      args.saveDataUrl = out.toDataURL(fmt === 'jpg' ? 'image/jpeg' : 'image/png', 0.92)
    }
    if (action === 'copy' || copyAfterCapture) {
      args.copyDataUrl = out.toDataURL('image/png')
    }

    if (demo) {
      say(`演示模式：${action === 'save' ? '保存' : '复制'} ${out.width}×${out.height}（在应用内会真正执行）`)
      setBusy(false)
      return
    }
    try {
      await screenshotFinish(args)
      // 成功之后窗口马上被 Rust 销毁，这里一般走不到
    } catch (e) {
      say(`失败：${String(e)}`)
      setBusy(false)
    }
  }

  const cancel = useCallback(() => {
    if (busy) return
    if (demo) {
      say('演示模式：已取消（在应用内会关闭窗口）')
      return
    }
    void screenshotCancel().catch(() => {})
  }, [busy, demo, say])

  // ———————————————————————————— 键盘 ————————————————————————————

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (textEdit) return // 输入框自己管自己的按键
      const mod = e.metaKey || e.ctrlKey

      if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        void finish('save')
      } else if (mod && e.code === 'KeyZ') {
        e.preventDefault()
        setMarks((ms) => ms.slice(0, -1))
      } else if (mod && e.code === 'KeyA') {
        e.preventDefault()
        setSel({ x: 0, y: 0, w: W, h: H })
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && sel) {
        e.preventDefault()
        setSel(null)
        setMarks([])
        setTool(null)
      } else if (!mod && !e.altKey && e.code === `Key${copyKey}`) {
        e.preventDefault()
        void copyColorAtCursor()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  // ———————————————————————————— 渲染 ————————————————————————————

  if (!img) {
    return <div className="ovl-root ovl-loading">正在准备截图…</div>
  }

  // DOM 元素用的 CSS 像素几何
  const selCss = sel ? { x: sel.x / k, y: sel.y / k, w: sel.w / k, h: sel.h / k } : null
  const cursorCss = cursor ? { x: cursor.x / k, y: cursor.y / k } : null
  const cursorRgb = cursor ? colorAt(cursor) : null
  const showMagnifier = cursor && cursorRgb && drag?.type !== 'draw' && !textEdit

  // 工具栏贴选区下边，放不下就翻到上边
  const TB_H = 40
  const tbTop = selCss
    ? selCss.y + selCss.h + 10 + TB_H <= window.innerHeight
      ? selCss.y + selCss.h + 10
      : Math.max(8, selCss.y - TB_H - 10)
    : 0

  return (
    <div className="ovl-root">
      <canvas ref={baseRef} className="ovl-canvas" />
      <canvas
        ref={hudRef}
        className="ovl-canvas ovl-hud"
        style={{ cursor: hoverCursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => {
          e.preventDefault()
          cancel()
        }}
      />

      {/* 放大镜 + 颜色值 */}
      {showMagnifier && cursorCss && (
        <div
          className="ovl-mag"
          style={{
            left: clamp(cursorCss.x + 22, 8, window.innerWidth - 160),
            top: clamp(cursorCss.y + 22, 8, window.innerHeight - 196),
          }}
        >
          <canvas ref={magRef} className="ovl-mag-canvas" />
          <div className="ovl-mag-text">
            <span>{formatColor(cursorRgb[0], cursorRgb[1], cursorRgb[2], colorFormat)}</span>
            <span className="ovl-mag-pos">
              {Math.round(cursor!.x)}, {Math.round(cursor!.y)}
            </span>
            <span className="ovl-mag-hint">{copyKey} 复制颜色并退出</span>
          </div>
        </div>
      )}

      {/* 文字标记的输入框：跟着点击位置走，字号颜色与最终绘制一致 */}
      {textEdit && (
        <input
          className="ovl-text-input"
          style={{
            left: textEdit.at.x / k,
            top: textEdit.at.y / k,
            color,
            fontSize: 12 + size * 2,
          }}
          autoFocus
          value={textEdit.value}
          placeholder="输入文字，Enter 确定"
          onFocus={() => void overlayLog('input onFocus')}
          onChange={(e) => setTextEdit({ ...textEdit, value: e.target.value })}
          onBlur={() => {
            void overlayLog('input onBlur')
            // 还没输内容就失焦的话不销毁编辑框 —— 留着让用户继续点。
            // （有内容才提交，防止误触丢失已输入的文字）
            if (textEdit.value.trim()) commitText()
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commitText()
            if (e.key === 'Escape') setTextEdit(null)
          }}
        />
      )}

      {/* 没选区时的底部提示 */}
      {!selCss && !textEdit && (
        <div className="ovl-hint">
          拖拽框选 · ⌘A 全屏 · {copyKey} 复制光标处颜色（{colorFormat}）并退出 · Esc 取消
          {demo && <span className="ovl-demo-tag">演示模式</span>}
        </div>
      )}

      {/* 工具栏 */}
      {selCss && (
        <div
          ref={observeToolbar}
          className="ovl-toolbar"
          style={{
            top: tbTop,
            // 以选区中心对齐，但左右各留 8px：工具栏比半屏宽时
            // 只夹中心点没用，会直接跑出屏幕
            left: clamp(
              selCss.x + selCss.w / 2,
              tbWidth / 2 + 8,
              Math.max(tbWidth / 2 + 8, window.innerWidth - tbWidth / 2 - 8),
            ),
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {([
            ['pen', '画笔'],
            ['rect', '方框'],
            ['arrow', '箭头'],
            ['text', '文字'],
          ] as [Tool, string][]).map(([t, label]) => (
            <button
              key={t}
              className={`ovl-btn${tool === t ? ' is-on' : ''}`}
              onClick={() => setTool(tool === t ? null : t)}
            >
              {label}
            </button>
          ))}
          <span className="ovl-sep" />
          {COLORS.map((c) => (
            <button
              key={c}
              className={`ovl-color${color === c ? ' is-on' : ''}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
          <span className="ovl-sep" />
          {SIZES.map((s) => (
            <button
              key={s}
              className={`ovl-btn${size === s ? ' is-on' : ''}`}
              onClick={() => setSize(s)}
            >
              {['细', '中', '粗'][SIZES.indexOf(s)]}
            </button>
          ))}
          <span className="ovl-sep" />
          <button className="ovl-btn" disabled={marks.length === 0} onClick={() => setMarks((ms) => ms.slice(0, -1))}>
            撤销
          </button>
          <span className="ovl-sep" />
          <button className="ovl-btn" title="Esc" onClick={cancel}>
            ✕
          </button>
          <button className="ovl-btn" disabled={busy} title="复制到剪贴板" onClick={() => void finish('copy')}>
            复制
          </button>
          <button className="ovl-btn ovl-primary" disabled={busy} title="Enter" onClick={() => void finish('save')}>
            保存
          </button>
        </div>
      )}

      {toast && <div className="ovl-toast">{toast}</div>}
    </div>
  )
}

/** 选区的 8 个手柄位置（物理像素） */
function handlePoints(sel: Rect): { name: string; x: number; y: number }[] {
  const { x, y, w, h } = sel
  const cx = x + w / 2
  const cy = y + h / 2
  return [
    { name: 'nw', x, y },
    { name: 'n', x: cx, y },
    { name: 'ne', x: x + w, y },
    { name: 'e', x: x + w, y: cy },
    { name: 'se', x: x + w, y: y + h },
    { name: 's', x: cx, y: y + h },
    { name: 'sw', x, y: y + h },
    { name: 'w', x, y: cy },
  ]
}
