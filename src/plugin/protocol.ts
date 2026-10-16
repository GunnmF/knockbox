import type { RefObject } from 'react'
import { pluginCall, pluginMeta } from '../ipc'

/** 插件通过 iframe 发给宿主的请求。协议见 docs/PLUGIN_SPEC.md §6.4。 */
export interface PluginRequest {
  kb: 1
  token: string
  id?: number
  method: string
  params?: Record<string, unknown>
}

/**
 * 插件页面的消息桥（宿主侧）。
 *
 * 主窗口和覆盖层窗口用的是**同一套**协议，所以只写一份：复制两份的话，
 * 两边迟早会漂移，而漂移的是安全边界 —— 令牌校验、来源校验、权限转发
 * 任何一处走样，都是"插件能冒充别人调能力"。
 *
 * 两个窗口的差别只有"收到各个 method 该做什么"，由 hooks 提供。
 */
export interface ProtocolHooks {
  /** 握手时捎带的额外字段。主窗口带 query，覆盖层带 openOverlay 的 params */
  handshakeExtras?: () => Promise<Record<string, unknown>> | Record<string, unknown>
  /** 插件要一块面板（只有主窗口有面板，覆盖层整块屏幕都是它的） */
  onSetPanel?: (title: string, height: number) => void
  /** 纯确认，宿主目前不用这个返回值 */
  onPushResult?: () => void
  /** 插件主动收尾（kb.close()） */
  onClose?: () => void
}

export interface BridgeOptions {
  frameRef: RefObject<HTMLIFrameElement | null>
  /** 每次唤起换新 token 的容器 */
  tokenRef: RefObject<string>
  /** 当前会话是哪个插件 */
  pluginId: () => string
  hooks: ProtocolHooks
}

/**
 * 挂上消息桥，返回解绑函数。
 *
 * 三道校验缺一不可：
 *   ① 来源必须是当前 iframe 的 window —— 主窗口里的其它脚本（哪怕是 XSS）
 *      不能伪装成插件调用 SDK
 *   ② kb === 1
 *   ③ 除握手外必须携带正确 token（token 是握手响应里下发的，握手本身
 *      是唯一豁免项——插件发请求时还不可能知道它）
 */
export function attachPluginBridge(opts: BridgeOptions): () => void {
  const { frameRef, tokenRef, pluginId, hooks } = opts

  // 响应必须 postMessage 到 **iframe 的 window**，不是宿主 window。
  // 发给宿主 window 的话插件页永远收不到，connect() 会一直等到超时。
  const respond = (id: number | undefined, payload: unknown, ok = true) => {
    const target = frameRef.current?.contentWindow
    if (!target) return
    target.postMessage({ kb: 1, id, ok, ...(ok ? { result: payload } : { error: payload }) }, '*')
  }

  const onMessage = async (e: MessageEvent) => {
    const frame = frameRef.current
    if (!frame?.contentWindow || e.source !== frame.contentWindow) return

    const msg = e.data as PluginRequest
    if (!msg || msg.kb !== 1) return
    if (msg.method !== 'handshake' && msg.token !== tokenRef.current) return

    if (msg.method === 'handshake') {
      try {
        const meta = await pluginMeta(pluginId())
        const extra = (await hooks.handshakeExtras?.()) ?? {}
        respond(msg.id, { ...meta, token: tokenRef.current, ...extra })
      } catch (err) {
        respond(msg.id, { code: 'INTERNAL', message: String(err) }, false)
      }
      return
    }

    if (msg.method === 'setPanel') {
      const p = msg.params as { title?: string; height?: number } | undefined
      hooks.onSetPanel?.(p?.title ?? '', Math.min(Math.max(p?.height ?? 0, 0), 360))
      respond(msg.id, null)
      return
    }

    if (msg.method === 'pushResult') {
      hooks.onPushResult?.()
      respond(msg.id, null)
      return
    }

    if (msg.method === 'close') {
      hooks.onClose?.()
      respond(msg.id, null)
      return
    }

    try {
      // 其余一律转给内核，由它做权限判定
      const result = await pluginCall(pluginId(), msg.method, msg.params)
      respond(msg.id, result)
    } catch (err) {
      const raw = err as { code?: string; message?: string }
      respond(msg.id, { code: raw.code ?? 'INTERNAL', message: raw.message ?? String(err) }, false)
    }
  }

  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}
