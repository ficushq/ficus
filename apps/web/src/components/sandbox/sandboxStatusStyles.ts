import { SANDBOX_STATUS_ROLE, selectSandboxPresentationState, type SandboxPresentationState } from '@ficus/shared'
import type { SandboxStatus } from '../../api/workspace'
import { webStatus } from '../../lib/statusPresentation'

/** Visual treatment for a single sandbox status. */
export interface StatusStyle {
  label: string
  color: string
  dotColor: string
  pulse?: boolean
}

const SANDBOX_LABEL: Record<SandboxPresentationState, string> = {
  not_found: 'Not running',
  pending: 'Initializing',
  starting: 'Starting',
  running: 'Running',
  succeeded: 'Completed',
  failed: 'Failed',
  terminating: 'Stopping',
  unknown: 'Unknown',
  installing_packages: 'Installing packages',
  running_setup: 'Running setup',
  degraded: 'Running — degraded',
}

const PULSING_STATES = new Set<SandboxPresentationState>([
  'pending',
  'starting',
  'terminating',
  'installing_packages',
  'running_setup',
])

function styleForState(state: SandboxPresentationState): StatusStyle {
  const treatment = webStatus(SANDBOX_STATUS_ROLE[state])
  return {
    label: SANDBOX_LABEL[state],
    color: treatment.textClass,
    dotColor: treatment.markerClass,
    pulse: PULSING_STATES.has(state) || undefined,
  }
}

/** Statuses that indicate the pod is in transition and should be polled frequently. */
export const TRANSITIONING = new Set<string>(['pending', 'starting', 'terminating'])

/** Statuses where the sandbox can be stopped. */
export const CAN_STOP = new Set<string>(['running', 'pending', 'starting'])

/** Statuses where the sandbox can be started. */
export const CAN_START = new Set<string>(['not_found', 'failed', 'succeeded'])

/**
 * Safety-net poll interval (ms). Live WebSocket `sandbox.status` events drive
 * real-time updates; this slow poll only backstops a dropped event (the
 * WebSocket reconnect path re-subscribes but does not refetch). One interval
 * for every state. The `status` arg is kept so callers can pass
 * `query.state.data` unchanged.
 */
export const SANDBOX_STATUS_POLL_MS = 30_000

export function sandboxPollInterval(_status?: SandboxStatus): number {
  return SANDBOX_STATUS_POLL_MS
}

/** Reasons that merely echo the label and so add no information. */
const REDUNDANT_REASONS = new Set(['Scheduling', 'Pending', 'Running', 'PodInitializing', 'ContainerCreating'])

/** Resolve the display style and a human reason suffix (e.g. " (CrashLoopBackOff)") for a status. */
export function resolveSandboxStyle(status: SandboxStatus): { config: StatusStyle; reason: string } {
  const toolchain = status.toolchain
  const isRunning = status.status === 'running'
  const presentationState = selectSandboxPresentationState(status)
  const config = styleForState(presentationState)
  if (isRunning) {
    const safeReason = toolchain?.status === 'failed' ? toolchain.reason : status.reason
    return { config, reason: safeReason && !REDUNDANT_REASONS.has(safeReason) ? ` (${safeReason})` : '' }
  }
  const physicalReason = status.reason && !REDUNDANT_REASONS.has(status.reason) ? ` (${status.reason})` : ''
  const toolchainDetail =
    toolchain?.status === 'failed'
      ? `Toolchain failed${toolchain.reason ? ` (${toolchain.reason})` : ''}`
      : toolchain?.status === 'running_setup'
        ? 'Running setup'
        : toolchain?.status === 'installing'
          ? 'Installing packages'
          : toolchain?.status === 'pending'
            ? 'Toolchain pending'
            : undefined
  return { config, reason: `${physicalReason}${toolchainDetail ? `; ${toolchainDetail}` : ''}` }
}
