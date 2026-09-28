import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Agent, Monitor, MonitorStatus } from '@ficus/shared'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { monitorsApi } from '../../api/monitors'
import { MonitorsList } from './MonitorsList'
import { MonitorDetailsModal } from './MonitorDetailsModal'

const ACTIVE: MonitorStatus[] = ['starting', 'running', 'canceling']

export function AgentMonitorsPanel({ agent }: { agent: Agent }) {
  const [showAll, setShowAll] = useState(false)
  const [selected, setSelected] = useState<Monitor | null>(null)
  const queryClient = useQueryClient()
  const { data = [] } = useQuery({
    ...queries.monitors.listForAgent(agent.id, showAll ? undefined : { status: ACTIVE }),
    refetchInterval: showAll ? false : 4000,
  })
  const cancel = useMutation({
    mutationFn: monitorsApi.cancel,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.monitors.all }),
  })
  if (!agent.squadId) return null
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Monitors</h2>
          <p className="text-sm text-status-neutral-500">
            Agent-owned background monitor sessions. Creation is intentionally agent-only; cancel is an admin safety
            override.
          </p>
        </div>
        <button className="ficus-button rounded border px-3 py-1 text-sm" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Active' : 'All'}
        </button>
      </div>
      <MonitorsList rows={data} onCancel={(id) => cancel.mutate(id)} onSelect={setSelected} />
      {selected && (
        <MonitorDetailsModal monitorId={selected.id} initialMonitor={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}
