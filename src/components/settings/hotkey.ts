/** 一些不能从 `e.code` 直接截出来的键名。 */
const NAMED_KEYS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
}

/**
 * 把 KeyboardEvent 转成 Tauri 的全局快捷键描述串（`CommandOrControl+Shift+K`）。
 *
 * 优先用 `e.code` 而不是 `e.key`：`e.key` 会随 Shift 变成大写，
 * 于是「⇧K」和「K」录出来一模一样。
 */
export function toAccelerator(e: React.KeyboardEvent): string | null {
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')

  const code = e.code
  let key: string | null = null
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit\d$/.test(code)) key = code.slice(5)
  else if (/^F\d{1,2}$/.test(code)) key = code
  else if (code.startsWith('Numpad') && code.length > 6) key = code.slice(6)
  else key = NAMED_KEYS[code] ?? null

  if (!key) return null

  // 没有任何修饰键的话，这个组合会直接抢走正常的打字，必须拒绝
  if (mods.length === 0) return null
  // ⌘ 和 Ctrl 同时按下是同一个意思，留一个就够
  const hasPrimary = mods.includes('Control') || mods.includes('Super')
  const normalized = hasPrimary
    ? mods
        .filter((m) => m === 'Control' || m === 'Super')
        .slice(0, 1)
        .map(() => 'CommandOrControl')
        .concat(mods.filter((m) => m !== 'Control' && m !== 'Super'))
    : mods

  return [...normalized, key].join('+')
}

/** 「CommandOrControl+Shift+K」→ 人话「⌘⇧K」。 */
export function prettyAccelerator(accel: string): string {
  const mac = navigator.platform.toLowerCase().includes('mac')
  return accel
    .split('+')
    .map((p) => {
      if (p === 'CommandOrControl') return mac ? '⌘' : 'Ctrl'
      if (p === 'Control') return mac ? '⌃' : 'Ctrl'
      if (p === 'Shift') return mac ? '⇧' : 'Shift'
      if (p === 'Alt') return mac ? '⌥' : 'Alt'
      if (p === 'Super') return mac ? '⌘' : 'Win'
      if (p === 'Space') return mac ? '␣' : 'Space'
      if (p === 'Enter') return mac ? '↩' : 'Enter'
      if (p === 'Up') return mac ? '↑' : 'Up'
      if (p === 'Down') return mac ? '↓' : 'Down'
      if (p === 'Left') return mac ? '←' : 'Left'
      if (p === 'Right') return mac ? '→' : 'Right'
      return p.length === 1 ? p.toUpperCase() : p
    })
    .join(mac ? '' : '+')
}
