import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { hideWindow, pluginEntryUrl, pluginMeta, showWindow } from '../ipc'
import { attachPluginBridge } from '../plugin/protocol'

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

  // 插件声明的全局快捷键（src-tauri/src/plugins/shortcuts.rs）。
  //
  // 宿主负责监听、这里负责分发：
  //   silent —— 静默执行，主窗口保持隐藏。插件要界面（比如截图覆盖层）自己开，
  //             就是"按下 Cmd+Shift+S 直接截图，不唤醒主程序再选择"
  //   panel  —— 唤醒主窗口并打开插件面板
  useEffect(() => {
    const unlisten = listen<{ id: string; mode: string }>('kb://hotkey-run', (e) => {
      if (e.payload.mode === 'panel') {
        void showWindow()
      }
      // silent 模式什么都不显示：launch 只挂载 iframe，插件跑完 kb.close() 即收尾
      void launch(e.payload.id)
    })
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [launch])

  useEffect(() => {
    if (!active) return
    // 消息桥本体在 plugin/protocol.ts —— 主窗口和覆盖层窗口共用同一份，
    // 这里只提供"收到各个 method 该做什么"
    return attachPluginBridge({
      frameRef,
      tokenRef,
      pluginId: () => active.id,
      hooks: {
        // 握手时捎带当前输入，插件无需等下一次 onQueryChange
        handshakeExtras: () => ({ query }),
        onSetPanel: (title, height) => {
          setPanelTitle(title)
          setPanelHeight(height)
        },
        onClose: () => {
          reset()
          void hideWindow()
        },
      },
    })
  }, [active, query, reset])

  /** 回车转交给插件 —— 面板展开时这是插件唯一的「提交」信号（ctx.onSubmit）。 */
  const submit = useCallback(() => {
    push('submit', { query })
  }, [push, query])

  return { active, panelHeight, panelTitle, frameRef, launch, reset, submit }
}
