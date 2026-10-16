/** RGB → HSL（返回整百分数，取色面板直接显示）。 */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
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

/** 按用户选的格式把像素值渲染成字符串。 */
export function formatColor(r: number, g: number, b: number, format: string): string {
  if (format === 'RGB') return `rgb(${r}, ${g}, ${b})`
  if (format === 'HSL') {
    const [h, s, l] = rgbToHsl(r, g, b)
    return `hsl(${h}, ${s}%, ${l}%)`
  }
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
}
