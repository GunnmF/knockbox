import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Tauri 在 dev 下走 5173 端口的 devServer，并注入自定义协议支持
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5183,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    // 启动器界面追求极致首帧：target 降级到 es2021，产物控制在几十 KB
    target: 'es2021',
    minify: 'esbuild',
    sourcemap: false,
  },
})