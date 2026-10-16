import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { hideWindow, pluginCall, pluginEntryUrl, pluginMeta } from '../ipc'

/** 插件通过 iframe 发给宿主的请求。协议见 docs/PLUGIN_SPEC.md §6.4。 */
interface PluginRequest {
  kb: 1
  token: string
  id?: number
  method: string
  params?: Record<string, unknown>
}

/** 已唤起、正在跑（或正准备跑）的插件。 */
export interface ActivePlugin {
  id: string
  url: string
}

/**
 * 轻应用（插件）的完整生命周期：唤起 → 面板 → 消息桥 → 收尾。
 *
 * 把这一坨关起来是因为它同时攥着四样东西：插件身份、面板几何、iframe 引用、
 * 会话 token。外层拿到的只有一个「launch / reset / submit」的动作接口，
 * 至于回车为什么要转发、token 为什么每次会话都换，都留在这里。
 *
 * @param query   当前输入。变化时推给插件（kb.onQueryChange）。
 * @param onError 宿主级的错误提示（红条），传 null 表示清空。插件加载失败时用它。
 */
export function usePluginBridge(query: string, onError: (message: string | null) => void) {
  const [active, setActive] = useState<ActivePlugin | null>(null)
  const [panelHeight, setPanelHeight] = useState(0)
  const [panelTitle, setPanelTitle] = useState('')

  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const tokenRef = useRef<string>('') // 每个插件会话一次性 token

  // 注意：响应必须 postMessage 到 **iframe 的 window**，不是宿主 window。
  // 发给宿主 window 的话插件页永远收不到，connect() 会一直等到超时。
  const respond = useCallback((id: number | undefined, payload: unknown, ok = true) => {
    const target = frameRef.current?.contentWindow
    if (!target) return
    target.postMessage({ kb: 1, id, ok, ...(ok ? { result: payload } : { error: payload }) }, '*')
  }, [])

  /** 宿主主动推给插件的事件（当前输入、回车）。插件页 reload 后也能靠握手重新对齐。 */
  const push = useCallback((event: 'query' | 'submit', data: Record<string, unknown> = {}) => {
    const target = frameRef.current?.contentWindow
    if (!target) return
    target.postMessage({ kb: 1, event, ...data }, '*')
  }, [])

  /** 回到「没有插件」的状态：Esc、窗口重新被唤起、换个插件时都走这里。 */
  const reset = useCallback(() => {
    setActive(null)
    setPanelHeight(0)
    setPanelTitle('')
  }, [])

  const launch = useCallback(
    async (id: string) => {
      onError(null)
      try {
        const [url, meta] = await Promise.all([pluginEntryUrl(id), pluginMeta(id)])
        // 新会话换新 token，旧的立即失效
        tokenRef.current = crypto.randomUUID()
        setActive({ id, url })
        // direct 应用从 0 高度起步：静默执行，用户看不到界面。
        // 插件要反馈时自己调 setPanel 把面板撑起来。
        setPanelHeight(0)
        setPanelTitle('')
        if (meta.invocation === 'direct') {
          void hideWindow() // 静默执行，窗口也一并收起来
        }
      } catch (e) {
        onError(`轻应用 ${id} 加载失败：${String(e)}`)
      }
    },
    [onError],
  )

  // 输入变化 → 插件的 kb.onQueryChange 回调
  useEffect(() => {
    if (!active) return
    push('query', { query })
  }, [query, active, push])

  // 诊断用：KNOCKBOX_AUTOLAUNCH=<id> 启动即唤起该轻应用
  useEffect(() => {
    const unlisten = listen<string>('kb://autolaunch', (e) => void launch(e.payload))
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [launch])

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      // ① 来源必须是当前插件 iframe：主窗口里的其它脚本（哪怕是 XSS）
      //    不能伪装成插件调用 SDK。
      const frame = frameRef.current
      if (!frame?.contentWindow || e.source !== frame.contentWindow) return

      const msg = e.data as PluginRequest
      if (!msg || msg.kb !== 1) return

      // ② 握手是唯一豁免 token 的方法 —— token 本身是在握手**响应**里下发的，
      //    插件发请求时还不可能知道它。其余每一条都必须携带正确 token。
      if (msg.method !== 'handshake' && msg.token !== tokenRef.current) return

      // 握手：插件页面加载后第一件事
      if (msg.method === 'handshake') {
        try {
          const meta = await pluginMeta(active!.id)
          // 顺带把当前输入一起下发，插件无需等下一次 onQueryChange
          respond(msg.id, { ...meta, token: tokenRef.current, query })
        } catch (err) {
          respond(msg.id, { code: 'INTERNAL', message: String(err) }, false)
        }
        return
      }

      if (msg.method === 'setPanel') {
        const p = msg.params as { title?: string; height?: number } | undefined
        setPanelTitle(p?.title ?? '')
        setPanelHeight(Math.min(Math.max(p?.height ?? 0, 0), 360))
        respond(msg.id, null)
        return
      }

      if (msg.method === 'pushResult') {
        // 纯前端行为，这里无需处理，仅确认收到
        respond(msg.id, null)
        return
      }

      if (msg.method === 'close') {
        reset()
        void hideWindow()
        return
      }

      try {
        // 其余一律转给内核，由它做权限判定
        const result = await pluginCall(active!.id, msg.method, msg.params)
        respond(msg.id, result)
      } catch (err) {
        const raw = err as { code?: string; message?: string }
        respond(msg.id, { code: raw.code ?? 'INTERNAL', message: raw.message ?? String(err) }, false)
      }
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [active, query, respond, reset])

  /** 回车转交给插件 —— 面板展开时这是插件唯一的「提交」信号（ctx.onSubmit）。 */
  const submit = useCallback(() => {
    push('submit', { query })
  }, [push, query])

  return { active, panelHeight, panelTitle, frameRef, launch, reset, submit }
}
