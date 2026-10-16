import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { hideWindow } from '../ipc'
import type { View } from '../types'

/**
 * 窗口的显隐规矩：被叫出来时清场，失去焦点就自己收起。
 *
 * 两件事都必须只在启动器视图下生效 —— 管理页失焦不能藏，装轻应用会弹系统
 * 文件选择框，窗口一藏，模态框和主窗口就互相卡死（框是活的但主窗口收起
 * 来了，看起来像死机）。
 *
 * @param panelOpen 插件面板是否展开着。展开时不收起：用户要点插件里的输入框。
 * @param onShow   窗口被重新叫出来时的清场动作（清输入、清面板、清错误）。
 */
export function useWindowLifecycle(view: View, panelOpen: boolean, onShow: () => void) {
  useEffect(() => {
    const focus = () => {
      if (view === 'launcher') onShow()
    }
    const unlisten = listen('tauri://focus', focus)
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [view, onShow])

  useEffect(() => {
    const onBlur = () => {
      if (view === 'launcher' && !panelOpen) void hideWindow()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [panelOpen, view])
}
