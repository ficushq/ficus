import { Fragment, useMemo, useState } from 'react'
import type { Monitor, MonitorStatus } from '@ficus/shared'
import { MonitorIcon } from './icons'
import { MonitorDetailsModal } from './monitors/MonitorDetailsModal'
import { JumpingPlant } from './TypingIndicator'
import { usePermissions } from '../hooks/usePermissions'
import { usePlantPresence } from '../hooks/usePlantPresence'
import { useQuery } from '../reactQueryHooks'
import { queries } from '../queryOptions'

/** Statuses in which a monitor is still delivering (or about to stop delivering) updates. */
const ACTIVE_MONITOR_STATUSES: MonitorStatus[] = ['starting', 'running', 'canceling']

/**
 * Chat header row naming the agent's active monitors; each label opens its details.
 * Rendered next to AgentSlotWaitStatus and kept live by the `monitors` topic invalidation.
 *
 * While the agent is idle (`agentIdle`: no working plant anywhere in the chat) the Ficus
 * plant hangs upside down from the row, so a quiet agent visibly waits on its monitors
 * rather than looking stalled.
 */
export function AgentMonitorStatus({
  agentId,
  squadId,
  agentIdle = false,
}: {
  agentId: string
  squadId: string
  agentIdle?: boolean
}) {
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
  const visible = enabled && !monitors.isError && monitors.isFetchedAfterMount
  const active = useMemo(
    () => (visible ? (monitors.data ?? []).filter((monitor) => ACTIVE_MONITOR_STATUSES.includes(monitor.status)) : []),
    [visible, monitors.data]
  )

  const plant = usePlantPresence(agentIdle && active.length > 0)
  // When the last monitor ends under the plant, the row stays, naming them, until it has retreated behind it.
  const [lastActive, setLastActive] = useState(active)
  if (active.length > 0 && active !== lastActive) setLastActive(active)
  const shownMonitors = active.length > 0 ? active : plant.shown ? lastActive : []

  return (
    <>
      {shownMonitors.length > 0 && (
        // Its own stacking layer above the transcript, so the plant hangs over the top of the messages.
        <div className="relative z-20 shrink-0">
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            // Opaque and above the plant, so the plant's pot hides behind it.
            className="relative z-10 min-w-0 border-b border-th-border bg-surface px-3 py-2 text-xs text-secondary [overflow-wrap:anywhere]"
          >
            {/* Inline with the text, so it stays centered on the first line whatever its height. */}
            <MonitorIcon className="mr-2 inline-block h-3 w-3 align-[-0.15em] text-accent-light" />
            <span className="font-medium text-accent-light">Monitoring:</span>{' '}
            {shownMonitors.map((monitor, index) => (
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
          </div>
          {plant.shown && (
            // Clipped at the row's top edge, so the retreating plant never shows above the row.
            <div
              aria-hidden="true"
              data-testid="monitor-hanging-plant"
              className="pointer-events-none absolute left-0 top-0 z-0 h-[calc(100%+4rem)] w-10 overflow-hidden"
            >
              <div className="ficus-plant-hang absolute inset-x-0 top-[calc(100%-4rem)] flex justify-center">
                <div className="ficus-plant-peek py-0.5" data-state={plant.state} onAnimationEnd={plant.onAnimationEnd}>
                  <JumpingPlant />
                </div>
              </div>
            </div>
          )}
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
