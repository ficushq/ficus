import { useQuery } from '@tanstack/react-query'
import type { RenderItem } from '@ficus/client-react'
import { ASSISTANT_TASK_STATUS_LABELS } from '@ficus/shared'
import type { AssistantApi } from './assistantApi'
import { Collapsible, INBOX_BODY_LIMIT } from './Transcript'

/** The task updates an Assistant reply covers: the ids on every message grouped into it. */
export function assistantUpdateIds(item: Extract<RenderItem, { kind: 'persisted' }>): string[] {
  return [
    ...new Set((item.mergedFrom ?? [item.message]).flatMap((message) => message.metadata?.assistantUpdateIds ?? [])),
  ]
}

/** Under the farm's own `['farm', 'assistant']` keys, so the Assistant's live refresh reaches it. */
export const assistantUpdatesKey = (conversationId: string, ids: string[]) =>
  ['farm', 'assistant', 'updates', conversationId, [...ids].sort()] as const

function time(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const today = date.toDateString() === new Date().toDateString()
  return today
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * The task updates a reply covers, inline under it (as the web shows them): the task, its status,
 * who sent it and when, then what it said (a few lines, behind Show more when long). Viewing the chat reads them (AssistantChat).
 */
export function AssistantTaskUpdates({
  api,
  conversationId,
  item,
}: {
  api: AssistantApi
  conversationId: string
  item: Extract<RenderItem, { kind: 'persisted' }>
}) {
  const ids = assistantUpdateIds(item)
  const query = useQuery({
    queryKey: assistantUpdatesKey(conversationId, ids),
    queryFn: async () => {
      const updates = [] as Awaited<ReturnType<AssistantApi['readUpdates']>>
      for (let offset = 0; offset < ids.length; offset += 50)
        updates.push(...(await api.readUpdates(conversationId, ids.slice(offset, offset + 50))))
      return updates
    },
    enabled: ids.length > 0,
  })
  if (!ids.length) return null
  return (
    <section className="g-chat-updates" aria-label="Task updates">
      {query.isError ? (
        <button type="button" className="g-chat-link" onClick={() => void query.refetch()}>
          Retry loading updates
        </button>
      ) : query.isPending ? (
        <p className="g-chat-system" role="status">
          Loading updates…
        </p>
      ) : (
        <ul>
          {query.data.map((update) => (
            <li key={update.messageId} className="g-chat-update">
              <p className="g-chat-update-meta">
                {!update.seenAt && <span className="g-chat-update-new" aria-label="New" />}
                {update.taskLabel && <b>{update.taskLabel}</b>}
                {update.reportedStatus && <span>{ASSISTANT_TASK_STATUS_LABELS[update.reportedStatus]}</span>}
                <span className="g-chat-update-from">
                  {update.senderName} · {time(update.createdAt)}
                </span>
              </p>
              {update.subject && <p className="g-chat-update-subject">{update.subject}</p>}
              <Collapsible text={update.content} limit={INBOX_BODY_LIMIT} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
