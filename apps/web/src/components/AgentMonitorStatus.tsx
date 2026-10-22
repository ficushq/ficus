import { Fragment, useState } from 'react'
import type { Monitor, MonitorStatus } from '@ficus/shared'
import { MonitorIcon } from './icons'
import { MonitorDetailsModal } from './monitors/MonitorDetailsModal'
import { usePermissions } from '../hooks/usePermissions'
import { useQuery } from '../reactQueryHooks'
import { queries } from '../queryOptions'

/** Statuses in which a monitor is still delivering (or about to stop delivering) updates. */
const ACTIVE_MONITOR_STATUSES: MonitorStatus[] = ['starting', 'running', 'canceling']

/**
 * Chat header row naming the agent's active monitors; each label opens its details.
 * Rendered next to AgentSlotWaitStatus and kept live by the `monitors` topic invalidation.
 */
export function AgentMonitorStatus({ agentId, squadId }: { agentId: string; squadId: string }) {
  const permissions = usePermissions(squadId)
  const enabled =
    Boolean(agentId && squadId) && !permissions.isLoading && !permissions.isError && permissions.can('monitors:read')
  const monitors = useQuery({
    ...queries.monitors.listForAgent(agentId, { status: ACTIVE_MONITOR_STATUSES }),
    enabled,
  })
  const [selected, setSelected] = useState<Monitor | null>(null)

  // Like the slot rows: cache from an earlier visit stays hidden until this
  // mount has fetched it, while later background refetches keep the last
  // result visible instead of flickering. Errors hide the row silently.
  const active =
    enabled && !monitors.isError && monitors.isFetchedAfterMount
      ? (monitors.data ?? []).filter((monitor) => ACTIVE_MONITOR_STATUSES.includes(monitor.status))
      : []
  return (
    <>
      {active.length > 0 && (
        <div className="shrink-0 border-b border-th-border">
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="flex min-w-0 items-start gap-2 px-3 py-2 text-xs text-secondary"
          >
            <MonitorIcon className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              Monitoring:{' '}
              {active.map((monitor, index) => (
                <Fragment key={monitor.id}>
                  {index > 0 && ' · '}
                  <button
                    type="button"
                    className="text-left [overflow-wrap:anywhere] underline decoration-dotted underline-offset-2 hover:text-primary hover:decoration-solid focus-visible:decoration-solid"
                    title={monitor.description ?? undefined}
                    aria-haspopup="dialog"
                    onClick={() => setSelected(monitor)}
                  >
                    {monitor.label || 'Untitled monitor'}
                  </button>
                </Fragment>
              ))}
            </span>
          </div>
        </div>
      )}
      {/* Outside the row so a monitor ending while its details are open keeps them open. */}
      {selected && (
        <MonitorDetailsModal
          monitorId={selected.id}
          initialMonitor={active.find((monitor) => monitor.id === selected.id) ?? selected}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  )
}
