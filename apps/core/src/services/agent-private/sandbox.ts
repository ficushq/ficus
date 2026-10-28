/**
 * The state of an agent's own box, and starting it, for the private-area UI
 * and its terminal.
 *
 * Starting reuses `ensureAgentSandbox`, the same path the warmups use: it
 * materializes skills and the identity key and ensures the box (and the squad
 * box it pairs with). It does not create an execution, deliver a message, or
 * change the agent's status, so the agent's session is not woken. Dormant
 * agents are refused before that call: the vm lifecycle retires a dormant
 * agent's box, so starting one would fight it, and waking the agent is the
 * agent's own lifecycle, not this surface's.
 */

import type { EnsureAgentSandboxResult } from '../sandbox/agent-warmup'
import type { AgentPrivateTarget } from './access'

export interface AgentSandboxState {
  /** Runtime status (`running`, `not_found`, `pending`, …); `unknown` when it could not be read. */
  status: string
  reason?: string
}

export async function getAgentSandboxState(target: AgentPrivateTarget): Promise<AgentSandboxState> {
  const { getSandboxManager } = await import('../sandbox/factory')
  const manager = getSandboxManager()
  try {
    if (manager.getSandboxStatus) {
      // vm: reads recorded chain health and never probes (so never wakes) an idle box.
      const { status, reason } = await manager.getSandboxStatus(target.sandboxId)
      return reason ? { status, reason } : { status }
    }
    return { status: manager.hasSandbox(target.sandboxId) ? 'running' : 'not_found' }
  } catch {
    return { status: 'unknown' }
  }
}

export type StartAgentSandboxOutcome =
  { ok: true } | { ok: false; reason: 'dormant' | Exclude<EnsureAgentSandboxResult, 'ensured'>; message: string }

const START_REFUSALS: Record<Exclude<EnsureAgentSandboxResult, 'ensured'> | 'dormant', string> = {
  dormant: 'This agent is dormant. Its sandbox starts again when the agent wakes.',
  'skipped-subagent': 'This agent shares its parent’s sandbox.',
  'skipped-squad-inactive': 'This agent’s squad is not active.',
  'skipped-maintenance': 'Sandboxes are paused for maintenance. Try again later.',
  'skipped-work-stream-queued': 'This agent’s work is queued, so its sandbox stays stopped until the work is admitted.',
  'skipped-agent-unavailable': 'This agent is no longer available.',
}

export async function startAgentSandbox(
  target: AgentPrivateTarget,
  ensure?: (agent: AgentPrivateTarget['agent']) => Promise<EnsureAgentSandboxResult>
): Promise<StartAgentSandboxOutcome> {
  if (!target.live) return { ok: false, reason: 'dormant', message: START_REFUSALS.dormant }
  const run = ensure ?? (await import('../sandbox/agent-warmup')).ensureAgentSandbox
  const result = await run(target.agent)
  if (result === 'ensured') return { ok: true }
  return { ok: false, reason: result, message: START_REFUSALS[result] }
}
