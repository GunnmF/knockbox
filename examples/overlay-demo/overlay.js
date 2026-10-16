// 覆盖层里的界面：**完全是这个轻应用自己的代码**。
//
// 宿主提供的只有：一个无边框置顶窗口（盖满当前屏幕）+ 一个获取屏幕画面的
// 能力。选区框、提示条、键盘交互、结果怎么回传，没有一行是宿主写的 ——
// 截图轻应用里那套逻辑当初就长这样，只是当时它住在宿主里。
//
// 注意这里用的是 `connect()` 的同一个 SDK，但 connect 会把宿主给的
// `params` 一并带回来（见 openOverlay 的 params）。

import { connect } from './sdk.js'

const frame = document.getElementById('frame')
const hint = document.getElementById('hint')

let kb = null
let drag = null

function showBox(x, y, w, h) {
  frame.hidden = false
  frame.style.left = `${x}px`
  frame.style.top = `${y}px`
  frame.style.width = `${w}px`
  frame.style.height = `${h}px`
  frame.dataset.size = `${Math.round(w)} × ${Math.round(h)}`
}

async function main() {
  kb = await connect()

  // 拿一张当前屏幕的图当底图，让用户知道自己在选什么。
  // freeze 模式只给图、不带界面 —— 框选是本插件自己画的。
  try {
    const shot = await kb.screen.capture({ mode: 'freeze' })
    if (shot?.dataUrl) {
      const img = new Image()
      img.src = shot.dataUrl
      // 图片是物理像素，页面是 CSS 像素，按比例铺满
      img.style.cssText =
        'position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1'
      document.body.appendChild(img)
    }
  } catch {
    hint.textContent = '拿不到屏幕画面（可能没给屏幕录制权限），仍可框选'
  }
}

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY }
  showBox(drag.x0, drag.y0, 0, 0)
  e.preventDefault()
})

document.addEventListener('pointermove', (e) => {
  if (!drag) return
  drag.x1 = e.clientX
  drag.y1 = e.clientY
  showBox(
    Math.min(drag.x0, drag.x1),
    Math.min(drag.y0, drag.y1),
    Math.abs(drag.x1 - drag.x0),
    Math.abs(drag.y1 - drag.y0),
  )
})

document.addEventListener('pointerup', () => {
  // 松手时如果框太小，视为误触：清掉继续等下一次
  if (!drag) return
  const w = Math.abs(drag.x1 - drag.x0)
  const h = Math.abs(drag.y1 - drag.y0)
  drag = null
  if (w < 8 || h < 8) {
    frame.hidden = true
    hint.textContent = '框太小了，重新拖一次'
    setTimeout(() => (hint.textContent = '拖动框选 · Esc 取消 · 框好后按 Enter 确认'), 1200)
  }
})

document.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    // null = 用户主动取消，宿主会把它作为 openOverlay 的返回值
    kb?.window?.closeOverlay(null)
    return
  }
  if (e.key === 'Enter' && !frame.hidden) {
    e.preventDefault()
    const x = parseFloat(frame.style.left)
    const y = parseFloat(frame.style.top)
    const width = parseFloat(frame.style.width)
    const height = parseFloat(frame.style.height)
    // 结果原样交回 await openOverlay 的那次调用
    kb?.window?.closeOverlay({ label: '示例选区', x, y, width, height })
  }
})

main().catch(() => {
  hint.textContent = 'SDK 连接失败：宿主没有正常响应'
})
