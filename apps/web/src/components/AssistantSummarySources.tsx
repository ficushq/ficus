import { assistantSummaryUpdateIds } from '../lib/assistantSummarySources'
import { useQuery } from '@tanstack/react-query'
import type { RenderItem } from '@ficus/client-core'
import { assistantQueries } from '../queryOptions'
import { AssistantUpdateCard } from './AssistantUpdateCard'

/**
 * The task updates an Assistant reply covers, shown inline under it. Source IDs come from every
 * grouped row; retrieval does not depend on the latest update page. Viewing the conversation marks
 * its updates read (AssistantConversationView), so there's nothing to mark here.
 */
export function AssistantSummarySources({
  ownerId,
  conversationId,
  item,
}: {
  ownerId: string
  conversationId: string
  item: Extract<RenderItem, { kind: 'persisted' }>
}) {
  const ids = assistantSummaryUpdateIds(item)
  const query = useQuery({
    ...assistantQueries.updates(ownerId, conversationId, ids),
    enabled: ids.length > 0,
  })
  if (!ids.length) return null
  return (
    <section aria-label="Task updates" className="min-w-0 pb-2 text-sm">
      {query.isError ? (
        <button
          type="button"
          className="ficus-button py-1 text-xs text-accent-light"
          onClick={() => {
            void query.refetch()
          }}
        >
          Retry loading updates
        </button>
      ) : query.isPending ? (
        <p role="status" className="py-1 text-xs text-muted">
          Loading updates…
        </p>
      ) : (
        <ul className="mt-1 space-y-1">
          {query.data.map((update) => (
            <li
              key={update.messageId}
              className="rounded-xl bg-surface-secondary px-3 py-2 text-sm [overflow-wrap:anywhere]"
            >
              <AssistantUpdateCard update={update} taskLabel={update.taskLabel} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
