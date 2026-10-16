import type { KeyboardEvent, RefObject } from 'react'

/**
 * 启动器的固定部件：输入条、错误条、底栏。
 *
 * 三者放一起是因为它们有个共同约束 —— 高度是写死的，窗口高度自适应时
 * 要把它们逐个加起来当「chrome」（见 hooks/useWindowFit.ts）。拆散到三个
 * 文件反而看不出它们是一组。
 */

export function InputRow({
  value,
  onChange,
  onKeyDown,
  onClear,
  inputRef,
}: {
  value: string
  onChange: (v: string) => void
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  onClear: () => void
  inputRef: RefObject<HTMLInputElement | null>
}) {
  return (
    <div className="kb-input-row">
      <span className="kb-icon">⌘</span>
      <input
        ref={inputRef}
        className="kb-input"
        value={value}
        placeholder="搜索应用、文件，或输入任意内容去搜索…"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoFocus
      />
      {value && (
        <button className="kb-clear" onClick={onClear}>
          清空
        </button>
      )}
    </div>
  )
}

export function ErrorBar({ message }: { message: string }) {
  return <div className="kb-error">{message}</div>
}

export function Footer({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="kb-footer">
      <span>↑↓ 选择</span>
      <span>↵ 打开</span>
      <span>esc 关闭</span>
      <span className="kb-footer-right" onClick={onOpenSettings} role="button" tabIndex={0}>
        管理应用
      </span>
    </div>
  )
}
