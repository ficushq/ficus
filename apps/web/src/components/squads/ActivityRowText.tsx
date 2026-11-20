import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Agent, SquadActivityItem } from '@ficus/shared'
import { queries } from '../../queryOptions'
import { MarkdownContent } from '../MarkdownContent'
import { ActivityPreview } from './ActivityPreview'

/** The server cut the row's preview short: its last span is the ellipsis it adds. */
export function activityRowIsClipped(item: Pick<SquadActivityItem, 'preview'>): boolean {
  return item.preview.at(-1)?.text === '…'
}

/** Rows whose full text can be read: an agent's chat step that names its message. */
export function activityRowFullMessage(
  item: Pick<SquadActivityItem, 'ref'>
): { agentId: string; messageId: string } | null {
  const ref = item.ref
  return ref.type === 'agent' && ref.view === 'chat' && ref.messageId
    ? { agentId: ref.agentId, messageId: ref.messageId }
    : null
}

/**
 * Mid-step a chat row shows text that has no message yet and links the previous message instead;
 * that message is the full text only when it is the one the row was built from (same time).
 */
function sameInstant(left: string | Date, right: string): boolean {
  return Math.abs(new Date(left).getTime() - new Date(right).getTime()) < 1000
}

function FullMessage({ item, agentId, messageId }: { item: SquadActivityItem; agentId: string; messageId: string }) {
  const { data, isPending, isError } = useQuery(queries.agents.message(agentId, messageId))
  if (isPending) return <span className="block text-xs text-muted">Loading the full message…</span>
  if (isError || !data) return <span className="block text-xs text-muted">The full message could not be loaded.</span>
  if (!sameInstant(data.createdAt, item.at))
    return (
      <span className="block text-xs text-muted">This step is still writing; open the chat for the latest text.</span>
    )
  return <MarkdownContent agentId={agentId}>{data.content}</MarkdownContent>
}

/**
 * A row's text with "Show more" when the server clipped it: the full chat message loads on demand
 * (one request, cached) and renders in place; the rest of the row still opens its source. The toggle
 * is a real button, so it works from the keyboard and says whether it is expanded.
 */
export function ActivityRowText({
  item,
  onOpenAgent,
}: {
  item: SquadActivityItem
  onOpenAgent?: (agent: Agent) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const fullId = useId()
  const full = activityRowIsClipped(item) ? activityRowFullMessage(item) : null
  return (
    <>
      {expanded && full ? (
        <div
          id={fullId}
          className="pointer-events-auto relative z-10 cursor-text text-[13px]"
          data-activity-row-full=""
        >
          <FullMessage item={item} agentId={full.agentId} messageId={full.messageId} />
        </div>
      ) : (
        <ActivityPreview spans={item.preview} onOpenAgent={onOpenAgent} />
      )}
      {full && (
        <button
          type="button"
          className="ficus-button ficus-button-ghost pointer-events-auto relative z-10 ml-1 rounded px-1 py-0 align-baseline text-xs text-accent-light"
          aria-expanded={expanded}
          aria-controls={expanded ? fullId : undefined}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setExpanded(!expanded)
          }}
          data-activity-row-expand=""
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  )
}
