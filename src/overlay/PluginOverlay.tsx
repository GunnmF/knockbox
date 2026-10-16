import { useEffect, useRef, useState } from 'react'
import { overlayContext, overlayFinish, overlayReady, pluginAssetUrl, type OverlayContext } from '../ipc'
import { attachPluginBridge } from '../plugin/protocol'

/**
 * 覆盖层的「插件模式」：窗口里装的是**插件自己的页面**。
 *
 * 宿主在这里只提供一块盖满全屏的画布 —— 选区、标记、取色、快捷键全由插件实现。
 * 这是把截图从宿主里搬出去的前提（见 docs/PLUGIN_ECOSYSTEM.md §6）。
 *
 * 沙箱边界一点没松：插件仍然活在 `sandbox="allow-scripts allow-forms"` 的
 * iframe 里（没有 allow-same-origin ⇒ opaque origin，碰不到宿主 DOM 和
 * Tauri IPC），能做的每一件事都要经过 `attachPluginBridge` → `plugin_call`
 * → 内核的权限判定。它只是从「主窗口的 iframe」换到了「覆盖层窗口的 iframe」。
 */
export default function PluginOverlay() {
  const [ctx, setCtx] = useState<Extract<OverlayContext, { mode: 'plugin' }> | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  // 每个会话一次性 token，与主窗口同一套规则
  const tokenRef = useRef(crypto.randomUUID())

  // 问宿主「这次该装谁」，再去取那个文件的 URL
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const c = await overlayContext()
        if (!alive) return
        if (c.mode !== 'plugin') {
          setError('这次覆盖层不是插件模式（应由截图会话打开）')
          return
        }
        const u = await pluginAssetUrl(c.pluginId, c.entry)
        if (!alive) return
        setCtx(c)
        setUrl(u)
      } catch (e) {
        if (alive) setError(String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // iframe 挂上之后再让宿主显示窗口，否则会闪一帧空窗
  useEffect(() => {
    if (url) void overlayReady()
  }, [url])

  // 消息桥：和主窗口共用 protocol.ts 里的同一份
  useEffect(() => {
    if (!ctx) return
    return attachPluginBridge({
      frameRef,
      tokenRef,
      pluginId: () => ctx.pluginId,
      hooks: {
        // openOverlay 时插件带过来的参数，握手时一起给它，省得再问一次
        handshakeExtras: () => ({ params: ctx.params }),
        // 插件做完事（kb.close()）→ 关掉覆盖层，唤醒 await openOverlay 的那次调用
        onClose: () => {
          void overlayFinish(null).catch(() => {})
        },
      },
    })
  }, [ctx])

  if (error) {
    // 出错也要让用户看得见：覆盖层是唯一能说话的地方
    return (
      <div className="kb-overlay-error" onClick={() => void overlayFinish(null)}>
        {error}
        <div className="kb-overlay-error-hint">点任意处关闭</div>
      </div>
    )
  }

  if (!url) return <div className="kb-overlay-loading" />

  return (
    <iframe
      ref={frameRef}
      className="kb-overlay-frame"
      // 与主窗口完全一致的安全属性：不给 allow-same-origin、不给 allow-modals
      sandbox="allow-scripts allow-forms"
      src={url}
      title={ctx?.pluginId ?? 'overlay'}
    />
  )
}
