import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ScreenshotOverlay from './overlay/ScreenshotOverlay'
import './styles.css'

// 同一个入口承载两种窗口：
// - 主窗口（启动器）：index.html
// - 截图覆盖层：index.html?overlay=1 —— 由 Rust 在截图会话开始时创建，
//   全屏无边框置顶，盖在冻结帧上做选区/标记/取色（见 src-tauri/src/screenshot.rs）
const isOverlay = new URLSearchParams(window.location.search).has('overlay')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isOverlay ? <ScreenshotOverlay /> : <App />}</React.StrictMode>,
)
