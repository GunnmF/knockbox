import { HotkeyRecorder } from './HotkeyRecorder'
import { SEARCH_ENGINES } from './constants'
import type { SelfUpdate } from './useSelfUpdate'
import type { GlobalSettings } from '../../ipc'

/** 「设置」页：快捷键与搜索、外加应用自身的更新。 */
export function PrefsTab({
  settings,
  patch,
  engineCustom,
  setEngineCustom,
  updater,
}: {
  settings: GlobalSettings | null
  patch: (next: Partial<GlobalSettings>) => Promise<void>
  engineCustom: boolean
  setEngineCustom: (v: boolean) => void
  updater: SelfUpdate
}) {
  const hitsPreset = (t: string) => SEARCH_ENGINES.some((e) => e.template === t)

  return (
    <>
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
              <select
                className="kb-git-input kb-engine-select"
                disabled={!settings.webSearchEnabled}
                value={
                  engineCustom
                    ? 'custom'
                    : (SEARCH_ENGINES.find((e) => e.template === settings.webSearchTemplate)
                        ?.name ?? 'custom')
                }
                onChange={(e) => {
                  if (e.target.value === 'custom') {
                    setEngineCustom(true)
                    return
                  }
                  const hit = SEARCH_ENGINES.find((en) => en.name === e.target.value)
                  if (hit) {
                    setEngineCustom(false)
                    void patch({ webSearchTemplate: hit.template })
                  }
                }}
              >
                {SEARCH_ENGINES.map((e) => (
                  <option key={e.name} value={e.name}>
                    {e.name}
                  </option>
                ))}
                <option value="custom">自定义</option>
              </select>
              <input
                className="kb-git-input"
                placeholder="https://www.google.com/search?q={query}"
                value={settings.webSearchEnabled ? settings.webSearchTemplate : ''}
                disabled={!settings.webSearchEnabled || (!engineCustom && hitsPreset(settings.webSearchTemplate))}
                onChange={(e) => {
                  // 手敲的模板如果恰好等于某个预设，把选中态还回去
                  if (hitsPreset(e.target.value)) setEngineCustom(false)
                  void patch({ webSearchTemplate: e.target.value })
                }}
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

      <section className="kb-section">
        <h3>更新</h3>
        <div className="kb-row">
          <span className="kb-field-label">当前版本 v{updater.version || '…'}</span>
          <button disabled={updater.busy} onClick={() => void updater.check()}>
            {updater.busy ? '处理中…' : '检查更新'}
          </button>
          {updater.update && !updater.installed && (
            <button disabled={updater.busy} onClick={() => void updater.install()}>
              下载并安装 v{updater.update.version}
            </button>
          )}
          {updater.installed && (
            <button onClick={updater.relaunch}>立即重启</button>
          )}
        </div>
        {updater.progress && !updater.installed && (
          <div className="kb-row">
            <progress
              className="kb-update-progress"
              value={updater.progress.downloaded}
              max={updater.progress.total ?? 100}
            />
            <span className="kb-field-hint">
              {updater.progress.total
                ? `${Math.min(
                    100,
                    Math.round((updater.progress.downloaded / updater.progress.total) * 100),
                  )}%`
                : `${(updater.progress.downloaded / 1048576).toFixed(1)} MB`}
            </span>
          </div>
        )}
        {updater.status && <p className="kb-hint-text">{updater.status}</p>}
      </section>
    </>
  )
}
