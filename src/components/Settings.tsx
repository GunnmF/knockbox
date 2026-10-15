import { useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import {
  appInfo,
  checkForUpdate,
  getSettings,
  installUpdate,
  pluginInstallDir,
  pluginInstallGit,
  pluginInstallZip,
  pluginList,
  pluginSetEnabled,
  pluginSetPinned,
  pluginUninstall,
  pluginMeta,
  pluginSaveSettingValues,
  pluginSettingValues,
  relaunchApp,
  rescanApps,
  saveSettings,
  type DownloadProgress,
  type GlobalSettings,
  type InstalledPlugin,
  type SettingDef,
  type Update,
} from '../ipc'

/** 权限的中文说明，安装确认时逐条展示给用户。 */
const PERMISSION_LABELS: Record<string, string> = {
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
const DEFAULT_SETTINGS: GlobalSettings = {
  hotkey: 'CommandOrControl+Shift+K',
  useHistory: true,
  historyLimit: 200,
  webSearchEnabled: true,
  webSearchTemplate: 'https://www.google.com/search?q={query}',
  fileSearchDirs: [],
  registryUrl: '',
}

/** 一些不能从 `e.code` 直接截出来的键名。 */
const NAMED_KEYS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
}

/**
 * 把 KeyboardEvent 转成 Tauri 的全局快捷键描述串（`CommandOrControl+Shift+K`）。
 *
 * 优先用 `e.code` 而不是 `e.key`：`e.key` 会随 Shift 变成大写，
 * 于是「⇧K」和「K」录出来一模一样。
 */
function toAccelerator(e: React.KeyboardEvent): string | null {
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')

  const code = e.code
  let key: string | null = null
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit\d$/.test(code)) key = code.slice(5)
  else if (/^F\d{1,2}$/.test(code)) key = code
  else if (code.startsWith('Numpad') && code.length > 6) key = code.slice(6)
  else key = NAMED_KEYS[code] ?? null

  if (!key) return null

  // 没有任何修饰键的话，这个组合会直接抢走正常的打字，必须拒绝
  if (mods.length === 0) return null
  // ⌘ 和 Ctrl 同时按下是同一个意思，留一个就够
  const hasPrimary = mods.includes('Control') || mods.includes('Super')
  const normalized = hasPrimary
    ? mods.filter((m) => m === 'Control' || m === 'Super').slice(0, 1).map(() => 'CommandOrControl')
        .concat(mods.filter((m) => m !== 'Control' && m !== 'Super'))
    : mods

  return [...normalized, key].join('+')
}

/** 「CommandOrControl+Shift+K」→ 人话「⌘⇧K」。 */
function prettyAccelerator(accel: string): string {
  const mac = navigator.platform.toLowerCase().includes('mac')
  return accel
    .split('+')
    .map((p) => {
      if (p === 'CommandOrControl') return mac ? '⌘' : 'Ctrl'
      if (p === 'Control') return mac ? '⌃' : 'Ctrl'
      if (p === 'Shift') return mac ? '⇧' : 'Shift'
      if (p === 'Alt') return mac ? '⌥' : 'Alt'
      if (p === 'Super') return mac ? '⌘' : 'Win'
      if (p === 'Space') return mac ? '␣' : 'Space'
      if (p === 'Enter') return mac ? '↩' : 'Enter'
      if (p === 'Up') return mac ? '↑' : 'Up'
      if (p === 'Down') return mac ? '↓' : 'Down'
      if (p === 'Left') return mac ? '←' : 'Left'
      if (p === 'Right') return mac ? '→' : 'Right'
      return p.length === 1 ? p.toUpperCase() : p
    })
    .join(mac ? '' : '+')
}

function HotkeyRecorder({
  value,
  onChange,
}: {
  value: string
  onChange: (accel: string) => void
}) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!recording) return
    const onKeyDown = (e: KeyboardEvent) => {
      // 录制期间**所有**按键都要拦下来。
      // 特别是空格：录制按钮此刻是聚焦状态，不拦的话空格会触发它的 click，
      // 录制刚开始就被自己关掉，看起来就是"按了没反应"。
      e.preventDefault()
      e.stopPropagation()

      // Esc 是「取消录制」而不是被录成快捷键
      if (e.key === 'Escape') {
        setRecording(false)
        setError('')
        return
      }
      const accel = toAccelerator(e as unknown as React.KeyboardEvent)
      if (!accel) {
        setError('需要一个修饰键（⌘ / ⌃ / ⌥ / ⇧）加一个字母、数字、空格、F 键或方向键')
        return
      }
      setRecording(false)
      setError('')
      onChange(accel)
    }
    // 录制期间要挡住全局快捷键，否则按下新组合键的瞬间窗口会被收走
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording, onChange])

  return (
    <>
      <button
        className={recording ? 'kb-recording' : ''}
        onClick={() => {
          setError('')
          setRecording((r) => !r)
        }}
      >
        {recording ? '按下组合键…（Esc 取消）' : prettyAccelerator(value)}
      </button>
      {error && <span className="kb-field-error">{error}</span>}
      {!recording && !error && (
        <span className="kb-field-hint">
          组合键被系统占用时录不上（如 macOS 的 ⌘空格属于 Spotlight），
          先去系统设置里改掉再录
        </span>
      )}
    </>
  )
}

export default function Settings({ onClose }: { onClose: () => void }) {
  // 管理页分两个入口：「应用」管轻应用，「设置」管全局偏好。
  // 之前两者混在一页，加上底栏写的是"管理轻应用"却含设置，指向很乱。
  const [tab, setTab] = useState<'apps' | 'prefs'>('apps')
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([])
  const [gitUrl, setGitUrl] = useState('')
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [appCount, setAppCount] = useState<number | null>(null)
  const [settings, setSettings] = useState<GlobalSettings | null>(null)
  // 正在编辑某个轻应用的设置（null = 没打开）
  const [settingFor, setSettingFor] = useState<{
    id: string
    name: string
    defs: SettingDef[]
    values: Record<string, unknown>
  } | null>(null)

  // ——— 自更新 ———
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<Update | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateStatus, setUpdateStatus] = useState('')
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [installed, setInstalled] = useState(false)

  const onCheckUpdate = async () => {
    setUpdateBusy(true)
    setUpdateStatus('')
    setUpdate(null)
    setInstalled(false)
    setProgress(null)
    try {
      const found = await checkForUpdate()
      if (!found) {
        setUpdateStatus(`已是最新版本（v${version}）`)
      } else {
        setUpdate(found)
      }
    } catch (e) {
      // 常见原因：还没发布过 release、网络不通、endpoint 没配
      setUpdateStatus(`检查失败：${String(e)}`)
    } finally {
      setUpdateBusy(false)
    }
  }

  const onInstall = async () => {
    if (!update) return
    setUpdateBusy(true)
    setUpdateStatus('下载中…')
    try {
      await installUpdate(update, setProgress)
      setInstalled(true)
      setUpdateStatus('安装完成，重启后生效')
    } catch (e) {
      setUpdateStatus(`安装失败：${String(e)}`)
    } finally {
      setUpdateBusy(false)
    }
  }

  const refresh = () => void pluginList().then(setPlugins)
  useEffect(() => {
    refresh()
    // 读不到设置也要把界面画出来（用默认值），否则「快捷键」那一栏会整个消失，
    // 用户连快捷键是哪个都看不到 —— 恰好是这个页面最该保证的事。
    void getSettings()
      .then(setSettings)
      .catch((e) => {
        setSettings(DEFAULT_SETTINGS)
        setMessage({ kind: 'err', text: `读取设置失败：${String(e)}` })
      })
    void appInfo()
      .then((i) => setVersion(i.version))
      .catch(() => {})
  }, [])

  /** 改一项设置并立刻落盘。快捷键会在 Rust 侧热切换，不需要重启。 */
  const patch = async (next: Partial<GlobalSettings>) => {
    if (!settings) return
    const merged = { ...settings, ...next }
    setSettings(merged) // 乐观更新，录完快捷键界面马上变
    try {
      await saveSettings(merged)
    } catch (e) {
      setSettings(settings) // 失败则回滚，否则界面显示的是一个根本没生效的值
      setMessage({ kind: 'err', text: `保存失败：${String(e)}` })
    }
  }

  /**
   * 打开某个轻应用的设置界面。
   *
   * 界面由 plugin.json 的 `settings` 声明自动生成（规范 §5）——插件作者
   * 不需要为设置界面写一行 UI，宿主按类型渲染控件就够了。
   * 没声明任何 settings 的应用就直接告诉用户，不弹一个空框。
   */
  const openSettings = async (id: string) => {
    setBusy(true)
    setMessage(null)
    try {
      const [meta, values] = await Promise.all([pluginMeta(id), pluginSettingValues(id)])
      if (meta.settings.length === 0) {
        setMessage({ kind: 'err', text: `${meta.name} 没有声明任何设置项` })
        return
      }
      // 用户没填过的项用声明里的 default 兜底
      const merged: Record<string, unknown> = {}
      for (const def of meta.settings) {
        merged[def.key] = def.key in values ? values[def.key] : def.default
      }
      setSettingFor({ id, name: meta.name, defs: meta.settings, values: merged })
    } catch (e) {
      setMessage({ kind: 'err', text: `打开设置失败：${String(e)}` })
    } finally {
      setBusy(false)
    }
  }

  const saveSettingsFor = async () => {
    if (!settingFor) return
    setBusy(true)
    try {
      await pluginSaveSettingValues(settingFor.id, settingFor.values)
      setMessage({ kind: 'ok', text: `${settingFor.name} 的设置已保存` })
      setSettingFor(null)
    } catch (e) {
      setMessage({ kind: 'err', text: `保存失败：${String(e)}` })
    } finally {
      setBusy(false)
    }
  }

  const guard = async (label: string, fn: () => Promise<string>) => {    setBusy(true)
    setMessage(null)
    try {
      setMessage({ kind: 'ok', text: `${label}成功：${await fn()}` })
      refresh()
    } catch (e) {
      setMessage({ kind: 'err', text: `${label}失败：${String(e)}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="kb-window kb-settings">
      <div className="kb-input-row">
        <span className="kb-icon">⚙</span>
        <div className="kb-settings-title">管理应用</div>
        <button className="kb-clear" onClick={onClose}>
          返回 esc
        </button>
      </div>

      <div className="kb-tabs">
        <button
          className={`kb-tab${tab === 'apps' ? ' is-active' : ''}`}
          onClick={() => {
            setSettingFor(null)
            setTab('apps')
          }}
        >
          应用
        </button>
        <button
          className={`kb-tab${tab === 'prefs' ? ' is-active' : ''}`}
          onClick={() => {
            setSettingFor(null)
            setTab('prefs')
          }}
        >
          设置
        </button>
      </div>

      <div className="kb-settings-body">
        {/* 内层容器：外层是 flex:1 + overflow:auto，永远等于视口高度，
            只有量它的高度才量得出「设置内容到底需要多高」。 */}
        <div className="kb-settings-inner">
        {/*
          某个轻应用的设置**替换**整个内容区，而不是浮在管理应用上面一块：
          浮层既被下面的列表挤着，又不在滚动容器里，项一多就溢出窗口。
        */}
        {settingFor ? (
        <section className="kb-section kb-plugin-settings">
          <div className="kb-plugin-settings-head">
            <span>{settingFor.name} · 设置</span>
            <button onClick={() => setSettingFor(null)}>返回</button>
          </div>
          {settingFor.defs.map((def) => {
            const value = settingFor.values[def.key]
            const set = (v: unknown) =>
              setSettingFor((s) => (s ? { ...s, values: { ...s.values, [def.key]: v } } : s))

            return (
              <div className="kb-row" key={def.key}>
                <span className="kb-field-label">{def.label}</span>
                {def.kind === 'boolean' ? (
                  <label className="kb-check">
                    <input
                      type="checkbox"
                      checked={Boolean(value)}
                      onChange={(e) => set(e.target.checked)}
                    />
                    启用
                  </label>
                ) : def.kind === 'select' ? (
                  <select
                    className="kb-git-input"
                    value={String(value ?? '')}
                    onChange={(e) => set(e.target.value)}
                  >
                    {def.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : def.kind === 'text' ? (
                  <textarea
                    className="kb-git-input"
                    rows={3}
                    value={String(value ?? '')}
                    onChange={(e) => set(e.target.value)}
                  />
                ) : (
                  <input
                    className="kb-git-input"
                    type={def.kind === 'number' ? 'number' : 'text'}
                    placeholder={def.secret ? '••••••' : ''}
                    value={String(value ?? '')}
                    onChange={(e) =>
                      set(def.kind === 'number' ? Number(e.target.value) : e.target.value)
                    }
                  />
                )}
              </div>
            )
          })}
          <div className="kb-row">
            <button disabled={busy} onClick={() => void saveSettingsFor()}>
              保存
            </button>
          </div>
        </section>
        ) : (
        <>
        {tab === 'prefs' && (
        <section className="kb-section">
          <h3>快捷键与搜索</h3>
          {settings && (
            <>
              <div className="kb-row">
                <span className="kb-field-label">唤出快捷键</span>
                <HotkeyRecorder
                  value={settings.hotkey}
                  onChange={(hotkey) => void patch({ hotkey })}
                />
              </div>

              <div className="kb-row">
                <span className="kb-field-label">网页搜索</span>
                <input
                  className="kb-git-input"
                  placeholder="https://www.google.com/search?q={query}"
                  value={settings.webSearchEnabled ? settings.webSearchTemplate : ''}
                  disabled={!settings.webSearchEnabled}
                  onChange={(e) => void patch({ webSearchTemplate: e.target.value })}
                />
                <label className="kb-check">
                  <input
                    type="checkbox"
                    checked={settings.webSearchEnabled}
                    onChange={(e) => void patch({ webSearchEnabled: e.target.checked })}
                  />
                  启用
                </label>
              </div>

              <div className="kb-row">
                <span className="kb-field-label">使用历史</span>
                <label className="kb-check">
                  <input
                    type="checkbox"
                    checked={settings.useHistory}
                    onChange={(e) => void patch({ useHistory: e.target.checked })}
                  />
                  把常用的结果往前排
                </label>
              </div>
              <p className="kb-hint-text">网页搜索模板里用 {'{query}'} 代表输入内容。</p>
            </>
          )}
        </section>
        )}

        {tab === 'prefs' && (
        <section className="kb-section">
          <h3>更新</h3>
          <div className="kb-row">
            <span className="kb-field-label">当前版本 v{version || '…'}</span>
            <button disabled={updateBusy} onClick={() => void onCheckUpdate()}>
              {updateBusy ? '处理中…' : '检查更新'}
            </button>
            {update && !installed && (
              <button disabled={updateBusy} onClick={() => void onInstall()}>
                下载并安装 v{update.version}
              </button>
            )}
            {installed && (
              <button onClick={() => void relaunchApp().catch(() => {})}>立即重启</button>
            )}
          </div>
          {progress && !installed && (
            <div className="kb-row">
              <progress
                className="kb-update-progress"
                value={progress.downloaded}
                max={progress.total ?? 100}
              />
              <span className="kb-field-hint">
                {progress.total
                  ? `${Math.min(100, Math.round((progress.downloaded / progress.total) * 100))}%`
                  : `${(progress.downloaded / 1048576).toFixed(1)} MB`}
              </span>
            </div>
          )}
          {updateStatus && <p className="kb-hint-text">{updateStatus}</p>}
        </section>
        )}

        {tab === 'apps' && (
        <>
        <section className="kb-section">
          <h3>安装轻应用</h3>
          <div className="kb-row">
            <button
              disabled={busy}
              onClick={() =>
                guard('安装', async () => {
                  const picked = await open({ directory: true, multiple: false, title: '选择插件目录' })
                  if (!picked) return '已取消'
                  const r = await pluginInstallDir(picked)
                  return `${r.name} ${r.version}（申请 ${r.permissions.length} 项权限）`
                })
              }
            >
              从本地目录
            </button>
            <button
              disabled={busy}
              onClick={() =>
                guard('安装', async () => {
                  const picked = await open({
                    multiple: false,
                    title: '选择 .kbplugin 安装包',
                    filters: [{ name: 'Knockbox Plugin', extensions: ['kbplugin', 'zip'] }],
                  })
                  if (!picked) return '已取消'
                  const r = await pluginInstallZip(picked)
                  return `${r.name} ${r.version}`
                })
              }
            >
              从安装包
            </button>
            <button
              disabled={busy}
              onClick={async () => {
                setAppCount(await rescanApps())
              }}
            >
              重新扫描应用
            </button>
          </div>

          <div className="kb-row">
            <input
              className="kb-git-input"
              placeholder="https://github.com/you/my-plugin.git"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
            />
            <button
              disabled={busy || !gitUrl.trim()}
              onClick={() =>
                guard('安装', async () => {
                  const r = await pluginInstallGit(gitUrl.trim())
                  setGitUrl('')
                  return `${r.name} ${r.version}`
                }).then(refresh)
              }
            >
              从 Git 安装
            </button>
          </div>

          {appCount !== null && <p className="kb-hint-text">已索引 {appCount} 个应用</p>}
          {message && (
            <p className={message.kind === 'ok' ? 'kb-hint-text' : 'kb-error'}>{message.text}</p>
          )}
        </section>

        <section className="kb-section">
          <h3>已安装（{plugins.length}）</h3>
          {plugins.length === 0 && (
            <p className="kb-hint-text">
              还没有轻应用。从一个目录或 .kbplugin 包开始 —— 规范见 docs/PLUGIN_SPEC.md
            </p>
          )}
          {plugins.length > 0 && (
            <p className="kb-hint-text">
              钉住的轻应用才会出现在启动器搜索结果里。装完默认已钉住，用不上的可以取消。
            </p>
          )}
          {plugins.map((p) => (
            <div key={p.id} className="kb-plugin-row">
              <div className="kb-plugin-info">
                <div className="kb-plugin-name">
                  {p.name}
                  <span className="kb-plugin-version">v{p.version}</span>
                  {p.pinned && <span className="kb-tag-on">已钉住</span>}
                  {!p.enabled && <span className="kb-tag-off">已禁用</span>}
                </div>
                <div className="kb-plugin-id">{p.id}</div>
                {p.permissions.length > 0 && (
                  <div className="kb-perms">
                    {p.permissions.map((perm) => (
                      <span key={perm} className="kb-perm">
                        {PERMISSION_LABELS[perm] ?? perm}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="kb-plugin-actions">
                <button onClick={() => void pluginSetPinned(p.id, !p.pinned).then(refresh)}>
                  {p.pinned ? '取消钉住' : '钉住'}
                </button>
                {/* 没声明 settings 的应用不显示这个按钮 ——
                    摆一个点开只会提示"没有设置项"的按钮是纯噪音 */}
                {p.hasSettings && <button onClick={() => void openSettings(p.id)}>设置</button>}
                <button onClick={() => void pluginSetEnabled(p.id, !p.enabled).then(refresh)}>
                  {p.enabled ? '禁用' : '启用'}
                </button>
                <button
                  className="kb-danger"
                  onClick={() =>
                    guard('卸载', async () => {
                      await pluginUninstall(p.id)
                      return p.name
                    })
                  }
                >
                  卸载
                </button>
              </div>
            </div>
          ))}
        </section>
        </>
        )}
        </>
        )}
        </div>
      </div>

    </div>
  )
}