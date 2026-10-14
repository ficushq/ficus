import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'crypto'
import { eq, inArray } from 'drizzle-orm'
import { db, agents, squads, workStreams } from '../../db'
import { Agent } from '../../entities/Agent'
import { Squad } from '../../entities/Squad'
import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { findIdleConsultants, makeIdleConsultantsDormant, runIdleConsultantDormancySweep } from './idle-consultants'

const DAY = 24 * 60 * 60 * 1000

describe('idle consultant dormancy', () => {
  let squadIds: string[]
  let agentIds: string[]
  const now = new Date()
  const daysAgo = (days: number) => new Date(now.getTime() - days * DAY)

  beforeEach(() => {
    squadIds = []
    agentIds = []
  })

  afterEach(async () => {
    // Own every fixture: never sweep another test's agents or squads.
    if (squadIds.length) await db.delete(workStreams).where(inArray(workStreams.squadId, squadIds))
    if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds))
    if (squadIds.length) await db.delete(squads).where(inArray(squads.id, squadIds))
  })

  async function squad(consultantIdleDormancyDays: number | null) {
    const created = await Squad.create({ name: `idle-${randomUUID()}`, purpose: 'idle consultant fixture' })
    squadIds.push(created.id)
    await db.update(squads).set({ consultantIdleDormancyDays }).where(eq(squads.id, created.id))
    return created
  }

  async function agent(
    squadId: string,
    fields: { lastMessageAt?: Date | null; createdAt?: Date; agentTypeId?: string; status?: Agent['status'] } = {}
  ) {
    const { agentTypeId = 'consultant', ...rest } = fields
    const created = await Agent.create({ agentTypeId, squadId, persist: false })
    agentIds.push(created.id)
    await db
      .update(agents)
      .set({ lastMessageAt: null, createdAt: now, ...rest })
      .where(eq(agents.id, created.id))
    return created
  }

  async function status(id: string) {
    const [row] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, id))
    return row?.status
  }

  it('finds consultants idle for N days: last message older, or never messaged and created earlier', async () => {
    const own = await squad(null)
    const old = await agent(own.id, { lastMessageAt: daysAgo(40), createdAt: daysAgo(100) })
    const neverMessaged = await agent(own.id, { createdAt: daysAgo(31) })
    await agent(own.id, { lastMessageAt: daysAgo(5), createdAt: daysAgo(100) })
    await agent(own.id, { createdAt: daysAgo(2) })
    await agent(own.id, { agentTypeId: 'engineer', lastMessageAt: daysAgo(40), createdAt: daysAgo(100) })
    await agent(own.id, { agentTypeId: 'manager', lastMessageAt: daysAgo(40), createdAt: daysAgo(100) })
    await agent(own.id, { status: 'dormant', lastMessageAt: daysAgo(40), createdAt: daysAgo(100) })
    await agent(own.id, { status: 'waiting-input', lastMessageAt: daysAgo(40), createdAt: daysAgo(100) })
    const foreign = await squad(null)
    await agent(foreign.id, { lastMessageAt: daysAgo(40), createdAt: daysAgo(100) })
    // canTerminate would refuse it, so it is never a candidate.
    const onOpenWork = await agent(own.id, { lastMessageAt: daysAgo(40), createdAt: daysAgo(100) })
    await storedLegacyWorkStream({ squadId: own.id, title: 'open work', agentIds: [onOpenWork.id] })

    const idle = await findIdleConsultants(own.id, 30, now)
    expect(idle.map((row) => row.id).sort()).toEqual([old.id, neverMessaged.id].sort())
  })

  it('applies only to the server-computed idle set, intersecting any ids the client previewed', async () => {
    const own = await squad(null)
    const idle = await agent(own.id, { lastMessageAt: daysAgo(100), createdAt: daysAgo(200) })
    const alsoIdle = await agent(own.id, { lastMessageAt: daysAgo(100), createdAt: daysAgo(200) })
    const recent = await agent(own.id, { lastMessageAt: daysAgo(1), createdAt: daysAgo(200) })
    const manager = await agent(own.id, {
      agentTypeId: 'manager',
      lastMessageAt: daysAgo(100),
      createdAt: daysAgo(200),
    })

    const result = await makeIdleConsultantsDormant(own.id, 90, {
      now,
      agentIds: [idle.id, recent.id, manager.id, randomUUID()],
    })
    expect(result.dormant).toEqual([idle.id])
    expect(result.skipped.map((item) => item.id)).toContain(recent.id)
    expect(result.skipped.map((item) => item.id)).toContain(manager.id)
    expect(result.skipped).toHaveLength(3)
    expect(await status(idle.id)).toBe('dormant')
    expect(await status(alsoIdle.id)).toBe('idle')
    expect(await status(recent.id)).toBe('idle')
    expect(await status(manager.id)).toBe('idle')

    // Without a client list, the whole current idle set is made dormant.
    expect((await makeIdleConsultantsDormant(own.id, 90, { now })).dormant).toEqual([alsoIdle.id])
  })

  it('the lifecycle sweep enforces each squad setting and leaves recent, executing and unconfigured agents alone', async () => {
    const enabled = await squad(30)
    const off = await squad(null)
    const idle = await agent(enabled.id, { lastMessageAt: daysAgo(31), createdAt: daysAgo(60) })
    const neverMessaged = await agent(enabled.id, { createdAt: daysAgo(45) })
    const recent = await agent(enabled.id, { lastMessageAt: daysAgo(3), createdAt: daysAgo(60) })
    const executing = await agent(enabled.id, { status: 'active', lastMessageAt: daysAgo(31), createdAt: daysAgo(60) })
    const compacting = await agent(enabled.id, {
      status: 'compacting',
      lastMessageAt: daysAgo(31),
      createdAt: daysAgo(60),
    })
    const worker = await agent(enabled.id, {
      agentTypeId: 'engineer',
      lastMessageAt: daysAgo(90),
      createdAt: daysAgo(90),
    })
    const unconfigured = await agent(off.id, { lastMessageAt: daysAgo(365), createdAt: daysAgo(400) })

    const count = await runIdleConsultantDormancySweep({ now, squadIds: [enabled.id, off.id] })
    expect(count).toBe(2)
    expect(await status(idle.id)).toBe('dormant')
    expect(await status(neverMessaged.id)).toBe('dormant')
    expect(await status(recent.id)).toBe('idle')
    expect(await status(executing.id)).toBe('active')
    expect(await status(compacting.id)).toBe('compacting')
    expect(await status(worker.id)).toBe('idle')
    expect(await status(unconfigured.id)).toBe('idle')
  })

  it('caps the agents one sweep tick makes dormant', async () => {
    const enabled = await squad(30)
    for (let i = 0; i < 3; i++) await agent(enabled.id, { lastMessageAt: daysAgo(31), createdAt: daysAgo(60) })
    expect(await runIdleConsultantDormancySweep({ now, squadIds: [enabled.id], maxAgents: 2 })).toBe(2)
    expect(await runIdleConsultantDormancySweep({ now, squadIds: [enabled.id], maxAgents: 2 })).toBe(1)
  })
})
