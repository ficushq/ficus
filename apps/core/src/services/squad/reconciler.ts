/**
 * Type-driven agent provisioning — spawning, default-agent reconciliation,
 * and flex-agent cleanup. Functions take the live Squad entity (or the
 * squads/args already fetched by the static delegates) so the entity can
 * keep thin delegates.
 */

import { LIVE_AGENT_STATUSES } from '@ficus/shared'
import { and, eq, inArray, isNotNull, isNull, not } from 'drizzle-orm'
import { agents, db, squads } from '../../db'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import type { Agent } from '../../entities/Agent'
import type { CleanupFlexAgentsResult, FlexAgentInfo, Squad } from '../../entities/Squad'

const log = createLogger('squad')

/**
 * Spawn a new agent in this squad.
 * @param agentTypeId - The type of agent to spawn.
 * @param persist - Whether the agent should persist (default: false).
 * @returns The newly created agent.
 */
export async function spawnAgent(
  squad: Squad,
  agentTypeId: string,
  options: { persist?: boolean; model?: string } | boolean = {}
): Promise<Agent> {
  const { Agent } = await import('../../entities/Agent')
  const spawnOptions = typeof options === 'boolean' ? { persist: options } : options

  const agent = await Agent.create({
    agentTypeId,
    squadId: squad.id,
    persist: spawnOptions.persist ?? false,
    modelOverride: spawnOptions.model ?? null,
    metadata: {
      spawnedAt: new Date().toISOString(),
    },
  })

  eventEmitter.emit('squad.agentSpawned', { squadId: squad.id, agentId: agent.id })
  return agent
}

/**
 * Reconcile this squad's agents to match its desired defaultAgents.
 * Spawns any missing default agents with persist=true. Never terminates
 * agents — extras just become non-persistent (unspawn-eligible).
 *
 * @returns The number of agents spawned.
 */
export async function reconcileAgents(squad: Squad): Promise<number> {
  if (squad.status !== 'active') return 0
  if (squad.defaultAgents.length === 0) return 0

  // One query prevents a concurrent live/dormant transition from duplicating
  // or omitting an addressable agent in the desired persistent roster.
  const existing = await squad.getAddressableAgents()

  // Count agents by type
  const counts = new Map<string, number>()
  for (const a of existing) {
    counts.set(a.agentTypeId, (counts.get(a.agentTypeId) ?? 0) + 1)
  }

  // Count how many of each type are desired
  const desired = new Map<string, number>()
  for (const t of squad.defaultAgents) {
    desired.set(t, (desired.get(t) ?? 0) + 1)
  }

  // Ensure at least one manager agent is present
  desired.set('manager', desired.get('manager') || 1)

  let spawned = 0
  for (const [agentTypeId, need] of desired) {
    const have = counts.get(agentTypeId) ?? 0
    for (let i = have; i < need; i++) {
      await spawnAgent(squad, agentTypeId, true) // persist=true for default agents
      spawned++
    }
  }

  if (spawned > 0) {
    log.info(`reconcile: Squad ${squad.id}: spawned ${spawned} default agent(s)`)
  }

  // Enforce persist flags:
  // - Default agents (as defined by desired counts) should have persist=true
  // - Extra agents should have persist=false (unspawn-eligible)
  // - Manager agents should always have persist=true
  const agentsNow = spawned > 0 ? await squad.getAddressableAgents() : existing

  const byType = new Map<string, Agent[]>()
  for (const a of agentsNow) {
    const list = byType.get(a.agentTypeId) ?? []
    list.push(a)
    byType.set(a.agentTypeId, list)
  }

  // Stable ordering: oldest agents are considered the default set first.
  for (const list of byType.values()) {
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  }

  const persistIds = new Set<string>()

  // Managers are always persistent.
  for (const a of agentsNow) {
    if (a.agentTypeId === 'manager') persistIds.add(a.id)
  }

  for (const [agentTypeId, need] of desired) {
    const list = byType.get(agentTypeId) ?? []
    for (let i = 0; i < Math.min(need, list.length); i++) {
      persistIds.add(list[i].id)
    }
  }

  let persistUpdates = 0
  for (const a of agentsNow) {
    const shouldPersist = persistIds.has(a.id)
    if (a.persist === shouldPersist) continue

    // Never set manager persist=false.
    if (a.agentTypeId === 'manager') {
      if (!a.persist) {
        await db.update(agents).set({ persist: true, updatedAt: new Date() }).where(eq(agents.id, a.id))
        persistUpdates++
      }
      continue
    }

    await db.update(agents).set({ persist: shouldPersist, updatedAt: new Date() }).where(eq(agents.id, a.id))
    persistUpdates++
  }

  if (persistUpdates > 0) {
    log.info(`reconcile: Squad ${squad.id}: updated persist for ${persistUpdates} agent(s)`)
  }

  return spawned
}

/**
 * Make eligible live flex agents dormant, retaining their history and worktrees.
 * @param dryRun If true, preview eligibility without requesting dormancy.
 * @param squadId Canonical authorized squad ID; omitted for the administrator global sweep.
 * Authorization belongs to the caller. Scoped requests filter before loading any candidates.
 */
export async function cleanupFlexAgents(dryRun = false, squadId?: string): Promise<CleanupFlexAgentsResult> {
  const flexAgents = await db
    .select({
      id: agents.id,
      metadata: agents.metadata,
      agentTypeId: agents.agentTypeId,
      squadId: agents.squadId,
    })
    .from(agents)
    .where(
      and(
        squadId === undefined ? undefined : eq(agents.squadId, squadId),
        not(eq(agents.agentTypeId, 'manager')),
        not(eq(agents.agentTypeId, 'consultant')),
        inArray(agents.status, [...LIVE_AGENT_STATUSES]),
        eq(agents.persist, false),
        isNotNull(agents.squadId),
        isNull(agents.parentAgentId)
      )
    )

  // Get squad names for agents that have squadId
  const squadIds = [...new Set(flexAgents.map((a) => a.squadId).filter(Boolean))] as string[]
  const squadMap = new Map<string, string>()
  if (squadIds.length > 0) {
    const squadRows = await db
      .select({ id: squads.id, name: squads.name })
      .from(squads)
      .where(inArray(squads.id, squadIds))
    for (const row of squadRows) {
      squadMap.set(row.id, row.name)
    }
  }

  const terminatedAgents: FlexAgentInfo[] = []
  const deferredAgents: FlexAgentInfo[] = []

  // Dynamic import to avoid circular dependency
  const { Agent } = await import('../../entities/Agent')

  for (const agentRow of flexAgents) {
    const agent = await Agent.mustFind(agentRow.id)
    const meta = agentRow.metadata as Record<string, unknown> | null
    const info: FlexAgentInfo = {
      id: agentRow.id,
      name: (meta?.name as string) ?? null,
      agentTypeId: agentRow.agentTypeId,
      squadName: agentRow.squadId ? (squadMap.get(agentRow.squadId) ?? null) : null,
    }

    if (dryRun) {
      if ((await agent.canTerminate()).canTerminate) terminatedAgents.push(info)
      continue
    }

    try {
      await agent.tryTerminate()
      // tryTerminate may only enqueue dormancy, and does not refresh the entity
      // in that case. Report persisted lifecycle state, not promise fulfillment.
      await agent.reload()
      if (agent.status === 'dormant') terminatedAgents.push(info)
      else if (agent.pendingDormancyAt) deferredAgents.push(info)
    } catch {
      // Eligibility can change since the candidate query; guarded lifecycle wins.
    }
  }

  return {
    checked: flexAgents.length,
    terminated: terminatedAgents.length,
    agents: terminatedAgents,
    deferred: deferredAgents.length,
    deferredAgents,
  }
}
