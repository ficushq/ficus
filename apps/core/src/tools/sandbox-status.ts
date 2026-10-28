import { getExposureCleanupStatus } from '../services/sandbox/exposure-cleanup'
/**
 * sandbox_status Tool
 *
 * Live status of the sandboxes the agent depends on: its private box and (for
 * squad members) the shared squad box. Always a forced recheck against the
 * cluster/runtime — never the in-memory cache — so it stays truthful when a
 * box just died. Complements the automatic recovery watch: agents can verify
 * a box proactively or mid-outage.
 */

import { Type } from '@sinclair/typebox'
import type { ToolDefinition, AgentToolResult } from '@earendil-works/pi-coding-agent'
import { Agent } from '../entities/Agent'
import { Squad } from '../entities/Squad'
import { mergeSandboxStatus, resolveToolchainStatus } from '../services/sandbox/status'
import { createLogger } from '../lib/infra/logger'
import { SandboxRecoveryStore } from '../services/sandbox/recovery-store'

const log = createLogger('tools')

export interface SandboxStatusDeps {
  /** Live (never cached) status for a sandbox. */
  getLiveStatus: (sandboxId: string) => Promise<{
    status: string
    reason?: string
    devboxReady?: boolean
    assetsRefreshPending?: boolean
    readiness?: 'pending' | 'reconciling' | 'ready' | 'ready_degraded'
    degradation?: { reasons: string[]; attemptCount: number; nextAttemptAt?: string }
    toolchain?: { status: string; reason?: string }
  }>
  /** Whether a recovery watch is active for this agent (a notification will arrive). */
  isWatched: (agentId: string) => Promise<boolean>
}

export interface SandboxStatusToolContext {
  agentId: string
  /** The agent's own (private) sandbox id. */
  sandboxId: string
  /** Set for squad members — the shared squad box is checked too. */
  squadId?: string
}

function describeToolchain(toolchain: { status: string; reason?: string } | undefined): string | undefined {
  if (!toolchain || toolchain.status === 'ready') return undefined
  if (toolchain.status === 'failed') return `toolchain failed${toolchain.reason ? ` (${toolchain.reason})` : ''}`
  if (toolchain.status === 'running_setup') return 'running setup'
  if (toolchain.status === 'installing') return 'installing packages'
  if (toolchain.status === 'pending') return 'toolchain pending'
  return `toolchain ${toolchain.status}`
}

function describeStatus(status: {
  status: string
  reason?: string
  devboxReady?: boolean
  assetsRefreshPending?: boolean
  readiness?: 'pending' | 'reconciling' | 'ready' | 'ready_degraded'
  degradation?: { reasons: string[]; attemptCount: number; nextAttemptAt?: string }
  toolchain?: { status: string; reason?: string }
}): string {
  const toolchain = describeToolchain(status.toolchain)
  if (status.status === 'starting' && status.assetsRefreshPending === true) {
    return toolchain && status.toolchain?.status !== 'pending' ? toolchain : 'idle — assets refresh on next start'
  }
  if (status.status === 'running') {
    if (status.readiness === 'ready_degraded') {
      const labels: Record<string, string> = {
        devbox_unavailable: 'Devbox comfort tools unavailable',
        bashrc_unavailable: 'shell activation unavailable',
        git_credentials_unavailable: 'Git credentials unavailable',
        transport_recovery_failed: 'transport recovery pending',
        callback_transport_degraded: 'callback transport degraded',
        command_outcome_ambiguous: 'command cleanup pending',
      }
      const reason = status.degradation?.reasons[0]
      const retry = status.degradation
        ? `; attempt ${status.degradation.attemptCount}${status.degradation.nextAttemptAt ? `; next retry ${status.degradation.nextAttemptAt}` : ''}`
        : ''
      return `running — setup degraded${reason ? ` (${labels[reason] ?? 'setup component unavailable'}${retry})` : retry}`
    }
    if (toolchain) return toolchain
    return status.devboxReady === false
      ? 'running (installing packages — recently added tools may be missing until install finishes)'
      : 'ready'
  }
  const physical =
    status.status === 'starting' || status.status === 'pending'
      ? `starting${status.reason ? ` (${status.reason})` : ''}`
      : `down (${status.status}${status.reason ? `, reason: ${status.reason}` : ''})`
  return toolchain ? `${physical}; ${toolchain}` : physical
}

function defaultDeps(): SandboxStatusDeps {
  return {
    getLiveStatus: async (sandboxId) => {
      const { getSandboxManager, isRemoteSandboxRuntime } = await import('../services/sandbox/factory')
      const manager = getSandboxManager()
      const physical = isRemoteSandboxRuntime()
        ? await (
            manager as unknown as {
              getSandboxStatus(id: string): Promise<{ status: string; reason?: string; devboxReady?: boolean }>
            }
          ).getSandboxStatus(sandboxId)
        : { status: manager.hasSandbox(sandboxId) ? 'running' : 'not_found', devboxReady: true }

      // The managed-toolchain declaration only DECORATES the physical answer.
      // Resolving it costs two more database round-trips on a live status path,
      // and Agent.find prefix-matches (so it can raise AmbiguousPrefixError) —
      // none of which may be allowed to turn a real status into "down
      // (unknown)", which is what the caller reports when this throws.
      try {
        let squad: Squad | null = null
        if (sandboxId.startsWith('squad_')) squad = await Squad.find(sandboxId.slice('squad_'.length))
        else if (sandboxId.startsWith('agent_')) {
          const agent = await Agent.find(sandboxId.slice('agent_'.length))
          if (agent?.squadId) squad = await Squad.find(agent.squadId)
        }
        return mergeSandboxStatus(
          physical,
          await resolveToolchainStatus(sandboxId, squad),
          await getExposureCleanupStatus(sandboxId, squad?.id)
        )
      } catch (err) {
        log.warn(`Could not resolve managed toolchain status for ${sandboxId}:`, err)
        return physical
      }
    },
    isWatched: (agentId) => new SandboxRecoveryStore().isWatched(agentId),
  }
}

export function createSandboxStatusTool(
  ctx: SandboxStatusToolContext,
  deps: SandboxStatusDeps = defaultDeps()
): ToolDefinition {
  return {
    name: 'sandbox_status',
    label: 'Sandbox Status',
    description:
      'Check the live status of your sandbox(es): your private box and, for squad members, the shared ' +
      'squad box. Always performs a fresh check (never cached), so use it to verify a box after an ' +
      'outage error or before a critical command. Reports ready / starting / installing packages / down.',
    parameters: Type.Object({}),
    async execute(_toolCallId: string): Promise<AgentToolResult<unknown>> {
      const boxes: Array<{ sandboxId: string; role: string }> = [{ sandboxId: ctx.sandboxId, role: 'private box' }]
      if (ctx.squadId) {
        boxes.push({ sandboxId: Squad.getSandboxId(ctx.squadId), role: 'shared squad box' })
      }

      const lines: string[] = []
      const details: Record<string, unknown> = {}
      for (const box of boxes) {
        let status: {
          status: string
          reason?: string
          devboxReady?: boolean
          assetsRefreshPending?: boolean
          toolchain?: { status: string; reason?: string }
        }
        try {
          status = await deps.getLiveStatus(box.sandboxId)
        } catch (err) {
          log.warn(`sandbox_status:${ctx.agentId}: live status check failed for ${box.sandboxId}:`, err)
          status = { status: 'unknown' }
        }
        lines.push(`- \`${box.sandboxId}\` (${box.role}): ${describeStatus(status)}`)
        details[box.sandboxId] = status
      }

      if (await deps.isWatched(ctx.agentId)) {
        lines.push('A recovery watch is active — you will be notified automatically when everything is back online.')
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        details,
      }
    },
  }
}
