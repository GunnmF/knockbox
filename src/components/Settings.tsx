import { useCallback, useState } from 'react'
import { AppsTab } from './settings/AppsTab'
import { PluginSettingsForm } from './settings/PluginSettingsForm'
import { PrefsTab } from './settings/PrefsTab'
import { useGlobalSettings } from './settings/useGlobalSettings'
import { usePluginManager } from './settings/usePluginManager'
import { useSelfUpdate } from './settings/useSelfUpdate'

/**
 * 管理页的壳：标题条、两个页签、以及「谁占着内容区」这一个决定。
 *
 * 具体的设置项、插件操作、更新流程都在 settings/ 下各自的文件里 ——
 * 这一层只剩组装，别再往里加字段。
 */
export default function Settings({ onClose }: { onClose: () => void }) {
  // 管理页分两个入口：「应用」管轻应用，「设置」管全局偏好。
  // 之前两者混在一页，加上底栏写的是"管理轻应用"却含设置，指向很乱。
  const [tab, setTab] = useState<'apps' | 'prefs'>('apps')

  const mgr = usePluginManager()
  const updater = useSelfUpdate()
  const prefs = useGlobalSettings(mgr.setNotice)

  // 切页签时顺手关掉正在编辑的插件设置，否则它会跨页签留着
  const go = useCallback((next: 'apps' | 'prefs') => {
    mgr.setSettingFor(null)
    setTab(next)
  }, [mgr.setSettingFor])

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
          onClick={() => go('apps')}
        >
          应用
        </button>
        <button
          className={`kb-tab${tab === 'prefs' ? ' is-active' : ''}`}
          onClick={() => go('prefs')}
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
          {mgr.settingFor ? (
            <PluginSettingsForm
              form={mgr.settingFor}
              busy={mgr.busy}
              onPatch={mgr.patchValue}
              onBack={() => mgr.setSettingFor(null)}
              onSave={() => void mgr.saveSettings()}
            />
          ) : tab === 'prefs' ? (
            <PrefsTab
              settings={prefs.settings}
              patch={prefs.patch}
              engineCustom={prefs.engineCustom}
              setEngineCustom={prefs.setEngineCustom}
              updater={updater}
            />
          ) : (
            <AppsTab mgr={mgr} />
          )}
        </div>
      </div>
    </div>
  )
}
