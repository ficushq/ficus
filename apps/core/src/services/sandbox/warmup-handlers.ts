import { isLiveAgentStatus } from '@ficus/shared'
import type { Agent } from '../../entities/Agent'
import type { WorkStream } from '../../entities/WorkStream'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import type { EnsureAgentSandboxResult } from './agent-warmup'

const log = createLogger('sandbox-warmup-handlers')

type EnsureAgent = (agent: Agent) => Promise<EnsureAgentSandboxResult>
type LoadAgent = (id: string) => Promise<Agent | null>
type LoadStream = (id: string) => Promise<WorkStream | null>

interface WarmDeps {
  loadAgent?: LoadAgent
  ensureAgent?: EnsureAgent
}

async function defaultLoadAgent(id: string): Promise<Agent | null> {
  const { Agent } = await import('../../entities/Agent')
  return Agent.find(id)
}

async function defaultEnsureAgent(agent: Agent): Promise<EnsureAgentSandboxResult> {
  const { ensureAgentSandbox } = await import('./agent-warmup')
  return ensureAgentSandbox(agent)
}

/** Warm one agent's personal sandbox. Best-effort; never throws. */
export async function warmAgentById(agentId: string, deps: WarmDeps = {}): Promise<void> {
  const loadAgent = deps.loadAgent ?? defaultLoadAgent
  const ensureAgent = deps.ensureAgent ?? defaultEnsureAgent
  try {
    const agent = await loadAgent(agentId)
    if (!agent || !isLiveAgentStatus(agent.status)) return
    await ensureAgent(agent)
  } catch (err) {
    log.warn(`Warm-on-spawn failed for agent ${agentId}:`, err)
  }
}

/** Warm every agent attached to a non-terminal work stream. Best-effort. */
export async function warmWorkStreamAgents(
  workStreamId: string,
  deps: WarmDeps & { loadStream?: LoadStream } = {}
): Promise<void> {
  const loadAgent = deps.loadAgent ?? defaultLoadAgent
  const ensureAgent = deps.ensureAgent ?? defaultEnsureAgent
  const loadStream =
    deps.loadStream ??
    (async (id: string) => {
      const { WorkStream } = await import('../../entities/WorkStream')
      return WorkStream.find(id)
    })
  try {
    const ws = await loadStream(workStreamId)
    if (!ws) return
    if (ws.status === 'done' || ws.status === 'canceled') return
    // Queued (parked) streams hold no concurrency slot: warming their crew
    // would defeat the sandbox gate — demotion just stopped these boxes.
    if (ws.status === 'queued') return
    const { collectWorkStreamAgentIds } = await import('./work-stream-activity')
    for (const id of collectWorkStreamAgentIds(ws)) {
      const agent = await loadAgent(id)
      if (!agent || !isLiveAgentStatus(agent.status)) continue
      await ensureAgent(agent)
    }
  } catch (err) {
    log.warn(`Warm-on-workstream-update failed for ${workStreamId}:`, err)
  }
}

let registered = false

/**
 * Subscribe to spawn + assignment/update events to proactively warm work-stream
 * agents' sandboxes (so handoffs land on a warm box). Idempotent.
 */
export function registerSandboxWarmupHandlers(): void {
  if (registered) return
  registered = true
  eventEmitter.on('squad.agentSpawned', async ({ agentId }) => {
    await warmAgentById(agentId)
  })
  eventEmitter.on('workStream.updated', async ({ workStreamId }) => {
    await warmWorkStreamAgents(workStreamId)
  })
}
