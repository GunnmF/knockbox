import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  execute,
  hideWindow,
  pluginCall,
  pluginEntryUrl,
  pluginMeta,
  resizeWindow,
  type ResultItem,
} from './ipc'
import { useSearch, useSelection } from './hooks'
import Settings from './components/Settings'

type View = 'launcher' | 'settings'

/**
 * 管理页的固定窗口高度（px）。
 *
 * 不跟随内容是有意的：页面内容从一条安装提示到几十个轻应用都有，跟着一高一低
 * 会晃。超出部分由 `.kb-settings-body` 自己滚动。
 * 嫌高嫌低改这一个数就行；Rust 侧还会按屏幕高度夹到 80% 以内，
 * 小屏笔记本上不会顶出屏幕。
 */
const SETTINGS_HEIGHT = 600

/** 插件通过 iframe 发给宿主的请求。协议见 docs/PLUGIN_SPEC.md §6.4。 */
interface PluginRequest {
  kb: 1
  token: string
  id?: number
  method: string
  params?: Record<string, unknown>
}

export default function App() {
  const [view, setView] = useState<View>('launcher')
  // 从管理页返回时自增，强制重新拉一次结果（钉住状态可能变了）
  const [searchToken, setSearchToken] = useState(0)
  const [query, setQuery] = useState('')
  const [activePlugin, setActivePlugin] = useState<{ id: string; url: string } | null>(null)
  const [panelHeight, setPanelHeight] = useState(0)
  const [panelTitle, setPanelTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  const { results } = useSearch(query, searchToken)
  const { index, setIndex, move } = useSelection(results.length)
  const inputRef = useRef<HTMLInputElement>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const tokenRef = useRef<string>('') // 每个插件会话一次性 token
  const submitting = useRef(false)
  const resultsRef = useRef<HTMLDivElement>(null)
  const settingsSized = useRef(0) // 管理页已经请求过的高度，0 = 还没定过

  // ————————————————————————————————————————————
  // 窗口高度
  // ————————————————————————————————————————————
  // 两种视图用两套策略：
  //
  // **启动器**跟随内容。没有结果时输入框下面不该挂一块空盒子，结果多了
  // 也不该超出屏幕。用 ResizeObserver 而不是依赖数组 —— 装插件、显示错误
  // 提示都会改变内容高度，依赖数组列不全。
  //
  // **管理页**用固定高度。它是"待着不走"的页面，跟着内容一高一低反而晃；
  // 而且用户不会停留在只有一行内容的页面上等它缩。
  useEffect(() => {
    if (view === 'settings') {
      // 已经请求过这个高度就别再发一次 —— StrictMode 会重复跑 effect，
      // 而 resizeWindow 走的是 IPC，每次都是真实往返。
      if (settingsSized.current === SETTINGS_HEIGHT) return
      const delta = SETTINGS_HEIGHT - window.innerHeight
      if (Math.abs(delta) < 1) return
      settingsSized.current = SETTINGS_HEIGHT
      void resizeWindow(delta).catch(() => {})
      return
    }
    // 回到启动器后要能重新贴合内容，下次进设置页也才不会被这个标记挡住
    settingsSized.current = 0

    // 外层容器是 flex:1，永远等于视口高度；只有内层容器的高度才是内容本身
    const box = resultsRef.current
    const content = box?.firstElementChild as HTMLElement | undefined
    if (!box || !content) return

    const fit = () => {
      const header = document.querySelector('.kb-input-row') as HTMLElement | null
      if (!header) return
      // 固定高度的部件（输入条 / 插件面板 / 错误条 / 底栏）加上内容区本身，
      // 就是窗口该有的高度。
      let chrome = header.offsetHeight
      for (const sel of ['.kb-panel', '.kb-error', '.kb-footer']) {
        chrome += (document.querySelector(sel) as HTMLElement | null)?.offsetHeight ?? 0
      }
      // 必须向上取整：offsetHeight 是四舍五入的整像素，内容实际可能是 95.4，
      // 取整成 95 之后窗口刚好差那 0.4px —— overflow-y:auto 会为此画出一条
      // 明明"没东西"的滚动条。
      const desired = chrome + Math.ceil(content.getBoundingClientRect().height)
      const delta = desired - window.innerHeight
      if (Math.abs(delta) < 1) return
      void resizeWindow(delta).catch(() => {})
    }

    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(content)
    // 插件面板展开时结果区的**内容**高度不变（它由内容决定），
    // 只观察 content 的话面板撑高窗口不会跟着变，所以面板本身也要观察。
    const panel = document.querySelector('.kb-panel')
    if (panel) ro.observe(panel)
    return () => ro.disconnect()
    // panelHeight 参与依赖：面板每展开/收起一次都要重新贴合
  }, [view, panelHeight])

  // ————————————————————————————————————————————
  // 窗口显隐：显示时聚焦并清空上一次的查询
  // ————————————————————————————————————————————
  useEffect(() => {
    const focus = () => {
      if (view === 'launcher') {
        setQuery('')
        setActivePlugin(null)
        setPanelHeight(0)
        setPanelTitle('')
        setError(null)
        // 等窗口真正拿到焦点再 focus，否则 macOS 上会被系统吞掉
        requestAnimationFrame(() => inputRef.current?.focus())
      }
    }
    const unlisten = listen('tauri://focus', focus)
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [view])

  // 托盘菜单的「设置…」：后端只负责把窗口叫出来，切视图走这个事件
  useEffect(() => {
    const unlisten = listen('kb://open-settings', () => setView('settings'))
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [])

  // 失焦自动收起，是 launcher 的标准行为 —— 但仅限启动器视图。
  useEffect(() => {
    const onBlur = () => {
      // 插件面板展开时不收起：用户要点插件里的输入框。
      // 管理页也不收起：装轻应用会弹系统文件选择框，窗口一藏，模态框
      // 和主窗口就互相卡死 —— 框是活的但主窗口收起来了，看起来像死机。
      if (view === 'launcher' && panelHeight === 0) void hideWindow()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [panelHeight, view])

  // ————————————————————————————————————————————
  // 插件唤起
  // ————————————————————————————————————————————
  const launchPlugin = useCallback(async (id: string) => {
    setError(null)
    try {
      const url = await pluginEntryUrl(id)
      await pluginMeta(id)
      // 新会话换新 token，旧的立即失效
      tokenRef.current = crypto.randomUUID()
      setActivePlugin({ id, url })
      setPanelHeight(0)
      setPanelTitle('')
    } catch (e) {
      setError(`轻应用 ${id} 加载失败：${String(e)}`)
    }
  }, [])

  const run = useCallback(
    async (item: ResultItem) => {
      if (submitting.current) return
      submitting.current = true
      try {
        if (item.kind === 'plugin') {
          await launchPlugin(item.target.v)
          return // 插件接管后窗口保持打开，不收起
        }
        await execute(item)
        await hideWindow()
      } catch (e) {
        setError(String(e))
      } finally {
        submitting.current = false
      }
    },
    [launchPlugin],
  )

  // ————————————————————————————————————————————
  // 插件消息桥
  // ————————————————————————————————————————————
  // 注意：响应必须 postMessage 到 **iframe 的 window**，不是宿主 window。
  // 发给宿主 window 的话插件页永远收不到，connect() 会一直等到超时。
  const respond = useCallback((id: number | undefined, payload: unknown, ok = true) => {
    const target = frameRef.current?.contentWindow
    if (!target) return
    target.postMessage({ kb: 1, id, ok, ...(ok ? { result: payload } : { error: payload }) }, '*')
  }, [])

  /** 宿主主动推给插件的事件（当前输入、回车）。插件页 reload 后也能靠握手重新对齐。 */
  const pushToPlugin = useCallback(
    (event: 'query' | 'submit', data: Record<string, unknown> = {}) => {
      const target = frameRef.current?.contentWindow
      if (!target) return
      target.postMessage({ kb: 1, event, ...data }, '*')
    },
    [],
  )

  const onKeyDown = useCallback(
    async (e: React.KeyboardEvent) => {
      // 面板展开时，输入类按键必须让给插件面板 —— 但回车要转交给插件，
      // 这是插件唯一的"提交"信号（ctx.onSubmit）。
      if (panelHeight > 0) {
        if (e.key === 'Enter') {
          e.preventDefault()
          pushToPlugin('submit', { query })
        }
        if (e.key !== 'Escape') return
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          move(1)
          break
        case 'ArrowUp':
          e.preventDefault()
          move(-1)
          break
        case 'Home':
          if (results.length) {
            e.preventDefault()
            setIndex(0)
          }
          break
        case 'End':
          if (results.length) {
            e.preventDefault()
            setIndex(results.length - 1)
          }
          break
        case 'Enter': {
          e.preventDefault()
          const item = results[index]
          if (item) void run(item)
          break
        }
        case 'Escape':
          e.preventDefault()
          if (activePlugin) {
            setActivePlugin(null)
            setPanelHeight(0)
            setPanelTitle('')
            inputRef.current?.focus()
          } else if (query) {
            setQuery('')
          } else {
            void hideWindow()
          }
          break
        case ',':
          // Cmd/Ctrl + , 打开设置
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault()
            setView((v) => (v === 'settings' ? 'launcher' : 'settings'))
          }
          break
      }
    },
    [activePlugin, index, move, panelHeight, pushToPlugin, query, results, run, setIndex],
  )

  // ————————————————————————————————————————————
  // 插件消息桥
  // ————————————————————————————————————————————
  useEffect(() => {
    // 输入变化 → 插件的 kb.onQueryChange 回调
    if (!activePlugin) return
    pushToPlugin('query', { query })
  }, [query, activePlugin])

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
          const meta = await pluginMeta(activePlugin!.id)
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
        setActivePlugin(null)
        setPanelHeight(0)
        void hideWindow()
        return
      }

      try {
        // 其余一律转给内核，由它做权限判定
        const result = await pluginCall(activePlugin!.id, msg.method, msg.params)
        respond(msg.id, result)
      } catch (err) {
        const raw = err as { code?: string; message?: string }
        respond(msg.id, { code: raw.code ?? 'INTERNAL', message: raw.message ?? String(err) }, false)
      }
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [activePlugin, query])

  const grouped = useMemo(() => {
    const map = new Map<string, ResultItem[]>()
    for (const r of results) {
      const list = map.get(r.kind) ?? []
      list.push(r)
      map.set(r.kind, list)
    }
    return [...map.entries()]
  }, [results])

  if (view === 'settings') {
    return (
      <Settings
        onClose={() => {
          setView('launcher')
          // 钉住/启用状态可能刚被改过，回到启动器要重新拉结果
          setSearchToken((t) => t + 1)
          requestAnimationFrame(() => inputRef.current?.focus())
        }}
      />
    )
  }

  return (
    <div className="kb-window">
      <div className="kb-input-row">
        <span className="kb-icon">⌘</span>
        <input
          ref={inputRef}
          className="kb-input"
          value={query}
          placeholder="搜索应用、文件，或输入任意内容去搜索…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoFocus
        />
        {query && (
          <button className="kb-clear" onClick={() => { setQuery(''); inputRef.current?.focus() }}>
            清空
          </button>
        )}
      </div>

      {error && <div className="kb-error">{error}</div>}

      <div className="kb-results" role="listbox" ref={resultsRef}>
        {/* 内层容器：外层是 flex:1 永远等于视口高度，只有量它的高度
            才量得出「内容到底需要多高」，窗口高度自适应全靠这一层。 */}
        <div className="kb-results-inner">
          {results.length === 0 && query.trim() && (
            <div className="kb-empty">没有匹配项，回车直接在网络上搜索</div>
          )}

          {/* 空查询的快捷列表：图标+名称的紧凑网格。
              不渲染成整行（badge+标题+副标题）——那是给搜索结果区分候选用的，
              钉住列表里的每一条用户都认识，塞满一行纯属浪费高度。 */}
          {!query.trim() && results.length > 0 ? (
            <div className="kb-quick-grid" role="listbox">
              {results.map((item) => {
                const flat = results.indexOf(item)
                return (
                  <div
                    key={item.id}
                    role="option"
                    aria-selected={flat === index}
                    className={`kb-tile${flat === index ? ' is-active' : ''}`}
                    onMouseEnter={() => setIndex(flat)}
                    onClick={() => void run(item)}
                    title={item.subtitle || item.title}
                  >
                    <ItemIcon src={item.icon} kind={item.kind} title={item.title} />
                    <span className="kb-tile-name">{item.title}</span>
                  </div>
                )
              })}
            </div>
          ) : (
            grouped.map(([kind, items]) => (
              <div key={kind} className="kb-group">
                {items.map((item) => {
                  const flat = results.indexOf(item)
                  return (
                    <div
                      key={item.id}
                      role="option"
                      aria-selected={flat === index}
                      className={`kb-item${flat === index ? ' is-active' : ''}`}
                      onMouseEnter={() => setIndex(flat)}
                      onClick={() => void run(item)}
                    >
                      <span className={`kb-badge kb-badge-${kind}`}>{kindLabel(kind)}</span>
                      <ItemIcon src={item.icon} kind={kind} title={item.title} />
                      <div className="kb-item-body">
                        <div className="kb-item-title">{item.title}</div>
                        <div className="kb-item-subtitle">{truncate(item.subtitle, 70)}</div>
                      </div>
                      {flat === index && <span className="kb-hint">↵</span>}
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>

      {activePlugin && (
        <div className="kb-panel" style={{ height: panelHeight || 200 }}>
          {panelTitle && <div className="kb-panel-title">{panelTitle}</div>}
          <iframe
            key={activePlugin.id}
            ref={frameRef}
            className="kb-panel-frame"
            // 关键安全属性：不给 allow-same-origin，插件处于独立 opaque origin，
            // 碰不到宿主 DOM / localStorage / Tauri IPC。
            // 也不给 allow-modals —— 否则插件一个 alert() 就能挡住整个启动器。
            sandbox="allow-scripts allow-forms"
            src={activePlugin.url}
            title={activePlugin.id}
          />
        </div>
      )}

      <div className="kb-footer">
        <span>↑↓ 选择</span>
        <span>↵ 打开</span>
        <span>esc 关闭</span>
        <span className="kb-footer-right" onClick={() => setView('settings')} role="button" tabIndex={0}>
          管理应用
        </span>
      </div>
    </div>
  )
}

function kindLabel(kind: string): string {
  return { app: '应用', file: '文件', web: '网页', plugin: '轻应用' }[kind] ?? kind
}

/**
 * 结果项图标。
 *
 * 图标是本机绝对路径（.icns），要靠 asset: 协议读出来。三种情况会退化到
 * 首字母徽标：没有图标路径、asset 协议没开/路径不在 scope 内（onError）、
 * 或者 WebView 不认这个格式。绝不能留一个破图占着位置。
 */
function ItemIcon({ src, kind, title }: { src?: string | null; kind: string; title: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])

  if (!src || failed) {
    return (
      <span className={`kb-item-icon kb-fallback kb-fallback-${kind}`}>
        {title.slice(0, 1).toUpperCase()}
      </span>
    )
  }
  // 轻应用的图标已经是 knockbox-plugin: 的完整 URL，直接用；
  // 应用图标是本机绝对路径，才需要 convertFileSrc 走 asset: 协议。
  const url = kind === 'plugin' ? src : convertFileSrc(src)
  return <img className="kb-item-icon" src={url} alt="" onError={() => setFailed(true)} />
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}