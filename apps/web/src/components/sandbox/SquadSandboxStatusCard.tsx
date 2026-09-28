import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { queries } from '../../queryOptions'
import { sandboxPollInterval } from './sandboxStatusStyles'
import { SandboxStatusBadge } from './SandboxStatusBadge'
import { resolveVmChainDisplay } from './vmChainHealth'
import { webStatus } from '../../lib/statusPresentation'
import { isSandboxOverloaded } from '@ficus/shared'
import { PressureSummary } from './SandboxProcesses'

/** Read-only status of the squad's shared warm sandbox. */
export function SquadSandboxStatusCard({ squadId, compact = false }: { squadId: string; compact?: boolean }) {
  const { data: status } = useQuery({
    ...queries.sandbox.status(squadId),
    refetchInterval: (query) => sandboxPollInterval(query.state.data),
  })

  if (!status)
    return compact ? (
      <dl className="flex items-center gap-2">
        <dt className="text-xs text-muted">Squad</dt>
        <dd className="text-xs text-muted">Loading…</dd>
      </dl>
    ) : null

  // Host mode: there is no squad sandbox to report on, and AgentSandboxControls
  // — directly above this card in AgentInfoPanel — already carries the "agents
  // run on this machine, there is no sandbox" note. Repeating it here just
  // printed the same paragraph twice, so stand down entirely.
  if (status.runtime === 'host') return null

  const display = resolveVmChainDisplay(status)
  const treatment = webStatus(display.healthy ? 'success' : 'attention')

  return (
    <dl className={compact ? 'flex flex-wrap items-center gap-x-2 gap-y-1' : 'border-b border-panel-border py-3'}>
      <dt className={compact ? 'text-xs text-muted' : 'text-xs font-medium uppercase tracking-wide text-muted'}>
        {compact ? 'Squad' : 'Squad sandbox'}
      </dt>
      <dd className={compact ? 'flex flex-wrap items-center gap-2' : 'mt-2'}>
        <div className="flex flex-wrap items-center gap-2">
          {status.runtime === 'vm' ? (
            <span
              className={clsx('inline-flex items-center gap-1.5 text-sm', treatment.textClass)}
              title={display.detail ? `${display.label} — ${display.detail}` : display.label}
            >
              <span className={clsx('h-2 w-2 rounded-full', treatment.markerClass)} />
              {display.label}
            </span>
          ) : (
            <SandboxStatusBadge status={status} />
          )}
        </div>
        {display.detail && <p className="mt-1 text-xs text-muted">{display.detail}</p>}
        {isSandboxOverloaded(status.pressure) && status.pressure && (
          <div className="mt-1">
            <PressureSummary pressure={status.pressure} />
          </div>
        )}
      </dd>
    </dl>
  )
}
