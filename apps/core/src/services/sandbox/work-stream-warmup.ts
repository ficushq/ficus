import { isLiveAgentStatus } from '@ficus/shared'
import { Agent } from '../../entities/Agent'
import { listAgentActivityRows } from '../../entities/agent-queries'
import { WorkStream } from '../../entities/WorkStream'
import { RECENT_ACTIVITY_WINDOW_MS } from './squad-activity'
import { ensureAgentSandbox, type EnsureAgentSandboxResult } from './agent-warmup'
import {
  NON_TERMINAL_WORK_STREAM_STATUSES,
  anyAgentRecentlyActive,
  collectWorkStreamAgentIds,
  type AgentActivity,
} from './work-stream-activity'
import type { BoxLivenessHintResolver } from './types'

const WARMUP_CONCURRENCY = 3

interface Logger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

type StreamMembership = { assigneeAgentId: string | null; agentIds: string[] | null }

interface WarmupOptions {
  ensureAgent?: (
    agent: Agent,
    opts?: { resolveBoxLiveness?: BoxLivenessHintResolver }
  ) => Promise<EnsureAgentSandboxResult>
  listStreams?: () => Promise<StreamMembership[]>
  /** Point lookup for the agents actually being warmed (needs the whole row). */
  loadAgent?: (id: string) => Promise<Pick<Agent, 'id' | 'lastMessageAt' | 'status' | 'parentAgentId'> | null>
  /** Set-based activity lookup for stream membership. Defaults to one query. */
  loadAgentActivity?: (ids: string[]) => Promise<AgentActivity[]>
  /**
   * vm runtime: resolves each warmed box's liveness from what the caller already
   * observed (the lifecycle tick's per-machine `ss -ltnH`), so this sweep never
   * HTTP-probes — and so never wakes — a socket-activated box that has stood down.
   */
  resolveBoxLiveness?: BoxLivenessHintResolver
}

/**
 * Keep work-stream agents' personal sandboxes warm: for every non-terminal work
 * stream that has a member active within the last 30 minutes, ensure the boxes of
 * ALL of that stream's members. This is the cross-agent keepalive that prevents
 * cascading cold-starts when work is handed off between teammates.
 *
 * vm-runtime note: under the vm runtime's always-on default (vm/idle.ts's
 * `vmBoxAlwaysOnDefault`, applied both at ensure time and in the idle-reap
 * sweep — see vm/lifecycle.ts) a vm box is never idle-parked in the first
 * place, so every re-ensure this warmup drives for a vm box lands on
 * box-manager's pre-existing HEALTHY fast path (one `/healthz` probe, no
 * mutation) instead of reviving a parked one. This function is therefore a
 * genuine no-op for the vm runtime in steady state — but it is NOT deleted:
 * it stays runtime-agnostic and still does real, necessary work for k8s/
 * docker, where boxes remain idle-parked based on activity.
 */
export async function warmupWorkStreamAgentSandboxes(log: Logger, options: WarmupOptions = {}): Promise<void> {
  const { maintenanceStore } = await import('../maintenance/store')
  if (maintenanceStore.isPausedCached()) return
  const ensureAgent = options.ensureAgent ?? ensureAgentSandbox
  const listStreams = options.listStreams ?? (() => WorkStream.list({ statuses: NON_TERMINAL_WORK_STREAM_STATUSES }))
  // The warm step needs a whole agent row, but only row fields — never the
  // eager squad/agent-type loads `Agent.find` does by default.
  const loadAgent = options.loadAgent ?? ((id: string) => Agent.find(id, { eager: false }))
  // Activity resolution is SET-BASED: one query for every member of every
  // stream. Previously this was one eager `Agent.find` per member PER STREAM,
  // which is what made this the heaviest step of the 60s lifecycle tick.
  const loadAgentActivity: (ids: string[]) => Promise<AgentActivity[]> =
    options.loadAgentActivity ??
    (options.loadAgent
      ? async (ids: string[]) => {
          const rows = await Promise.all(ids.map((id) => loadAgent(id)))
          return rows.filter((a) => a != null) as AgentActivity[]
        }
      : listAgentActivityRows)

  const streams = await listStreams()
  if (streams.length === 0) return

  const cutoff = Date.now() - RECENT_ACTIVITY_WINDOW_MS
  const membership = streams.map((ws) => collectWorkStreamAgentIds(ws))
  const allIds = [...new Set(membership.flat())]
  if (allIds.length === 0) return

  const activityById = new Map<string, AgentActivity>()
  for (const row of await loadAgentActivity(allIds)) activityById.set(row.id, row)
  const lookup = async (id: string) => activityById.get(id) ?? null

  const toWarm = new Set<string>()
  for (const ids of membership) {
    if (ids.length === 0) continue
    if (await anyAgentRecentlyActive(ids, cutoff, lookup)) {
      ids.forEach((id) => toWarm.add(id))
    }
  }
  if (toWarm.size === 0) return

  log.info(`Warming ${toWarm.size} work-stream agent sandbox(es)`)

  const ids = [...toWarm]
  let nextIndex = 0
  async function warmNext(): Promise<void> {
    while (nextIndex < ids.length) {
      const id = ids[nextIndex++]
      try {
        const agent = await loadAgent(id)
        if (!agent || !isLiveAgentStatus(agent.status) || agent.parentAgentId != null) continue
        await ensureAgent(agent as Agent, { resolveBoxLiveness: options.resolveBoxLiveness })
      } catch (err) {
        log.warn(`Work-stream agent sandbox warmup failed for ${id}:`, err)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(WARMUP_CONCURRENCY, ids.length) }, () => warmNext()))
}
