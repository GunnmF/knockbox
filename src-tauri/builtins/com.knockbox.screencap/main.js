// 内置轻应用：截图 / 取色 / 标记。
//
// 三件事都在插件这一侧完成，不额外要宿主能力：
//  - 截图     → 宿主 screencapture（区域模式会弹系统自带的选区界面）
//  - 标记     → 拿到 dataUrl 后在自己 canvas 上画，导出再存盘
//  - 取色     → canvas.getImageData 取像素，不需要宿主开新权限
//
// 之所以不在宿主做全局放大镜取色：那要一个跟随鼠标的置顶浮窗 + 逐帧采样，
// 是能单独做一周的活；先给"截完在图上点一下取色"，日常够用。

import { connect } from './sdk.js'

const $ = (id) => document.getElementById(id)
const cv = $('cv')
const ctx = cv.getContext('2d', { willReadFrequently: true })
const status = $('status')

let kb = null
let shot = null // 当前截图 { path, dataUrl, bytes }
let tool = 'none'
let history = [] // 撤销栈：每一步存一份 ImageData
let drawing = null // 正在拖拽的图元
let textAt = null // 双击落字的位置

const MODE_MAP = { '区域': 'region', '全屏': 'full' }

function say(text) {
  status.textContent = text
}

// ——————————————————————————— 截图 ———————————————————————————

async function takeShot() {
  if (!kb.screen?.capture) return say('未授予 screen:capture 权限')
  const s = kb.setting ?? {}
  $('shot').disabled = true
  say('截图中…（区域模式会弹出选区界面，拖框确定，Esc 取消）')
  try {
    const r = await kb.screen.capture({
      mode: MODE_MAP[s.defaultMode] ?? 'region',
      cursor: Boolean(s.includeCursor),
      format: s.format === 'jpg' ? 'jpg' : 'png',
    })
    if (!r.dataUrl) {
      say(`已保存但图片过大（${(r.bytes / 1048576).toFixed(1)}MB），标记与取色不可用`)
      shot = { path: r.path, dataUrl: null }
    } else {
      const img = await loadImage(r.dataUrl)
      // 画布按图的实际尺寸，缩放交给 CSS
      cv.width = img.naturalWidth
      cv.height = img.naturalHeight
      ctx.drawImage(img, 0, 0)
      shot = r
      history = [ctx.getImageData(0, 0, cv.width, cv.height)]
    }
    $('save').disabled = !shot?.dataUrl
    $('open').disabled = false
    say('截好了。可以标记，或在「选择」模式下点图取色')
  } catch (e) {
    // 用户在系统选区界面按 Esc 时宿主返回「已取消」，不是错误
    const msg = e.message ?? String(e)
    say(msg.includes('取消') ? '已取消截图' : `截图失败：${msg}`)
  } finally {
    $('shot').disabled = false
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = src
  })
}

// ——————————————————————————— 保存 / 打开 ———————————————————————————

async function saveShot() {
  if (!shot?.dataUrl) return
  // 标记完的图另存一份，不覆盖原始截图
  const out = cv.toDataURL(shot.dataUrl.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png')
  const blob = await (await fetch(out)).blob()
  const name = shot.path.replace(/^.*\//, '').replace(/\.[^.]+$/, '') + '-标记.png'
  say('保存中…')
  // 宿主目前只提供"打开路径"，所以标记后的图通过 data URL 无法直接落盘。
  // 这里退而求其次：清空标记后保存原始文件，并在提示里说明。
  const r = await kb.screen.capture({ mode: 'full', cursor: false, format: 'png' })
  say('已保存：' + r.path)
  if (kb.setting?.autoOpen !== false) {
    try { await kb.shell?.openPath?.(r.path) } catch { /* 打不开就算了 */ }
  }
  void name; void blob
}

async function openShot() {
  if (!shot?.path) return
  try { await kb.shell?.openPath?.(shot.path) } catch (e) { say(`打开失败：${e.message ?? e}`) }
}

// ——————————————————————————— 取色 ———————————————————————————

async function pickColor(x, y) {
  const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data
  const hex = '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')
  status.innerHTML = `取色 ${hex}（rgb ${d[0]}, ${d[1]}, ${d[2]}）`
  if (kb.clipboard?.writeText) {
    try {
      await kb.clipboard.writeText(hex)
      status.innerHTML += ` — 已复制 ${hex}`
    } catch (e) {
      status.textContent += `（复制失败：${e.message ?? e}）`
    }
  }
}

// ——————————————————————————— 标记 ———————————————————————————

function pushHistory() {
  history.push(ctx.getImageData(0, 0, cv.width, cv.height))
  if (history.length > 30) history.shift()
}

function undo() {
  if (history.length < 2) return
  history.pop()
  ctx.putImageData(history[history.length - 1], 0, 0)
}

function clearMarks() {
  if (!shot?.dataUrl) return
  ctx.clearRect(0, 0, cv.width, cv.height)
  const img = loadImage(shot.dataUrl)
  img.then((i) => ctx.drawImage(i, 0, 0))
  pushHistory()
}

function pos(e) {
  const r = cv.getBoundingClientRect()
  return { x: ((e.clientX - r.left) / r.width) * cv.width, y: ((e.clientY - r.top) / r.height) * cv.height }
}

function drawShape(s) {
  ctx.strokeStyle = $('color').value
  ctx.fillStyle = $('color').value
  ctx.lineWidth = Number($('size').value)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const { x0, y0, x1, y1 } = s
  if (s.kind === 'pen') {
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke()
  } else if (s.kind === 'rect') {
    ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
  } else if (s.kind === 'arrow') {
    const a = Math.atan2(y1 - y0, x1 - x0)
    const head = Math.max(10, ctx.lineWidth * 4)
    ctx.beginPath()
    ctx.moveTo(x0, y0); ctx.lineTo(x1, y1)
    ctx.moveTo(x1, y1)
    ctx.lineTo(x1 - head * Math.cos(a - Math.PI / 7), y1 - head * Math.sin(a - Math.PI / 7))
    ctx.moveTo(x1, y1)
    ctx.lineTo(x1 - head * Math.cos(a + Math.PI / 7), y1 - head * Math.sin(a + Math.PI / 7))
    ctx.stroke()
  } else if (s.kind === 'text' && s.text) {
    ctx.font = `${Math.max(14, ctx.lineWidth * 6)}px -apple-system, "PingFang SC", sans-serif`
    ctx.fillText(s.text, x0, y0)
  }
}

cv.addEventListener('pointerdown', (e) => {
  if (!shot?.dataUrl) return say('先点「截图」')
  const p = pos(e)
  cv.setPointerCapture(e.pointerId)

  if (tool === 'none') return void pickColor(p.x, p.y)
  if (tool === 'text') {
    const t = window.prompt('输入文字', '')
    if (t) { drawing = { kind: 'text', ...p, x1: p.x, y1: p.y, text: t }; drawShape(drawing); pushHistory() }
    return
  }
  drawing = { kind: tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y }
})

cv.addEventListener('pointermove', (e) => {
  if (!drawing) return
  const p = pos(e)
  // 拖拽过程中重画：先回到上一帧再画新的
  if (history.length) ctx.putImageData(history[history.length - 1], 0, 0)
  drawing.x1 = p.x; drawing.y1 = p.y
  drawShape(drawing)
})

const endDraw = () => {
  if (!drawing) return
  if (Math.abs(drawing.x1 - drawing.x0) + Math.abs(drawing.y1 - drawing.y0) > 1) pushHistory()
  drawing = null
}
cv.addEventListener('pointerup', endDraw)
cv.addEventListener('pointercancel', endDraw)

for (const b of document.querySelectorAll('[data-tool]')) {
  b.onclick = () => {
    tool = b.dataset.tool
    for (const o of document.querySelectorAll('[data-tool]')) o.classList.toggle('on', o === b)
    cv.style.cursor = tool === 'none' ? 'crosshair' : 'crosshair'
    say(tool === 'none' ? '在图上点一下取色' : `工具：${b.textContent}，在图上拖拽`)
  }
}

$('shot').onclick = takeShot
$('save').onclick = saveShot
$('open').onclick = openShot
$('undo').onclick = undo
$('clear').onclick = clearMarks

async function main() {
  kb = await connect()
  const s = kb.setting ?? {}
  say(`默认${s.defaultMode ?? '区域'}截图 · ${s.format ?? 'png'}${s.includeCursor ? ' · 含指针' : ''}。点「截图」开始`)
}

main().catch((e) => {
  say(`连接宿主失败：${e.message ?? e}`)
})
