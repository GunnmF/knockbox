import { PERMISSION_LABELS } from './constants'
import type { PluginManager } from './usePluginManager'

/** 「应用」页：装轻应用，以及已装列表的开关/钉住/设置/卸载。 */
export function AppsTab({ mgr }: { mgr: PluginManager }) {
  const { plugins, busy } = mgr

  return (
    <>
      <section className="kb-section">
        <h3>安装轻应用</h3>
        <div className="kb-row">
          <button disabled={busy} onClick={() => void mgr.installFromDir()}>
            从本地目录
          </button>
          <button disabled={busy} onClick={() => void mgr.installFromZip()}>
            从安装包
          </button>
          <button disabled={busy} onClick={() => void mgr.rescan()}>
            重新扫描应用
          </button>
        </div>

        <div className="kb-row">
          <input
            className="kb-git-input"
            placeholder="https://github.com/you/my-plugin.git"
            value={mgr.gitUrl}
            onChange={(e) => mgr.setGitUrl(e.target.value)}
          />
          <button disabled={busy || !mgr.gitUrl.trim()} onClick={() => void mgr.installFromGit()}>
            从 Git 安装
          </button>
        </div>

        {mgr.appCount !== null && <p className="kb-hint-text">已索引 {mgr.appCount} 个应用</p>}
        {mgr.notice && (
          <p className={mgr.notice.kind === 'ok' ? 'kb-hint-text' : 'kb-error'}>{mgr.notice.text}</p>
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
              <button onClick={() => mgr.togglePinned(p)}>
                {p.pinned ? '取消钉住' : '钉住'}
              </button>
              {/* 没声明 settings 的应用不显示这个按钮 ——
                  摆一个点开只会提示"没有设置项"的按钮是纯噪音 */}
              {p.hasSettings && <button onClick={() => void mgr.openSettings(p.id)}>设置</button>}
              <button onClick={() => mgr.toggleEnabled(p)}>
                {p.enabled ? '禁用' : '启用'}
              </button>
              <button className="kb-danger" onClick={() => void mgr.uninstall(p)}>
                卸载
              </button>
            </div>
          </div>
        ))}
      </section>
    </>
  )
}
