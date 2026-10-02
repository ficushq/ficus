import { useEffect, useState } from 'react'
import { HourglassIcon, TicketIcon } from './icons'
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
  const waits = useQuery({ ...queries.agents.slotWaits(squadId, agentId), enabled })
  const holds = useQuery({ ...queries.agents.slotHolds(squadId, agentId), enabled })
  const [leaseTick, setLeaseTick] = useState(0)
  // A missed expiry frame must not leave a lease displayed as live. This is a
  // local expiry deadline, not a poll or a new reconciliation mechanism.
  useEffect(() => {
    if (!enabled || holds.isError || holds.isFetching) return
    const now = Date.now()
    const deadlines = (holds.data ?? []).map((hold) => Date.parse(hold.expiresAt)).filter((end) => end > now)
    if (!deadlines.length) return
    const timer = setTimeout(
      () => setLeaseTick((tick) => tick + 1),
      Math.min(Math.min(...deadlines) - now, 2_147_483_647)
    )
    return () => clearTimeout(timer)
  }, [enabled, holds.data, holds.isError, holds.isFetching, leaseTick])

  if (!enabled) return null
  // Each read has its own hide-on-revalidation/error boundary. Optional older
  // server support cannot erase an independently valid waiting indicator.
  const heldNames =
    holds.isError || holds.isFetching
      ? []
      : [
          ...new Set(
            (holds.data ?? []).filter((hold) => Date.parse(hold.expiresAt) > Date.now()).map((hold) => hold.poolKey)
          ),
        ]
  const waitNames =
    waits.isError || waits.isFetching ? [] : [...new Set((waits.data ?? []).map((wait) => wait.poolKey))]
  if (!heldNames.length && !waitNames.length && !waits.isError) return null
  return (
    <div className="shrink-0 border-b border-th-border">
      <SlotStatusRow kind="hold" label={heldNames.length > 1 ? 'Holding slots' : 'Holding slot'} names={heldNames} />
      {waits.isError ? (
        <div className="text-xs text-secondary py-1" role="status">
          Slot wait status unavailable
        </div>
      ) : (
        <SlotStatusRow kind="wait" label={isIdle ? 'Waiting for slot' : 'Slot queue'} names={waitNames} />
      )}
    </div>
  )
}

function SlotStatusRow({ label, names, kind }: { label: string; names: readonly string[]; kind: 'hold' | 'wait' }) {
  if (!names.length) return null
  const Icon = kind === 'hold' ? TicketIcon : HourglassIcon
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="flex min-w-0 items-start gap-2 px-3 py-2 text-xs text-secondary"
    >
      <Icon className="mt-0.5 h-3 w-3 shrink-0" />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {label}: {names.join(' · ')}
      </span>
    </div>
  )
}
