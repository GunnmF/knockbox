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
 * 本文件只留会话本身：加载冻结帧、取色、收尾、组装。手势在
 * usePointerGestures，绘制在 useOverlayCanvas，键盘在 useOverlayKeys，
 * 文字编辑在 useTextEditor；工具栏/放大镜/输入框是独立组件。
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
import { COLORS, COLOR_FORMATS, COPY_KEYS, SIZES } from './constants'
import { formatColor } from './color'
import { clamp } from './geometry'
import { makeDemoImage } from './demoImage'
import { Magnifier } from './Magnifier'
import { OverlayToolbar } from './OverlayToolbar'
import { TextInput } from './TextInput'
import { useBaseCanvas, useHudCanvas } from './useOverlayCanvas'
import { useOverlayKeys } from './useOverlayKeys'
import { usePointerGestures } from './usePointerGestures'
import { useTextEditor } from './useTextEditor'
import type { Mark, Pt, Rect, Tool } from './types'
import './overlay.css'

export default function ScreenshotOverlay() {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [demo, setDemo] = useState(false)
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [sel, setSel] = useState<Rect | null>(null)
  const [marks, setMarks] = useState<Mark[]>([])
  const [tool, setTool] = useState<Tool | null>(null)
  const [color, setColor] = useState(COLORS[0])
  const [size, setSize] = useState(SIZES[1])
  const [textEdit, setTextEdit] = useState<{ at: Pt; value: string } | null>(null)
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState(false)
  const [tbWidth, setTbWidth] = useState(600) // 实测工具栏宽，用于贴边时不跑出屏幕

  const baseRef = useRef<HTMLCanvasElement>(null)
  const hudRef = useRef<HTMLCanvasElement>(null)
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
  const colorFormat = COLOR_FORMATS.includes(String(settings.colorFormat))
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

  // ———————————————————————————— 文字标记 ————————————————————————————

  const commitText = useTextEditor({
    textEdit,
    setTextEdit,
    setMarks,
    setTool,
    setSel,
    img,
    sel,
    color,
    size,
    W,
    H,
  })

  // ———————————————————————————— 手势与绘制 ————————————————————————————

  const { drag, cursor, preview, hoverCursor, onPointerDown, onPointerMove, onPointerUp } =
    usePointerGestures({
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
    })

  useBaseCanvas(baseRef, img, marks, W, H, k)
  useHudCanvas(hudRef, img, sel, preview, cursor, W, H, k)

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

  const finish = useCallback(
    async (action: 'save' | 'copy') => {
      if (!sel || busy) return
      if (textEdit) commitText()
      setBusy(true)

      // 裁出选区：底层画布已是 冻结帧+标记，直接裁
      const base = baseRef.current!
      const out = document.createElement('canvas')
      out.width = Math.round(sel.w)
      out.height = Math.round(sel.h)
      out
        .getContext('2d')!
        .drawImage(base, sel.x, sel.y, sel.w, sel.h, 0, 0, out.width, out.height)

      const args: { saveDataUrl?: string; copyDataUrl?: string } = {}
      if (action === 'save') {
        args.saveDataUrl = out.toDataURL(fmt === 'jpg' ? 'image/jpeg' : 'image/png', 0.92)
      }
      if (action === 'copy' || copyAfterCapture) {
        args.copyDataUrl = out.toDataURL('image/png')
      }

      if (demo) {
        say(
          `演示模式：${action === 'save' ? '保存' : '复制'} ${out.width}×${out.height}（在应用内会真正执行）`,
        )
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
    },
    [sel, busy, textEdit, commitText, fmt, copyAfterCapture, demo, say],
  )

  const cancel = useCallback(() => {
    if (busy) return
    if (demo) {
      say('演示模式：已取消（在应用内会关闭窗口）')
      return
    }
    void screenshotCancel().catch(() => {})
  }, [busy, demo, say])

  useOverlayKeys({
    textEdit,
    sel,
    W,
    H,
    copyKey,
    cancel,
    finish,
    copyColorAtCursor,
    setMarks,
    setSel,
    setTool,
  })

  // ———————————————————————————— 渲染 ————————————————————————————

  if (!img) {
    return <div className="ovl-root ovl-loading">正在准备截图…</div>
  }

  // DOM 元素用的 CSS 像素几何
  const selCss = sel ? { x: sel.x / k, y: sel.y / k, w: sel.w / k, h: sel.h / k } : null
  const cursorRgb = cursor ? colorAt(cursor) : null
  const showMagnifier = !!cursor && !!cursorRgb && drag?.type !== 'draw' && !textEdit

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

      {showMagnifier && cursor && (
        <Magnifier
          cursor={cursor}
          k={k}
          W={W}
          H={H}
          pristine={pristineRef.current}
          rgb={cursorRgb}
          colorFormat={colorFormat}
          copyKey={copyKey}
        />
      )}

      {textEdit && (
        <TextInput
          at={textEdit.at}
          k={k}
          color={color}
          fontSize={12 + size * 2}
          value={textEdit.value}
          onChange={(v) => setTextEdit({ ...textEdit, value: v })}
          onCommit={commitText}
          onCancel={() => setTextEdit(null)}
        />
      )}

      {/* 没选区时的底部提示 */}
      {!selCss && !textEdit && (
        <div className="ovl-hint">
          拖拽框选 · ⌘A 全屏 · {copyKey} 复制光标处颜色（{colorFormat}）并退出 · Esc 取消
          {demo && <span className="ovl-demo-tag">演示模式</span>}
        </div>
      )}

      {selCss && (
        <OverlayToolbar
          top={tbTop}
          // 以选区中心对齐，但左右各留 8px：工具栏比半屏宽时
          // 只夹中心点没用，会直接跑出屏幕
          left={clamp(
            selCss.x + selCss.w / 2,
            tbWidth / 2 + 8,
            Math.max(tbWidth / 2 + 8, window.innerWidth - tbWidth / 2 - 8),
          )}
          tool={tool}
          color={color}
          size={size}
          canUndo={marks.length > 0}
          busy={busy}
          onMeasure={observeToolbar}
          onTool={(t) => setTool(tool === t ? null : t)}
          onColor={setColor}
          onSize={setSize}
          onUndo={() => setMarks((ms) => ms.slice(0, -1))}
          onCancel={cancel}
          onCopy={() => void finish('copy')}
          onSave={() => void finish('save')}
        />
      )}

      {toast && <div className="ovl-toast">{toast}</div>}
    </div>
  )
}
