import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { restartAgentSandbox, stopAgentSandbox } from '../api/agents'
import { CAN_START, CAN_STOP, TRANSITIONING, sandboxPollInterval } from './sandbox/sandboxStatusStyles'
import { SandboxStatusBadge } from './sandbox/SandboxStatusBadge'
import { resolveVmChainDisplay } from './sandbox/vmChainHealth'
import { HOST_RUNTIME_NOTE } from './sandbox/hostRuntime'
import { webStatus } from '../lib/statusPresentation'
import { isSandboxOverloaded } from '@ficus/shared'
import { PressureSummary, SandboxProcesses } from './sandbox/SandboxProcesses'

interface AgentSandboxControlsProps {
  agentId: string
  compact?: boolean
}

/**
 * Live status + Stop/Restart controls for an agent's individual light sandbox.
 * Controls only appear when the box is this agent's own (`controllable`); a
 * shared box (squad/system-manager/consultant) is shown read-only.
 */
export function AgentSandboxControls({ agentId, compact = false }: AgentSandboxControlsProps) {
  const queryClient = useQueryClient()

  const { data: status } = useQuery({
    ...queries.agents.sandboxStatus(agentId),
    refetchInterval: (query) => sandboxPollInterval(query.state.data),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.sandboxStatus(agentId) })
  }

  const stopMutation = useMutation({
    mutationFn: () => stopAgentSandbox(agentId),
    onSuccess: invalidate,
  })

  const restartMutation = useMutation({
    mutationFn: () => restartAgentSandbox(agentId),
    onSuccess: invalidate,
  })

  const rowClass = compact ? 'flex flex-wrap items-center gap-x-2 gap-y-1' : 'border-b border-panel-border py-3'
  const labelClass = compact ? 'text-xs text-muted' : 'text-xs font-medium uppercase tracking-wide text-muted'
  const valueClass = compact ? 'flex flex-wrap items-center gap-2' : 'mt-2 flex flex-wrap items-center gap-2'
  if (!status)
    return compact ? (
      <dl className={rowClass}>
        <dt className={labelClass}>Agent</dt>
        <dd className="text-xs text-muted">Loading…</dd>
      </dl>
    ) : null

  // Host mode: the agent has no box of its own — stop/restart would only
  // forget an in-memory record. Explain instead of offering controls.
  if (status.runtime === 'host') {
    return (
      <dl className={rowClass}>
        <dt className={labelClass}>{compact ? 'Agent' : 'Sandbox'}</dt>
        <dd className="text-xs text-muted" title={HOST_RUNTIME_NOTE}>
          {compact ? 'Host runtime' : HOST_RUNTIME_NOTE}
        </dd>
      </dl>
    )
  }

  const isBusy = stopMutation.isPending || restartMutation.isPending
  const controllable = status.controllable === true

  // Machine-box lifecycle is infrastructure, so the agent info panel only shows health.
  if (status.runtime === 'vm') {
    const { label, detail, healthy } = resolveVmChainDisplay(status)
    const treatment = webStatus(healthy ? 'success' : 'attention')
    return (
      <dl className={rowClass}>
        <dt className={labelClass}>{compact ? 'Agent' : 'Sandbox'}</dt>
        <dd className={valueClass}>
          <span className={clsx('inline-flex items-center gap-1.5 text-sm', treatment.textClass)}>
            <span className="relative flex h-2 w-2">
              <span className={clsx('relative inline-flex h-2 w-2 rounded-full', treatment.markerClass)} />
            </span>
            <span title={detail ? `${label} — ${detail}` : label}>
              {label}
              {detail ? ` — ${detail}` : ''}
            </span>
          </span>
        </dd>
      </dl>
    )
  }

  const canStop = controllable && CAN_STOP.has(status.status) && !isBusy
  // Restart re-provisions a fresh box; offer it whenever the box is ours and not mid-transition.
  const canRestart = controllable && !TRANSITIONING.has(status.status) && !isBusy
  // When there's no live box, the same action reads as "Start" rather than "Restart".
  const isStart = CAN_START.has(status.status)

  return (
    <dl className={rowClass}>
      <dt className={labelClass}>{compact ? 'Agent' : 'Sandbox'}</dt>
      <dd className={valueClass}>
        <SandboxStatusBadge status={status} />
        {canStop && (
          <button
            onClick={() => stopMutation.mutate()}
            className="ficus-button ml-auto rounded bg-status-danger-600/15 px-2 py-0.5 text-xs font-medium text-status-danger-600 transition-colors hover:bg-status-danger-600/25 dark:text-status-danger-400"
            title="Stop sandbox"
          >
            Stop
          </button>
        )}
        {canRestart && (
          <button
            onClick={() => restartMutation.mutate()}
            className={clsx(
              'ficus-button',
              'rounded bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent-light transition-colors hover:bg-accent/25',
              !canStop && 'ml-auto'
            )}
            title={isStart ? 'Start sandbox' : 'Restart sandbox'}
          >
            {isStart ? 'Start' : 'Restart'}
          </button>
        )}
      </dd>
      {!controllable && <p className="mt-1 text-xs text-muted">Shared sandbox — not individually controllable.</p>}
      {isSandboxOverloaded(status.pressure) && status.pressure && (
        <div className="mt-1">
          <PressureSummary pressure={status.pressure} />
        </div>
      )}
      {controllable && !compact && status.status === 'running' && (
        <div className="mt-3">
          <SandboxProcesses target={{ kind: 'agent', agentId }} />
        </div>
      )}
    </dl>
  )
}
