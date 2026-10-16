import { overlayLog } from '../ipc'
import type { Pt } from './types'

interface Props {
  /** 输入框锚点（物理像素），显示时除以 k。 */
  at: Pt
  k: number
  color: string
  fontSize: number
  value: string
  onChange: (v: string) => void
  onCommit: () => void
  onCancel: () => void
}

/**
 * 文字标记的输入框：跟着点击位置走，字号颜色与最终绘制一致。
 *
 * autoFocus 之外还有父组件里那次挂载后的 refocus —— 输入框是在 pointerdown
 * 里挂载的，万一那时窗口还没成为 key 窗，focus() 会失败（探针里见过
 * is_focused=false），挂载后再抢一次更稳。焦点状态也全部打到宿主日志，
 * 真机上「文字不行」的头号嫌疑就是焦点进不了窗口。
 */
export function TextInput({ at, k, color, fontSize, value, onChange, onCommit, onCancel }: Props) {
  return (
    <input
      className="ovl-text-input"
      style={{ left: at.x / k, top: at.y / k, color, fontSize }}
      autoFocus
      value={value}
      placeholder="输入文字，Enter 确定"
      onFocus={() => void overlayLog('input onFocus')}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => {
        void overlayLog('input onBlur')
        // 还没输内容就失焦的话不销毁编辑框 —— 留着让用户继续点。
        // （有内容才提交，防止误触丢失已输入的文字）
        if (value.trim()) onCommit()
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') onCommit()
        if (e.key === 'Escape') onCancel()
      }}
    />
  )
}
