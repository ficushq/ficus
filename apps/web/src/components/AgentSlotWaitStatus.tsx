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
      className="flex min-w-0 items-start gap-2 px-3 py-2 text-xs text-secondary"
    >
      <span
        aria-hidden="true"
        className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-status-progress-solid motion-safe:animate-pulse"
      />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {isIdle ? 'Waiting for slot' : 'Slot queue'}: {[...new Set(data.map((wait) => wait.poolKey))].join(' · ')}
      </span>
    </div>
  )
}
