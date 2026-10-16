import type { Pt, Rect } from './types'

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** 选区的 8 个手柄位置（物理像素）。顺时针从左上角开始。 */
export function handlePoints(sel: Rect): { name: string; x: number; y: number }[] {
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

/** 点是否落在矩形内（用于选区命中与「标记只允许画在选区内」）。 */
export function pointInRect(p: Pt, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
}
