import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'crypto'
import { eq, inArray } from 'drizzle-orm'
import { db, agents, squads } from '../../db'
import { Agent } from '../../entities/Agent'
import { Squad } from '../../entities/Squad'
import { makeDormant } from '../agent/lifecycle'
import { removeDormantAgentsNow } from './cleanup'

describe('remove dormant agents now', () => {
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

  async function agent() {
    const created = await Agent.create({ agentTypeId: 'consultant', squadId: squad.id, persist: false })
    agentIds.push(created.id)
    return created
  }

  async function status(id: string) {
    return (await Agent.mustFind(id, { eager: false })).status
  }

  it('finalizes dormant agents immediately, ignoring the retention window, and refuses live agents', async () => {
    const dormant = await agent()
    await makeDormant(dormant)
    expect(await status(dormant.id)).toBe('dormant')
    const live = await agent()
    const missing = randomUUID()

    const result = await removeDormantAgentsNow([dormant.id, live.id, missing])
    expect(result.removed).toEqual([dormant.id])
    expect(result.pending).toEqual([])
    expect(result.skipped).toEqual([
      { id: live.id, reason: 'Only dormant agents can be removed now.' },
      { id: missing, reason: 'Agent not found.' },
    ])
    expect(await status(dormant.id)).toBe('terminated')
    expect(await status(live.id)).toBe('idle')
  })

  it('reports agents whose dormancy completion is still pending instead of finalizing them', async () => {
    const dormant = await agent()
    await makeDormant(dormant)
    const finalized: string[] = []
    const result = await removeDormantAgentsNow([dormant.id], {
      completePending: async () => false,
      finalize: async (candidate) => void finalized.push(candidate.id),
    })
    expect(result).toEqual({ removed: [], pending: [dormant.id], skipped: [] })
    expect(finalized).toEqual([])
    expect(await status(dormant.id)).toBe('dormant')
  })
})
