/**
 * 与 Rust 内核的类型化通信层。
 *
 * 所有 `invoke` 都集中在这里，方便两件事：
 * - 类型与 Rust 侧的 serde 定义一一对应，改一处就能看到全部影响面
 * - 插件 SDK 也复用这里的 `pluginCall`，保证权限校验只有一条路径
 */
import { invoke } from '@tauri-apps/api/core'

export type Target =
  | { t: 'app'; v: string }
  | { t: 'path'; v: string }
  | { t: 'url'; v: string }
  | { t: 'plugin'; v: string }

export interface ResultItem {
  id: string
  kind: 'app' | 'file' | 'web' | 'plugin' | string
  title: string
  subtitle: string
  icon: string | null
  score: number
  target: Target
}

export interface GlobalSettings {
  hotkey: string
  useHistory: boolean
  historyLimit: number
  webSearchEnabled: boolean
  webSearchTemplate: string
  fileSearchDirs: string[]
  registryUrl: string
}

export interface InstalledPlugin {
  id: string
  name: string
  version: string
  description: string | null
  author: string | null
  keywords: string[]
  activation: 'keyword' | 'manual'
  permissions: string[]
  enabled: boolean
  /** 是否钉在启动器里。只有钉住的才会出现在搜索结果中。 */
  pinned: boolean
  /** direct 的应用唤起后静默执行，不显示界面 */
  invocation: Invocation
  /** 是否声明了 settings。没声明就不该显示「设置」按钮。 */
  hasSettings: boolean
  icon: string | null
  dir: string
}

export interface InstallResult {
  id: string
  name: string
  version: string
  permissions: string[]
  updated: boolean
}

/** 被唤起后怎么呈现：panel = 弹界面让用户操作，direct = 静默执行 */
export type Invocation = 'panel' | 'direct'

export type SettingKind = 'string' | 'number' | 'boolean' | 'select' | 'text'

/** `plugin.json` 里 settings 的声明，宿主据此自动生成设置界面 */
export interface SettingDef {
  key: string
  label: string
  kind: SettingKind
  default: unknown
  options: string[]
  secret: boolean
}

export interface PluginMeta {
  id: string
  name: string
  description: string | null
  version: string
  keywords: string[]
  activation: 'keyword' | 'manual'
  permissions: string[]
  invocation: Invocation
  settings: SettingDef[]
}

export class PluginCallError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export const search = (query: string) => invoke<ResultItem[]>('search', { query })
export const execute = (item: ResultItem) => invoke<void>('execute', { item })
export const hideWindow = () => invoke<void>('hide')
export const rescanApps = () => invoke<number>('rescan_apps')
export const getSettings = () => invoke<GlobalSettings>('get_settings')
export const saveSettings = (settings: GlobalSettings) => invoke<void>('save_settings', { settings })
export const readSelection = () => invoke<{ text: string; app: string }>('read_selection')

/**
 * 让窗口高度跟着内容走。传入「内容比当前视口多/少了多少像素」，
 * Rust 侧会夹在屏幕高度的合理区间内，返回实际生效的高度。
 */
export const resizeWindow = (delta: number) => invoke<number>('resize_window', { delta })

export const pluginList = () => invoke<InstalledPlugin[]>('plugin_list')
export const pluginInstallDir = (path: string) => invoke<InstallResult>('plugin_install_dir', { path })
export const pluginInstallZip = (path: string) => invoke<InstallResult>('plugin_install_zip', { path })
export const pluginInstallGit = (url: string) => invoke<InstallResult>('plugin_install_git', { url })
export const pluginInstallRegistry = (url: string, id: string) =>
  invoke<InstallResult>('plugin_install_registry', { url, id })
export const pluginUninstall = (id: string) => invoke<void>('plugin_uninstall', { args: { id } })
export const pluginSetEnabled = (id: string, enabled: boolean) =>
  invoke<void>('plugin_set_enabled', { args: { id, enabled } })
export const pluginSetPinned = (id: string, pinned: boolean) =>
  invoke<void>('plugin_set_pinned', { args: { id, pinned } })
export const pluginEntryUrl = (id: string) => invoke<string>('plugin_entry_url', { id })
export const pluginMeta = (id: string) => invoke<PluginMeta>('plugin_meta', { id })
export const pluginSettingValues = (id: string) => invoke<Record<string, unknown>>('plugin_setting_values', { id })
export const pluginSaveSettingValues = (id: string, values: Record<string, unknown>) =>
  invoke<void>('plugin_save_setting_values', { id, values })

// ——— 截图覆盖层（index.html?overlay=1 页面专用，宿主自有页面不过权限网关）———

export interface ScreenshotBeginInfo {
  /** 冻结帧（PNG data URL），尺寸是物理像素 */
  dataUrl: string
  /** 发起会话的插件的设置（manifest default 垫底 + 用户值） */
  settings: Record<string, unknown>
  /** 截图保存目录，仅用于界面提示 */
  saveDir: string
}

export interface ScreenshotFinishResult {
  path?: string
  bytes?: number
  copied: boolean
  dataUrl?: string
}

export const screenshotBegin = () => invoke<ScreenshotBeginInfo>('screenshot_begin')
export const screenshotFinish = (args: { saveDataUrl?: string; copyDataUrl?: string }) =>
  invoke<ScreenshotFinishResult>('screenshot_finish', args)
export const screenshotCancel = () => invoke<void>('screenshot_cancel')
export const screenshotCopyColor = (text: string) => invoke<void>('screenshot_copy_color', { text })

/**
 * 插件 SDK 的唯一出口。Rust 侧会先校验该插件的 manifest 里是否声明了
 * 对应权限，未声明会返回 PERMISSION_DENIED。
 */
export async function pluginCall<T = unknown>(
  id: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>('plugin_call', { id, method, params: params ?? {} })
  } catch (e) {
    const raw = e as { code?: string; message?: string }
    throw new PluginCallError(raw.code ?? 'INTERNAL', raw.message ?? String(e))
  }
}