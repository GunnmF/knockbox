// 覆盖层示例：演示 `window.openOverlay` 这条路。
//
// 它要证明的事情只有一件 —— **宿主只提供一块盖满全屏的画布**，
// 画什么、怎么交互、怎么结束，全是这个轻应用自己的事：
//
//   1. openOverlay({entry}) → 宿主开一个无边框置顶窗口，装的是本插件的 overlay.html
//   2. overlay.html 拿底图（screen.capture({mode:'freeze'})）自己画选区
//   3. 选完 closeOverlay({result}) → await openOverlay 的那次调用拿到结果
//
// 对照：截图轻应用走的是 screen.capture({mode:'region'})，选区由宿主代画。
// 两条路的差别就是"谁来画"。

import { connect } from './sdk.js'

async function main() {
  const kb = await connect()

  if (!kb.window?.openOverlay) {
    // 没授予 window:overlay：SDK 上这个方法根本不存在（不是调用时报错）
    document.getElementById('open').textContent = '未授予 window:overlay 权限'
    document.getElementById('open').disabled = true
    return
  }

  document.getElementById('open').addEventListener('click', async () => {
    document.getElementById('open').textContent = '打开中…'
    try {
      // 覆盖层里的操作结果会原样回来；用户直接按 Esc 关掉则是 null
      const result = await kb.window.openOverlay({ entry: 'overlay.html' })
      document.getElementById('open').textContent = result
        ? `选区：${result.label}（${result.width}×${result.height}）`
        : '用户取消了'
    } catch (e) {
      document.getElementById('open').textContent = `失败：${e.message ?? e}`
    }
  })
}

main().catch((e) => {
  document.getElementById('open').textContent = `加载失败：${e.message ?? e}`
})
