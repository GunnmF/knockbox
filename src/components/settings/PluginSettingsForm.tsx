import type { PluginSettingForm } from './usePluginManager'

/**
 * 某个轻应用的设置表单。
 *
 * 界面由 plugin.json 的 `settings` 声明自动生成（规范 §5）—— 插件作者
 * 不需要为设置界面写一行 UI，这里只按 kind 挑一个对应的控件。
 */
export function PluginSettingsForm({
  form,
  busy,
  onPatch,
  onBack,
  onSave,
}: {
  form: PluginSettingForm
  busy: boolean
  onPatch: (key: string, value: unknown) => void
  onBack: () => void
  onSave: () => void
}) {
  return (
    <section className="kb-section kb-plugin-settings">
      <div className="kb-plugin-settings-head">
        <span>{form.name} · 设置</span>
        <button onClick={onBack}>返回</button>
      </div>
      {form.defs.map((def) => {
        const value = form.values[def.key]

        return (
          <div className="kb-row" key={def.key}>
            <span className="kb-field-label">{def.label}</span>
            {def.kind === 'boolean' ? (
              <label className="kb-check">
                <input
                  type="checkbox"
                  checked={Boolean(value)}
                  onChange={(e) => onPatch(def.key, e.target.checked)}
                />
                启用
              </label>
            ) : def.kind === 'select' ? (
              <select
                className="kb-git-input"
                value={String(value ?? '')}
                onChange={(e) => onPatch(def.key, e.target.value)}
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
                onChange={(e) => onPatch(def.key, e.target.value)}
              />
            ) : (
              <input
                className="kb-git-input"
                type={def.kind === 'number' ? 'number' : 'text'}
                placeholder={def.secret ? '••••••' : ''}
                value={String(value ?? '')}
                onChange={(e) =>
                  onPatch(def.key, def.kind === 'number' ? Number(e.target.value) : e.target.value)
                }
              />
            )}
          </div>
        )
      })}
      <div className="kb-row">
        <button disabled={busy} onClick={onSave}>
          保存
        </button>
      </div>
    </section>
  )
}
