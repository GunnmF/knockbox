// 内置轻应用：截图（Snipaste 式）。
//
// 插件本体只做一件事：发起截图会话。选区、标记、放大镜取色、保存、复制
// 全部在宿主的覆盖层窗口里完成（见 src-tauri/src/screenshot.rs 和
// src/overlay/ScreenshotOverlay.tsx）—— 全屏无边框置顶窗口是系统级能力，
// 沙箱里的插件页面做不到，也不该做到。
//
// 截图中：拖框选区（可移动/八向调整），悬停看颜色，按设置的快捷键复制颜色，
// Enter 保存，Esc/右键取消。这些交互都在覆盖层里，不走这里。

import { connect } from './sdk.js'

async function main() {
  const kb = await connect()
  try {
    if (!kb.screen?.capture) return // 未授予 screen:capture，静默退出
    const s = kb.setting ?? {}
    await kb.screen.capture({
      mode: s.defaultMode === '全屏' ? 'full' : 'region',
      cursor: Boolean(s.includeCursor),
      format: s.format === 'jpg' ? 'jpg' : 'png',
    })
    // 返回即完成：保存/复制都已在覆盖层里做完。需要的话这里能拿到
    // { path, bytes, copied, dataUrl? }，静默结束就好，不弹结果页。
  } catch {
    // 「已取消截图」是用户按 Esc 的正常路径；
    // 真错误（如无屏幕录制权限）宿主已经提示过，都不需要再说话。
  } finally {
    kb.close()
  }
}

main().catch(() => {})
