import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { Mark, Rect, Tool } from './types'

interface Options {
  /** 正在编辑文字时所有按键都让给输入框。 */
  textEdit: unknown
  sel: Rect | null
  /** 冻结帧尺寸，⌘A 全屏时要拿它当选区大小。 */
  W: number
  H: number
  copyKey: string
  cancel: () => void
  finish: (action: 'save' | 'copy') => void
  copyColorAtCursor: () => void
  setMarks: Dispatch<SetStateAction<Mark[]>>
  setSel: Dispatch<SetStateAction<Rect | null>>
  setTool: Dispatch<SetStateAction<Tool | null>>
}

/**
 * 截图会话的全局快捷键。
 *
 * 故意不写依赖数组：这些回调每帧都在变（finish 闭包着当前选区），列全了
 * 等于每帧解绑重绑，不如每次渲染重挂一遍 —— 反正也就一个监听器。
 */
export function useOverlayKeys({
  textEdit,
  sel,
  W,
  H,
  copyKey,
  cancel,
  finish,
  copyColorAtCursor,
  setMarks,
  setSel,
  setTool,
}: Options) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (textEdit) return // 输入框自己管自己的按键
      const mod = e.metaKey || e.ctrlKey

      if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        finish('save')
      } else if (mod && e.code === 'KeyZ') {
        e.preventDefault()
        setMarks((ms) => ms.slice(0, -1))
      } else if (mod && e.code === 'KeyA') {
        e.preventDefault()
        setSel({ x: 0, y: 0, w: W, h: H })
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && sel) {
        e.preventDefault()
        setSel(null)
        setMarks([])
        setTool(null)
      } else if (!mod && !e.altKey && e.code === `Key${copyKey}`) {
        e.preventDefault()
        void copyColorAtCursor()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })
}
