import { useEffect, useRef, useState } from 'react'
import { search, type ResultItem } from './ipc'

/**
 * 搜索输入的防抖查询。
 *
 * 40ms 是刻意选的：低于它会让人感觉"输入和结果之间有粘滞感"，
 * 高于它在快速输入时会明显看到结果追不上键盘。
 * 内核侧已经做了打分和截断，这里的延迟纯粹是为了不重复打 IO。
 */
/**
 * @param refreshToken 变了就重新查询一次。
 * 管理页里改了钉住/启用状态后，回到启动器必须刷新 —— 钉住列表只在
 * query 变化时才会重查，不给这个出口的话会一直显示取消钉住前的旧列表。
 */
export function useSearch(query: string, refreshToken = 0) {
  const [results, setResults] = useState<ResultItem[]>([])
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    const trimmed = query.trim()
    const ticket = ++seq.current
    setLoading(true)
    // 空查询也要去问内核：钉住的轻应用就该在没敲字时摆在外面，
    // 这里提前 return 的话，内核连被问的机会都没有。
    const timer = setTimeout(async () => {
      try {
        const items = await search(trimmed)
        // 丢弃过期响应：快速输入时旧请求可能后到，不能让它覆盖新结果
        if (ticket === seq.current) setResults(items)
      } catch (e) {
        if (ticket === seq.current) setResults([])
        console.error('[knockbox] 搜索失败', e)
      } finally {
        if (ticket === seq.current) setLoading(false)
      }
    }, trimmed ? 40 : 0)

    return () => clearTimeout(timer)
  }, [query, refreshToken])

  return { results, loading }
}

/** 键盘上下键维护选中项索引。index 由外部保持，便于和回车执行共用。 */
export function useSelection(count: number) {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    setIndex((i) => (count === 0 ? 0 : Math.min(i, count - 1)))
  }, [count])

  const move = (delta: number) => {
    if (count === 0) return
    setIndex((i) => (i + delta + count) % count)
  }

  return { index, setIndex, move }
}