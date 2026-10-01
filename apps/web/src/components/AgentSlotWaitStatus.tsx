import { usePermissions } from '../hooks/usePermissions'
import { useQuery } from '../reactQueryHooks'
import { queries } from '../queryOptions'

/** Additional context, not an exclusive explanation of the agent's activity. */
export function AgentSlotWaitStatus({
  agentId,
  squadId,
  isIdle,
}: {
  agentId: string
  squadId: string
  isIdle: boolean
}) {
  const permissions = usePermissions(squadId)
  const enabled =
    Boolean(agentId && squadId) &&
    !permissions.isLoading &&
    !permissions.isError &&
    (permissions.can('slots:use') || permissions.can('slots:write'))
  const { data, isError, isFetching } = useQuery({ ...queries.agents.slotWaits(squadId, agentId), enabled })

  // A failed permission/read check must never keep claiming cached waits are
  // current. Initial loading and an empty projection add no chat chrome.
  if (!enabled) return null
  if (isError)
    return (
      <div className="text-xs text-secondary py-1" role="status">
        Slot wait status unavailable
      </div>
    )
  // Cached rows are not proof of a live wait until revalidation finishes.
  if (isFetching || !data?.length) return null
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="min-w-0 border-b border-status-queue-border bg-status-queue-surface px-3 py-1 text-xs text-status-queue-fg"
    >
      <details>
        <summary className="cursor-pointer rounded py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
          {isIdle ? 'Waiting for slot' : 'Slot queue'}
          <span className="ml-1">({data.length})</span>
        </summary>
        <ul className="max-h-24 overflow-y-auto space-y-1 py-1" aria-label="Queued slot pools">
          {data.map((wait) => (
            <li key={wait.waiterId} className="min-w-0 break-all">
              {wait.poolKey}
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}
