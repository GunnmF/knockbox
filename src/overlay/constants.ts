import type { Tool } from './types'

/** 画笔调色板。索引即默认色。 */
export const COLORS = [
  '#ff3b30',
  '#ff9500',
  '#ffcc00',
  '#34c759',
  '#0a84ff',
  '#bf5af2',
  '#ffffff',
  '#000000',
]

/** 笔宽档位（CSS 像素，绘制时乘 k）。 */
export const SIZES = [3, 6, 10]

export const SIZE_LABELS = ['细', '中', '粗']

export const TOOLS: [Tool, string][] = [
  ['pen', '画笔'],
  ['rect', '方框'],
  ['arrow', '箭头'],
  ['text', '文字'],
]

/** 手柄命中后的光标形态（对角线两两同向，命名即方位）。 */
export const HANDLE_CURSORS: Record<string, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  w: 'ew-resize',
  e: 'ew-resize',
}

/** 取色快捷键的候选范围（与 plugin.json 的 select options 保持一致）。 */
export const COPY_KEYS = ['C', 'X', 'B']

/** 取色允许的输出格式，其余一律按 HEX。 */
export const COLOR_FORMATS = ['HEX', 'RGB', 'HSL']
