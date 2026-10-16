import { useEffect, useState } from 'react'

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
