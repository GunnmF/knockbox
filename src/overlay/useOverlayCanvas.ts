import { useEffect, type RefObject } from 'react'
import { renderMark } from './drawMark'
import { handlePoints } from './geometry'
import type { Mark, Pt, Rect } from './types'

/**
 * 底层画布：冻结帧 + 已提交的标记。
 *
 * 导出图片时裁的就是这张 —— 标记画在 HUD 上只是预览，不进成品。
 */
export function useBaseCanvas(
  ref: RefObject<HTMLCanvasElement | null>,
  img: HTMLImageElement | null,
  marks: Mark[],
  W: number,
  H: number,
  k: number,
) {
  useEffect(() => {
    const cv = ref.current
    if (!cv || !img) return
    cv.width = W
    cv.height = H
    const ctx = cv.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    for (const m of marks) renderMark(ctx, m, k)
  }, [ref, img, marks, W, H, k])
}

/** 上层 HUD：选区外的暗化、边框、手柄、尺寸标签、正在拖的预览。 */
export function useHudCanvas(
  ref: RefObject<HTMLCanvasElement | null>,
  img: HTMLImageElement | null,
  sel: Rect | null,
  preview: Mark | null,
  cursor: Pt | null,
  W: number,
  H: number,
  k: number,
) {
  useEffect(() => {
    const cv = ref.current
    if (!cv || !img) return
    cv.width = W
    cv.height = H
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, W, H)

    // 暗化：有选区时露出选区，没选区整屏稍暗
    ctx.fillStyle = 'rgba(0, 0, 0, .38)'
    if (sel) {
      ctx.beginPath()
      ctx.rect(0, 0, W, H)
      ctx.rect(sel.x, sel.y, sel.w, sel.h)
      ctx.fill('evenodd')
    } else {
      ctx.fillRect(0, 0, W, H)
    }

    // 还没选区时的十字参考线，帮助对齐
    if (!sel && cursor) {
      ctx.strokeStyle = 'rgba(255,255,255,.35)'
      ctx.lineWidth = k
      ctx.setLineDash([4 * k, 4 * k])
      ctx.beginPath()
      ctx.moveTo(0, cursor.y)
      ctx.lineTo(W, cursor.y)
      ctx.moveTo(cursor.x, 0)
      ctx.lineTo(cursor.x, H)
      ctx.stroke()
      ctx.setLineDash([])
    }

    if (sel) {
      // 边框 + 八向手柄
      ctx.strokeStyle = '#0a84ff'
      ctx.lineWidth = Math.max(1.5 * k, 2)
      ctx.strokeRect(sel.x, sel.y, sel.w, sel.h)
      const hs = 5 * k
      ctx.fillStyle = '#fff'
      ctx.strokeStyle = 'rgba(0,0,0,.4)'
      ctx.lineWidth = k
      for (const p of handlePoints(sel)) {
        ctx.beginPath()
        ctx.rect(p.x - hs, p.y - hs, hs * 2, hs * 2)
        ctx.fill()
        ctx.stroke()
      }
      // 尺寸标签：选区上方，没地方就贴进选区里
      const label = `${Math.round(sel.w / k)} × ${Math.round(sel.h / k)}`
      ctx.font = `${12 * k}px -apple-system, "PingFang SC", sans-serif`
      ctx.textBaseline = 'middle'
      const tw = ctx.measureText(label).width
      const pad = 6 * k
      const ly = sel.y - 26 * k >= 0 ? sel.y - 26 * k : sel.y + 6 * k
      ctx.fillStyle = 'rgba(0,0,0,.72)'
      ctx.beginPath()
      ctx.roundRect(sel.x, ly, tw + pad * 2, 20 * k, 4 * k)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.fillText(label, sel.x + pad, ly + 10 * k)
    }

    if (preview) renderMark(ctx, preview, k)
  }, [ref, img, sel, preview, cursor, W, H, k])
}
