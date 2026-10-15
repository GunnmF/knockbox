// 内置轻应用：锁屏。
//
// 声明了 `"invocation": "direct"`，宿主唤起它时不显示任何面板、窗口也一并收起，
// 一步做完。成功就关掉；**失败必须让用户看见原因** —— 静默失败会让人以为
// 软件卡了，所以这里用 setPanel 把错误顶出来，面板也就随之出现。

import { connect } from './sdk.js'

async function main() {
  const kb = await connect()

  if (!kb.system?.lockScreen) {
    kb.setPanel({ title: '锁屏 · 出错', height: 140, render: (box) => {
      box.textContent = '未授予 system:lock-screen 权限'
    } })
    return
  }

  try {
    await kb.system.lockScreen()
    kb.close() // 屏幕都黑了，没什么可展示的
  } catch (e) {
    kb.setPanel({ title: '锁屏 · 出错', height: 160, render: (box) => {
      box.textContent = `锁屏失败：${e.message ?? e}`
    } })
  }
}

main().catch((e) => {
  // 连宿主都没连上：说明桥接断了，同样要显示而不是沉默
  document.body.textContent = `连接宿主失败：${e.message ?? e}`
  document.body.style.cssText = 'padding:12px;color:rgba(255,255,255,.92);font:13px system-ui'
})
