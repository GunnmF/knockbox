// 内置轻应用：截图。
//
// **唤起即执行**：截屏的价值就是"按一下截到"，多一次点击没有意义。
// 只回传文件路径、不回传图片内容：整屏 PNG 转 base64 有好几 MB，
// 穿 postMessage 既慢又没必要。

import { connect } from './sdk.js'

const out = document.getElementById('out')

async function main() {
  const kb = await connect()

  // 没声明权限时 SDK 直接把这些方法裁掉，这里如实反映，不假装有
  if (!kb.screen?.capture) {
    out.textContent = '未授予 screen:capture 权限'
    out.classList.remove('muted')
    return
  }

  out.textContent = '截屏中…'
  try {
    const { path } = await kb.screen.capture()
    // 直接用系统看图工具打开，用户立刻能看到截到了什么。
    // 失败就退回显示路径 —— 文件已经存下来了，别因为打不开就丢掉。
    if (kb.shell?.openPath) {
      try {
        await kb.shell.openPath(path)
        kb.close()
        return
      } catch { /* 继续走下面的兜底 */ }
    }
    out.classList.remove('muted')
    out.textContent = `已保存：${path}`
  } catch (e) {
    out.classList.remove('muted')
    out.textContent = e.message ?? String(e)
  }
}

main().catch((e) => {
  out.classList.remove('muted')
  out.textContent = `连接宿主失败：${e.message ?? e}`
})
