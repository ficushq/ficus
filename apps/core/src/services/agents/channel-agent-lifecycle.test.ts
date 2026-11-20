import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { randomUUID } from 'crypto'
import { eq, inArray, sql } from 'drizzle-orm'
import { db, agents, executions, inbox, messages, squads } from '../../db'
import { Agent } from '../../entities/Agent'
import {
  channelBoundAgentSql,
  DORMANT_STORAGE_RECLAIMED_AT_KEY,
  isChannelBoundAgent,
} from '../../entities/agent-queries'
import { Squad } from '../../entities/Squad'
import { makeDormant } from '../agent/lifecycle'
import { consultantSandboxId } from '../sandbox/consultant-sandbox'
import { storageAgentColumns, storageAgentInfo } from '../storage/agents'
import { requestDormantRemoval, runDormantAgentSweep, stopAndArchivePersonalSandbox } from './cleanup'
import { makeIdleConsultantsDormant, resetIdleConsultantBackoffForTest } from './idle-consultants'

const DAY = 24 * 60 * 60 * 1000
const RETENTION_DAYS = 3

/** The context ChannelInstance.queueForConsultant gives a channel consultant. */
const channelContext = () => ({
  scope: { type: 'consultant' },
  origin: 'channel',
  channelInstance: { id: randomUUID(), provider: 'slack' },
  thread: { id: `thread-${randomUUID()}`, channelId: 'C123' },
})

describe('channel-bound agent lifecycle', () => {
  let squad: Squad
  let agentIds: string[]

  beforeEach(async () => {
    agentIds = []
    resetIdleConsultantBackoffForTest()
    squad = await Squad.create({ name: `channel-agents-${randomUUID()}`, purpose: 'channel agent lifecycle fixture' })
  })

  afterEach(async () => {
    // Own every fixture: never sweep another test's agents.
    if (agentIds.length) {
      await db.delete(executions).where(inArray(executions.agentId, agentIds))
      await db.delete(messages).where(inArray(messages.agentId, agentIds))
      await db.delete(inbox).where(inArray(inbox.recipientId, agentIds))
      await db.delete(agents).where(inArray(agents.id, agentIds))
    }
    await db.delete(squads).where(eq(squads.id, squad.id))
  })

  async function channelAgent() {
    const created = await Agent.create({
      agentTypeId: 'consultant',
      squadId: squad.id,
      persist: false,
      context: channelContext(),
    })
    agentIds.push(created.id)
    return created
  }

  async function plainAgent(agentTypeId = 'consultant') {
    const created = await Agent.create({ agentTypeId, squadId: squad.id, persist: false })
    agentIds.push(created.id)
    return created
  }

  /** Dormant for longer than the retention period. */
  async function dormantPastRetention(agent: Agent, daysAgo = RETENTION_DAYS + 1) {
    await makeDormant(agent)
    const dormantAt = new Date(Date.now() - daysAgo * DAY)
    await db.update(agents).set({ dormantAt }).where(eq(agents.id, agent.id))
    return dormantAt
  }

  /** Only this file's agents: the sweep is global and other fixtures may be dormant too. */
  const ours = (ids: string[]) => ids.filter((id) => agentIds.includes(id))
  const fresh = (id: string) => Agent.mustFind(id, { eager: false })
  const sweep = (reclaimStorage: (id: string) => Promise<boolean>) =>
    runDormantAgentSweep({ getRetentionDays: () => RETENTION_DAYS, maxCandidates: 25, reclaimStorage })
  async function info(id: string) {
    const [row] = await db.select(storageAgentColumns).from(agents).where(eq(agents.id, id))
    return storageAgentInfo(row!)
  }

  it('identifies only top-level consultants bound to a channel instance, in TypeScript and SQL alike', async () => {
    const channel = await channelAgent()
    const web = await plainAgent()
    const worker = await Agent.create({
      agentTypeId: 'engineer',
      squadId: squad.id,
      persist: false,
      context: channelContext(),
    })
    agentIds.push(worker.id)
    const child = await Agent.create({
      agentTypeId: 'consultant',
      squadId: squad.id,
      persist: false,
      parentAgentId: channel.id,
      context: channelContext(),
    })
    agentIds.push(child.id)

    const rows = await db
      .select({ id: agents.id, bound: sql<boolean>`${channelBoundAgentSql}` })
      .from(agents)
      .where(inArray(agents.id, [channel.id, web.id, worker.id, child.id]))
    const bound = new Map(rows.map((row) => [row.id, row.bound]))
    for (const agent of [channel, web, worker, child]) {
      const loaded = await fresh(agent.id)
      expect(bound.get(agent.id)).toBe(isChannelBoundAgent(loaded))
    }
    expect(isChannelBoundAgent(await fresh(channel.id))).toBe(true)
    expect(isChannelBoundAgent(await fresh(web.id))).toBe(false)
    expect(isChannelBoundAgent(await fresh(worker.id))).toBe(false)
    expect(isChannelBoundAgent(await fresh(child.id))).toBe(false)
  })

  it('goes dormant through the idle-consultant setting once idle, without anyone setting persist', async () => {
    const idle = await channelAgent()
    const recent = await channelAgent()
    await db
      .update(agents)
      .set({ lastMessageAt: new Date(Date.now() - 40 * DAY) })
      .where(eq(agents.id, idle.id))
    await db
      .update(agents)
      .set({ lastMessageAt: new Date(Date.now() - 2 * DAY) })
      .where(eq(agents.id, recent.id))

    const result = await makeIdleConsultantsDormant(squad.id, 30)
    expect(result.dormant).toEqual([idle.id])
    expect((await fresh(idle.id)).status).toBe('dormant')
    expect((await fresh(recent.id)).status).toBe('idle')
  })

  it('dormant retention reclaims its storage once and never terminates it, while others are still terminated', async () => {
    const channel = await channelAgent()
    const dormantAt = await dormantPastRetention(channel)
    const webConsultant = await plainAgent()
    await dormantPastRetention(webConsultant)
    const worker = await plainAgent('engineer')
    await dormantPastRetention(worker)
    const notYet = await channelAgent()
    await dormantPastRetention(notYet, RETENTION_DAYS - 1)

    const reclaimed: string[] = []
    const reclaim = async (id: string) => {
      reclaimed.push(id)
      return true
    }
    await sweep(reclaim)

    expect(ours(reclaimed)).toEqual([channel.id])
    const after = await fresh(channel.id)
    expect(after.status).toBe('dormant')
    expect((after.metadata as Record<string, unknown>)[DORMANT_STORAGE_RECLAIMED_AT_KEY]).toBe(dormantAt.getTime())
    expect((await fresh(webConsultant.id)).status).toBe('terminated')
    expect((await fresh(worker.id)).status).toBe('terminated')
    expect((await fresh(notYet.id)).status).toBe('dormant')
    expect(await info(channel.id)).toMatchObject({ channelBound: true, storageReclaimed: true })

    // Done for this dormancy: later ticks neither reclaim again nor terminate.
    await sweep(reclaim)
    await sweep(reclaim)
    expect(ours(reclaimed)).toEqual([channel.id])
    expect((await fresh(channel.id)).status).toBe('dormant')
  })

  it('reclaims through the personal-box cleanup: the box is removed and /private archived', async () => {
    const channel = await channelAgent()
    await dormantPastRetention(channel)
    const removed: string[] = []
    const archived: string[] = []
    const manager = {
      removeSandbox: async (sandboxId: string) => {
        removed.push(sandboxId)
      },
    }
    await sweep((id) =>
      stopAndArchivePersonalSandbox(id, {
        getManager: () => manager,
        archive: (sandboxId) => {
          archived.push(sandboxId)
          return `/archive/${sandboxId}`
        },
      })
    )
    expect(ours(removed.map((id) => id.replace(/^agent_/, '')))).toEqual([channel.id])
    expect(archived).toContain(`agent_${channel.id}`)
    expect((await fresh(channel.id)).status).toBe('dormant')
  })

  it('a failed reclamation leaves it dormant and unmarked, and the next tick retries it', async () => {
    const channel = await channelAgent()
    await dormantPastRetention(channel)
    let attempts = 0
    await sweep(async (id) => {
      if (id === channel.id) attempts++
      return false
    })
    expect((await fresh(channel.id)).status).toBe('dormant')
    expect(await info(channel.id)).not.toHaveProperty('storageReclaimed')
    await sweep(async (id) => {
      if (id === channel.id) attempts++
      return true
    })
    expect(attempts).toBe(2)
    expect(await info(channel.id)).toMatchObject({ storageReclaimed: true })
  })

  it('"remove now" only frees its storage early, then is refused because nothing is left to remove', async () => {
    const channel = await channelAgent()
    await makeDormant(channel)
    expect((await requestDormantRemoval([channel.id])).accepted).toEqual([channel.id])
    expect(await info(channel.id)).toMatchObject({ removalPending: true, channelBound: true })

    const reclaimed: string[] = []
    await sweep(async (id) => {
      reclaimed.push(id)
      return true
    })
    expect(ours(reclaimed)).toEqual([channel.id])
    expect((await fresh(channel.id)).status).toBe('dormant')
    const after = await info(channel.id)
    expect(after.removalPending).toBeUndefined()
    expect(after.storageReclaimed).toBe(true)

    const again = await requestDormantRemoval([channel.id])
    expect(again.accepted).toEqual([])
    expect(again.skipped).toEqual([
      {
        id: channel.id,
        reason: 'Its storage is already freed; channel agents stay dormant so a new message can wake them.',
      },
    ])
  })

  it('wakes after reclamation with its history and the shared consultant runtime, and a later dormancy is reclaimed again', async () => {
    const agentWarmup = await import('../sandbox/agent-warmup')
    const ensure = spyOn(agentWarmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
    const mint = spyOn(Agent.prototype, 'getOrCreateToken').mockResolvedValue('ficus_agent_test')
    try {
      const channel = await channelAgent()
      await db.insert(messages).values([
        { agentId: channel.id, role: 'human', content: 'Can you check the deploy?' },
        { agentId: channel.id, role: 'assistant', content: 'The deploy finished.' },
      ])
      await dormantPastRetention(channel)
      await sweep(async () => true)
      expect(await info(channel.id)).toMatchObject({ storageReclaimed: true })

      const dormant = await fresh(channel.id)
      expect(await dormant.wake()).toBe(true)
      const woken = await fresh(channel.id)
      expect(woken.status).toBe('idle')
      expect(ensure).toHaveBeenCalled()
      expect(await woken.getSandboxId()).toBe(consultantSandboxId(squad.id))
      const history = await db
        .select({ content: messages.content })
        .from(messages)
        .where(eq(messages.agentId, channel.id))
      expect(history.map((row) => row.content).sort()).toEqual(['Can you check the deploy?', 'The deploy finished.'])
      expect(await info(channel.id)).not.toHaveProperty('storageReclaimed')

      // A new dormancy episode gets its own reclamation after retention.
      await dormantPastRetention(woken)
      const reclaimed: string[] = []
      await sweep(async (id) => {
        reclaimed.push(id)
        return true
      })
      expect(ours(reclaimed)).toEqual([channel.id])
      expect((await fresh(channel.id)).status).toBe('dormant')
    } finally {
      ensure.mockRestore()
      mint.mockRestore()
    }
  })
})
