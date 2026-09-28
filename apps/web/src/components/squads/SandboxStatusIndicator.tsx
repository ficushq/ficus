import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { applySquadToolchain, startSandbox, stopSandbox } from '../../api/workspace'
import { CAN_START, CAN_STOP, resolveSandboxStyle, sandboxPollInterval } from '../sandbox/sandboxStatusStyles'
import { resolveVmChainDisplay } from '../sandbox/vmChainHealth'
import { webStatus } from '../../lib/statusPresentation'

/**
 * Pill chrome, owned here rather than by the squad header: this indicator
 * renders nothing on the host runtime, and a wrapper in the header would leave
 * a padded, background-filled empty box behind it.
 */
const PILL = 'px-2 py-0.5 rounded-md bg-surface-secondary inline-flex items-center gap-1.5 text-xs'

interface SandboxStatusIndicatorProps {
  squadId: string
}

export function SandboxStatusIndicator({ squadId }: SandboxStatusIndicatorProps) {
  const queryClient = useQueryClient()

  const { data: status } = useQuery({
    ...queries.sandbox.status(squadId),
    refetchInterval: (query) => sandboxPollInterval(query.state.data),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.sandbox.status(squadId) })
  }

  const startMutation = useMutation({
    mutationFn: () => startSandbox(squadId),
    onSuccess: invalidate,
  })

  const stopMutation = useMutation({
    mutationFn: () => stopSandbox(squadId),
    onSuccess: invalidate,
  })

  const toolchainMutation = useMutation({
    mutationFn: () => applySquadToolchain(squadId),
    onSuccess: invalidate,
  })

  if (!status) return null

  // Host mode: there is no sandbox. The server's "running" only means this
  // process has ensured the squad, and Stop would merely forget that in-memory
  // record — a chip saying so is a header slot spent on a non-thing, so render
  // nothing at all. Runtime is server-driven (never guessed).
  if (status.runtime === 'host') return null

  // Machine-box VMs manage their own lifecycle. Keep health visible without
  // offering an infrastructure restart in the normal squad workflow.
  if (status.runtime === 'vm') {
    const chain = resolveVmChainDisplay(status)
    const toolchainStyle = resolveSandboxStyle(status)
    const provisioning = status.status === 'running' && status.toolchain && status.toolchain.status !== 'ready'
    const label = provisioning ? toolchainStyle.config.label : chain.label
    const detail = provisioning ? toolchainStyle.reason.replace(/^ \(|\)$/g, '') : chain.detail
    const healthy = !provisioning && chain.healthy
    const semanticTreatment = webStatus(healthy ? 'success' : 'attention')
    const treatmentColor = provisioning ? toolchainStyle.config.color : semanticTreatment.textClass
    const treatmentDot = provisioning ? toolchainStyle.config.dotColor : semanticTreatment.markerClass
    const canRetryToolchain = status.toolchain?.status === 'failed' || status.toolchain?.status === 'pending'
    const isBusy = toolchainMutation.isPending

    return (
      <span className={clsx(PILL, treatmentColor)}>
        <span className="relative flex h-2 w-2">
          <span className={clsx('relative inline-flex h-2 w-2 rounded-full', treatmentDot)} />
        </span>
        <span title={detail ? `${label} — ${detail}` : label}>
          {label}
          {detail ? ` — ${detail}` : ''}
        </span>
        {canRetryToolchain && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              toolchainMutation.mutate()
            }}
            disabled={isBusy}
            className="ficus-button ml-1 px-1.5 py-0.5 text-[10px] font-medium rounded text-muted hover:text-primary transition-colors disabled:opacity-40"
            title="Retry toolchain provisioning"
          >
            Retry provisioning
          </button>
        )}
      </span>
    )
  }

  const { config, reason } = resolveSandboxStyle(status)

  const isBusy = startMutation.isPending || stopMutation.isPending || toolchainMutation.isPending
  const canRetryToolchain = status.toolchain?.status === 'failed' || status.toolchain?.status === 'pending'
  const canStart = CAN_START.has(status.status) && !isBusy
  const canStop = CAN_STOP.has(status.status) && !isBusy

  return (
    <span className={clsx(PILL, config.color)}>
      <span className="relative flex h-2 w-2">
        {config.pulse && (
          <span
            className={clsx('absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping', config.dotColor)}
          />
        )}
        <span className={clsx('relative inline-flex h-2 w-2 rounded-full', config.dotColor)} />
      </span>
      <span title={`Sandbox: ${config.label}${reason}`}>
        Sandbox {config.label.toLowerCase()}
        {reason}
      </span>
      {canRetryToolchain && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            toolchainMutation.mutate()
          }}
          disabled={isBusy}
          className="ficus-button ml-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-status-review-600/15 text-status-review-700 dark:text-status-review-400 hover:bg-status-review-600/25 transition-colors disabled:opacity-40"
          title="Retry toolchain provisioning"
        >
          Retry provisioning
        </button>
      )}
      {canStart && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            startMutation.mutate()
          }}
          className="ficus-button ml-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-status-success-600/15 text-status-success-600 dark:text-status-success-400 hover:bg-status-success-600/25 transition-colors"
          title="Start sandbox"
        >
          Start
        </button>
      )}
      {canStop && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            stopMutation.mutate()
          }}
          className="ficus-button ml-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-status-danger-600/15 text-status-danger-600 dark:text-status-danger-400 hover:bg-status-danger-600/25 transition-colors"
          title="Stop sandbox"
        >
          Stop
        </button>
      )}
    </span>
  )
}
