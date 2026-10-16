import { useEffect, useMemo, type RefObject } from 'react'
import type { ResultItem } from '../../ipc'
import { ItemIcon, kindLabel, truncate } from './ItemIcon'

interface Props {
  results: ResultItem[]
  query: string
  index: number
  setIndex: (i: number) => void
  run: (item: ResultItem) => void
  /** 落在外层滚动容器上：窗口高度自适应量的就是它（见 hooks/useWindowFit.ts）。 */
  containerRef: RefObject<HTMLDivElement | null>
}

/**
 * 搜索结果区。
 *
 * 两种形态共用一个滚动容器：空查询时是图标+名称的紧凑网格（钉住列表里的
 * 每一条用户都认识，塞满一整行纯属浪费高度）；有查询时按类型分组，
 * 每条带徽标+标题+副标题，用来区分候选。
 */
export function ResultsList({ results, query, index, setIndex, run, containerRef }: Props) {
  const trimmed = query.trim()

  const grouped = useMemo(() => {
    const map = new Map<string, ResultItem[]>()
    for (const r of results) {
      const list = map.get(r.kind) ?? []
      list.push(r)
      map.set(r.kind, list)
    }
    return [...map.entries()]
  }, [results])

  // 选中项滚入视野。
  //
  // 滚动条被藏起来之后，这就成了「下面还有没有东西」的唯一线索：窗口高度
  // 被内核卡在屏幕的 80%，结果一多列表就会超出可视区，↑↓ 走到看不见的
  // 条目上时必须把它带回来。block:'nearest' 保证已经可见时一动不动，
  // 只有真的滚出视野才动。滚轮依旧是原生行为，不用管。
  useEffect(() => {
    containerRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' })
  }, [containerRef, index, results])

  return (
    <div className="kb-results" role="listbox" ref={containerRef}>
      {/* 内层容器：外层是 flex:1 永远等于视口高度，只有量它的高度
          才量得出「内容到底需要多高」，窗口高度自适应全靠这一层。 */}
      <div className="kb-results-inner">
        {results.length === 0 && trimmed && (
          <div className="kb-empty">没有匹配项，回车直接在网络上搜索</div>
        )}

        {!trimmed && results.length > 0 ? (
          <div className="kb-quick-grid" role="listbox">
            {results.map((item) => {
              const flat = results.indexOf(item)
              return (
                <div
                  key={item.id}
                  role="option"
                  aria-selected={flat === index}
                  className={`kb-tile${flat === index ? ' is-active' : ''}`}
                  onMouseEnter={() => setIndex(flat)}
                  onClick={() => run(item)}
                  title={item.subtitle || item.title}
                >
                  <ItemIcon src={item.icon} kind={item.kind} title={item.title} />
                  <span className="kb-tile-name">{item.title}</span>
                </div>
              )
            })}
          </div>
        ) : (
          grouped.map(([kind, items]) => (
            <div key={kind} className="kb-group">
              {items.map((item) => {
                const flat = results.indexOf(item)
                return (
                  <div
                    key={item.id}
                    role="option"
                    aria-selected={flat === index}
                    className={`kb-item${flat === index ? ' is-active' : ''}`}
                    onMouseEnter={() => setIndex(flat)}
                    onClick={() => run(item)}
                  >
                    <span className={`kb-badge kb-badge-${kind}`}>{kindLabel(kind)}</span>
                    <ItemIcon src={item.icon} kind={item.kind} title={item.title} />
                    <div className="kb-item-body">
                      <div className="kb-item-title">{item.title}</div>
                      <div className="kb-item-subtitle">{truncate(item.subtitle, 70)}</div>
                    </div>
                    {flat === index && <span className="kb-hint">↵</span>}
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
