import { assistantSummaryUpdateIds } from '../lib/assistantSummarySources'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RenderItem } from '@ficus/client-core'
import { assistantQueries } from '../queryOptions'
import { assistantApi } from '../api/assistant'
import clsx from 'clsx'
import { AssistantUpdateCard } from './AssistantUpdateCard'
import { ChevronRightIcon } from './icons'

/** Source IDs come from every grouped row. Retrieval does not depend on the latest update page. */
export function AssistantSummarySources({
  ownerId,
  conversationId,
  item,
  visible,
}: {
  ownerId: string
  conversationId: string
  item: Extract<RenderItem, { kind: 'persisted' }>
  visible: boolean
}) {
  const ids = assistantSummaryUpdateIds(item)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState(false)
  const query = useQuery({
    ...assistantQueries.updates(ownerId, conversationId, ids),
    enabled: ids.length > 0 && expanded,
  })
  if (!ids.length) return null
  return (
    <div className="min-w-0 pb-2 text-sm">
      <button
        type="button"
        aria-expanded={expanded}
        className="ficus-button flex min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-xs text-muted hover:text-primary"
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronRightIcon
          className={clsx(
            'h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none',
            expanded && 'rotate-90'
          )}
        />
        <span className="font-medium">Task updates</span>
        <span>{ids.length}</span>
      </button>
      {expanded &&
        (query.isError ? (
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
                <AssistantUpdateCard
                  update={update}
                  taskLabel={update.taskLabel}
                  action={
                    visible &&
                    !update.seenAt && (
                      <button
                        type="button"
                        className="ficus-button -my-1 shrink-0 rounded-md px-1.5 py-1 text-accent-light hover:bg-selection"
                        onClick={async () => {
                          try {
                            await assistantApi.seen(conversationId, [update.messageId])
                            await query.refetch()
                            setError(false)
                          } catch {
                            setError(true)
                          }
                        }}
                      >
                        Mark read
                      </button>
                    )
                  }
                />
              </li>
            ))}
          </ul>
        ))}
      {error && (
        <p role="alert" className="py-1 text-xs text-muted">
          Could not mark the update read. Try again.
        </p>
      )}
    </div>
  )
}
