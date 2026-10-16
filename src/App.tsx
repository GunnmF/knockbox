import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { execute, hideWindow, type ResultItem } from './ipc'
import { useSearch } from './hooks/useSearch'
import { useSelection } from './hooks/useSelection'
import { usePluginBridge } from './hooks/usePluginBridge'
import { useWindowFit } from './hooks/useWindowFit'
import { useWindowLifecycle } from './hooks/useWindowLifecycle'
import { ErrorBar, Footer, InputRow } from './components/launcher/LauncherChrome'
import { PluginPanel } from './components/launcher/PluginPanel'
import { ResultsList } from './components/launcher/ResultsList'
import Settings from './components/Settings'
import type { View } from './types'

/**
 * 启动器外壳。
 *
 * 这里只留「这一屏由哪几块组成」和「按一个键该发生什么」，块内怎么做、
 * 窗口怎么贴合内容、插件怎么通信都各自在 hooks/ 和 components/launcher/ 里。
 */
export default function App() {
  const [view, setView] = useState<View>('launcher')
  // 从管理页返回时自增，强制重新拉一次结果（钉住状态可能变了）
  const [searchToken, setSearchToken] = useState(0)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)

  const { results } = useSearch(query, searchToken)
  const { index, setIndex, move } = useSelection(results.length)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const submitting = useRef(false)

  const { active, panelHeight, panelTitle, frameRef, launch, reset, submit } =
    usePluginBridge(query, setError)

  useWindowFit(view, panelHeight, resultsRef)

  // 窗口被重新叫出来：清掉上一次留下的输入、面板和错误，然后要回焦点。
  // 不等窗口真正拿到焦点就 focus 的话，macOS 上会被系统吞掉。
  const resetLauncher = useCallback(() => {
    setQuery('')
    setError(null)
    reset()
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [reset])

  useWindowLifecycle(view, panelHeight > 0, resetLauncher)

  // 托盘菜单的「设置…」：后端只负责把窗口叫出来，切视图走这个事件
  useEffect(() => {
    const unlisten = listen('kb://open-settings', () => setView('settings'))
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [])

  const run = useCallback(
    async (item: ResultItem) => {
      if (submitting.current) return
      submitting.current = true
      try {
        if (item.kind === 'plugin') {
          await launch(item.target.v)
          return // 插件接管后窗口保持打开，不收起
        }
        await execute(item)
        await hideWindow()
      } catch (e) {
        setError(String(e))
      } finally {
        submitting.current = false
      }
    },
    [launch],
  )

  const onKeyDown = useCallback(
    async (e: React.KeyboardEvent) => {
      // 面板展开时，输入类按键必须让给插件面板 —— 但回车要转交给插件，
      // 这是插件唯一的"提交"信号（ctx.onSubmit）。
      if (panelHeight > 0) {
        if (e.key === 'Enter') {
          e.preventDefault()
          submit()
        }
        if (e.key !== 'Escape') return
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          move(1)
          break
        case 'ArrowUp':
          e.preventDefault()
          move(-1)
          break
        case 'Home':
          if (results.length) {
            e.preventDefault()
            setIndex(0)
          }
          break
        case 'End':
          if (results.length) {
            e.preventDefault()
            setIndex(results.length - 1)
          }
          break
        case 'Enter': {
          e.preventDefault()
          const item = results[index]
          if (item) void run(item)
          break
        }
        case 'Escape':
          e.preventDefault()
          if (active) {
            reset()
            inputRef.current?.focus()
          } else if (query) {
            setQuery('')
          } else {
            void hideWindow()
          }
          break
        case ',':
          // Cmd/Ctrl + , 打开设置
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault()
            setView((v) => (v === 'settings' ? 'launcher' : 'settings'))
          }
          break
      }
    },
    [active, index, move, panelHeight, query, reset, results, run, setIndex, submit],
  )

  if (view === 'settings') {
    return (
      <Settings
        onClose={() => {
          setView('launcher')
          // 钉住/启用状态可能刚被改过，回到启动器要重新拉结果
          setSearchToken((t) => t + 1)
          requestAnimationFrame(() => inputRef.current?.focus())
        }}
      />
    )
  }

  return (
    <div className="kb-window">
      <InputRow
        value={query}
        onChange={setQuery}
        onKeyDown={onKeyDown}
        onClear={() => {
          setQuery('')
          inputRef.current?.focus()
        }}
        inputRef={inputRef}
      />

      {error && <ErrorBar message={error} />}

      <ResultsList
        results={results}
        query={query}
        index={index}
        setIndex={setIndex}
        run={(item) => void run(item)}
        containerRef={resultsRef}
      />

      {active && (
        <PluginPanel plugin={active} title={panelTitle} height={panelHeight} frameRef={frameRef} />
      )}

      <Footer onOpenSettings={() => setView('settings')} />
    </div>
  )
}
