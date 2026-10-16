import { useEffect, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'

/** 结果分类的中文标签。内核只给英文 kind，界面上要一律说人话。 */
export function kindLabel(kind: string): string {
  return { app: '应用', file: '文件', web: '网页', plugin: '轻应用' }[kind] ?? kind
}

/**
 * 截断过长文本。
 *
 * 副标题是文件路径或网址，长度完全不受控，全放进去会把结果行撑得歪掉。
 */
export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/**
 * 结果项图标。
 *
 * 图标是本机绝对路径（.icns），要靠 asset: 协议读出来。三种情况会退化到
 * 首字母徽标：没有图标路径、asset 协议没开/路径不在 scope 内（onError）、
 * 或者 WebView 不认这个格式。绝不能留一个破图占着位置。
 */
export function ItemIcon({ src, kind, title }: { src?: string | null; kind: string; title: string }) {
  const [failed, setFailed] = useState(false)
  // 图标路径变了要重置失败状态，否则换插件后仍然显示上一个的字母徽标
  useEffect(() => setFailed(false), [src])

  if (!src || failed) {
    return (
      <span className={`kb-item-icon kb-fallback kb-fallback-${kind}`}>
        {title.slice(0, 1).toUpperCase()}
      </span>
    )
  }
  // 轻应用的图标已经是 knockbox-plugin: 的完整 URL，直接用；
  // 应用图标是本机绝对路径，才需要 convertFileSrc 走 asset: 协议。
  const url = kind === 'plugin' ? src : convertFileSrc(src)
  return <img className="kb-item-icon" src={url} alt="" onError={() => setFailed(true)} />
}
