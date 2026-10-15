import { Command } from 'commander'
import { apiGet, apiPost } from '../client'
import { isJsonMode, output, outputError, outputTable } from '../output'

interface Monitor {
  id: string
  label: string
  status: string
  agentId: string
  linesEmitted: number
  lastBatchAt: string | null
  createdAt: string
  restartPolicy?: 'never' | 'on-loss'
  restartCount?: number
  nextRestartAt?: string | null
}

/** "never", or "on-loss" with the relaunch count and a pending relaunch. */
export function formatMonitorRestart(m: Pick<Monitor, 'restartPolicy' | 'restartCount' | 'nextRestartAt'>): string {
  if (m.restartPolicy !== 'on-loss') return 'never'
  const restarts = m.restartCount ?? 0
  return `on-loss (${restarts} restart${restarts === 1 ? '' : 's'}${m.nextRestartAt ? ', relaunch pending' : ''})`
}

export function registerMonitorCommands(program: Command) {
  const monitor = program
    .command('monitor')
    .description('Manage agent-owned background monitors (read/cancel only; create is agent-owned)')

  monitor
    .command('list')
    .description('List monitors')
    .option('--agent <id>', 'Filter by agent')
    .option('--squad <id>', 'Filter by squad')
    .option('--status <csv>', 'Filter by comma-separated statuses')
    .option('--active', 'Only active monitors')
    .action(async (options) => {
      try {
        const params = new URLSearchParams()
        if (options.agent) params.set('agentId', options.agent)
        if (options.squad) params.set('squadId', options.squad)
        if (options.active) params.set('status', 'starting,running,canceling')
        else if (options.status) params.set('status', options.status)
        const query = params.toString()
        const rows = await apiGet<Monitor[]>(`/api/monitors${query ? `?${query}` : ''}`)
        if (isJsonMode()) return output(rows)
        if (rows.length === 0) return console.log('No monitors found')
        outputTable(
          rows.map((m) => ({
            ID: m.id.slice(0, 8),
            Label: m.label.slice(0, 28),
            Status: m.status,
            Restart: formatMonitorRestart(m),
            Agent: m.agentId.slice(0, 8),
            Lines: m.linesEmitted,
            'Last Batch': m.lastBatchAt ?? '-',
            Created: m.createdAt,
          })),
          ['ID', 'Label', 'Status', 'Restart', 'Agent', 'Lines', 'Last Batch', 'Created']
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  monitor
    .command('show <id>')
    .description('Show monitor details')
    .action(async (id) => {
      try {
        output(await apiGet(`/api/monitors/${id}`))
      } catch (error) {
        outputError(error as Error)
      }
    })

  monitor
    .command('logs <id>')
    .description('Print recent monitor logs')
    .option('--tail <n>', 'Number of lines', '100')
    .action(async (id, options) => {
      try {
        const result = await apiGet<{ lines: string[]; note?: string }>(`/api/monitors/${id}/logs?tail=${options.tail}`)
        if (isJsonMode()) return output(result)
        if (result.note) console.error(result.note)
        console.log(result.lines.join('\n'))
      } catch (error) {
        outputError(error as Error)
      }
    })

  monitor
    .command('cancel <id>')
    .description('Cancel an agent-owned monitor (admin safety override)')
    .action(async (id) => {
      try {
        const result = await apiPost(`/api/monitors/${id}/cancel`, {})
        if (isJsonMode()) return output(result)
        console.log(`Canceled monitor ${id}`)
      } catch (error) {
        outputError(error as Error)
      }
    })
}
