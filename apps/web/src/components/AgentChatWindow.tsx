import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { isHttpResponseError } from '@ficus/client-core'
import { queries } from '../queryOptions'
import { useSquadSlugs } from '../hooks/useSquadSlugs'
import { useStableRef } from '../hooks/useStableRef'
import { useFloatingWindowGesture } from '../hooks/useFloatingWindowGesture'
import { currentViewport } from '../hooks/useAssistantPosition'
import { CHAT_WINDOW_MIN, windowRect, type AgentWindow } from '../lib/chatWindows'
import { registerFloatingWindow } from '../lib/floatingWindowRegistry'
import { getAgentPrimaryLabel } from '../lib/agentDisplay'
import type { AgentChatController } from './AgentChat'
import { AgentActivityDot } from './AgentActivityDot'
import { AgentConversation } from './AgentConversationBody'
import { WindowSnapMenu } from './AssistantSnapMenu'
import { ChatFullscreenContext } from './ChatFullscreenContext'
import { FloatingWindowFrame } from './FloatingWindowFrame'
import { FloatingWindowAgentContext, useFloatingWindows } from './floatingWindowsContext'
import { agentFullPagePath } from './FloatingChatButton'
import { CloseIcon, ExpandIcon, MinusIcon } from './icons'

interface AgentChatWindowDependencies {
  ConversationComponent?: typeof AgentConversation
}

/** Keeps windows on this screen as the browser window or an on-screen keyboard resizes it. */
function useViewport() {
  const [viewport, setViewport] = useState(currentViewport)
  useEffect(() => {
    const update = () =>
      setViewport((current) => {
        const next = currentViewport()
        return next.left === current.left &&
          next.top === current.top &&
          next.width === current.width &&
          next.height === current.height
          ? current
          : next
      })
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      window.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [])
  return viewport
}

const KEY_STEPS: Record<string, [number, number]> = {
  ArrowLeft: [-16, 0],
  ArrowRight: [16, 0],
  ArrowUp: [0, -16],
  ArrowDown: [0, 16],
}

function humanize(id: string) {
  return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

/** What a conversation's latest arrival is, to notice new activity (the user's own sends excluded). */
function latestActivity(conversation: AgentChatController): string | undefined {
  for (let index = conversation.items.length - 1; index >= 0; index--) {
    const item = conversation.items[index]!
    if (item.kind === 'streaming') return `streaming:${item.id}`
    if (item.kind === 'persisted' && item.message.role !== 'human') return `persisted:${item.id}`
  }
  return undefined
}

/**
 * One agent's chat in a floating window: dragged by its title bar (snapping at screen edges or on the
 * zone picker), resized from every edge, brought to the front by any press inside it. Its title bar
 * names the agent, its type and squad, shows live activity and unread state, and offers layout, open
 * full page, minimize and close. It never closes on Escape.
 */
export function AgentChatWindow({
  win,
  dependencies,
}: {
  win: AgentWindow
  dependencies?: AgentChatWindowDependencies
}) {
  const Conversation = dependencies?.ConversationComponent ?? AgentConversation
  const windows = useFloatingWindows()!
  const { dispatch } = windows
  const { agentId } = win
  const navigate = useNavigate()
  const ref = useRef<HTMLDivElement>(null)
  const viewport = useViewport()
  const winRef = useStableRef(win)
  const windowsRef = useStableRef(windows)
  const { slugFor } = useSquadSlugs()

  const agent = useQuery({ ...queries.agents.detail(agentId), retry: (count, error) => !isGone(error) && count < 2 })
  const types = useQuery(queries.agentTypes.list())
  const squads = useQuery(queries.squads.list())
  // An agent that no longer exists, or that this account cannot see, closes its window quietly.
  const gone = agent.isError && isGone(agent.error)
  useEffect(() => {
    if (gone) dispatch({ type: 'discard', agentId })
  }, [gone, agentId, dispatch])

  const front = windows.isFront(agentId)
  const gesture = useFloatingWindowGesture({
    currentRect: () => windowRect(winRef.current, currentViewport()),
    min: CHAT_WINDOW_MIN,
    snapOnDrag: true,
    restoreSize: () => (winRef.current.snap ? winRef.current.rect : undefined),
    onTitleDoubleClick: () => dispatch({ type: 'toggleFull', agentId }),
    onCommit: ({ rect, snap }) =>
      dispatch(
        snap ? { type: 'snap', agentId, snap, rect } : { type: 'rect', agentId, rect, viewport: currentViewport() }
      ),
  })

  // Ctrl+Option shortcuts reach this window when it holds focus or is frontmost.
  useEffect(
    () =>
      registerFloatingWindow(agentId, {
        element: () => ref.current,
        z: () => windowsRef.current.rankOf(agentId),
        visible: () => !winRef.current.minimized,
        snap: (snap) => dispatch({ type: 'snap', agentId, snap }),
        center: () => dispatch({ type: 'center', agentId, viewport: currentViewport() }),
      }),
    [agentId, dispatch, winRef, windowsRef]
  )

  // New activity while another window is in front (or this one is minimized) marks it unread.
  const seen = useRef<string | undefined>(undefined)
  const frontRef = useStableRef(front && !win.minimized)
  const markUnread = windows.markUnread
  const onConversation = useCallback(
    (conversation: AgentChatController) => {
      if (conversation.isLoading) return
      const latest = latestActivity(conversation)
      const previous = seen.current
      seen.current = latest
      if (previous !== undefined && latest !== previous && !frontRef.current) markUnread(agentId)
      else if (previous === undefined && latest === undefined) seen.current = ''
    },
    [agentId, frontRef, markUnread]
  )

  const rect = gesture.live ?? windowRect(win, viewport)
  const style: CSSProperties = {
    left: viewport.left + rect.x,
    top: viewport.top + rect.y,
    width: rect.w,
    height: rect.h,
  }

  const data = agent.data
  const label = data ? (data.agentTypeId === 'manager' ? 'Manager' : getAgentPrimaryLabel(data)) : 'Agent chat'
  const typeName = data
    ? (types.data?.find((type) => type.id === data.agentTypeId)?.name ?? humanize(data.agentTypeId))
    : undefined
  const squadName = data?.squadId ? squads.data?.find((squad) => squad.id === data.squadId)?.name : undefined
  const caption = [typeName, squadName].filter(Boolean).join(' · ')
  const unread = windows.unread.has(agentId)

  const openFullPage = () => {
    navigate(agentFullPagePath(agentId, data?.squadId ? slugFor(data.squadId) : undefined))
    dispatch({ type: 'close', agentId })
  }

  return (
    <FloatingWindowFrame
      frameRef={ref}
      windowKey={agentId}
      role="dialog"
      aria-modal={false}
      aria-label={`${label} chat window`}
      gesture={gesture}
      // A minimized window stays mounted (so it can notice new activity), just not drawn.
      style={{
        ...style,
        ...(gesture.live ? { transition: 'none' } : {}),
        ...(win.minimized ? { display: 'none' } : {}),
      }}
      zIndex={windows.zIndexFor(agentId)}
      onActivate={() => windows.bringToFront(agentId)}
      corner={{
        label: 'Resize window',
        title: 'Drag to resize · arrow keys resize · double-click to fill the screen',
        onKeyDown: (event) => {
          const step = KEY_STEPS[event.key]
          if (!step) return
          event.preventDefault()
          const current = windowRect(winRef.current, currentViewport())
          dispatch({
            type: 'rect',
            agentId,
            rect: { ...current, w: current.w + step[0], h: current.h + step[1] },
            viewport: currentViewport(),
          })
        },
        onDoubleClick: () => dispatch({ type: 'toggleFull', agentId }),
      }}
      aria-hidden={win.minimized || undefined}
      className="ficus-assistant-panel ficus-glass fixed flex flex-col overflow-hidden rounded-2xl transition-[left,top,width,height] duration-200 motion-reduce:transition-none"
    >
      <header
        data-window-drag-handle
        className="flex shrink-0 cursor-grab touch-none items-center gap-2 border-b border-th-border py-1.5 pl-3 pr-1.5"
      >
        {data ? (
          <AgentActivityDot status={data.status} />
        ) : (
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-selection" />
        )}
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium text-primary" title={label}>
              {label}
            </span>
            {unread && !front && (
              <span role="img" aria-label="Unread activity" className="h-2 w-2 shrink-0 rounded-full bg-badge" />
            )}
          </span>
          {caption && <span className="truncate text-xs text-muted">{caption}</span>}
        </span>
        <WindowSnapMenu
          label="Arrange window"
          resetLabel="Center"
          resetTitle="Center on the screen, keeping its size"
          snap={win.snap}
          onSnap={(snap) => dispatch({ type: 'snap', agentId, snap })}
          onReset={() => dispatch({ type: 'center', agentId, viewport: currentViewport() })}
        />
        <button
          type="button"
          className="ficus-button ficus-button-ghost flex h-8 w-8 items-center justify-center rounded-lg"
          aria-label="Open full page"
          title="Open full page"
          onClick={openFullPage}
        >
          <ExpandIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="ficus-button ficus-button-ghost flex h-8 w-8 items-center justify-center rounded-lg"
          aria-label="Minimize"
          title="Minimize"
          onClick={() => dispatch({ type: 'minimize', agentId })}
        >
          <MinusIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="ficus-button ficus-button-ghost flex h-8 w-8 items-center justify-center rounded-lg"
          aria-label="Close window"
          title="Close window"
          onClick={() => dispatch({ type: 'close', agentId })}
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <FloatingWindowAgentContext value={agentId}>
          <ChatFullscreenContext value={false}>
            {!gone && (
              <Conversation
                agentId={agentId}
                enableFullscreen={false}
                draftKey={`agent-window:${agentId}`}
                onConversation={onConversation}
              />
            )}
          </ChatFullscreenContext>
        </FloatingWindowAgentContext>
      </div>
    </FloatingWindowFrame>
  )
}

function isGone(error: unknown) {
  return isHttpResponseError(error, 404) || isHttpResponseError(error, 403) || isHttpResponseError(error, 400)
}
