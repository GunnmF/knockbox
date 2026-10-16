import { useEffect, useState } from 'react'
import { getSettings, saveSettings, type GlobalSettings } from '../../ipc'
import { DEFAULT_SETTINGS } from './constants'
import type { Notice } from './usePluginManager'

/**
 * 全局偏好（快捷键、网页搜索、历史）的读写。
 *
 * 读不到也要把界面画出来（用默认值），否则「快捷键」那一栏会整个消失，
 * 用户连快捷键是哪个都看不到 —— 恰好是这个页面最该保证的事。
 */
export function useGlobalSettings(setNotice: (n: Notice | null) => void) {
  const [settings, setSettings] = useState<GlobalSettings | null>(null)
  // 用户显式选了「自定义」搜索引擎：模板不变、输入框解锁。
  // 不能纯靠"模板不匹配预设"推导 —— 那会导致选自定义时什么都不发生，
  // 下拉框直接弹回当前预设
  const [engineCustom, setEngineCustom] = useState(false)

  useEffect(() => {
    void getSettings()
      .then(setSettings)
      .catch((e) => {
        setSettings(DEFAULT_SETTINGS)
        setNotice({ kind: 'err', text: `读取设置失败：${String(e)}` })
      })
  }, [setNotice])

  /** 改一项设置并立刻落盘。快捷键会在 Rust 侧热切换，不需要重启。 */
  const patch = async (next: Partial<GlobalSettings>) => {
    if (!settings) return
    const merged = { ...settings, ...next }
    setSettings(merged) // 乐观更新，录完快捷键界面马上变
    try {
      await saveSettings(merged)
    } catch (e) {
      setSettings(settings) // 失败则回滚，否则界面显示的是一个根本没生效的值
      setNotice({ kind: 'err', text: `保存失败：${String(e)}` })
    }
  }

  return { settings, patch, engineCustom, setEngineCustom }
}
