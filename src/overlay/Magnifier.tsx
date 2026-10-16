import { useEffect, useRef } from 'react'
import { clamp } from './geometry'
import { formatColor } from './color'
import type { Pt } from './types'

interface Props {
  /** 光标位置（物理像素）。null = 不显示。 */
  cursor: Pt | null
  k: number
  W: number
  H: number
  /** 只含冻结帧的纯净画布：取色不能被标记污染。 */
  pristine: HTMLCanvasElement | null
  rgb: [number, number, number] | null
  colorFormat: string
  copyKey: string
}

/**
 * 放大镜：光标周围 11×11 物理像素放大 12 倍，外加取到的颜色值和坐标。
 *
 * 面板尺寸是写死的，定位时按它夹住屏幕边界，不然贴到屏幕右/下边就只剩半截。
 */
export function Magnifier({ cursor, k, W, H, pristine, rgb, colorFormat, copyKey }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || !pristine || !cursor) return
    const cells = 11
    const zoom = 12
    cv.width = cells * zoom
    cv.height = cells * zoom
    const ctx = cv.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    const half = Math.floor(cells / 2)
    const sx = clamp(Math.round(cursor.x) - half, 0, Math.max(0, W - cells))
    const sy = clamp(Math.round(cursor.y) - half, 0, Math.max(0, H - cells))
    ctx.drawImage(pristine, sx, sy, cells, cells, 0, 0, cells * zoom, cells * zoom)
    // 中心格描边 = 当前取到的像素
    ctx.strokeStyle = 'rgba(255,255,255,.9)'
    ctx.lineWidth = 2
    ctx.strokeRect(half * zoom + 1, half * zoom + 1, zoom - 2, zoom - 2)
  }, [cursor, pristine, W, H])

  if (!cursor || !rgb) return null

  return (
    <div
      className="ovl-mag"
      style={{
        left: clamp(cursor.x / k + 22, 8, window.innerWidth - 160),
        top: clamp(cursor.y / k + 22, 8, window.innerHeight - 196),
      }}
    >
      <canvas ref={canvasRef} className="ovl-mag-canvas" />
      <div className="ovl-mag-text">
        <span>{formatColor(rgb[0], rgb[1], rgb[2], colorFormat)}</span>
        <span className="ovl-mag-pos">
          {Math.round(cursor.x)}, {Math.round(cursor.y)}
        </span>
        <span className="ovl-mag-hint">{copyKey} 复制颜色并退出</span>
      </div>
    </div>
  )
}
