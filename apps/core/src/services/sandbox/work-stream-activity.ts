import { Agent } from '../../entities/Agent'
import { listAgentActivityRows } from '../../entities/agent-queries'
import { WorkStream } from '../../entities/WorkStream'
import { isLiveAgentStatus, WORK_STREAM_ADMITTED_STATUSES, type WorkStreamStatus } from '@ficus/shared'
import { collectWorkStreamAgentIds } from '../work-streams/agent-ids'
import { RECENT_ACTIVITY_WINDOW_MS } from './squad-activity'

export { collectWorkStreamAgentIds } from '../work-streams/agent-ids'

/**
 * Work-stream statuses that count as "assigned / in progress" for keepalive.
 * Exactly the ADMITTED set of the concurrency cap: `queued` (parked) streams
 * must never keep a sandbox warm — that is the cap's actual resource release.
 */
export const NON_TERMINAL_WORK_STREAM_STATUSES: WorkStreamStatus[] = WORK_STREAM_ADMITTED_STATUSES

export type AgentActivity = Pick<Agent, 'id' | 'lastMessageAt' | 'status'>
type StreamMembership = { assigneeAgentId: string | null; agentIds: string[] | null }
type LoadAgent = (id: string) => Promise<AgentActivity | null>
/** Set-based membership loader; missing ids are simply absent from the result. */
export type LoadAgents = (ids: string[]) => Promise<AgentActivity[]>
type ListStreams = (agentId: string) => Promise<StreamMembership[]>

/** The per-agent half of the predicate — shared by the loop and batch paths. */
function isRecentlyActive(a: AgentActivity | null | undefined, cutoff: number): boolean {
  return !!a && isLiveAgentStatus(a.status) && a.lastMessageAt != null && a.lastMessageAt.getTime() >= cutoff
}

/**
 * True if any of the (non-terminated) agents has lastMessageAt >= cutoff.
 *
 * Production takes the BATCH path: one set-based query for the whole
 * membership. The per-id `loadAgent` seam is kept for callers/tests that
 * already hold a per-id loader (it short-circuits on the first hit, exactly as
 * before); when it is omitted the ids go to `loadAgents` in a single query.
 * A terminated, message-less, or missing agent counts as inactive on both
 * paths, and an empty membership never queries.
 */
export async function anyAgentRecentlyActive(
  agentIds: string[],
  cutoff: number,
  loadAgent?: LoadAgent,
  loadAgents: LoadAgents = listAgentActivityRows
): Promise<boolean> {
  if (agentIds.length === 0) return false
  if (loadAgent) {
    for (const id of agentIds) {
      if (isRecentlyActive(await loadAgent(id), cutoff)) return true
    }
    return false
  }
  return (await loadAgents(agentIds)).some((a) => isRecentlyActive(a, cutoff))
}

/**
 * True if any non-terminal work stream the agent participates in (as assignee or
 * member) has a member that has been active at or after `cutoff`. This is the
 * cross-agent signal: a quiet agent is kept warm while a teammate is active.
 */
export async function hasRecentWorkStreamActivityForAgent(
  agentId: string,
  cutoff: number,
  deps: { listStreams?: ListStreams; loadAgent?: LoadAgent; loadAgents?: LoadAgents } = {}
): Promise<boolean> {
  const listStreams =
    deps.listStreams ?? ((id: string) => WorkStream.listForAgent(id, NON_TERMINAL_WORK_STREAM_STATUSES))
  // The owner check is a single row, so it stays a point lookup — but it only
  // reads authoritative `status`, so it never needs eager squad/agent-type loads.
  const loadOwner = deps.loadAgent ?? ((id: string) => Agent.find(id, { eager: false }))
  // A terminated (or deleted) owner must never be kept warm by teammate
  // activity — this is what lets the idle reaper collect pods whose
  // termination-time cleanup was missed (e.g. a swallowed removeSandbox
  // failure), instead of teammates keeping the dead agent's pod alive.
  const owner = await loadOwner(agentId)
  if (!owner || !isLiveAgentStatus(owner.status)) return false
  const streams = await listStreams(agentId)
  // Membership goes through the SET-BASED loader in production (deps.loadAgent
  // undefined → one query per stream instead of one Agent.find per member).
  const loadAgent = deps.loadAgents ? undefined : deps.loadAgent
  for (const ws of streams) {
    if (await anyAgentRecentlyActive(collectWorkStreamAgentIds(ws), cutoff, loadAgent, deps.loadAgents)) {
      return true
    }
  }
  return false
}

/**
 * Keep-alive predicate for a sandbox id. Only personal agent boxes (`agent_<id>`)
 * are work-stream gated; squad / system-manager sandboxes return false here
 * (their lifecycle is unchanged).
 */
export async function hasRecentWorkStreamActivityForSandbox(
  sandboxId: string,
  deps: { listStreams?: ListStreams; loadAgent?: LoadAgent; loadAgents?: LoadAgents } = {}
): Promise<boolean> {
  const prefix = 'agent_'
  if (!sandboxId.startsWith(prefix)) return false
  const agentId = sandboxId.slice(prefix.length)
  return hasRecentWorkStreamActivityForAgent(agentId, Date.now() - RECENT_ACTIVITY_WINDOW_MS, deps)
}
