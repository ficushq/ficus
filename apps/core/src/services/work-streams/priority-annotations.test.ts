import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { eq, like } from 'drizzle-orm'
import { db } from '../../db'
import { squads, workStreams, workStreamWaits } from '../../db/schema'
import { Squad } from '../../entities/Squad'
import { computePriorityAnnotations } from './priority-annotations'
import { openWait } from './waits'

describe('computePriorityAnnotations', () => {
  let testPrefix: string
  let squad: Squad

  beforeEach(async () => {
    testPrefix = `wsann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    squad = await Squad.create({ name: `${testPrefix} Squad`, purpose: 'annotation tests' })
  })

  afterEach(async () => {
    await db.delete(workStreams).where(eq(workStreams.squadId, squad.id))
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
  })

  it('positions only ELIGIBLE queued streams and flags dep-blocked ones', async () => {
    await squad.update({ maxConcurrentWorkStreams: 1 })
    const holder = await storedLegacyWorkStream({ squadId: squad.id, title: `${testPrefix} holder` })
    // Oldest queued stream, but blocked on the (open) holder — must NOT be
    // counted as next in line.
    const depBlocked = await storedLegacyWorkStream({
      squadId: squad.id,
      title: `${testPrefix} dep-blocked`,
      priority: 'critical',
      dependsOn: [holder.id],
    })
    const eligibleA = await storedLegacyWorkStream({
      squadId: squad.id,
      title: `${testPrefix} eligible-a`,
      priority: 'high',
    })
    const eligibleB = await storedLegacyWorkStream({ squadId: squad.id, title: `${testPrefix} eligible-b` })
    expect(depBlocked.status).toBe('queued')
    expect(eligibleA.status).toBe('queued')
    expect(eligibleB.status).toBe('queued')

    const all = [holder, depBlocked, eligibleA, eligibleB]
    const annotations = await computePriorityAnnotations(all)

    // Dep-blocked: no position, explicit waiting flag.
    expect(annotations.get(depBlocked.id)?.queuePosition).toBeUndefined()
    expect(annotations.get(depBlocked.id)?.waitingOnDependencies).toBe(true)
    // Eligible streams are 1 and 2 in effective-priority order.
    expect(annotations.get(eligibleA.id)?.queuePosition).toBe(1)
    expect(annotations.get(eligibleA.id)?.waitingOnDependencies).toBeUndefined()
    expect(annotations.get(eligibleB.id)?.queuePosition).toBe(2)
    // Admitted streams get neither.
    expect(annotations.get(holder.id)?.queuePosition).toBeUndefined()
    expect(annotations.get(holder.id)?.waitingOnDependencies).toBeUndefined()
  })

  it('a ready edge that unlocked makes the stream eligible; one that has not still waits', async () => {
    await squad.update({ maxConcurrentWorkStreams: 1 })
    const holder = await storedLegacyWorkStream({ squadId: squad.id, title: `${testPrefix} holder` })
    const waiting = await storedLegacyWorkStream({
      squadId: squad.id,
      title: `${testPrefix} waiting-ready`,
      dependsOn: [{ id: holder.id, condition: 'ready' }],
    })
    const unlocked = await storedLegacyWorkStream({
      squadId: squad.id,
      title: `${testPrefix} unlocked-ready`,
      dependsOn: [{ id: holder.id, condition: 'ready' }],
    })
    // The edge unlocked (its wait closed with it) while the cap kept the stream queued.
    await db
      .update(workStreams)
      .set({
        dependencyEdges: { [holder.id]: { condition: 'ready', readyUnlockedAt: new Date().toISOString() } },
      })
      .where(eq(workStreams.id, unlocked.id))
    await db
      .update(workStreamWaits)
      .set({ closedAt: new Date(), resolution: 'satisfied' })
      .where(eq(workStreamWaits.workStreamId, unlocked.id))

    const annotations = await computePriorityAnnotations([holder, waiting, unlocked])

    expect(annotations.get(waiting.id)?.waitingOnDependencies).toBe(true)
    expect(annotations.get(waiting.id)?.queuePosition).toBeUndefined()
    expect(annotations.get(unlocked.id)?.waitingOnDependencies).toBeUndefined()
    expect(annotations.get(unlocked.id)?.queuePosition).toBe(1)
  })

  it('gives no queue position to a queued stream with any open wait', async () => {
    await squad.update({ maxConcurrentWorkStreams: 1 })
    await storedLegacyWorkStream({ squadId: squad.id, title: `${testPrefix} holder` })
    const waiting = await storedLegacyWorkStream({
      squadId: squad.id,
      title: `${testPrefix} waiting`,
      priority: 'high',
    })
    const neighbor = await storedLegacyWorkStream({ squadId: squad.id, title: `${testPrefix} neighbor` })
    expect(waiting.status).toBe('queued')
    expect(neighbor.status).toBe('queued')
    await openWait(db, { workStreamId: waiting.id, type: 'manual', message: 'Needs input' })

    const annotations = await computePriorityAnnotations([waiting, neighbor])

    expect(annotations.get(waiting.id)?.queuePosition).toBeUndefined()
    expect(annotations.get(neighbor.id)?.queuePosition).toBe(1)
  })

  it('annotates boosted effective priority with the boosting dependent title', async () => {
    const blocker = await storedLegacyWorkStream({ squadId: squad.id, title: `${testPrefix} blocker`, priority: 'low' })
    await storedLegacyWorkStream({
      squadId: squad.id,
      title: `${testPrefix} feature`,
      priority: 'critical',
      dependsOn: [blocker.id],
    })
    const annotations = await computePriorityAnnotations([blocker])
    expect(annotations.get(blocker.id)?.effectivePriority).toBe('critical')
    expect(annotations.get(blocker.id)?.effectivePriorityVia).toBe(`${testPrefix} feature`)
  })
})
