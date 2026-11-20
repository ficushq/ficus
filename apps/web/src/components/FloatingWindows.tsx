/* eslint-disable react-refresh/only-export-components -- the provider colocates its scope helper */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import type { AuthIdentity } from '@ficus/client-core'
import { queries } from '../queryOptions'
import { usePermissions } from '../hooks/usePermissions'
import { useIsDesktop } from '../hooks/useIsDesktop'
import { useStableRef } from '../hooks/useStableRef'
import { currentViewport } from '../hooks/useAssistantPosition'
import { useAdjustOnChange } from '../hooks/useAdjustOnChange'
import {
  EMPTY_CHAT_WINDOWS,
  chatWindowsReducer,
  frontmostWindow,
  readChatWindows,
  saveChatWindows,
  stackOrder,
  type ChatWindowsAction,
  type ChatWindowsState,
} from '../lib/chatWindows'
import { agentChatTargetOf, isFloatingWindowClick } from '../lib/agentChatLinks'
import { getAgentPrimaryLabel } from '../lib/agentDisplay'
import { AgentActivityDot } from './AgentActivityDot'
import { AgentChatWindow } from './AgentChatWindow'
import { CloseIcon } from './icons'
import { FloatingWindowsContext, useFloatingWindows, type FloatingWindowsApi } from './floatingWindowsContext'

/** Floating windows sit between the page (and its popups, up to 50) and modals (60). */
const WINDOW_Z_BASE = 51
const WINDOW_Z_TOP = 58
/** The minimized-window tray stays above every window. */
const TRAY_Z = 59

const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Stored windows belong to one identity, so accounts sharing a browser never see each other's. */
export function chatWindowsScope(identity: AuthIdentity | undefined): string | null {
  if (!identity) return null
  switch (identity.type) {
    case 'user':
      return `user:${identity.userId}`
    case 'agent':
      return `agent:${identity.agentId}`
    case 'system':
      return `system:${identity.systemTokenId}`
    case 'legacy':
      return 'legacy'
  }
}

interface FloatingWindowsProviderProps {
  children: ReactNode
  dependencies?: { WindowComponent?: typeof AgentChatWindow }
}

/**
 * Agent chats popped out of the page into floating windows, any number at once, one per agent. They
 * share a stack with the assistant, survive refreshes (per signed-in identity) until closed, and are
 * drawn only on wide screens. Shift+click or Alt/Option+click on anything that opens an agent chat
 * opens it here instead of navigating.
 */
export function FloatingWindowsProvider({ children, dependencies }: FloatingWindowsProviderProps) {
  const WindowComponent = dependencies?.WindowComponent ?? AgentChatWindow
  const client = useQueryClient()
  const { identity } = usePermissions()
  const scope = chatWindowsScope(identity)
  const wide = useIsDesktop()
  const [loaded, setLoaded] = useState<{ scope: string | null; state: ChatWindowsState }>({
    scope: null,
    state: EMPTY_CHAT_WINDOWS,
  })
  // A new identity reads its own windows, kept on this screen, while rendering.
  useAdjustOnChange(
    [scope],
    () => {
      setLoaded({
        scope,
        state: scope
          ? chatWindowsReducer(readChatWindows(scope), { type: 'fit', viewport: currentViewport() })
          : EMPTY_CHAT_WINDOWS,
      })
    },
    { onMount: true }
  )
  const state = loaded.scope === scope ? loaded.state : EMPTY_CHAT_WINDOWS
  const [unread, setUnread] = useState<ReadonlySet<string>>(() => new Set())
  const [assistantShown, setAssistantShown] = useState(false)
  const available = wide && !!scope

  useEffect(() => {
    if (loaded.scope) saveChatWindows(loaded.scope, loaded.state)
  }, [loaded])

  const dispatch = useCallback((action: ChatWindowsAction) => {
    setLoaded((current) => (current.scope ? { ...current, state: chatWindowsReducer(current.state, action) } : current))
    const seen =
      action.type === 'open' || action.type === 'restore'
        ? action.agentId
        : action.type === 'focus'
          ? action.key
          : undefined
    const gone = action.type === 'close' || action.type === 'discard' ? action.agentId : undefined
    if (seen || gone || action.type === 'closeAll')
      setUnread((current) => {
        if (action.type === 'closeAll') return current.size ? new Set() : current
        const key = (seen ?? gone)!
        if (!current.has(key)) return current
        const next = new Set(current)
        next.delete(key)
        return next
      })
  }, [])

  const stateRef = useStableRef(state)
  const availableRef = useStableRef(available)
  const open = useCallback(
    (agentIdOrPrefix: string) => {
      if (!availableRef.current) return
      if (FULL_ID.test(agentIdOrPrefix)) {
        dispatch({ type: 'open', agentId: agentIdOrPrefix.toLowerCase(), viewport: currentViewport() })
        return
      }
      // A `ficus:agent:` reference may name a unique prefix: resolve it to the agent first.
      void client
        .fetchQuery({ ...queries.agents.detail(agentIdOrPrefix), staleTime: 30_000 })
        .then((agent) => dispatch({ type: 'open', agentId: agent.id, viewport: currentViewport() }))
        .catch(() => {})
    },
    [availableRef, client, dispatch]
  )
  const focusIfFloating = useCallback(
    (agentId: string) => {
      if (!availableRef.current || !stateRef.current.windows.some((w) => w.agentId === agentId)) return false
      dispatch({ type: 'restore', agentId })
      return true
    },
    [availableRef, dispatch, stateRef]
  )

  // Shift+click or Alt/Option+click on an agent chat link or control: a floating window, not navigation.
  // Captured on the document, before React's handlers and the browser's own Shift (new window) and
  // Option (download) behaviors run.
  useEffect(() => {
    if (!available) return
    const target = (event: MouseEvent) =>
      isFloatingWindowClick(event) ? agentChatTargetOf(event.target, window.location.origin) : null
    const onClick = (event: MouseEvent) => {
      const agentId = target(event)
      if (!agentId) return
      event.preventDefault()
      event.stopPropagation()
      open(agentId)
    }
    // Shift+press would otherwise extend the text selection to the link.
    const onMouseDown = (event: MouseEvent) => {
      if (target(event)) event.preventDefault()
    }
    document.addEventListener('click', onClick, true)
    document.addEventListener('mousedown', onMouseDown, true)
    return () => {
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('mousedown', onMouseDown, true)
    }
  }, [available, open])

  const order = useMemo(() => stackOrder(state), [state])
  const front = frontmostWindow(state, assistantShown)
  const api = useMemo<FloatingWindowsApi>(
    () => ({
      available,
      windows: state.windows,
      unread,
      open,
      focusIfFloating,
      isFloating: (agentId) => available && state.windows.some((w) => w.agentId === agentId),
      bringToFront: (key) => {
        if (front !== key) dispatch({ type: 'focus', key })
      },
      rankOf: (key) => order.get(key) ?? -1,
      zIndexFor: (key) => Math.min(WINDOW_Z_TOP, WINDOW_Z_BASE + (order.get(key) ?? 0)),
      isFront: (key) => front === key,
      setAssistantShown,
      dispatch,
      markUnread: (agentId) => setUnread((current) => (current.has(agentId) ? current : new Set(current).add(agentId))),
    }),
    [available, state.windows, unread, open, focusIfFloating, front, dispatch, order]
  )

  return (
    <FloatingWindowsContext value={api}>
      {children}
      {available && (
        <>
          {state.windows.map((win) => (
            <WindowComponent key={win.agentId} win={win} />
          ))}
          <MinimizedTray />
        </>
      )}
    </FloatingWindowsContext>
  )
}

/** Minimized windows as chips along the bottom of the screen; a chip restores and focuses its window. */
function MinimizedTray() {
  const windows = useFloatingWindows()
  const minimized = windows?.windows.filter((w) => w.minimized) ?? []
  if (!windows || !minimized.length) return null
  return (
    <nav
      aria-label="Minimized chat windows"
      className="pointer-events-none fixed inset-x-3 bottom-3 flex justify-center"
      style={{ zIndex: TRAY_Z }}
    >
      <div className="ficus-overlay pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-th-border bg-surface p-1 shadow-theme-lg">
        {minimized.map((win) => (
          <TrayChip
            key={win.agentId}
            agentId={win.agentId}
            unread={windows.unread.has(win.agentId)}
            onRestore={() => windows.dispatch({ type: 'restore', agentId: win.agentId })}
          />
        ))}
        <button
          type="button"
          className="ficus-button ficus-button-ghost flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted"
          title="Close every floating chat window"
          onClick={() => windows.dispatch({ type: 'closeAll' })}
        >
          <CloseIcon className="h-3.5 w-3.5" />
          Close all
        </button>
      </div>
    </nav>
  )
}

function TrayChip({ agentId, unread, onRestore }: { agentId: string; unread: boolean; onRestore: () => void }) {
  const { data: agent } = useQuery(queries.agents.detail(agentId))
  const label = agent ? (agent.agentTypeId === 'manager' ? 'Manager' : getAgentPrimaryLabel(agent)) : 'Agent chat'
  return (
    <button
      type="button"
      className={clsx(
        'ficus-button ficus-button-secondary flex min-w-0 max-w-56 shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs'
      )}
      title={`Restore ${label}`}
      aria-label={`Restore ${label}${unread ? ' (unread activity)' : ''}`}
      onClick={onRestore}
    >
      {agent && <AgentActivityDot status={agent.status} />}
      <span className="min-w-0 truncate font-medium">{label}</span>
      {unread && <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-badge" />}
    </button>
  )
}
