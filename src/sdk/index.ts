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
  'screen.save': 'screen:capture',
  'window.openOverlay': 'window:overlay',
  'window.closeOverlay': 'window:overlay',
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
     * 截屏。
     *
     * `mode: 'region'` 弹出宿主的全屏覆盖层：拖框选区、标记、放大镜取色、
     * 快捷键复制颜色，用户完成或取消后才返回 —— 也就是说这个 Promise
     * 会挂到用户操作结束。`'full'`（默认，不传参数时）是整屏直出，不弹界面。
     *
     * 返回值：`copied` 表示是否进了剪贴板；保存了文件时才有 `path`/`bytes`；
     * 超过 8MB 的图不带 `dataUrl`。用户取消时 Promise 以「已取消截图」reject。
     */
    capture(opts?: {
      /**
       * `full` 整屏直出（默认）；`region` 用宿主那套现成的选区界面；
       * `freeze` 只给你一张全屏图、不带任何界面 —— 想自己做选区的插件
       * 用它，配合 `window.openOverlay` 开自己的覆盖层去画。
       */
      mode?: 'full' | 'region' | 'freeze'
      cursor?: boolean
      format?: 'png' | 'jpg'
    }): Promise<{ path?: string; bytes?: number; copied?: boolean; dataUrl?: string }>
    /**
     * 把画布上标记好的图落盘。只能写进宿主的截图目录，文件名由宿主生成。
     */
    save(dataUrl: string, tag?: string): Promise<{ path: string; bytes: number }>
  }
  readonly window: {
    /**
     * 开一块盖满当前屏幕的无边框置顶窗口，把**你自己的页面**装进去。
     * 需声明 `window:overlay` 权限。
     *
     * 宿主只提供画布：选区、标记、取色、快捷键全由你的页面实现
     * （拿底图用 `screen.capture({ mode: 'freeze' })`）。
     *
     * 这个 Promise 会挂到你关掉覆盖层为止：`window.closeOverlay({result})`
     * 里的 `result` 就是它的返回值；用户直接按 Esc 关掉时返回 null。
     */
    openOverlay<T = unknown>(options: {
      /** 插件目录内的相对路径，如 'overlay.html' */
      entry: string
      /** 传给你自己的参数，握手时一起拿到（见 onOverlayParams） */
      params?: unknown
    }): Promise<T | null>
    /** 关掉覆盖层并把结果交回 await openOverlay 的那次调用 */
    closeOverlay<T = unknown>(result?: T): void
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
      capture: (opts) =>
        send<{ path?: string; bytes?: number; copied?: boolean; dataUrl?: string }>('screen.capture', {
          // 默认仍是 full：老插件不传参数时行为不该变（region 会弹覆盖层）
          mode: opts?.mode ?? 'full',
          cursor: opts?.cursor ?? false,
          format: opts?.format ?? 'png',
        }),
      save: (dataUrl: string, tag?: string) =>
        send<{ path: string; bytes: number }>('screen.save', { dataUrl, tag }),
    },
    window: {
      openOverlay: <T,>(options: { entry: string; params?: unknown }) =>
        send<T | null>('window.openOverlay', { entry: options.entry, params: options.params ?? null }),
      // 不等返回值：覆盖层关掉之后这个窗口就没了，等也等不到
      closeOverlay: <T,>(result?: T) => {
        void send<void>('window.closeOverlay', { result: result ?? null }).catch(() => {})
      },
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
 *
 * 注意是**按方法**裁剪，不是按分组。一组里的方法可能属于不同权限 ——
 * `kb.system` 下 `getSelection` 要 `system:selection`、`lockScreen` 要
 * `system:lock-screen`。早前按组删除，导致只声明了后者的插件（比如锁屏）
 * 会因为前者没声明而把整个 `system` 删掉，连已授权的方法也一起没了。
 * 整组被清空之后才把组本身删掉，这样"完全没声明"时作者拿到的仍是 undefined。
 */
function pruneByPermissions(kb: Knockbox, granted: Set<string>): Knockbox {
  const target = kb as unknown as Record<string, unknown>
  for (const [method, permission] of Object.entries(PERMISSION_MAP)) {
    if (granted.has(permission)) continue
    const [group, action] = method.split('.')
    if (!action) {
      delete target[group]
      continue
    }
    const holder = target[group]
    if (!holder) continue
    // kb.history(limit) 这种是函数而不是对象，没法只删一个方法，只能整个删
    if (typeof holder === 'function') {
      delete target[group]
      continue
    }
    delete (holder as Record<string, unknown>)[action]
  }

  for (const group of ['clipboard', 'system', 'shell', 'storage', 'screen']) {
    const holder = target[group]
    if (holder && typeof holder === 'object' && Object.keys(holder as object).length === 0) {
      delete target[group]
    }
  }
  return kb
}

export default connect