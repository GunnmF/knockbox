import { useCallback, useEffect, type Dispatch, type SetStateAction } from 'react'
import { overlayLog } from '../ipc'
import type { Mark, Pt, Rect } from './types'

interface Options {
  textEdit: { at: Pt; value: string } | null
  setTextEdit: Dispatch<SetStateAction<{ at: Pt; value: string } | null>>
  setMarks: Dispatch<SetStateAction<Mark[]>>
  setTool: Dispatch<SetStateAction<'pen' | 'rect' | 'arrow' | 'text' | null>>
  setSel: Dispatch<SetStateAction<Rect | null>>
  img: HTMLImageElement | null
  sel: Rect | null
  color: string
  size: number
  W: number
  H: number
}

/**
 * 文字标记的编辑态：输入框内容、提交，以及两个探针。
 *
 * 两个探针都是为查「真机上文字工具点了没反应」留下的：焦点探针把开/关
 * 输入框时的焦点状态全打到宿主日志；`?probe=text` 则在无头环境里
 * 程序化地建选区、开输入框，把焦点问题复现成一条日志。
 */
export function useTextEditor({
  textEdit,
  setTextEdit,
  setMarks,
  setTool,
  setSel,
  img,
  sel,
  color,
  size,
  W,
  H,
}: Options) {
  const commit = useCallback(() => {
    if (!textEdit) return
    const t = textEdit.value.trim()
    if (t) setMarks((ms) => [...ms, { kind: 'text', color, size, at: textEdit.at, text: t }])
    setTextEdit(null)
  }, [textEdit, setMarks, setTextEdit, color, size])

  // 文字输入框的焦点探针：真机上"文字不行"的头号嫌疑就是焦点进不了窗口
  useEffect(() => {
    if (!textEdit) return
    void overlayLog('textEdit 打开')
    // autoFocus 之外再补一次：输入框是在 pointerdown 里挂载的，
    // 万一那时窗口还没成为 key 窗，focus() 会失败（探针里见过
    // is_focused=false），挂载后再抢一次更稳
    const refocus = setTimeout(() => {
      const el = document.querySelector('.ovl-text-input') as HTMLInputElement | null
      if (el && document.activeElement !== el) el.focus()
    }, 0)
    const t = setTimeout(() => {
      const el = document.activeElement
      void overlayLog(
        `textEdit 100ms 后 activeElement=${el?.tagName}.${el?.className} hasFocus=${document.hasFocus()}`,
      )
    }, 100)
    return () => {
      clearTimeout(refocus)
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textEdit?.at])

  // probe=text：免点击自测。真实点击没法在无头环境模拟，直接程序化
  // 建选区 + 开文字框，把焦点问题复现成一条日志
  useEffect(() => {
    if (!img || textEdit || sel) return
    if (new URLSearchParams(window.location.search).get('probe') !== 'text') return
    const cx = W / 2
    const cy = H / 2
    setSel({ x: W / 4, y: H / 4, w: cx, h: cy })
    setTool('text')
    setTextEdit({ at: { x: cx, y: cy }, value: '' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img])

  return commit
}
