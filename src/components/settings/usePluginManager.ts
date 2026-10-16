import { useCallback, useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import {
  pluginInstallDir,
  pluginInstallGit,
  pluginInstallZip,
  pluginList,
  pluginMeta,
  pluginSaveSettingValues,
  pluginSetEnabled,
  pluginSettingValues,
  pluginSetPinned,
  pluginUninstall,
  rescanApps,
  type InstalledPlugin,
  type SettingDef,
} from '../../ipc'

/** 一次性提示条。装完了/失败了/设置保存了，都走它。 */
export interface Notice {
  kind: 'ok' | 'err'
  text: string
}

/** 正在编辑的某个轻应用的设置（null = 没打开）。 */
export interface PluginSettingForm {
  id: string
  name: string
  defs: SettingDef[]
  values: Record<string, unknown>
}

/**
 * 「应用」这一页的全部状态：已装列表、三种安装入口、开关/钉住/卸载、
 * 以及点开某个轻应用的设置界面。
 *
 * 顺带一提设置界面为什么能只写一套：它由 plugin.json 的 `settings`
 * 声明自动生成（规范 §5）—— 插件作者不需要为设置界面写一行 UI，
 * 宿主按类型渲染控件就够了。
 */
export function usePluginManager() {
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([])
  const [gitUrl, setGitUrl] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [appCount, setAppCount] = useState<number | null>(null)
  const [settingFor, setSettingFor] = useState<PluginSettingForm | null>(null)

  const refresh = useCallback(() => void pluginList().then(setPlugins), [])
  useEffect(refresh, [refresh])

  /** 装/卸这类动作的统一外壳：置忙、清提示、成败都变成一句话提示。 */
  const guard = useCallback(async (label: string, fn: () => Promise<string>) => {
    setBusy(true)
    setNotice(null)
    try {
      setNotice({ kind: 'ok', text: `${label}成功：${await fn()}` })
      refresh()
    } catch (e) {
      setNotice({ kind: 'err', text: `${label}失败：${String(e)}` })
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const installFromDir = () =>
    guard('安装', async () => {
      const picked = await open({ directory: true, multiple: false, title: '选择插件目录' })
      if (!picked) return '已取消'
      const r = await pluginInstallDir(picked)
      return `${r.name} ${r.version}（申请 ${r.permissions.length} 项权限）`
    })

  const installFromZip = () =>
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

  const installFromGit = () =>
    guard('安装', async () => {
      const r = await pluginInstallGit(gitUrl.trim())
      setGitUrl('')
      return `${r.name} ${r.version}`
    })

  const rescan = async () => {
    setAppCount(await rescanApps())
  }

  const togglePinned = (p: InstalledPlugin) =>
    void pluginSetPinned(p.id, !p.pinned).then(refresh)

  const toggleEnabled = (p: InstalledPlugin) =>
    void pluginSetEnabled(p.id, !p.enabled).then(refresh)

  const uninstall = (p: InstalledPlugin) =>
    guard('卸载', async () => {
      await pluginUninstall(p.id)
      return p.name
    })

  /**
   * 打开某个轻应用的设置界面。没声明任何 settings 的应用就直接告诉用户，
   * 不弹一个空框。
   */
  const openSettings = async (id: string) => {
    setBusy(true)
    setNotice(null)
    try {
      const [meta, values] = await Promise.all([pluginMeta(id), pluginSettingValues(id)])
      if (meta.settings.length === 0) {
        setNotice({ kind: 'err', text: `${meta.name} 没有声明任何设置项` })
        return
      }
      // 用户没填过的项用声明里的 default 兜底
      const merged: Record<string, unknown> = {}
      for (const def of meta.settings) {
        merged[def.key] = def.key in values ? values[def.key] : def.default
      }
      setSettingFor({ id, name: meta.name, defs: meta.settings, values: merged })
    } catch (e) {
      setNotice({ kind: 'err', text: `打开设置失败：${String(e)}` })
    } finally {
      setBusy(false)
    }
  }

  const saveSettings = async () => {
    if (!settingFor) return
    setBusy(true)
    try {
      await pluginSaveSettingValues(settingFor.id, settingFor.values)
      setNotice({ kind: 'ok', text: `${settingFor.name} 的设置已保存` })
      setSettingFor(null)
    } catch (e) {
      setNotice({ kind: 'err', text: `保存失败：${String(e)}` })
    } finally {
      setBusy(false)
    }
  }

  const patchValue = (key: string, value: unknown) =>
    setSettingFor((s) => (s ? { ...s, values: { ...s.values, [key]: value } } : s))

  return {
    plugins,
    gitUrl,
    setGitUrl,
    notice,
    setNotice,
    busy,
    appCount,
    settingFor,
    setSettingFor,
    refresh,
    guard,
    installFromDir,
    installFromZip,
    installFromGit,
    rescan,
    togglePinned,
    toggleEnabled,
    uninstall,
    openSettings,
    saveSettings,
    patchValue,
  }
}

export type PluginManager = ReturnType<typeof usePluginManager>
