import type { GlobalSettings } from '../../ipc'

/** 权限的中文说明，安装确认时逐条展示给用户。 */
export const PERMISSION_LABELS: Record<string, string> = {
  'clipboard:read': '读取剪贴板内容',
  'clipboard:write': '写入剪贴板',
  'shell:open-url': '用默认浏览器打开链接',
  'shell:open-path': '打开本地文件',
  'shell:open-app': '启动应用',
  notification: '发送系统通知',
  'system:selection': '读取前台窗口选中的文本',
  'web:fetch': '发起网络请求（受域名白名单限制）',
  'storage:local': '读写插件私有存储',
  'history:read': '读取最近使用记录',
  'window:resize': '调整面板高度',
  'system:lock-screen': '锁定屏幕',
  'screen:capture': '截取屏幕并保存到本机',
}

/** 与 Rust 侧 `GlobalSettings::default` 保持一致。 */
export const DEFAULT_SETTINGS: GlobalSettings = {
  hotkey: 'CommandOrControl+Shift+K',
  useHistory: true,
  historyLimit: 200,
  webSearchEnabled: true,
  webSearchTemplate: 'https://www.google.com/search?q={query}',
  fileSearchDirs: [],
  registryUrl: '',
}

/**
 * 预设搜索引擎。存储的永远只是模板串（`{query}` 占位），
 * 这个映射只负责"选引擎 → 填模板"和"模板命中 → 回显选中项"：
 * 模板和任何一项相等就显示那个引擎，不等就是「自定义」。
 */
export const SEARCH_ENGINES: { name: string; template: string }[] = [
  { name: 'Google', template: 'https://www.google.com/search?q={query}' },
  { name: '百度', template: 'https://www.baidu.com/s?wd={query}' },
  { name: 'Bing', template: 'https://www.bing.com/search?q={query}' },
  { name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q={query}' },
  { name: 'GitHub', template: 'https://github.com/search?q={query}' },
  { name: '哔哩哔哩', template: 'https://search.bilibili.com/all?keyword={query}' },
  { name: '知乎', template: 'https://www.zhihu.com/search?type=content&q={query}' },
]
