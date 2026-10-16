/**
 * 截图覆盖层的数据类型。
 *
 * 坐标模型：一切内部坐标都是**物理像素**（冻结帧的原始尺寸），
 * 只有 DOM 元素（工具栏/放大镜/文字输入框）定位时除以 k 换回 CSS 像素。
 */

export interface Pt {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type Tool = 'pen' | 'rect' | 'arrow' | 'text'

export type Mark =
  | { kind: 'pen'; color: string; size: number; pts: Pt[] }
  | { kind: 'rect'; color: string; size: number; r: Rect }
  | { kind: 'arrow'; color: string; size: number; from: Pt; to: Pt }
  | { kind: 'text'; color: string; size: number; at: Pt; text: string }

/** 一次拖拽手势的状态机：新建选区 / 挪选区 / 拽手柄 / 画标记。 */
export type Drag =
  | { type: 'create'; start: Pt }
  | { type: 'move'; offset: Pt }
  | { type: 'resize'; edges: string; startSel: Rect; start: Pt }
  | { type: 'draw' }
