import type { Mark } from './types'

/**
 * 在画布上画一个标记。
 *
 * @param k 物理像素 / CSS 像素。所有笔宽、字体都要乘 k，否则高分屏上
 *          线条细一半、字小一半。调用方保证 k 已经算好。
 */
export function renderMark(ctx: CanvasRenderingContext2D, m: Mark, k: number) {
  ctx.strokeStyle = m.color
  ctx.fillStyle = m.color
  ctx.lineWidth = m.size * k
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (m.kind === 'pen') {
    if (m.pts.length < 2) return
    ctx.beginPath()
    ctx.moveTo(m.pts[0].x, m.pts[0].y)
    for (const p of m.pts.slice(1)) ctx.lineTo(p.x, p.y)
    ctx.stroke()
  } else if (m.kind === 'rect') {
    ctx.strokeRect(m.r.x, m.r.y, m.r.w, m.r.h)
  } else if (m.kind === 'arrow') {
    const a = Math.atan2(m.to.y - m.from.y, m.to.x - m.from.x)
    const head = Math.max(10 * k, m.size * k * 4)
    ctx.beginPath()
    ctx.moveTo(m.from.x, m.from.y)
    ctx.lineTo(m.to.x, m.to.y)
    ctx.moveTo(m.to.x, m.to.y)
    ctx.lineTo(m.to.x - head * Math.cos(a - Math.PI / 7), m.to.y - head * Math.sin(a - Math.PI / 7))
    ctx.moveTo(m.to.x, m.to.y)
    ctx.lineTo(m.to.x - head * Math.cos(a + Math.PI / 7), m.to.y - head * Math.sin(a + Math.PI / 7))
    ctx.stroke()
  } else if (m.kind === 'text') {
    ctx.font = `${(12 + m.size * 2) * k}px -apple-system, "PingFang SC", sans-serif`
    ctx.textBaseline = 'top'
    ctx.fillText(m.text, m.at.x, m.at.y)
  }
}
