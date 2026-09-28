import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { and, eq, isNull, like } from 'drizzle-orm'
import { updateSquadSchema } from '@ficus/shared'
import { db } from '../../db'
import { agentTypes, squads, workStreams, workStreamWaits } from '../../db/schema'
import { Squad } from '../../entities/Squad'
import { WorkStream } from '../../entities/WorkStream'
import { AgentType } from '../../entities/AgentType'
import { promoteEligibleQueuedStreams, runAdmissionReconcilerOnce, runSquadAdmissionMaintenance } from './admission'

/**
 * The admission MAINTENANCE pass: uniform grace auto-park + promotion under
 * one squad lock. Includes the lived starvation scenario the spec pins.
 */
describe('work-stream admission maintenance (grace auto-park)', () => {
  let testPrefix: string
  let squad: Squad
  let testAgentTypeId: string

  beforeEach(async () => {
    testPrefix = `wsmaint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-agent-type`
    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Maintenance Test Agent Type',
      systemPrompt: 'You are a test agent.',
    })
    squad = await Squad.create({ name: `${testPrefix} Squad`, purpose: 'maintenance tests' })
  })

  afterEach(async () => {
    await db.delete(workStreams).where(eq(workStreams.squadId, squad.id))
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
    await db.delete(agentTypes).where(like(agentTypes.id, `${testPrefix}%`))
  })

  async function createStream(
    title: string,
    overrides: Partial<Parameters<typeof WorkStream.create>[0]> = {}
  ): Promise<WorkStream> {
    return storedLegacyWorkStream({ squadId: squad.id, title: `${testPrefix} ${title}`, ...overrides })
  }

  /** Open a wait directly with a back-dated openedAt (minutes ago). */
  async function openAgedWait(
    workStreamId: string,
    type: 'dependency' | 'question' | 'review' | 'manual',
    minutesAgo: number
  ): Promise<void> {
    await db.insert(workStreamWaits).values({
      workStreamId,
      type,
      message: `aged ${type} wait`,
      openedAt: new Date(Date.now() - minutesAgo * 60_000),
    })
  }

  async function statusOf(id: string): Promise<string> {
    return (await WorkStream.mustFind(id)).status
  }

  it('THE LIVED STARVATION SCENARIO: cap 6, six waiting active streams past grace, high queued stream admits', async () => {
    await squad.update({ maxConcurrentWorkStreams: 6, blockedGraceMinutes: 30 })

    // Six active streams, each parked on an open dependency/manual wait
    // older than the grace.
    const holders: WorkStream[] = []
    for (let i = 0; i < 6; i++) {
      const ws = await createStream(`holder-${i}`)
      expect(ws.status).toBe('active')
      await openAgedWait(ws.id, i % 2 === 0 ? 'manual' : 'dependency', 31)
      holders.push(ws)
    }

    // The high-priority stream arrives into a full cap: queued, starved.
    const high = await createStream('high-priority', { priority: 'high' })
    expect(high.status).toBe('queued')

    // Promotion ALONE cannot help — every slot is held by a waiting stream.
    await promoteEligibleQueuedStreams(squad.id)
    expect(await statusOf(high.id)).toBe('queued')

    // The maintenance pass parks all six (grace exceeded, NO exemptions) and
    // admits the high stream in the same locked pass.
    const result = await runSquadAdmissionMaintenance(squad.id, { removeSandbox: async () => {} })
    expect(result.parked.map((w) => w.id).sort()).toEqual(holders.map((w) => w.id).sort())
    for (const holder of holders) {
      expect(await statusOf(holder.id)).toBe('queued')
    }
    expect(await statusOf(high.id)).toBe('active')
    expect(result.promoted.map((w) => w.id)).toEqual([high.id])
  })

  it('does NOT park an active stream whose open wait is still within grace (the grace comparison is load-bearing)', async () => {
    await squad.update({ maxConcurrentWorkStreams: 1, blockedGraceMinutes: 30 })
    const holder = await createStream('fresh-wait-holder')
    await openAgedWait(holder.id, 'manual', 1)
    const waiting = await createStream('waiting')
    expect(waiting.status).toBe('queued')

    const result = await runSquadAdmissionMaintenance(squad.id, { removeSandbox: async () => {} })
    expect(result.parked).toHaveLength(0)
    expect(await statusOf(holder.id)).toBe('active')
    expect(await statusOf(waiting.id)).toBe('queued')
  })

  it('review and question waits park too — NO exemptions', async () => {
    await squad.update({ maxConcurrentWorkStreams: 2, blockedGraceMinutes: 10 })
    const inReview = await createStream('in-review')
    await openAgedWait(inReview.id, 'review', 11)
    const waitingOnAnswer = await createStream('waiting-on-answer')
    await openAgedWait(waitingOnAnswer.id, 'question', 11)

    const result = await runSquadAdmissionMaintenance(squad.id, { removeSandbox: async () => {} })
    expect(result.parked.map((w) => w.id).sort()).toEqual([inReview.id, waitingOnAnswer.id].sort())
    // The waits stay OPEN across the park — parking never resolves anything.
    for (const id of [inReview.id, waitingOnAnswer.id]) {
      const open = await db
        .select()
        .from(workStreamWaits)
        .where(and(eq(workStreamWaits.workStreamId, id), isNull(workStreamWaits.closedAt)))
      expect(open).toHaveLength(1)
    }
  })

  describe('grace boundaries', () => {
    it('0 = park immediately (any open wait)', async () => {
      await squad.update({ maxConcurrentWorkStreams: 5, blockedGraceMinutes: 0 })
      const ws = await createStream('immediate')
      await ws.block({ message: 'hold' })
      const result = await runSquadAdmissionMaintenance(squad.id, { removeSandbox: async () => {} })
      expect(result.parked.map((w) => w.id)).toEqual([ws.id])
      expect(await statusOf(ws.id)).toBe('queued')
    })

    it('null -> default 30 minutes (29 stays, 31 parks)', async () => {
      await squad.update({ maxConcurrentWorkStreams: 5 })
      expect((await Squad.mustFind(squad.id)).blockedGraceMinutes).toBeNull()

      const fresh = await createStream('within-default')
      await openAgedWait(fresh.id, 'manual', 29)
      const overdue = await createStream('past-default')
      await openAgedWait(overdue.id, 'manual', 31)

      const result = await runSquadAdmissionMaintenance(squad.id, { removeSandbox: async () => {} })
      expect(result.parked.map((w) => w.id)).toEqual([overdue.id])
      expect(await statusOf(fresh.id)).toBe('active')
      expect(await statusOf(overdue.id)).toBe('queued')
    })

    it('negative grace is rejected at the API schema', () => {
      expect(updateSquadSchema.safeParse({ blockedGraceMinutes: -1 }).success).toBe(false)
      expect(updateSquadSchema.safeParse({ blockedGraceMinutes: 0 }).success).toBe(true)
      expect(updateSquadSchema.safeParse({ blockedGraceMinutes: null }).success).toBe(true)
      expect(updateSquadSchema.safeParse({ blockedGraceMinutes: 45 }).success).toBe(true)
      expect(updateSquadSchema.safeParse({ blockedGraceMinutes: 1.5 }).success).toBe(false)
    })
  })

  describe('admissibility: open waits gate the queue (spec test 5)', () => {
    it('a queued stream with ANY open wait is not admitted even with free slots, and admits in place once the wait closes', async () => {
      await squad.update({ maxConcurrentWorkStreams: 3 })
      const parked = await createStream('parked-on-wait')
      await db.update(workStreams).set({ status: 'queued' }).where(eq(workStreams.id, parked.id))
      await (await WorkStream.mustFind(parked.id)).block({ message: 'held' })

      // Free slots exist, but the open wait bars admission.
      await promoteEligibleQueuedStreams(squad.id)
      expect(await statusOf(parked.id)).toBe('queued')
      await runSquadAdmissionMaintenance(squad.id, { removeSandbox: async () => {} })
      expect(await statusOf(parked.id)).toBe('queued')

      // Closing the wait makes it admissible in place (unblock runs the
      // promotion pass itself).
      await (await WorkStream.mustFind(parked.id)).unblock({ note: 'released' })
      expect(await statusOf(parked.id)).toBe('active')
    })

    it('ordering is respected when a wait closes: the freed stream competes by effective priority then createdAt', async () => {
      await squad.update({ maxConcurrentWorkStreams: 1 })
      const holder = await createStream('holder')
      const older = await createStream('older-normal')
      await db
        .update(workStreams)
        .set({ createdAt: new Date(Date.now() - 60_000) })
        .where(eq(workStreams.id, older.id))
      const parked = await createStream('parked-high', { priority: 'high' })
      await (await WorkStream.mustFind(parked.id)).block({ message: 'held' })
      await db.update(workStreams).set({ status: 'queued' }).where(eq(workStreams.id, parked.id))

      // Slot frees; the held stream is skipped, nothing else outranks older.
      await holder.update({ status: 'done' })
      await promoteEligibleQueuedStreams(squad.id)
      expect(await statusOf(older.id)).toBe('active')
      expect(await statusOf(parked.id)).toBe('queued')

      // Wait closes: parked-high is admissible in place; when the slot frees
      // again it wins over nothing else (highest effective priority).
      await (await WorkStream.mustFind(parked.id)).unblock({ note: 'released' })
      expect(await statusOf(parked.id)).toBe('queued') // no free slot yet
      await (await WorkStream.mustFind(older.id)).update({ status: 'done' })
      await promoteEligibleQueuedStreams(squad.id)
      expect(await statusOf(parked.id)).toBe('active')
    })
  })

  it('the periodic reconciler covers squads with waiting ACTIVE streams even when nothing is queued', async () => {
    await squad.update({ maxConcurrentWorkStreams: 5, blockedGraceMinutes: 0 })
    const ws = await createStream('lone-waiting')
    await ws.block({ message: 'hold' })
    // Nothing queued in this squad — the reconciler must still park it.
    await runAdmissionReconcilerOnce()
    expect(await statusOf(ws.id)).toBe('queued')
  })
})
