import { selectSandboxPresentationState } from '@ficus/shared'
import type { SandboxStatus } from '../../api/workspace'

/** Display for a VM-mode sandbox's chain-health status (see resolveVmChainDisplay). */
export interface VmChainDisplay {
  /** Primary status text, e.g. "Running" or "Machine unreachable". */
  label: string
  /** Optional trailing context, e.g. "starts on next use". */
  detail?: string
  /** True only for the fully-healthy chain — every other state renders as attention-worthy. */
  healthy: boolean
}

/**
 * Resolve a human chain-health display for a VM-mode sandbox: which link in
 * machine → box provisioned → box server is broken, if any.
 *
 * Operator-decided semantics (see squad detail page / agent sandbox info tab):
 * a VM "sandbox" is a unix account + per-box server on a machine host, and it
 * should in general ALWAYS be running — Stop is not a meaningful goal state.
 * So a healthy chain collapses to a plain "Running", and every other state
 * names the broken link instead of a generic "stopped"/"failed".
 *
 * Degrades honestly when the `chain` breakdown is absent from the payload
 * (e.g. an older cached response): falls back to the coarse `status` field
 * rather than guessing which link broke.
 */
export function resolveVmChainDisplay(status: SandboxStatus): VmChainDisplay {
  const chain = status.chain

  switch (status.status) {
    case 'running': {
      if (status.readiness === 'ready_degraded') {
        const labels: Record<string, string> = {
          devbox_unavailable: 'Devbox comfort tools unavailable',
          bashrc_unavailable: 'Shell activation unavailable',
          git_credentials_unavailable: 'Git credentials unavailable',
          transport_recovery_failed: 'Sandbox transport recovery pending',
          callback_transport_degraded: 'Callback transport degraded',
          command_outcome_ambiguous: 'Command cleanup pending',
        }
        const reason = status.degradation?.reasons[0]
        const retry = status.degradation
          ? `Attempt ${status.degradation.attemptCount}${status.degradation.nextAttemptAt ? `; next retry ${status.degradation.nextAttemptAt}` : ''}`
          : undefined
        const detail = [reason ? labels[reason] : undefined, retry].filter(Boolean).join('; ') || undefined
        return { label: 'Running — degraded', detail, healthy: false }
      }
      return { label: 'Running', healthy: true }
    }

    case 'starting':
      switch (selectSandboxPresentationState(status)) {
        case 'idle':
          return { label: 'Idle', detail: 'assets refresh on next start', healthy: true }
        case 'installing_packages':
          return { label: 'Installing packages', healthy: false }
        case 'running_setup':
          return { label: 'Running setup', healthy: false }
        case 'failed':
          return { label: 'Toolchain failed', detail: status.toolchain?.reason, healthy: false }
      }
      // A provisioned box on a reachable machine whose server failed the live
      // probe is NOT provisioning — it was ready and is momentarily not
      // answering (mid-restart / CPU-pegged). The coarse status stays 'starting'
      // (routes + recovery key on it to keep sessions alive); only the wording
      // differs so the pill doesn't claim the box is starting up.
      if (chain && chain.boxProvisioned && chain.boxServer === 'down') {
        return { label: 'Box server unresponsive', detail: 'retrying…', healthy: false }
      }
      return { label: 'Starting…', healthy: false }

    case 'failed':
      if (chain?.machine === 'unreachable') return { label: 'Machine unreachable', healthy: false }
      return { label: 'Failed', detail: status.reason, healthy: false }

    case 'not_found':
    default:
      if (chain && chain.boxProvisioned && chain.boxServer === 'down') {
        return { label: 'Box server down', detail: 'starts on next use', healthy: false }
      }
      if (chain && !chain.boxProvisioned) return { label: 'Not started', healthy: false }
      return { label: 'Not running', healthy: false }
  }
}
