/**
 * Knockbox 轻应用 SDK。
 *
 * 开发者只需 `import { connect } from '@knockbox/plugin-sdk'`，剩下的宿主会搞定。
 * 本文件既是应用内的实现，也是将来发布到 npm 的源码。
 *
 * 规范见 docs/PLUGIN_SPEC.md。
 */

export interface PluginMeta {
  id: string
  name: string
  description: string | null
  version: string
  keywords: string[]
  activation: 'keyword' | 'manual'
  permissions: string[]
  /** 本次会话的凭证，由宿主握手时下发的不可猜测随机串 */
  token: string
  /** 握手那一刻宿主输入框的内容 */
  query?: string
}

export interface PanelContext {
  /** 宿主输入框当前内容 */
  readonly query: string
  /** 订阅输入变化，返回取消订阅函数 */
  onQueryChange(cb: (q: string) => void): () => void
  /** 订阅回车 */
  onSubmit(cb: (q: string) => void): () => void
  /** 关闭插件面板，焦点回到宿主搜索框 */
  close(): void
}

export interface PanelOptions {
  title?: string
  /** 面板高度（px），上限 360。需声明 window:resize 权限 */
  height?: number
  /** 在 container 里画出你的界面 */
  render: (container: HTMLElement, ctx: PanelContext) => void
}

export interface ResultOption {
  type: 'action'
  title: string
  subtitle?: string
  icon?: string
}

export interface FetchResponse {
  status: number
  body: string
}

export class KnockboxError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** SDK 方法 → 它需要的权限。见 docs/PLUGIN_SPEC.md §4。 */
const PERMISSION_MAP = {
  'clipboard.readText': 'clipboard:read',
  'clipboard.writeText': 'clipboard:write',
  'system.getSelection': 'system:selection',
  'shell.openUrl': 'shell:open-url',
  'shell.openPath': 'shell:open-path',
  'shell.openApp': 'shell:open-app',
  fetch: 'web:fetch',
  notify: 'notification',
  'history.list': 'history:read',
  'window.resize': 'window:resize',
  'storage.get': 'storage:local',
  'storage.set': 'storage:local',
  'storage.remove': 'storage:local',
  'storage.clear': 'storage:local',
  'system.lockScreen': 'system:lock-screen',
  'screen.capture': 'screen:capture',
} as const

export interface Knockbox {
  readonly meta: PluginMeta

  /** 宿主输入框当前内容 */
  readonly query: string
  onQueryChange(cb: (q: string) => void): () => void

  /**
   * 声明若干条**静态**结果，由宿主按统一样式渲染。
   *
   * 注意：函数无法跨 postMessage 传递，因此这里的结果**不可带回调**。
   * 需要按下后做事的逻辑，请改用 `setPanel` 在自己的界面里渲染列表。
   */
  pushResult(...results: ResultOption[]): void
  /** 接管结果区，自己渲染界面 */
  setPanel(options: PanelOptions): void
  close(): void

  readonly clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<void>
  }
  readonly system: {
    getSelection(): Promise<{ text: string; app: string }>
    /**
     * 锁定屏幕。**不可撤销**，请务必给用户一个明确的确认动作，
     * 不要在唤起时直接调用。
     */
    lockScreen(): Promise<void>
  }
  readonly screen: {
    /**
     * 截取整屏。返回保存到本机的文件路径 —— 不是图片内容：
     * 一张 4K PNG 转 base64 有好几 MB，穿 postMessage 不划算。
     */
    capture(): Promise<{ path: string }>
  }
  readonly shell: {
    openUrl(url: string): Promise<void>
    openPath(path: string): Promise<void>
    openApp(name: string): Promise<void>
  }
  readonly storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    remove(key: string): Promise<void>
    clear(): Promise<void>
  }
  /** 用户在宿主设置界面填写的值 */
  readonly setting: Record<string, unknown>

  notify(title: string, body?: string): void
  fetch(url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<FetchResponse>
  history(limit?: number): Promise<Array<{ id: string; title: string; kind: string; count: number }>>
}

/**
 * 连接宿主。返回一个 Proxy，使得**未授权的方法根本不存在**（`undefined`），
 * 而不是调用时才报错 —— 这样插件作者在开发期就能发现自己忘了声明权限。
 */
export async function connect(): Promise<Knockbox> {
  const meta = await handshake()
  const granted = new Set(meta.permissions)

  const send = <T>(method: string, params?: Record<string, unknown>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++
      const onMessage = (e: MessageEvent) => {
        const msg = e.data
        if (!msg || msg.kb !== 1 || msg.id !== id) return
        window.removeEventListener('message', onMessage)
        if (msg.ok) resolve(msg.result as T)
        else reject(new KnockboxError(msg.error?.code ?? 'INTERNAL', msg.error?.message ?? '调用失败'))
      }
      window.addEventListener('message', onMessage)
      window.parent.postMessage(
        { kb: 1, token: meta.token, id, method, params: params ?? {} },
        '*',
      )
    })

  const kb: Knockbox = {
    meta,
    get query() {
      return currentQuery
    },
    onQueryChange(cb) {
      return subscribe('query', cb)
    },
    pushResult(...results) {
      void send('pushResult', { results })
    },
    setPanel(options) {
      void send('setPanel', { title: options.title, height: options.height })
      mountPanel(options.render, send)
    },
    close() {
      void send('close')
    },
    clipboard: {
      readText: () => send<string>('clipboard.readText'),
      writeText: (text: string) => send<void>('clipboard.writeText', { text }),
    },
    system: {
      getSelection: () => send('system.getSelection'),
      lockScreen: () => send<void>('system.lockScreen'),
    },
    screen: {
      capture: () => send<{ path: string }>('screen.capture'),
    },
    shell: {
      openUrl: (url: string) => send<void>('shell.openUrl', { url }),
      openPath: (path: string) => send<void>('shell.openPath', { path }),
      openApp: (name: string) => send<void>('shell.openApp', { app: name }),
    },
    storage: {
      get: (key: string) => send('storage.get', { key }),
      set: (key: string, value: unknown) => send<void>('storage.set', { key, value }),
      remove: (key: string) => send<void>('storage.remove', { key }),
      clear: () => send<void>('storage.clear'),
    },
    setting: {},
    notify(title: string, body?: string) {
      void send('notify', { title, body })
    },
    fetch: (url, init) =>
      send<FetchResponse>('fetch', {
        url,
        method: init?.method ?? 'GET',
        body: init?.body,
        headers: init?.headers,
      }),
    history: (limit = 20) => send('history.list', { limit }),
  }

  // 设置值：connect 时一次性取回
  const settings = await send<Record<string, unknown>>('settings.get').catch(() => ({}))
  Object.defineProperty(kb, 'setting', { value: settings, enumerable: true })

  return pruneByPermissions(kb, granted)
}

let nextId = 1
const subscribers = new Map<string, Set<(payload: any) => void>>()
let panelHost: HTMLElement | null = null
/** 宿主输入框的当前内容。由握手响应和后续 query 事件共同维护。 */
let currentQuery = ''

/**
 * 宿主 → 插件的单向事件通道：当前输入（query）、回车（submit）。
 *
 * 这条监听器必须挂在模块加载时就绪，早于 `connect()` —— 宿主可能在插件
 * connect 之前就已经推过一次 query 了。
 */
window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data
  if (!msg || msg.kb !== 1 || typeof msg.event !== 'string') return
  if (typeof msg.query === 'string') currentQuery = msg.query
  subscribers.get(msg.event)?.forEach((cb) => cb(msg.query ?? ''))
})

function handshake(): Promise<PluginMeta> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new KnockboxError('HOST_CLOSED', '未收到宿主响应')), 3000)
    const onMessage = (e: MessageEvent) => {
      const msg = e.data
      // 宿主不知道我们的请求 id，只能按「第一条带 meta 的响应」来认领
      if (!msg || msg.kb !== 1 || !msg.ok || !msg.result?.token) return
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      // 握手响应会捎带当前输入，省掉"等下一次 query 事件"的空窗期
      if (typeof msg.result.query === 'string') currentQuery = msg.result.query
      resolve(msg.result as PluginMeta)
    }
    window.addEventListener('message', onMessage)
    window.parent.postMessage({ kb: 1, token: '', method: 'handshake' }, '*')
  })
}

function subscribe(channel: string, cb: (payload: any) => void): () => void {
  const set = subscribers.get(channel) ?? new Set()
  set.add(cb)
  subscribers.set(channel, set)
  return () => set.delete(cb)
}

type Sender = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

function mountPanel(render: (container: HTMLElement, ctx: PanelContext) => void, send: Sender) {
  panelHost?.remove()
  panelHost = document.createElement('div')
  panelHost.className = 'kb-plugin-panel'
  panelHost.style.cssText = 'height:100%;overflow:auto;padding:10px 12px;'
  document.body.appendChild(panelHost)
  document.documentElement.style.height = '100%'

  render(panelHost, {
    get query() {
      return currentQuery
    },
    onQueryChange(cb) {
      return subscribe('query', cb)
    },
    onSubmit(cb) {
      return subscribe('submit', cb)
    },
    close() {
      void send('close')
    },
  })
}

/**
 * 按权限裁剪 API：没声明的方法直接不存在。
 * SDK 层的这道裁剪不是安全措施（真正的关卡在 Rust 侧的 dispatch），
 * 但它能让插件作者在开发期就拿到明确反馈。
 */
function pruneByPermissions(kb: Knockbox, granted: Set<string>): Knockbox {
  const target = kb as unknown as Record<string, unknown>
  for (const [method, permission] of Object.entries(PERMISSION_MAP)) {
    if (!granted.has(permission)) {
      delete target[methodGroup(method)]
    }
  }
  return kb
}

function methodGroup(method: string): string {
  const [group, action] = method.split('.')
  return action ? group : method
}

export default connect