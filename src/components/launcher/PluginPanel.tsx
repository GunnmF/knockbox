import type { RefObject } from 'react'

interface Props {
  plugin: { id: string; url: string }
  title: string
  height: number
  frameRef: RefObject<HTMLIFrameElement | null>
}

/**
 * 插件面板：iframe + 标题条，高度由插件自己通过 setPanel 决定。
 *
 * 面板高度 0 不代表插件没跑 —— 直接执行的应用（锁屏/截图）就是从 0 高度
 * 起步的，iframe 仍然活着，用户只是看不到界面。所以这里是 visibility
 * 而不是 display：后者会把 iframe 整个从渲染树摘掉，插件当场死掉。
 */
export function PluginPanel({ plugin, title, height, frameRef }: Props) {
  return (
    <div className="kb-panel" style={{ height }}>
      {title && <div className="kb-panel-title">{title}</div>}
      <iframe
        key={plugin.id}
        ref={frameRef}
        className="kb-panel-frame"
        // 关键安全属性：不给 allow-same-origin，插件处于独立 opaque origin，
        // 碰不到宿主 DOM / localStorage / Tauri IPC。
        // 也不给 allow-modals —— 否则插件一个 alert() 就能挡住整个启动器。
        sandbox="allow-scripts allow-forms"
        src={plugin.url}
        title={plugin.id}
        // 直接执行的应用（锁屏/截图）面板高度为 0，iframe 仍然是活的：
        // 插件要靠它执行，只是没有界面给用户看。失败时插件调用
        // setPanel 把高度撑起来，错误信息才看得见。
        style={{ visibility: height > 0 ? 'visible' : 'hidden' }}
      />
    </div>
  )
}
