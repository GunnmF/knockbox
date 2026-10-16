import { COLORS, SIZES, SIZE_LABELS, TOOLS } from './constants'
import type { Tool } from './types'

interface Props {
  /** 定位由父级算好：那里才知道选区和屏幕边界。 */
  top: number
  left: number
  tool: Tool | null
  color: string
  size: number
  canUndo: boolean
  busy: boolean
  onMeasure: (el: HTMLDivElement | null) => void
  onTool: (t: Tool) => void
  onColor: (c: string) => void
  onSize: (s: number) => void
  onUndo: () => void
  onCancel: () => void
  onCopy: () => void
  onSave: () => void
}

/** 工具栏：工具/颜色/笔宽，加上撤销、取消、复制、保存。 */
export function OverlayToolbar({
  top,
  left,
  tool,
  color,
  size,
  canUndo,
  busy,
  onMeasure,
  onTool,
  onColor,
  onSize,
  onUndo,
  onCancel,
  onCopy,
  onSave,
}: Props) {
  return (
    <div
      ref={onMeasure}
      className="ovl-toolbar"
      style={{ top, left }}
      // 工具栏压在画布上：不拦住的话，选区边缘那一下 pointerdown
      // 会穿透下去变成「挪动选区」，点按钮时选区跟着跑
      onPointerDown={(e) => e.stopPropagation()}
    >
      {TOOLS.map(([t, label]) => (
        <button
          key={t}
          className={`ovl-btn${tool === t ? ' is-on' : ''}`}
          onClick={() => onTool(t)}
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
          onClick={() => onColor(c)}
        />
      ))}
      <span className="ovl-sep" />
      {SIZES.map((s) => (
        <button
          key={s}
          className={`ovl-btn${size === s ? ' is-on' : ''}`}
          onClick={() => onSize(s)}
        >
          {SIZE_LABELS[SIZES.indexOf(s)]}
        </button>
      ))}
      <span className="ovl-sep" />
      <button className="ovl-btn" disabled={!canUndo} onClick={onUndo}>
        撤销
      </button>
      <span className="ovl-sep" />
      <button className="ovl-btn" title="Esc" onClick={onCancel}>
        ✕
      </button>
      <button
        className="ovl-btn"
        disabled={busy}
        title="复制到剪贴板"
        onClick={onCopy}
      >
        复制
      </button>
      <button className="ovl-btn ovl-primary" disabled={busy} title="Enter" onClick={onSave}>
        保存
      </button>
    </div>
  )
}
