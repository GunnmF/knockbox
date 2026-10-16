/** 浏览器演示模式用的合成测试图：渐变底 + 色块 + 网格 + 文字，取色才有东西可取。 */
export function makeDemoImage(): Promise<HTMLImageElement> {
  const c = document.createElement('canvas')
  c.width = 2560
  c.height = 1440
  const x = c.getContext('2d')!
  const grad = x.createLinearGradient(0, 0, 2560, 1440)
  grad.addColorStop(0, '#1c2541')
  grad.addColorStop(0.5, '#3a506b')
  grad.addColorStop(1, '#5bc0be')
  x.fillStyle = grad
  x.fillRect(0, 0, 2560, 1440)
  const swatches = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2', '#ffffff', '#000000']
  swatches.forEach((color, i) => {
    x.fillStyle = color
    x.fillRect(200 + i * 270, 500, 220, 220)
  })
  x.strokeStyle = 'rgba(255,255,255,.18)'
  for (let gx = 0; gx < 2560; gx += 128) {
    x.beginPath()
    x.moveTo(gx, 0)
    x.lineTo(gx, 1440)
    x.stroke()
  }
  for (let gy = 0; gy < 1440; gy += 128) {
    x.beginPath()
    x.moveTo(0, gy)
    x.lineTo(2560, gy)
    x.stroke()
  }
  x.fillStyle = '#fff'
  x.font = '80px -apple-system, "PingFang SC", sans-serif'
  x.fillText('Knockbox 截图 · 演示模式', 200, 320)
  x.font = '44px -apple-system, "PingFang SC", sans-serif'
  x.fillText('拖拽框选 · 悬停看颜色 · C 复制颜色 · Esc 取消', 200, 860)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('演示图生成失败'))
    img.src = c.toDataURL('image/png')
  })
}
