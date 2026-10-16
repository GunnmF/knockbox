import { useEffect, useState } from 'react'
import { prettyAccelerator, toAccelerator } from './hotkey'

/** 点击即进入录制态，再点一下或按 Esc 退出；录到的组合键直接回调给设置页。 */
export function HotkeyRecorder({
  value,
  onChange,
}: {
  value: string
  onChange: (accel: string) => void
}) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!recording) return
    const onKeyDown = (e: KeyboardEvent) => {
      // 录制期间**所有**按键都要拦下来。
      // 特别是空格：录制按钮此刻是聚焦状态，不拦的话空格会触发它的 click，
      // 录制刚开始就被自己关掉，看起来就是"按了没反应"。
      e.preventDefault()
      e.stopPropagation()

      // Esc 是「取消录制」而不是被录成快捷键
      if (e.key === 'Escape') {
        setRecording(false)
        setError('')
        return
      }
      const accel = toAccelerator(e as unknown as React.KeyboardEvent)
      if (!accel) {
        setError('需要一个修饰键（⌘ / ⌃ / ⌥ / ⇧）加一个字母、数字、空格、F 键或方向键')
        return
      }
      setRecording(false)
      setError('')
      onChange(accel)
    }
    // 录制期间要挡住全局快捷键，否则按下新组合键的瞬间窗口会被收走
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording, onChange])

  return (
    <>
      <button
        className={recording ? 'kb-recording' : ''}
        onClick={() => {
          setError('')
          setRecording((r) => !r)
        }}
      >
        {recording ? '按下组合键…（Esc 取消）' : prettyAccelerator(value)}
      </button>
      {error && <span className="kb-field-error">{error}</span>}
      {!recording && !error && (
        <span className="kb-field-hint">
          组合键被系统占用时录不上（如 macOS 的 ⌘空格属于 Spotlight），
          先去系统设置里改掉再录
        </span>
      )}
    </>
  )
}
