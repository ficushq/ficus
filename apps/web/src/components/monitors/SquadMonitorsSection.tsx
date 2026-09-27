import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Monitor, MonitorStatus } from '@ficus/shared'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { monitorsApi } from '../../api/monitors'
import { MonitorsList } from './MonitorsList'
import { MonitorDetailsModal } from './MonitorDetailsModal'
import { usePermissions } from '../../hooks/usePermissions'

const ACTIVE: MonitorStatus[] = ['starting', 'running', 'canceling']

export function SquadMonitorsSection({ squadId }: { squadId: string }) {
  const [showAll, setShowAll] = useState(false)
  const [selected, setSelected] = useState<Monitor | null>(null)
  const queryClient = useQueryClient()
  const { can, isLoading: permissionsLoading } = usePermissions(squadId)
  const canCancelMonitors = !permissionsLoading && can('monitors:write')
  const { data = [] } = useQuery({
    ...queries.monitors.listForSquad(squadId, showAll ? undefined : { status: ACTIVE }),
    refetchInterval: showAll ? false : 4000,
  })
  const cancel = useMutation({
    mutationFn: monitorsApi.cancel,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.monitors.all }),
  })
  return (
    <section aria-label="Squad monitors">
      <div className="mb-4 flex items-center justify-between gap-4">
        <span className="text-xs text-muted">
          {data.length} {showAll ? 'total' : 'active'}
        </span>
        <button
          className="ficus-button shrink-0 rounded-md border border-th-border px-3 py-1.5 text-sm font-medium text-secondary hover:bg-surface-hover hover:text-primary transition-colors"
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? 'Active only' : 'View all'}
        </button>
      </div>
      <MonitorsList
        rows={data}
        onCancel={(id) => cancel.mutate(id)}
        onSelect={setSelected}
        showAgentColumn
        canCancel={canCancelMonitors}
        emptyMessage={
          showAll
            ? 'No monitors exist for this squad yet.'
            : 'No active monitors. Use View all to see completed or canceled monitors.'
        }
      />
      {selected && (
        <MonitorDetailsModal monitorId={selected.id} initialMonitor={selected} onClose={() => setSelected(null)} />
      )}
    </section>
  )
}
