import { assistantSummaryUpdateIds } from '../lib/assistantSummarySources'
import { useQuery } from '@tanstack/react-query'
import type { RenderItem } from '@ficus/client-core'
import { assistantQueries } from '../queryOptions'
import { AssistantUpdateChip } from './AssistantUpdateChip'

/**
 * The task updates an Assistant reply covers, one compact chip each under it (the reply already says
 * what matters; a chip expands to the full report). Source IDs come from every
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
    <section aria-label="Task updates" className="min-w-0 pb-1 text-sm">
      {query.isError ? (
        <button
          type="button"
          className="ficus-button ficus-button-link py-1 text-xs"
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
            <li key={update.messageId} className="min-w-0">
              <AssistantUpdateChip updates={[update]} taskLabel={update.taskLabel} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
