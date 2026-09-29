import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { useAssistantNavigation, assistantNavigationParams } from '../hooks/useAssistantNavigation'
import { useURLStringState } from '../hooks/useURLState'
import { useRealtimeEnabled } from '../hooks/useVoiceEnabled'
import { usePermissions } from '../hooks/usePermissions'
import { useStableRef } from '../hooks/useStableRef'
import { useAssistantWindow } from '../hooks/useAssistantWindow'
import { useKeepAssistantAcrossPages } from '../hooks/useKeepAssistantAcrossPages'
import { assistantQueries } from '../queryOptions'
import { useAssistantActivity } from '../hooks/useAssistantActivity'
import { formatAssistantUpdateTime, summarizeAssistantTasks } from '../lib/assistantActivityPresentation'
import { AgentChat } from './AgentChat'
import { ChatFullscreenContext } from './ChatFullscreenContext'
import { AssistantCommandCenter } from './AssistantCommandCenter'
import type { AssistantConversationLink } from '../lib/assistantConversationLinks'
import type { CommandDestination } from '../lib/commandCenterSearch'
import { AssistantConversationView, type AssistantViewControls } from './AssistantConversationView'
import { AssistantSnapMenu } from './AssistantSnapMenu'
import { SparklesIcon, CloseIcon, MicIcon, MinimizeIcon, PlusIcon, ResizeCornerIcon } from './icons'
import { OPEN_ASSISTANT_EVENT, TOGGLE_ASSISTANT_EVENT } from '@ficus/shared/browser-keys'

interface UnifiedAssistantProps {
  dependencies?: { ConversationComponent?: typeof AssistantConversationView; ChatComponent?: typeof AgentChat }
}

export function UnifiedAssistant(props: UnifiedAssistantProps = {}) {
  // This modal already follows the keyboard viewport. Keep every nested chat
  // inside it, including retained Assistant conversations and agent previews.
  return (
    <ChatFullscreenContext value={false}>
      <UnifiedAssistantPanel {...props} />
    </ChatFullscreenContext>
  )
}

function UnifiedAssistantPanel({ dependencies }: UnifiedAssistantProps) {
  const ConversationComponent = dependencies?.ConversationComponent ?? AssistantConversationView
  const [state, setState] = useURLStringState<'closed' | 'open' | 'expanded'>('chat', 'closed', [
    'closed',
    'open',
    'expanded',
  ])
  const location = useLocation()
  const navigate = useNavigate()
  useKeepAssistantAcrossPages()
  const params = new URLSearchParams(location.search)
  const navigation = useAssistantNavigation()
  const destination = navigation.entries.at(-1)
  const assistantEntry = [...navigation.entries].reverse().find((entry) => entry.kind === 'assistant')
  const linkedId = assistantEntry?.id ?? null
  const linkedDraft = assistantEntry?.kind === 'assistant' && assistantEntry.draft
  const viewing = destination?.kind === 'assistant'
  const browse = destination?.kind === 'recent'
  const stack = navigation.entries.filter(
    (entry): entry is CommandDestination => entry.kind !== 'assistant' && entry.kind !== 'recent'
  )
  const legacyId = params.get('assistantChat')
  const [id, setId] = useState(linkedId ?? crypto.randomUUID())
  const [existing, setExisting] = useState(Boolean(linkedId && !linkedDraft))
  const [initial, setInitial] = useState<{ id: string; text: string }>()
  const [compact, setCompact] = useState(false)
  const [controls, setControls] = useState<AssistantViewControls>()
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const { can } = usePermissions()
  const configured = useRealtimeEnabled()
  const realtime = configured && can('ai:voice')
  const open = state !== 'closed'
  const live = controls?.live ?? false
  const small = live && (compact || !open)
  const voiceReason = !configured
    ? 'Enable realtime and configure OpenAI API services in Settings → Assistant & Memory.'
    : !can('ai:voice')
      ? 'Your account does not have permission to use Realtime.'
      : !window.isSecureContext
        ? 'Microphone access needs HTTPS or localhost.'
        : undefined
  const panel = useRef<HTMLDivElement>(null)
  const assistantWindow = useAssistantWindow(panel, {
    visible: open || live,
    small,
    layoutKey: small ? 'compact' : viewing || stack.length > 0 ? 'conversation' : 'search',
  })
  const positionControl = (
    <AssistantSnapMenu
      snap={assistantWindow.placement.snap}
      onSnap={assistantWindow.snap}
      onReset={assistantWindow.reset}
    />
  )
  const recent = useQuery({ ...assistantQueries.list(search, offset), enabled: open && can('chat:send') })
  // Activity decorates saved rows with unread state and task summaries; the badge query already runs app-wide.
  const activity = useAssistantActivity({ enabled: open })
  const activityById = new Map((activity.activity?.conversations ?? []).map((row) => [row.id, row]))
  const controlsRef = useStableRef(controls)
  const openRef = useStableRef(open)
  const idRef = useStableRef(id)
  const navigationRef = useStableRef(navigation)
  const select = useCallback(
    (next: string) => {
      if (controlsRef.current?.live) return
      setId(next)
      setExisting(true)
      setCompact(false)
      setInitial(undefined)
    },
    [controlsRef]
  )
  useEffect(() => {
    if (linkedId && linkedId !== idRef.current) {
      select(linkedId)
      setExisting(!linkedDraft)
    }
  }, [linkedId, select, idRef, linkedDraft])
  useEffect(() => {
    if (legacyId) navigate(`/chat/${encodeURIComponent(legacyId)}`, { replace: true })
  }, [legacyId, navigate])
  const created = useCallback(
    (createdId: string) => {
      if (createdId === idRef.current) setExisting(true)
      const nav = navigationRef.current
      const entry = nav.entries.at(-1)
      if (entry?.kind === 'assistant' && entry.id === createdId && entry.draft) nav.replace({ ...entry, draft: false })
    },
    [idRef, navigationRef]
  )
  const onControls = useCallback((next: AssistantViewControls) => setControls(next), [])
  useLayoutEffect(() => {
    setCompact(live)
  }, [live])
  const openConversation = useCallback(
    (conversation: AssistantConversationLink) => {
      const nav = navigationRef.current
      // Preserve an Assistant parent even when a compact voice session opens a chat from search.
      const needsParent = !nav.entries.some((entry) => entry.kind === 'assistant' && entry.id === idRef.current)
      if (needsParent) nav.push({ kind: 'assistant', id: idRef.current, label: 'Assistant', draft: !existing })
      const top = navigationRef.current.entries.at(-1)
      if (needsParent || top?.kind !== 'chat' || top.agentId !== conversation.agentId)
        nav.push({
          kind: 'chat',
          id: conversation.agentId,
          agentId: conversation.agentId,
          squadId: conversation.squadId,
          label: conversation.label,
        })
      else setState('open')
      setCompact(false)
    },
    [existing, idRef, navigationRef, setState]
  )
  const newChat = () => {
    if (live) return
    const nextId = crypto.randomUUID()
    setId(nextId)
    setExisting(false)
    setInitial(undefined)
    const entry = { kind: 'assistant' as const, id: nextId, label: 'Assistant', draft: true }
    if (viewing) navigation.replace(entry)
    else navigation.push(entry)
  }
  useEffect(() => {
    const show = () => {
      setCompact(false)
      setState('open')
    }
    const toggle = () => {
      setCompact(false)
      if (openRef.current) navigationRef.current.close()
      else setState('open')
    }
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        toggle()
      } else if (event.key === 'Escape' && openRef.current) {
        event.preventDefault()
        if (navigationRef.current.entries.length) navigationRef.current.back()
        else navigationRef.current.close()
      }
    }
    window.addEventListener(OPEN_ASSISTANT_EVENT, show)
    window.addEventListener(TOGGLE_ASSISTANT_EVENT, toggle)
    document.addEventListener('keydown', key)
    return () => {
      window.removeEventListener(OPEN_ASSISTANT_EVENT, show)
      window.removeEventListener(TOGGLE_ASSISTANT_EVENT, toggle)
      document.removeEventListener('keydown', key)
    }
  }, [openRef, setState, navigationRef])
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !panel.current?.contains(event.target as Node)) return
      const items = Array.from(
        panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, a[href], summary')
      ).filter((item) => item.getClientRects().length)
      const first = items[0],
        last = items.at(-1)
      if (event.shiftKey && event.target === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && event.target === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', trap)
    return () => {
      document.removeEventListener('keydown', trap)
      previous?.focus()
    }
  }, [open])
  return (
    <div
      ref={panel}
      role="dialog"
      aria-label="Assistant"
      hidden={!open && !live}
      {...assistantWindow.panelHandlers}
      data-assistant-drag-handle={small || undefined}
      style={{
        ...assistantWindow.style,
        display: !open && !live ? 'none' : undefined,
      }}
      className={clsx(
        'ficus-assistant-panel fixed z-[60] ficus-glass rounded-2xl overflow-hidden flex flex-col transition-[left,top,width,height] duration-200 motion-reduce:transition-none max-w-[calc(100vw-1rem)] max-h-[calc(100dvh-1rem)]',
        small ? 'w-64 touch-none cursor-grab' : 'w-[42rem]',
        !small &&
          (viewing || stack.length > 0 ? 'h-[min(42rem,calc(100dvh-1rem))]' : 'h-[min(36rem,calc(100dvh-1rem))]')
      )}
    >
      {!small && (
        <header
          data-assistant-drag-handle
          className="flex shrink-0 items-center gap-2 px-3 py-2 border-b border-th-border touch-none cursor-grab"
        >
          <SparklesIcon className="h-4 w-4 text-accent-light" />
          <span className="text-sm font-medium flex-1">Assistant</span>
          {positionControl}
          <span
            title={
              stack.length ? 'Return to search to use live Assistant voice' : (voiceReason ?? 'Turn on live voice')
            }
          >
            <button
              className="ficus-button p-2 rounded-lg hover:bg-selection disabled:opacity-40"
              disabled={Boolean(voiceReason) || live || controls?.connecting || stack.length > 0}
              aria-label={controls?.connecting ? 'Starting voice chat' : 'Start voice chat'}
              onClick={() => {
                if (!viewing) navigation.push({ kind: 'assistant', id, label: 'Assistant', draft: !existing })
                void controls?.startVoice()
              }}
            >
              <MicIcon className={clsx('w-4 h-4', controls?.connecting && 'motion-safe:animate-pulse')} />
            </button>
          </span>
          <button
            className="ficus-button p-2 rounded-lg hover:bg-surface-hover"
            title={live ? 'Collapse assistant' : 'Close assistant'}
            onClick={() => (live ? setState('closed') : navigation.close())}
          >
            {live ? <MinimizeIcon className="h-4 w-4" /> : <CloseIcon className="h-4 w-4" />}
          </button>
        </header>
      )}
      {!small && open && viewing && (
        <div className="flex shrink-0 items-center gap-2 px-3 py-2 text-xs">
          <button className="ficus-button text-muted py-1" onClick={navigation.back}>
            {navigation.entries.length > 1 ? '← Back' : '← Back to search'}
          </button>
          <button
            className="ficus-button text-muted ml-auto py-1"
            disabled={live}
            title={live ? 'End voice before switching conversations' : undefined}
            onClick={() => {
              navigation.replace({ kind: 'recent', id: 'recent', label: 'Recent chats' })
            }}
          >
            Recent chats
          </button>
          <button className="ficus-button text-accent-light p-1" disabled={live} onClick={newChat}>
            <PlusIcon className="h-4 w-4" />
            <span className="sr-only">New chat</span>
          </button>
        </div>
      )}
      {!small && open && destination?.kind === 'chat' && live && (
        <div className="flex shrink-0 items-center gap-2 border-b border-th-border px-4 py-2 text-xs text-muted">
          <MicIcon className="h-3.5 w-3.5 text-accent-light" />
          <span>Talking to Assistant · Type below to message the selected agent</span>
          <button
            className="ficus-button ml-auto shrink-0 text-accent-light"
            onClick={() => {
              setCompact(false)
              while (navigationRef.current.entries.length && navigationRef.current.entries.at(-1)?.kind !== 'assistant')
                navigationRef.current.back()
            }}
          >
            Assistant
          </button>
        </div>
      )}
      <AssistantCommandCenter
        dependencies={{ ChatComponent: dependencies?.ChatComponent }}
        active={!small && open && !viewing && !browse}
        stack={stack}
        query={navigation.query}
        onQueryChange={navigation.setQuery}
        onPush={navigation.push}
        onBack={navigation.back}
        backLabel={navigation.entries.at(-2)?.kind === 'assistant' ? 'Back to Assistant' : undefined}
        onChatCreated={navigation.chatCreated}
        onAsk={(text) => {
          newChat()
          setInitial({ id: crypto.randomUUID(), text })
        }}
        canAsk={can('chat:send') && !live}
        canSendChat={can('chat:send')}
        onNavigate={navigation.close}
        onBrowseAssistant={() => navigation.push({ kind: 'recent', id: 'recent', label: 'Recent chats' })}
      />
      {!small && open && !viewing && browse && (
        <div className="min-h-0 overflow-y-auto">
          <section className="px-5 pb-4 space-y-2">
            <button className="ficus-button py-2 text-xs text-muted" onClick={navigation.back}>
              ← Back to search
            </button>
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-medium text-muted">Recent chats</h2>
              {existing && (
                <button
                  className="ficus-button text-xs text-accent-light"
                  onClick={() => navigation.push({ kind: 'assistant', id, label: 'Assistant' })}
                >
                  Continue current chat
                </button>
              )}
            </div>
            {browse && (
              <input
                aria-label="Search conversations"
                placeholder="Search conversations…"
                className="ficus-field w-full px-3 py-2 text-sm"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value)
                  setOffset(0)
                }}
              />
            )}
            {recent.isError && (
              <p role="alert" className="text-sm text-muted">
                Recent chats could not be loaded.
              </p>
            )}
            {(recent.data?.conversations ?? []).slice(0, browse ? 30 : 5).map((chat) => (
              <Link
                key={chat.id}
                to={{
                  pathname: location.pathname,
                  search: assistantNavigationParams(
                    params,
                    [...navigation.entries, { kind: 'assistant', id: chat.id, label: 'Assistant' }],
                    navigation.query
                  ).toString(),
                  hash: location.hash,
                }}
                aria-disabled={live}
                className="ficus-button block px-3 py-2 hover:bg-selection rounded-lg"
                onClick={(event) => {
                  if (live) {
                    event.preventDefault()
                    return
                  }
                  if (!event.metaKey && !event.ctrlKey) select(chat.id)
                }}
              >
                {(() => {
                  const row = activityById.get(chat.id)
                  const summary = row ? summarizeAssistantTasks(row) : ''
                  return (
                    <>
                      <span className="flex items-center gap-2">
                        {row && row.unreadUpdates > 0 && (
                          <span
                            aria-label={`${row.unreadUpdates} unread update${row.unreadUpdates === 1 ? '' : 's'}`}
                            className="inline-block h-2 w-2 shrink-0 rounded-full bg-accent"
                          />
                        )}
                        <span className="text-sm text-primary block min-w-0 flex-1 truncate">{chat.title}</span>
                        <time
                          dateTime={row?.latestUpdate?.createdAt ?? chat.updatedAt}
                          className="shrink-0 text-xs text-muted"
                        >
                          {formatAssistantUpdateTime(row?.latestUpdate?.createdAt ?? chat.updatedAt)}
                        </time>
                      </span>
                      {row?.latestUpdate && (
                        <span className="block truncate text-xs text-muted">{row.latestUpdate.preview}</span>
                      )}
                      {summary && <span className="block truncate text-xs text-muted">{summary}</span>}
                    </>
                  )
                })()}
              </Link>
            ))}
            {!browse && ((recent.data?.conversations.length ?? 0) > 5 || recent.data?.hasMore) && (
              <button
                className="ficus-button text-xs text-muted"
                onClick={() => navigation.push({ kind: 'recent', id: 'recent', label: 'Recent chats' })}
              >
                View all chats →
              </button>
            )}
            {browse && (
              <div className="flex gap-4 text-xs text-muted">
                {offset > 0 && <button onClick={() => setOffset(Math.max(0, offset - 30))}>Previous</button>}
                {recent.data?.hasMore && <button onClick={() => setOffset(offset + 30)}>More chats</button>}
              </div>
            )}
          </section>
        </div>
      )}
      <div style={{ display: viewing || small ? 'contents' : 'none' }}>
        <ConversationComponent
          key={id}
          id={id}
          onOpenConversation={openConversation}
          existing={existing}
          realtime={realtime}
          initialMessage={initial}
          focusTaskId={params.get('assistantTask') ?? undefined}
          compact={small}
          visible={(open && viewing) || small}
          onControls={onControls}
          onCreated={created}
          onExpand={() => {
            setCompact(false)
            if (!viewing) navigation.push({ kind: 'assistant', id, label: 'Assistant', draft: !existing })
            else setState('open')
          }}
          positionControl={positionControl}
        />
      </div>
      {!small && (
        <button
          type="button"
          aria-label="Resize assistant"
          title="Drag to resize · double-click to reset"
          {...assistantWindow.resizeHandle}
          className="absolute bottom-0.5 right-0.5 z-10 flex h-5 w-5 cursor-nwse-resize touch-none items-center justify-center rounded text-muted opacity-60 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          <ResizeCornerIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
