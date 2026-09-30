import { useCallback, useEffect, useMemo, useReducer } from 'react'
import { ChatSlot, type ChatTarget } from './cards/ChatSlot'
import { ChatWindow } from './ChatWindow'
import {
  chatKey,
  chatWindowsReducer,
  frontmost,
  readRemembered,
  remember,
  snapRect,
  type ChatWindowState,
  type Rect,
  type Snap,
  type Viewport,
} from './chatWindowState'
import { useStableRef } from '../hooks/useStableRef'
import { useFarmCard } from './cards/context'
import { agentLabel } from './agentLabels'
import { snapForKey } from './SnapMenu'

export interface ChatWindowsApi {
  windows: ChatWindowState[]
  open: (target: ChatTarget) => void
  close: (key: string) => void
  focus: (key: string) => void
  setRect: (key: string, rect: Rect) => void
  commit: (key: string) => void
  /** Snaps a window into a place on screen (and remembers it there). */
  snap: (key: string, snap: Snap) => void
}

export function useChatWindows(viewport: Viewport, saved: ChatWindowState[] = []): ChatWindowsApi {
  // Windows open last time (a refresh) come back where they were; the fit below keeps them on screen.
  const [windows, dispatch] = useReducer(chatWindowsReducer, saved)
  const viewportRef = useStableRef(viewport)
  const windowsRef = useStableRef(windows)

  // Keep windows on screen when the browser window shrinks.
  useEffect(() => {
    if (viewport.width && viewport.height) dispatch({ type: 'fit', viewport })
  }, [viewport])

  const open = useCallback(
    (target: ChatTarget) =>
      dispatch({
        type: 'open',
        target,
        viewport: viewportRef.current,
        remembered: readRemembered()[chatKey(target)],
      }),
    [viewportRef]
  )
  const close = useCallback((key: string) => dispatch({ type: 'close', key }), [])
  const focus = useCallback((key: string) => dispatch({ type: 'focus', key }), [])
  const setRect = useCallback(
    (key: string, rect: Rect) => dispatch({ type: 'rect', key, rect, viewport: viewportRef.current }),
    [viewportRef]
  )
  const snap = useCallback(
    (key: string, to: Snap) => {
      dispatch({ type: 'snap', key, snap: to, viewport: viewportRef.current })
      remember(key, snapRect(to, viewportRef.current))
    },
    [viewportRef]
  )
  const commit = useCallback(
    (key: string) => {
      const win = windowsRef.current.find((w) => w.key === key)
      if (win) remember(key, win)
    },
    [windowsRef]
  )
  return useMemo(
    () => ({ windows, open, close, focus, setRect, commit, snap }),
    [windows, open, close, focus, setRect, commit, snap]
  )
}

/**
 * All open conversations: floating windows on wide screens; on phones the
 * frontmost one fills the screen, with chips to switch between them.
 */
export function ChatWindows({ chats, narrow }: { chats: ChatWindowsApi; narrow: boolean }) {
  const env = useFarmCard()
  const { windows } = chats
  const chatsRef = useStableRef(chats)

  // Ctrl+Option (Ctrl+Alt) shortcuts snap the window you used last, wherever focus is.
  useEffect(() => {
    if (narrow) return
    const onKeyDown = (e: KeyboardEvent) => {
      const to = snapForKey(e)
      const top = to && frontmost(chatsRef.current.windows)
      if (!to || !top) return
      e.preventDefault()
      chatsRef.current.snap(top.key, to)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [narrow, chatsRef])
  if (!windows.length) return null

  const label = (target: ChatTarget) => {
    if (target.kind === 'agent') {
      const agent = env.agentsById.get(target.agentId)
      return agent ? agentLabel(agent).primary : 'Robot'
    }
    if (target.kind === 'consultant') return `New consultant · ${env.squadsById.get(target.squadId)?.name ?? ''}`
    if (target.kind === 'fieldLog') return `Field log · ${env.squadsById.get(target.squadId)?.name ?? ''}`
    return 'Assistant'
  }

  if (narrow) {
    const top = frontmost(windows)!
    return (
      <>
        {windows.length > 1 && (
          <nav className="g-chat-tabs" aria-label="Open chats">
            {windows.map((w) => (
              <button
                key={w.key}
                type="button"
                className="g-chat-tab"
                aria-current={w.key === top.key}
                onClick={() => chats.focus(w.key)}
              >
                {label(w.target)}
              </button>
            ))}
          </nav>
        )}
        <ChatSlot key={top.key} target={top.target} onClose={() => chats.close(top.key)} />
      </>
    )
  }

  return (
    <>
      {windows.map((w) => (
        <ChatWindow
          key={w.key}
          win={w}
          onFocus={() => chats.focus(w.key)}
          onRect={(rect) => chats.setRect(w.key, rect)}
          onCommit={() => chats.commit(w.key)}
          onSnap={(to) => chats.snap(w.key, to)}
        >
          <ChatSlot target={w.target} onClose={() => chats.close(w.key)} />
        </ChatWindow>
      ))}
    </>
  )
}
