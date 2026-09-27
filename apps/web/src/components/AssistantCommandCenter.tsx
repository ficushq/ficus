import { workStreamRef } from '@ficus/shared'
import { workStreamTitle } from '@ficus/shared'
import { Fragment, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { integrationQueries, queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { usePermissions } from '../hooks/usePermissions'
import { useAssistantActivity } from '../hooks/useAssistantActivity'
import { useSquadSlugs } from '../hooks/useSquadSlugs'
import { formatAssistantUpdateTime, summarizeAssistantTasks } from '../lib/assistantActivityPresentation'
import { AgentActivityDot } from './AgentActivityDot'
import { Badge } from './Badge'
import { LoadingSurface, SkeletonBlock, SkeletonLine } from './loading/Skeleton'
import { WorkStreamStatusBadges } from './WorkStreamStatusBadges'
import {
  commandCenterSearch,
  consultantConversations,
  recentlyCompletedWork,
  type AssistantConversationDestination,
  type CommandDestination,
  type CommandResult,
} from '../lib/commandCenterSearch'
import { getAgentPrimaryLabel } from '../lib/agentDisplay'
import { ALL_SECTIONS, isSectionAllowed } from './settings/settingsSections'
import { AgentChat } from './AgentChat'
import { ActionItem } from './ActionItem'
import { MarkdownContent } from './MarkdownContent'
import { SparklesIcon, ChevronRightIcon } from './icons'
import type { Agent, PendingAction, Squad, WorkStream, WorkStreamActionData } from '@ficus/shared'

const suggestions = ['What needs my attention?', 'Summarize progress across my squads', 'Help me set up a new project']
type CompletedPreferences = { expanded: boolean; days: 7 | 30 }
const defaultCompletedPreferences: CompletedPreferences = { expanded: false, days: 7 }
type ChatDestination = Extract<CommandDestination, { kind: 'chat' }>

export function AssistantCommandCenter({
  active,
  query: externalQuery,
  onQueryChange,
  onChatCreated,
  stack,
  onPush,
  onBack,
  backLabel,
  onAsk,
  canAsk,
  canSendChat = canAsk,
  onNavigate,
  onBrowseAssistant,
  dependencies,
}: {
  active: boolean
  query?: string
  onChatCreated?: (draftId: string, agentId: string) => void
  onQueryChange?: (query: string) => void
  stack: CommandDestination[]
  onPush: (destination: CommandDestination | AssistantConversationDestination) => void
  backLabel?: string
  onBack: () => void
  onAsk: (text: string) => void
  canAsk: boolean
  canSendChat?: boolean
  onNavigate: () => void
  onBrowseAssistant: () => void
  dependencies?: { ChatComponent?: typeof AgentChat }
}) {
  const [localQuery, setLocalQuery] = useState(externalQuery ?? '')
  // Update the controlled input synchronously; router transitions are deferred
  // and otherwise restore the old value after each keystroke, moving the caret.
  useEffect(() => {
    if (externalQuery !== undefined) setLocalQuery(externalQuery)
  }, [externalQuery])
  const [rootSelected, setRootSelected] = useState(0)
  const [squadSelections, setSquadSelections] = useState<Record<string, number>>({})
  const [createdChats, setCreatedChats] = useState<Record<string, string>>({})
  const { slugFor } = useSquadSlugs()
  const [openedChats, setOpenedChats] = useState<ChatDestination[]>([])
  const [squadDrafts, setSquadDrafts] = useState<Record<string, string>>({})
  const [completedPreferences, setCompletedPreferences] = useState<Record<string, CompletedPreferences>>({})
  const entry = stack.at(-1)
  const squadScope = entry?.kind === 'squad' ? entry.id : undefined
  const query = squadScope ? (squadDrafts[squadScope] ?? '') : localQuery
  const setQuery = squadScope
    ? (value: string) => setSquadDrafts((current) => ({ ...current, [squadScope]: value }))
    : (value: string) => {
        setLocalQuery(value)
        onQueryChange?.(value)
      }
  const selected = squadScope ? (squadSelections[squadScope] ?? 0) : rootSelected
  const setSelected = squadScope
    ? (value: number) => setSquadSelections((current) => ({ ...current, [squadScope]: value }))
    : setRootSelected
  const viewRef = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const { can, isLoading, isError } = usePermissions()
  const enabled = active && !isLoading && !isError
  const squads = useQuery({ ...queries.squads.list(), enabled })
  const streams = useQuery({ ...queries.squads.allWorkStreams(), enabled })
  const consultants = useQuery({ ...queries.agents.list({ agentTypeId: 'consultant' }), enabled })
  const actions = useQuery({ ...queries.actions.pending(), enabled })
  const catalog = useQuery({ ...integrationQueries.catalog(), enabled })
  const updates = useQuery({ ...queries.updates.settings(), enabled: enabled && can('updates:read') })
  const integrationAllowed =
    catalog.data?.integrations?.some((entry) => can(`integrations:read:${entry.key}`) || can('integrations:read')) ??
    false
  const allowedSettings = new Set(
    ALL_SECTIONS.filter(
      (section) =>
        isSectionAllowed(section.id, can, isLoading || isError, integrationAllowed) &&
        !(section.id === 'updates' && updates.data?.managed === true)
    ).map((section) => section.id)
  )
  const client = useQueryClient()
  useEffect(() => {
    if (entry?.kind === 'squad') void client.invalidateQueries({ queryKey: queryKeys.agents.listPrefix() })
  }, [client, entry?.kind, entry?.id])
  const data = {
    squads: squads.data ?? [],
    streams: streams.data ?? [],
    consultants: consultants.data ?? [],
    actions: actions.data ?? [],
    allowedSettings,
  }
  // Durable Assistant activity leads the root landing list; it never queries while a squad is scoped.
  const activity = useAssistantActivity({ enabled: enabled && !squadScope })
  const updateRows: CommandResult[] =
    !entry && !query.trim()
      ? (activity.activity?.conversations ?? [])
          // Only conversations with something unread; unfinished-but-quiet tasks stay off the landing list.
          .filter((conversation) => conversation.unreadUpdates > 0)
          .slice(0, 5)
          .map((conversation) => ({
            id: `update:${conversation.id}`,
            kind: 'Update' as const,
            label: conversation.title,
            detail: conversation.latestUpdate?.preview ?? summarizeAssistantTasks(conversation),
            summary: conversation.latestUpdate ? summarizeAssistantTasks(conversation) : undefined,
            unread: conversation.unreadUpdates > 0,
            timestamp: conversation.latestUpdate?.createdAt ?? conversation.updatedAt,
            destination: { kind: 'assistant' as const, id: conversation.id, label: 'Assistant' },
          }))
      : []
  const results = [
    ...updateRows,
    ...commandCenterSearch(query, { ...data, squadId: squadScope }).filter(
      (result) => !squadScope || result.kind === 'Conversation' || result.kind === 'Work stream'
    ),
  ]
  const visible = results.slice(0, 40)
  const index = visible.length ? Math.min(selected, visible.length - 1) : -1
  const askSelected = index < 0 && Boolean(query.trim()) && canAsk
  const currentAgentId = entry?.kind === 'chat' ? (entry.agentId ?? createdChats[entry.id]) : undefined
  const knownAgent = data.consultants.find((agent) => agent.id === currentAgentId)
  const agentDetail = useQuery({
    ...queries.agents.detail(currentAgentId ?? ''),
    enabled: enabled && Boolean(currentAgentId),
  })
  const currentAgent = agentDetail.data ?? knownAgent
  const label =
    entry?.kind === 'squad'
      ? data.squads.find((s) => s.id === entry.id)?.name
      : entry?.kind === 'work'
        ? data.streams.find((w) => w.id === entry.id || workStreamRef(w) === entry.id)?.title
        : entry?.kind === 'chat' && currentAgent
          ? currentAgent.agentTypeId === 'manager'
            ? 'Manager'
            : getAgentPrimaryLabel(currentAgent)
          : undefined
  const destination = entry && label ? { ...entry, label } : entry
  const push = (next: CommandDestination | AssistantConversationDestination) => {
    if (next.kind === 'chat')
      setOpenedChats((current) => (current.some((chat) => chat.id === next.id) ? current : [...current, next]))
    onPush(next)
  }
  // A direct conversation link can enter through the parent rather than a result click.
  useEffect(() => {
    if (entry?.kind === 'chat')
      setOpenedChats((current) => (current.some((chat) => chat.id === entry.id) ? current : [...current, entry]))
  }, [entry])
  useEffect(() => {
    if (!active) return
    if (!entry || entry.kind === 'squad') searchInput.current?.focus()
    else if (entry.kind !== 'chat') viewRef.current?.querySelector<HTMLElement>('[data-command-preview]')?.focus()
  }, [active, entry])
  useEffect(() => {
    if (active && (!entry || entry.kind === 'squad'))
      resultsRef.current?.querySelector(`[data-result-index="${index}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [index, active, entry])
  const choose = (result: CommandResult) => {
    if (result.destination) push(result.destination)
    else if (result.path) {
      onNavigate()
      navigate(result.path)
    }
  }
  const start = (targetId: string, text?: string) =>
    push({
      kind: 'chat',
      id: crypto.randomUUID(),
      squadId: targetId,
      label: text || 'New conversation',
      initialText: text,
    })
  const loading = [squads, streams, consultants, actions].some((q) => q.isLoading)
  const partialError = [squads, streams, consultants, actions].some((q) => q.isError)
  return (
    <div
      ref={viewRef}
      className="flex min-h-0 flex-1 flex-col"
      style={{ display: active ? 'flex' : 'none' }}
      onKeyDown={(event) => {
        if (
          !destination ||
          destination.kind === 'chat' ||
          !['ArrowDown', 'ArrowUp'].includes(event.key) ||
          (event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')
        )
          return
        const buttons = [
          ...(viewRef.current?.querySelectorAll<HTMLButtonElement>('[data-command-preview] button:not(:disabled)') ??
            []),
        ].filter((button) => !button.closest('[hidden]'))
        if (!buttons.length) return
        event.preventDefault()
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        if (squadScope && current === 0 && event.key === 'ArrowUp') {
          setSelected(-1)
          searchInput.current?.focus()
          return
        }
        const next = Math.max(0, Math.min(buttons.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
        buttons[next]?.focus()
      }}
    >
      <form
        style={{ display: !destination || squadScope ? undefined : 'none' }}
        className="shrink-0 flex items-center gap-2 px-4 pt-3 pb-2"
        onSubmit={(event) => {
          event.preventDefault()
          if ((!squadScope || query.trim()) && visible[index]) choose(visible[index])
          else if (query.trim() && canAsk) {
            if (squadScope) start(squadScope, query.trim())
            else onAsk(query.trim())
          }
        }}
      >
        <input
          ref={searchInput}
          role="combobox"
          aria-label={
            squadScope ? `Search ${destination?.label} or start a conversation` : 'Search Tau or ask anything'
          }
          aria-expanded={!squadScope || Boolean(query.trim())}
          aria-controls="command-center-results"
          aria-activedescendant={
            (!squadScope || query.trim()) && visible[index] ? `command-result-${index}` : undefined
          }
          aria-autocomplete="list"
          placeholder={
            squadScope
              ? `Search ${destination?.label} or start a conversation…`
              : 'Find work, pick up a conversation, or ask anything…'
          }
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelected(0)
          }}
          onKeyDown={(event) => {
            if (squadScope && !query.trim() && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
              event.preventDefault()
              const rows = viewRef.current?.querySelectorAll<HTMLButtonElement>(
                '[data-command-preview] button:not(:disabled)'
              )
              if (event.key === 'ArrowDown') rows?.[0]?.focus()
              return
            }
            if (['ArrowDown', 'ArrowUp'].includes(event.key) && visible.length) {
              event.preventDefault()
              setSelected(Math.max(-1, Math.min(visible.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))))
            }
          }}
          className="ficus-field tau-assistant-search h-12 flex-1 min-w-0 rounded-xl px-3 py-2 text-base"
        />
        <button
          type="button"
          aria-label={squadScope ? 'Start conversation in squad' : 'Ask Assistant'}
          title={squadScope ? `Start conversation in ${destination?.label}` : 'Ask Assistant'}
          disabled={!canAsk || !query.trim()}
          onClick={() => (squadScope ? start(squadScope, query.trim()) : onAsk(query.trim()))}
          data-enter-target={askSelected || undefined}
          onFocus={() => setSelected(-1)}
          className={clsx(
            'ficus-button flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-accent-light hover:bg-selection disabled:opacity-40',
            askSelected && 'bg-selection'
          )}
        >
          <SparklesIcon className="w-5 h-5" />
        </button>
      </form>
      {!destination && !query.trim() && (
        <div
          role="group"
          aria-label="Quick chats"
          className="flex shrink-0 items-center gap-2 overflow-x-auto px-4 pb-3"
        >
          {suggestions.map((text) => (
            <button
              key={text}
              disabled={!canAsk}
              onClick={() => onAsk(text)}
              className="ficus-button flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-surface-hover px-3 py-2 text-xs text-muted hover:bg-selection hover:text-accent-light disabled:opacity-40"
            >
              <SparklesIcon className="h-3.5 w-3.5 shrink-0" />
              {text}
            </button>
          ))}
        </div>
      )}
      {destination && (
        <div className="flex shrink-0 min-w-0 items-center gap-2 px-4 py-2 text-xs border-b border-th-border">
          <button
            onClick={onBack}
            className="ficus-button flex shrink-0 items-center gap-1 py-1.5 text-muted"
            aria-label={backLabel ?? (stack.length > 1 ? 'Back to preview' : 'Back to search')}
          >
            <ChevronRightIcon className="w-3.5 h-3.5 rotate-180" />
            {backLabel ?? (stack.length > 1 ? 'Back' : 'Search')}
          </button>
          <span className="text-muted">/</span>
          <span className="truncate font-medium" title={destination.label}>
            {destination.label}
          </span>
          {destination.kind === 'chat' && destination.readOnly && (
            <span className="text-muted shrink-0">Read only</span>
          )}
          {destination.kind === 'chat' && destination.squadId && (
            <>
              <span className="ml-auto truncate text-muted max-w-[25%]">
                {data.squads.find((s) => s.id === destination.squadId)?.name}
              </span>
              {currentAgentId && (
                <a
                  className="ficus-button shrink-0 p-1.5 text-muted hover:text-accent-light"
                  href={`/squads/${encodeURIComponent(slugFor(destination.squadId))}/agents?agent=${encodeURIComponent(currentAgentId)}`}
                  target="_blank"
                  rel="noreferrer"
                  title="Open full conversation"
                  aria-label="Open full conversation"
                >
                  ↗
                </a>
              )}
            </>
          )}
        </div>
      )}
      <div
        style={{ display: !destination || (squadScope && query.trim()) ? undefined : 'none' }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div ref={resultsRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <div id="command-center-results" role="listbox" aria-label="Search results">
            {visible.map((result, i) => (
              <Fragment key={result.id}>
                {i === 0 && result.kind === 'Update' && (
                  <div role="presentation" className="px-3 pt-2 pb-1 text-[11px] font-medium text-muted">
                    Updates
                  </div>
                )}
                {i > 0 && visible[i - 1].kind === 'Update' && result.kind !== 'Update' && (
                  <div role="presentation" className="px-3 pt-3 pb-1 text-[11px] font-medium text-muted">
                    Recent
                  </div>
                )}
                <button
                  id={`command-result-${i}`}
                  data-result-index={i}
                  role="option"
                  aria-selected={i === index}
                  onClick={() => choose(result)}
                  className={clsx(
                    'ficus-button flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-selection',
                    i === index && 'bg-selection'
                  )}
                >
                  {result.status && result.status !== 'idle' && (
                    <AgentActivityDot status={result.status} className="shrink-0" />
                  )}
                  {result.kind === 'Update' && (
                    <span
                      aria-label={result.unread ? 'Unread updates' : undefined}
                      className={clsx(
                        'inline-block h-2 w-2 shrink-0 rounded-full',
                        result.unread ? 'bg-accent' : 'bg-th-border'
                      )}
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{result.label}</span>
                    <span className="flex items-center gap-2 text-xs text-muted mt-0.5">
                      <span className="truncate">{result.detail}</span>
                      {result.work && <CommandWorkStatus work={result.work} />}
                      {result.agentTypeId && <CommandAgentType typeId={result.agentTypeId} />}
                      {result.summary && <span className="shrink-0 truncate max-w-[40%]">{result.summary}</span>}
                    </span>
                  </span>
                  {result.timestamp ? (
                    <time dateTime={result.timestamp} className="shrink-0 text-[11px] text-muted">
                      {formatAssistantUpdateTime(result.timestamp)}
                    </time>
                  ) : (
                    <span className="shrink-0 text-[11px] text-muted">{result.kind}</span>
                  )}
                  <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
                </button>
              </Fragment>
            ))}
          </div>
          {loading && <CommandRowsSkeleton label="Finding your work and conversations" />}
          {!loading && !visible.length && (
            <p className="px-3 py-3 text-sm text-muted">
              {squadScope
                ? 'No matches. Press Enter to start a conversation in this squad.'
                : 'No matches. Ask Assistant to start something.'}
            </p>
          )}
          {partialError && (
            <p role="status" className="px-3 py-2 text-xs text-muted">
              Some results could not be loaded.{' '}
              <button
                className="text-accent-light"
                onClick={() => {
                  for (const q of [squads, streams, consultants, actions]) if (q.isError) void q.refetch()
                }}
              >
                Retry
              </button>
            </p>
          )}
          {results.length > visible.length && (
            <p className="px-3 py-2 text-xs text-muted">Showing 40 matches. Keep typing to narrow your search.</p>
          )}
        </div>
      </div>
      {destination?.kind === 'squad' && !query.trim() && (
        <SquadPreview
          key={destination.id}
          id={destination.id}
          data={data}
          completed={completedPreferences[destination.id] ?? defaultCompletedPreferences}
          onCompletedChange={(preferences) =>
            setCompletedPreferences((current) => ({ ...current, [destination.id]: preferences }))
          }
          workFailed={streams.isError}
          chatsLoading={consultants.isLoading}
          workLoading={streams.isLoading}
          loadFailed={consultants.isError || streams.isError}
          onPush={push}
        />
      )}
      {destination?.kind === 'work' && (
        <WorkPreview key={destination.id} id={destination.id} squadId={destination.squadId} onPush={push} />
      )}
      {destination?.kind === 'action' && (
        <div data-command-preview tabIndex={-1} className="p-4 min-h-0 overflow-y-auto focus:outline-none">
          {actions.isLoading ? (
            <CommandRowsSkeleton label="Loading attention item" />
          ) : data.actions.find((a) => a.id === destination.id) ? (
            <CommandActionPreview action={data.actions.find((a) => a.id === destination.id)!} onPush={push} />
          ) : (
            <p className="py-6 text-sm text-muted">This item no longer needs your attention.</p>
          )}
        </div>
      )}
      {openedChats.map((chat) => (
        <div
          key={chat.id}
          inert={!(active && destination?.kind === 'chat' && destination.id === chat.id)}
          style={{ display: destination?.kind === 'chat' && destination.id === chat.id ? 'flex' : 'none' }}
          className="min-h-0 flex-1 flex flex-col"
        >
          <InlineCommandChat
            ChatComponent={dependencies?.ChatComponent}
            chat={
              destination?.kind === 'chat' && destination.id === chat.id
                ? { ...chat, readOnly: destination.readOnly }
                : chat
            }
            onCreated={(id) => {
              if (chat.squadId) {
                setSquadDrafts((current) => ({ ...current, [chat.squadId!]: '' }))
                setSquadSelections((current) => ({ ...current, [chat.squadId!]: -1 }))
              }
              setCreatedChats((current) => ({ ...current, [chat.id]: id }))
              onChatCreated?.(chat.id, id)
            }}
            active={active && destination?.id === chat.id}
            canSend={canSendChat}
          />
        </div>
      ))}
      {destination?.kind !== 'chat' && (
        <footer className="mt-auto shrink-0 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-th-border px-4 py-2 text-[11px] text-muted">
          <span>
            {destination && (!squadScope || !query.trim())
              ? 'Enter to open'
              : visible[index]
                ? 'Enter to open'
                : squadScope
                  ? 'Enter to start'
                  : 'Enter to ask'}
            {' · ↑ ↓ select · Esc back'}
          </span>
          {!squadScope && (
            <button
              onClick={onBrowseAssistant}
              className="ficus-button ml-auto py-1 text-xs text-muted hover:text-accent-light"
            >
              Assistant conversations →
            </button>
          )}
        </footer>
      )}
    </div>
  )
}

function CommandActionPreview({
  action,
  onPush,
}: {
  action: PendingAction
  onPush: (destination: CommandDestination) => void
}) {
  const work =
    action.type === 'workstream-review' || action.type === 'workstream-blocked'
      ? (action.data as WorkStreamActionData)
      : null
  return (
    <>
      <ActionItem action={action} embedded />
      {work && (
        <section className="border-t border-th-border pt-3">
          <PreviewRow
            title={work.workStreamTitle}
            detail="Work stream"
            onClick={() =>
              onPush({ kind: 'work', id: work.workStreamId, squadId: work.squadId, label: work.workStreamTitle })
            }
          />
        </section>
      )}
    </>
  )
}

function SquadPreview({
  id,
  data,
  onPush,
  completed,
  onCompletedChange,
  workFailed,
  chatsLoading,
  workLoading,
  loadFailed,
}: {
  id: string
  data: { squads: Squad[]; consultants: Agent[]; streams: WorkStream[] }
  onPush: (d: CommandDestination) => void
  completed: CompletedPreferences
  onCompletedChange: (preferences: CompletedPreferences) => void
  workFailed: boolean
  chatsLoading: boolean
  workLoading: boolean
  loadFailed: boolean
}) {
  const completedWork = recentlyCompletedWork(data.streams, id, completed.days)
  const squad = data.squads.find((s) => s.id === id)
  const chats = consultantConversations(data.consultants)
    .filter((a) => a.squadId === id)
    .slice(0, 8)
  const work = data.streams.filter((w) => w.squadId === id && ['active', 'queued'].includes(w.status))
  return (
    <div data-command-preview tabIndex={-1} className="min-h-0 overflow-y-auto p-4 space-y-5 focus:outline-none">
      <p className="text-sm text-muted">{squad?.purpose}</p>
      {squad?.managerAgentId && (
        <PreviewRow
          title="Manager"
          detail="Squad coordinator"
          onClick={() =>
            onPush({
              kind: 'chat',
              id: squad.managerAgentId!,
              agentId: squad.managerAgentId!,
              squadId: id,
              label: 'Manager',
            })
          }
        />
      )}
      <section>
        <h3 className="text-xs text-muted mb-2">Active work</h3>
        {work.map((w) => (
          <PreviewRow
            key={w.id}
            title={workStreamTitle(w)}
            detail={<CommandWorkStatus work={w} />}
            onClick={() => onPush({ kind: 'work', id: workStreamRef(w), squadId: id, label: workStreamTitle(w) })}
          />
        ))}
        {!work.length &&
          (workLoading ? (
            <CommandRowsSkeleton label="Loading work" />
          ) : (
            <p role="status" className="text-sm text-muted py-2">
              {loadFailed ? 'Work could not be loaded. Return to search to retry.' : 'No active work streams.'}
            </p>
          ))}
      </section>
      <section>
        <h3 className="text-xs text-muted mb-2">Recent conversations</h3>
        {chats.map((a) => (
          <PreviewRow
            key={a.id}
            title={getAgentPrimaryLabel(a)}
            status={a.status}
            detail={
              <span className="inline-flex items-center gap-2">
                <CommandAgentType typeId={a.agentTypeId} />
                {new Date(a.lastHumanMessageAt ?? a.createdAt).toLocaleDateString()}
              </span>
            }
            onClick={() =>
              onPush({ kind: 'chat', id: a.id, agentId: a.id, squadId: id, label: getAgentPrimaryLabel(a) })
            }
          />
        ))}
        {!chats.length &&
          (chatsLoading ? (
            <CommandRowsSkeleton label="Loading conversations" />
          ) : (
            <p role="status" className="text-sm text-muted py-2">
              {loadFailed
                ? 'Conversations could not be loaded. Return to search to retry.'
                : 'No recent conversations.'}
            </p>
          ))}
      </section>
      <section>
        <button
          type="button"
          aria-expanded={completed.expanded}
          aria-controls="command-completed-work"
          onClick={() => onCompletedChange({ ...completed, expanded: !completed.expanded })}
          className="flex items-center gap-2 py-2 text-sm text-muted hover:text-primary"
        >
          <ChevronRightIcon className={clsx('h-4 w-4 transition-transform', completed.expanded && 'rotate-90')} />
          Recently completed
          {!workLoading && !workFailed && <span className="text-xs">{completedWork.length}</span>}
        </button>
        {completed.expanded && (
          <div id="command-completed-work" className="space-y-2">
            <div role="group" aria-label="Completed work period" className="flex items-center gap-1">
              {([7, 30] as const).map((days) => (
                <button
                  key={days}
                  type="button"
                  aria-pressed={completed.days === days}
                  onClick={() => onCompletedChange({ ...completed, days })}
                  className={clsx(
                    'rounded-lg px-3 py-1.5 text-xs',
                    completed.days === days ? 'bg-selection text-accent-light' : 'text-muted hover:bg-surface-hover'
                  )}
                >
                  {days} days
                </button>
              ))}
            </div>
            {completedWork.map((work) => (
              <PreviewRow
                key={work.id}
                title={workStreamTitle(work)}
                detail={
                  <span className="inline-flex items-center gap-2">
                    <CommandWorkStatus work={work} />
                    {new Date(work.completedAt ?? work.updatedAt ?? work.createdAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                }
                onClick={() =>
                  onPush({ kind: 'work', id: workStreamRef(work), squadId: id, label: workStreamTitle(work) })
                }
              />
            ))}
            {workLoading ? (
              <CommandRowsSkeleton label="Loading completed work" />
            ) : workFailed ? (
              <p role="status" className="py-2 text-sm text-muted">
                Completed work could not be loaded. Return to search to retry.
              </p>
            ) : (
              !completedWork.length && (
                <p role="status" className="py-2 text-sm text-muted">
                  No work streams completed in the last {completed.days} days.
                </p>
              )
            )}
          </div>
        )}
      </section>
    </div>
  )
}

function PreviewRow({
  title,
  detail,
  status,
  onClick,
}: {
  title: string
  detail: React.ReactNode
  status?: Agent['status']
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="ficus-button flex w-full items-center gap-2 px-3 py-2.5 text-left rounded-xl hover:bg-selection focus:bg-selection"
    >
      {status && status !== 'idle' && <AgentActivityDot status={status} className="shrink-0" />}
      <span className="flex-1 min-w-0">
        <span className="block text-sm truncate">{title}</span>
        <span className="block text-xs text-muted mt-0.5">{detail}</span>
      </span>
      <ChevronRightIcon className="w-4 h-4 text-muted shrink-0" />
    </button>
  )
}

function WorkPreview({
  id,
  squadId,
  onPush,
}: {
  id: string
  squadId: string
  onPush: (d: CommandDestination) => void
}) {
  const work = useQuery(queries.squads.workStreamDetail(id))
  const agents = useQuery(queries.squads.agents(squadId))
  const creatorId = work.data?.creatorAgentId
  const knownCreator = agents.data?.find((agent) => agent.id === creatorId)
  // Archived consultants may be absent from the squad's current agent list.
  const creatorDetail = useQuery({
    ...queries.agents.detail(creatorId ?? ''),
    enabled: Boolean(creatorId) && !knownCreator,
  })
  const creator = knownCreator ?? creatorDetail.data
  const origin = creator?.agentTypeId === 'consultant' ? creator : undefined
  if (work.isPending) return <CommandWorkSkeleton />
  if (work.isError)
    return (
      <p role="alert" className="p-5 text-sm text-muted">
        Work could not be loaded.{' '}
        <button onClick={() => void work.refetch()} className="text-accent-light">
          Retry
        </button>
      </p>
    )
  const row = work.data
  const ids = new Set([row.assigneeAgentId, ...(row.agentIds ?? [])].filter(Boolean))
  const assigned = (agents.data ?? []).filter(
    (a) => ids.has(a.id) && a.id !== origin?.id && a.status !== 'terminated' && a.status !== 'dormant'
  )
  return (
    <div data-command-preview tabIndex={-1} className="p-4 min-h-0 overflow-y-auto space-y-5 focus:outline-none">
      <div className="flex gap-3 text-xs text-muted">
        <CommandWorkStatus work={row} />
        <span className="py-1">{row.priority} priority</span>
      </div>
      <section>
        <h3 className="text-xs text-muted mb-2">Conversations</h3>
        {assigned.map((a) => (
          <PreviewRow
            key={a.id}
            title={getAgentPrimaryLabel(a)}
            status={a.status}
            detail={
              <span className="inline-flex items-center gap-2">
                <CommandAgentType typeId={a.agentTypeId} />
                {a.id === row.assigneeAgentId ? 'Assigned' : null}
              </span>
            }
            onClick={() => onPush({ kind: 'chat', id: a.id, agentId: a.id, squadId, label: getAgentPrimaryLabel(a) })}
          />
        ))}
        {agents.isPending ? (
          <CommandRowsSkeleton label="Loading conversations" />
        ) : agents.isError ? (
          <button onClick={() => void agents.refetch()} className="ficus-button text-sm text-muted">
            Retry loading conversations
          </button>
        ) : (
          !assigned.length && <p className="text-sm text-muted py-2">No assigned conversations yet.</p>
        )}
      </section>
      {origin ? (
        <section>
          <h3 className="text-xs text-muted mb-2">Started here</h3>
          <PreviewRow
            title={getAgentPrimaryLabel(origin)}
            detail={
              <span className="inline-flex items-center gap-2">
                <CommandAgentType typeId={origin.agentTypeId} />
                Read only
              </span>
            }
            onClick={() =>
              onPush({
                kind: 'chat',
                id: origin.id,
                agentId: origin.id,
                squadId: origin.squadId ?? squadId,
                label: getAgentPrimaryLabel(origin),
                readOnly: true,
              })
            }
          />
        </section>
      ) : creatorId && !knownCreator && creatorDetail.isPending ? (
        <CommandRowsSkeleton label="Loading originating conversation" />
      ) : creatorId && creatorDetail.isError && !knownCreator ? (
        <button className="ficus-button text-sm text-muted" onClick={() => void creatorDetail.refetch()}>
          Retry loading originating conversation
        </button>
      ) : null}
      {row.description && (
        <section className="text-sm">
          <h3 className="text-xs text-muted mb-2">About this work</h3>
          <MarkdownContent>{row.description}</MarkdownContent>
        </section>
      )}
    </div>
  )
}

function CommandRowPlaceholders() {
  return (
    <div aria-hidden="true" className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="px-3 py-2.5 space-y-2">
          <SkeletonLine className={i === 1 ? 'w-3/5' : 'w-4/5'} />
          <SkeletonLine className="w-24 h-2.5" />
        </div>
      ))}
    </div>
  )
}

function CommandRowsSkeleton({ label }: { label: string }) {
  return (
    <LoadingSurface label={label}>
      <CommandRowPlaceholders />
    </LoadingSurface>
  )
}

function CommandWorkSkeleton() {
  return (
    <LoadingSurface label="Loading work" className="p-4 min-h-0 overflow-hidden space-y-5">
      <div className="flex gap-3">
        <SkeletonBlock className="h-6 w-20 rounded-full" />
        <SkeletonLine className="w-24 self-center" />
      </div>
      <div className="space-y-2">
        <SkeletonLine className="w-28" />
        <CommandRowPlaceholders />
      </div>
      <div className="space-y-3">
        <SkeletonLine className="w-24" />
        <SkeletonLine className="w-full" />
        <SkeletonLine className="w-11/12" />
        <SkeletonLine className="w-2/3" />
      </div>
    </LoadingSurface>
  )
}

function CommandAgentType({ typeId }: { typeId: string }) {
  const types = useQuery(queries.agentTypes.list())
  const label =
    types.data?.find((type) => type.id === typeId)?.name ??
    typeId.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
  return <Badge color="accent-1">{label}</Badge>
}

function CommandWorkStatus({ work }: { work: WorkStream }) {
  return <WorkStreamStatusBadges workStream={work} />
}

function InlineCommandChat({
  chat,
  active,
  canSend,
  ChatComponent = AgentChat,
  onCreated,
}: {
  chat: ChatDestination
  active: boolean
  canSend: boolean
  ChatComponent?: typeof AgentChat
  onCreated?: (id: string) => void
}) {
  const client = useQueryClient()
  return (
    <ChatComponent
      agentId={chat.agentId}
      scope={chat.agentId ? undefined : { type: 'consultant', id: chat.squadId }}
      initialMessage={!chat.readOnly && chat.initialText ? { content: chat.initialText } : undefined}
      embedded
      enableFullscreen={false}
      readOnly={chat.readOnly}
      inputDisabled={!canSend || Boolean(chat.readOnly)}
      className="flex-1 min-h-0"
      inputStorageKey={`command-chat:${chat.id}`}
      focusTrigger={active ? 1 : 0}
      keyboardShortcutsEnabled={active}
      squadId={chat.squadId}
      placeholder="Send a message…"
      onAgentCreated={(id) => {
        onCreated?.(id)
        void client.invalidateQueries({ queryKey: queryKeys.agents.listPrefix() })
        if (chat.squadId) void client.invalidateQueries({ queryKey: queryKeys.squads.agents(chat.squadId) })
      }}
    />
  )
}
