import type { Monitor } from '@ficus/shared'
import { ConfirmButton } from '../ConfirmButton'

const ACTIVE = new Set(['starting', 'running', 'canceling'])

function isActiveMonitor(monitor: Monitor) {
  return ACTIVE.has(monitor.status)
}

function statusClass(status: string) {
  if (status === 'running')
    return 'bg-status-success-100 text-status-success-700 dark:bg-status-success-900/30 dark:text-status-success-300'
  if (status === 'starting')
    return 'bg-status-progress-100 text-status-progress-700 dark:bg-status-progress-900/30 dark:text-status-progress-300'
  if (status === 'canceling')
    return 'bg-status-attention-100 text-status-attention-700 dark:bg-status-attention-900/30 dark:text-status-attention-300'
  if (status === 'canceled') return 'bg-surface-secondary text-muted'
  if (status === 'failed' || status === 'overloaded') {
    return 'bg-status-danger-100 text-status-danger-700 dark:bg-status-danger-900/30 dark:text-status-danger-300'
  }
  return 'bg-surface-secondary text-secondary'
}

export function MonitorsList({
  rows,
  onCancel,
  onSelect,
  showAgentColumn,
  canCancel = false,
  emptyMessage = 'No monitors found.',
}: {
  rows: Monitor[]
  onCancel: (id: string) => void
  onSelect: (monitor: Monitor) => void
  showAgentColumn?: boolean
  canCancel?: boolean
  emptyMessage?: string
}) {
  if (rows.length === 0) {
    return <div className="border-b border-panel-border last:border-b-0 p-4 text-sm text-muted">{emptyMessage}</div>
  }

  return (
    <div className="border-b border-panel-border last:border-b-0 overflow-hidden">
      <table className="ficus-table min-w-full divide-y divide-th-border text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="px-3 py-2 font-semibold">Label</th>
            {showAgentColumn && <th className="px-3 py-2 font-semibold">Agent</th>}
            <th className="px-3 py-2 font-semibold">Status</th>
            <th className="px-3 py-2 font-semibold">Lines / Bytes</th>
            <th className="px-3 py-2 font-semibold">Last batch</th>
            <th className="px-3 py-2 font-semibold">Created</th>
            <th className="px-3 py-2 font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-panel-border text-primary">
          {rows.map((m) => (
            <tr key={m.id} className="hover:bg-surface-hover transition-colors">
              <td className="px-3 py-2">
                <button
                  className="ficus-button font-medium text-accent-light hover:underline"
                  onClick={() => onSelect(m)}
                >
                  {m.label}
                </button>
              </td>
              {showAgentColumn && (
                <td className="px-3 py-2 font-mono text-xs text-secondary">{m.agentId.slice(0, 8)}</td>
              )}
              <td className="px-3 py-2">
                <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${statusClass(m.status)}`}>
                  {m.status}
                </span>
              </td>
              <td className="px-3 py-2 text-secondary">
                {m.linesEmitted} / {m.bytesEmitted}
              </td>
              <td className="px-3 py-2 text-muted">{m.lastBatchAt ?? '-'}</td>
              <td className="px-3 py-2 text-muted">{m.createdAt}</td>
              <td className="px-3 py-2">
                {isActiveMonitor(m) && (
                  <ConfirmButton
                    label="Cancel"
                    onConfirm={() => onCancel(m.id)}
                    disabled={!canCancel}
                    title={canCancel ? 'Cancel monitor' : 'You do not have permission to cancel monitors'}
                    className="ficus-button rounded-md px-2 py-1 text-xs font-medium text-status-danger-600 hover:bg-status-danger-50 dark:text-status-danger-400 dark:hover:bg-status-danger-900/30 transition-colors"
                    confirmClassName="rounded-md bg-status-danger-50 px-2 py-1 text-xs font-medium text-status-danger-700 hover:bg-status-danger-100 dark:bg-status-danger-900/30 dark:text-status-danger-300 dark:hover:bg-status-danger-900/50 transition-colors"
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
