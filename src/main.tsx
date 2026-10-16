import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ScreenshotOverlay from './overlay/ScreenshotOverlay'
import PluginOverlay from './overlay/PluginOverlay'
import './styles.css'

// 同一个入口承载三种窗口：
// - 主窗口（启动器）：index.html
// - 覆盖层（截图模式）：index.html?overlay=1 —— 由 Rust 在截图会话开始时创建，
//   全屏无边框置顶，盖在冻结帧上做选区/标记/取色（见 src-tauri/src/screenshot.rs）
// - 覆盖层（插件模式）：index.html?overlay=1&plugin=<id> —— 同一个窗口，但里面
//   装的是某个轻应用自己的页面，它要画什么、怎么交互全由它自己决定
const params = new URLSearchParams(window.location.search)
const isOverlay = params.has('overlay')
const isPluginOverlay = isOverlay && params.has('plugin')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isOverlay ? isPluginOverlay ? <PluginOverlay /> : <ScreenshotOverlay /> : <App />}
  </React.StrictMode>,
)
