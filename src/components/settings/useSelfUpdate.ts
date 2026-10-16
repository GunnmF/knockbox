import { useEffect, useState } from 'react'
import {
  appInfo,
  checkForUpdate,
  installUpdate,
  relaunchApp,
  type DownloadProgress,
  type Update,
} from '../../ipc'

/**
 * 应用自身的版本与自更新。
 *
 * 和插件的安装/更新刻意分开：这条链路走的是 Rust 侧的 updater，
 * 产物在 GitHub Release 上，跟轻应用那套 manifest 毫无关系。
 */
export function useSelfUpdate() {
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<Update | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [installed, setInstalled] = useState(false)

  useEffect(() => {
    void appInfo()
      .then((i) => setVersion(i.version))
      .catch(() => {})
  }, [])

  const check = async () => {
    setBusy(true)
    setStatus('')
    setUpdate(null)
    setInstalled(false)
    setProgress(null)
    try {
      const found = await checkForUpdate()
      if (!found) {
        setStatus(`已是最新版本（v${version}）`)
      } else {
        setUpdate(found)
      }
    } catch (e) {
      // 常见原因：还没发布过 release、网络不通、endpoint 没配
      setStatus(`检查失败：${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const install = async () => {
    if (!update) return
    setBusy(true)
    setStatus('下载中…')
    try {
      await installUpdate(update, setProgress)
      setInstalled(true)
      setStatus('安装完成，重启后生效')
    } catch (e) {
      setStatus(`安装失败：${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const relaunch = () => void relaunchApp().catch(() => {})

  return { version, update, busy, status, progress, installed, check, install, relaunch }
}

export type SelfUpdate = ReturnType<typeof useSelfUpdate>
