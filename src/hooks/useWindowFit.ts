import { useEffect, useRef, type RefObject } from 'react'
import { resizeWindow } from '../ipc'
import type { View } from '../types'

/**
 * 管理页的固定窗口高度（px）。
 *
 * 不跟随内容是有意的：页面内容从一条安装提示到几十个轻应用都有，跟着一高一低
 * 会晃。超出部分由 `.kb-settings-body` 自己滚动。
 * 嫌高嫌低改这一个数就行；Rust 侧还会按屏幕高度夹到 80% 以内，
 * 小屏笔记本上不会顶出屏幕。
 */
export const SETTINGS_HEIGHT = 600

/**
 * 让窗口高度贴合当前视图的内容。
 *
 * 两种视图两套策略：
 *
 * **启动器**跟随内容。没有结果时输入框下面不该挂一块空盒子，结果多了
 * 也不该超出屏幕。用 ResizeObserver 而不是依赖数组 —— 装插件、显示错误
 * 提示都会改变内容高度，依赖数组列不全。
 *
 * **管理页**用固定高度。它是"待着不走"的页面，跟着内容一高一低反而晃；
 * 而且用户不会停留在只有一行内容的页面上等它缩。
 */
export function useWindowFit(
  view: View,
  panelHeight: number,
  resultsRef: RefObject<HTMLDivElement | null>,
) {
  const settingsSized = useRef(0) // 管理页已经请求过的高度，0 = 还没定过

  // 高度自适应失败过一次就彻底查不到了：invoke 的错误被 .catch(() => {})
  // 吞掉，窗口纹丝不动，界面上看不出任何异常。这里留一句日志，
  // 至少能在控制台里看到"要多少 / 现在多少 / 差多少 / 报什么"
  const resize = (delta: number, desired: number) => {
    void resizeWindow(delta).catch((e) => {
      console.warn(
        `[knockbox] 窗口高度自适应失败：想要 ${desired}px，视口 ${window.innerHeight}px，` +
          `delta=${delta.toFixed(1)}，错误：${e}`,
      )
    })
  }

  useEffect(() => {
    if (view === 'settings') {
      // 已经请求过这个高度就别再发一次 —— StrictMode 会重复跑 effect，
      // 而 resizeWindow 走的是 IPC，每次都是真实往返。
      if (settingsSized.current === SETTINGS_HEIGHT) return
      const delta = SETTINGS_HEIGHT - window.innerHeight
      if (Math.abs(delta) < 1) return
      settingsSized.current = SETTINGS_HEIGHT
      resize(delta, SETTINGS_HEIGHT)
      return
    }
    // 回到启动器后要能重新贴合内容，下次进设置页也才不会被这个标记挡住
    settingsSized.current = 0

    // 外层容器是 flex:1，永远等于视口高度；只有内层容器的高度才是内容本身
    const box = resultsRef.current
    const content = box?.firstElementChild as HTMLElement | undefined
    if (!box || !content) return

    const fit = () => {
      const header = document.querySelector('.kb-input-row') as HTMLElement | null
      if (!header) return
      // 固定高度的部件（输入条 / 插件面板 / 错误条 / 底栏）加上内容区本身，
      // 就是窗口该有的高度。
      let chrome = header.offsetHeight
      for (const sel of ['.kb-panel', '.kb-error', '.kb-footer']) {
        chrome += (document.querySelector(sel) as HTMLElement | null)?.offsetHeight ?? 0
      }
      // 必须向上取整：offsetHeight 是四舍五入的整像素，内容实际可能是 95.4，
      // 取整成 95 之后窗口刚好差那 0.4px —— overflow-y:auto 会为此画出一条
      // 明明"没东西"的滚动条。
      const desired = chrome + Math.ceil(content.getBoundingClientRect().height)
      const delta = desired - window.innerHeight
      if (Math.abs(delta) < 1) return
      resize(delta, desired)
    }

    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(content)
    // 插件面板展开时结果区的**内容**高度不变（它由内容决定），
    // 只观察 content 的话面板撑高窗口不会跟着变，所以面板本身也要观察。
    const panel = document.querySelector('.kb-panel')
    if (panel) ro.observe(panel)
    return () => ro.disconnect()
    // panelHeight 参与依赖：面板每展开/收起一次都要重新贴合
  }, [view, panelHeight, resultsRef])
}
