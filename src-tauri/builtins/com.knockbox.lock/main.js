// 内置轻应用：锁屏。
//
// **唤起即执行**：这类应用的价值就在于"打完字回车，屏幕锁了"，
// 再要求用户点一次按钮是把一步能做完的事拆成两步。
//
// 但失败必须有反馈：锁屏失败时窗口保持打开并显示原因，
// 成功才 close —— 否则用户面对一个"什么都没发生"的窗口会以为软件卡了。

import { connect } from './sdk.js'

const out = document.getElementById('msg')

async function main() {
  const kb = await connect()

  if (!kb.system?.lockScreen) {
    out.textContent = '未授予 system:lock-screen 权限'
    out.classList.remove('muted')
    return
  }

  out.textContent = '正在锁屏…'
  try {
    await kb.system.lockScreen()
    // 锁屏后屏幕就黑了，用户看不见任何提示；
    // 这里的文字留到下次唤起（iframe 重建）时才读得到
    kb.close()
  } catch (e) {
    out.textContent = `锁屏失败：${e.message ?? e}`
    out.classList.remove('muted')
  }
}

main().catch((e) => {
  out.textContent = `连接宿主失败：${e.message ?? e}`
  out.classList.remove('muted')
})
