import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { randomUUID } from 'crypto'
import { eq, inArray } from 'drizzle-orm'
import { db, agents, squads } from '../../db'
import { Agent } from '../../entities/Agent'
import { Squad } from '../../entities/Squad'
import * as lifecycle from '../agent/lifecycle'
import { makeDormant } from '../agent/lifecycle'
import { storageAgentColumns, storageAgentInfo } from '../storage/agents'
import { requestDormantRemoval, runDormantAgentSweep } from './cleanup'

describe('remove dormant agents now (background)', () => {
  let squad: Squad
  let agentIds: string[]

  beforeEach(async () => {
    agentIds = []
    squad = await Squad.create({ name: `remove-now-${randomUUID()}`, purpose: 'dormant removal fixture' })
  })

  afterEach(async () => {
    // Own every fixture: never sweep another test's agents.
    if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds))
    await db.delete(squads).where(eq(squads.id, squad.id))
  })

  async function agent(agentTypeId = 'consultant') {
    const created = await Agent.create({ agentTypeId, squadId: squad.id, persist: false })
    agentIds.push(created.id)
    return created
  }

  async function status(id: string) {
    return (await Agent.mustFind(id, { eager: false })).status
  }

  it('marks dormant agents for the sweep without removing anything in the request', async () => {
    const dormant = await agent()
    await makeDormant(dormant)
    const manager = await agent('manager')
    await db.update(agents).set({ status: 'dormant', dormantAt: new Date() }).where(eq(agents.id, manager.id))
    const live = await agent()
    const missing = randomUUID()
    const terminate = spyOn(lifecycle, 'terminate')
    try {
      const result = await requestDormantRemoval([dormant.id, manager.id, live.id, missing])
      expect(result.accepted).toEqual([dormant.id])
      expect(result.skipped).toEqual([
        { id: manager.id, reason: 'manager agents are not removed from here.' },
        { id: live.id, reason: 'Only dormant agents can be removed now.' },
        { id: missing, reason: 'Agent not found.' },
      ])
      expect(terminate).not.toHaveBeenCalled()
      expect(await status(dormant.id)).toBe('dormant')
      expect(await status(manager.id)).toBe('dormant')
    } finally {
      terminate.mockRestore()
    }
  })

  it('the dormant sweep reclaims marked agents before their retention ends, and only those', async () => {
    const marked = await agent()
    await makeDormant(marked)
    const unmarked = await agent()
    await makeDormant(unmarked)
    const rewoken = await agent()
    await makeDormant(rewoken)
    expect((await requestDormantRemoval([marked.id, rewoken.id])).accepted.sort()).toEqual(
      [marked.id, rewoken.id].sort()
    )
    // A new dormancy episode after the request (e.g. woken and dormant again) must not be removed early.
    await db
      .update(agents)
      .set({ dormantAt: new Date(Date.now() + 1000) })
      .where(eq(agents.id, rewoken.id))

    await runDormantAgentSweep({ maxCandidates: 25 })
    expect(await status(marked.id)).toBe('terminated')
    expect(await status(unmarked.id)).toBe('dormant')
    expect(await status(rewoken.id)).toBe('dormant')
  })

  async function info(id: string) {
    const [row] = await db.select(storageAgentColumns).from(agents).where(eq(agents.id, id))
    return storageAgentInfo(row!)
  }

  it('records failed removals and, after five, clears the mark and reports the failure', async () => {
    const dormant = await agent()
    await makeDormant(dormant)
    expect((await requestDormantRemoval([dormant.id])).accepted).toEqual([dormant.id])
    const sweep = () =>
      runDormantAgentSweep({
        listDormant: async () => [dormant],
        completePending: async () => true,
        finalize: async () => {
          throw new Error('ssh timed out')
        },
      })
    for (let attempt = 1; attempt <= 4; attempt++) {
      await sweep()
      const current = await info(dormant.id)
      expect(current.removalPending).toBe(true)
      expect(current.removalError).toBeUndefined()
    }
    await sweep()
    const failed = await info(dormant.id)
    expect(failed.removalPending).toBeUndefined()
    expect(failed.removalError).toBe('ssh timed out')
    expect(await status(dormant.id)).toBe('dormant')

    // Asking again clears the failure and queues a fresh attempt.
    expect((await requestDormantRemoval([dormant.id])).accepted).toEqual([dormant.id])
    const retried = await info(dormant.id)
    expect(retried.removalPending).toBe(true)
    expect(retried.removalError).toBeUndefined()
  })

  it('a stop that has not finished yet is still in progress and never counts as a failed removal', async () => {
    const dormant = await agent()
    await makeDormant(dormant)
    expect((await requestDormantRemoval([dormant.id])).accepted).toEqual([dormant.id])
    for (let tick = 0; tick < 8; tick++)
      await runDormantAgentSweep({ listDormant: async () => [dormant], completePending: async () => false })
    const current = await info(dormant.id)
    expect(current.removalPending).toBe(true)
    expect(current.removalError).toBeUndefined()
    const [row] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, dormant.id))
    expect((row?.metadata as Record<string, unknown>).removeNowFailures).toBeUndefined()
  })
})
