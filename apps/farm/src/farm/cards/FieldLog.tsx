import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import {
  coerceSquadActivityRef,
  type ActivityPreviewSpan,
  type SquadActivityItem,
  type SquadActivityKind,
} from '@ficus/shared'
import { farmQueries } from '../../api/queries'
import { ChatShell } from '../../chat/ChatShell'
import { fieldLogTopic } from '../../live/invalidation'
import { useLiveTopic } from '../../live/LiveUpdates'
import { agentLabel } from '../agentLabels'
import { findPlot } from '../find'
import { RobotAvatar } from '../RobotAvatar'
import { ago } from '../time'
import { useFarmCard } from './context'

/**
 * The log's filters: the web Activity tab's kinds, grouped the way the farm
 * talks about them. Any mix of them can be on; with none on, it's everything.
 */
export const FIELD_LOG_FILTERS: ReadonlyArray<{ id: string; label: string; kinds: SquadActivityKind[] }> = [
  { id: 'chat', label: 'Chat', kinds: ['message'] },
  { id: 'work', label: 'Work', kinds: ['workstream', 'handoff', 'execution', 'subagent'] },
  { id: 'waits', label: 'Waits', kinds: ['wait'] },
  { id: 'code', label: 'Code', kinds: ['pr', 'issue'] },
]

/** The kinds a set of filters asks for (none for everything). */
export const fieldLogKinds = (filters: ReadonlySet<string>): SquadActivityKind[] =>
  FIELD_LOG_FILTERS.filter((f) => filters.has(f.id))
    .flatMap((f) => f.kinds)
    .sort()

/** The preview's inline formatting, without its links (the whole row is the link). */
function Preview({ spans }: { spans: readonly ActivityPreviewSpan[] }) {
  return (
    <>
      {spans.map((span, i) => {
        let node: React.ReactNode = span.text
        if (span.code) node = <code>{node}</code>
        if (span.italic) node = <em>{node}</em>
        if (span.bold) node = <strong>{node}</strong>
        return <span key={i}>{node}</span>
      })}
    </>
  )
}

/**
 * A squad's field log: what its robots have been doing, newest first, like
 * the web app's squad Activity tab. It's a window like a chat (it can stay
 * pinned while you work), stays live while it's open (the squad's activity
 * topic), and each entry opens what it's about: a robot's chat, a plant, or a
 * pull request or issue.
 */
export function FieldLog({ squadId, onClose }: { squadId: string; onClose: () => void }) {
  const env = useFarmCard()
  const [filters, setFilters] = useState<ReadonlySet<string>>(() => new Set())
  useLiveTopic(fieldLogTopic(squadId))
  const log = useInfiniteQuery(farmQueries.fieldLog(squadId, fieldLogKinds(filters)))
  const squad = env.squadsById.get(squadId)
  const items = log.data?.pages.flatMap((page) => page.items) ?? []

  const toggle = (id: string) =>
    setFilters((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const open = (item: SquadActivityItem): (() => void) | null => {
    const ref = coerceSquadActivityRef(item.ref)
    switch (ref?.type) {
      case 'agent':
        return () => env.openChat(ref.agentId)
      case 'workstream':
        return findPlot(env.layout, ref.workStreamId)
          ? () => env.select({ kind: 'plot', streamId: ref.workStreamId })
          : null
      case 'pr':
      case 'issue':
        return /^https?:\/\//.test(ref.url) ? () => window.open(ref.url, '_blank', 'noopener,noreferrer') : null
      default:
        return item.agentId ? () => env.openChat(item.agentId!) : null
    }
  }

  const filterChips = (
    <div className="g-log-filters" role="group" aria-label="Show">
      <button
        type="button"
        className="g-log-filter"
        aria-pressed={filters.size === 0}
        onClick={() => setFilters(new Set())}
      >
        All
      </button>
      {FIELD_LOG_FILTERS.map((option) => (
        <button
          key={option.id}
          type="button"
          className="g-log-filter"
          aria-pressed={filters.has(option.id)}
          onClick={() => toggle(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )

  return (
    <ChatShell
      title="Field log"
      subtitle={squad?.name ?? 'Squad'}
      header={filterChips}
      closeLabel="Close field log"
      onClose={onClose}
    >
      <div className="g-chat-body">
        <div className="g-chat-scroll g-log-scroll">
          {log.isPending ? (
            <p className="g-card-text">Reading the log…</p>
          ) : log.isError ? (
            <p className="g-card-text">The field log couldn’t be read right now.</p>
          ) : items.length === 0 ? (
            <p className="g-card-text">
              {filters.size === 0 ? 'Nothing has happened here yet.' : 'Nothing like that yet.'}
            </p>
          ) : (
            <ol className="g-log" aria-live="polite">
              {items.map((item) => {
                const agent = item.agentId ? env.agentsById.get(item.agentId) : undefined
                const who = agent ? agentLabel(agent).primary : item.agentId ? 'A robot' : 'Ficus'
                const onOpen = open(item)
                const body = (
                  <>
                    {agent ? (
                      <RobotAvatar agent={agent} squad={squad} halted={env.halted.has(agent.id)} size={30} />
                    ) : (
                      <span className="g-log-dot" aria-hidden="true" />
                    )}
                    <span className="g-log-text">
                      <span className="g-log-meta">
                        <span className="g-log-who">{who}</span>
                        <time dateTime={item.at}>{ago(item.at)}</time>
                      </span>
                      <span className="g-log-what">
                        {item.preview.length > 0 ? <Preview spans={item.preview} /> : item.summary}
                      </span>
                    </span>
                  </>
                )
                return (
                  <li key={item.id}>
                    {onOpen ? (
                      <button type="button" className="g-log-row" onClick={onOpen}>
                        {body}
                      </button>
                    ) : (
                      <div className="g-log-row">{body}</div>
                    )}
                  </li>
                )
              })}
            </ol>
          )}

          {log.hasNextPage && (
            <button
              type="button"
              className="g-button g-card-wide"
              disabled={log.isFetchingNextPage}
              onClick={() => void log.fetchNextPage()}
            >
              {log.isFetchingNextPage ? 'Reading further back…' : 'Load earlier'}
            </button>
          )}
        </div>
      </div>
    </ChatShell>
  )
}
