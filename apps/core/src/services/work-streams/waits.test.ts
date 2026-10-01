import { getPostgresError } from '../../db/errors'
import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { and, eq, isNull, like, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agentTypes, squads, workStreams, workStreamWaits } from '../../db/schema'
import { Squad } from '../../entities/Squad'
import { WorkStream } from '../../entities/WorkStream'
import { AgentType } from '../../entities/AgentType'
import { closeOpenWaits, listOpenWaits, listWaitHistory, openWait, syncDependencyWaits } from './waits'

describe('work-stream waits service', () => {
  let testPrefix: string
  let squad: Squad

  beforeEach(async () => {
    testPrefix = `wswait-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await AgentType.create({
      id: `${testPrefix}-agent-type`,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Waits Test Agent Type',
      systemPrompt: 'You are a test agent.',
    })
    squad = await Squad.create({ name: `${testPrefix} Squad`, purpose: 'waits tests' })
  })

  afterEach(async () => {
    await db.delete(workStreams).where(eq(workStreams.squadId, squad.id))
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
    await db.delete(agentTypes).where(like(agentTypes.id, `${testPrefix}%`))
  })

  async function createStream(title: string, overrides: Partial<Parameters<typeof WorkStream.create>[0]> = {}) {
    return storedLegacyWorkStream({ squadId: squad.id, title: `${testPrefix} ${title}`, ...overrides })
  }

  it('listWaitHistory returns every wait of every type, open and closed, newest first', async () => {
    const ws = await createStream('wait-history')
    // A manual wait, resolved with a note (the audit case that was invisible before).
    await openWait(db, { workStreamId: ws.id, type: 'manual', message: 'need a decision' })
    await closeOpenWaits(db, { workStreamId: ws.id, type: 'manual' }, 'cleared', {
      note: 'use the compliant alternative',
    })
    // A still-open review wait.
    await openWait(db, { workStreamId: ws.id, type: 'review', message: 'PR ready' })

    const history = await listWaitHistory(db, ws.id)
    expect(history.length).toBe(2)
    // Newest first: the review wait was opened last.
    expect(history[0].type).toBe('review')
    expect(history[0].closedAt).toBeNull()
    // The closed manual wait carries its resolution + note — auditable.
    const manual = history.find((w) => w.type === 'manual')!
    expect(manual.closedAt).not.toBeNull()
    expect(manual.resolution).toBe('cleared')
    expect(manual.resolutionNote).toBe('use the compliant alternative')
  })

  it('enforces at most ONE open review wait per stream at the database level', async () => {
    // The test DB is push-built and `drizzle-kit push` silently skips partial
    // indexes (see expected-schema.ts) — install the index exactly as the
    // migration defines it so this pins the REAL backstop.
    await db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS "idx_work_stream_waits_one_open_review" ON "work_stream_waits" ("work_stream_id") WHERE "type" = 'review' AND "closed_at" IS NULL`
    )
    const ws = await createStream('unique-review')
    await db.insert(workStreamWaits).values({ workStreamId: ws.id, type: 'review' })
    // A raw second insert (bypassing openWait's idempotency read) violates the
    // partial unique index — the race backstop.
    let violation: unknown
    try {
      await db.insert(workStreamWaits).values({ workStreamId: ws.id, type: 'review' })
    } catch (error) {
      violation = error
    }
    expect(getPostgresError(violation)).toEqual({
      code: '23505',
      constraint: 'idx_work_stream_waits_one_open_review',
    })
    // Other types stack freely.
    await db.insert(workStreamWaits).values({ workStreamId: ws.id, type: 'manual' })
    await db.insert(workStreamWaits).values({ workStreamId: ws.id, type: 'manual' })
    // A CLOSED review wait does not block a new open one.
    await closeOpenWaits(db, { workStreamId: ws.id, type: 'review' }, 'sent_back', {
      note: 'round 1',
    })
    await db.insert(workStreamWaits).values({ workStreamId: ws.id, type: 'review' })
  })

  it('closeOpenWaits refuses an unfiltered close and only closes OPEN rows', async () => {
    const ws = await createStream('guarded-close')
    await openWait(db, { workStreamId: ws.id, type: 'manual', message: 'one' })
    await closeOpenWaits(db, { workStreamId: ws.id, type: 'manual' }, 'cleared', {
      note: 'first close',
    })

    // Closing again matches nothing (closed_at IS NULL guard) — the first
    // resolution is never overwritten.
    const again = await closeOpenWaits(db, { workStreamId: ws.id, type: 'manual' }, 'cleared', {
      note: 'second',
    })
    expect(again).toHaveLength(0)
    const [row] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, ws.id))
    expect(row.resolutionNote).toBe('first close')

    await expect(closeOpenWaits(db, {}, 'cleared')).rejects.toThrow(/at least one filter/)
  })

  describe('dependency waits (system-maintained projection of dependsOn)', () => {
    async function openDepWaits(workStreamId: string) {
      return db
        .select()
        .from(workStreamWaits)
        .where(
          and(
            eq(workStreamWaits.workStreamId, workStreamId),
            eq(workStreamWaits.type, 'dependency'),
            isNull(workStreamWaits.closedAt)
          )
        )
    }

    it('creation with dependsOn opens one wait per unsatisfied dep; satisfied deps get none', async () => {
      const doneDep = await createStream('done-dep')
      await doneDep.update({ status: 'done' })
      const openDep = await createStream('open-dep')

      const ws = await createStream('dependent', { dependsOn: [doneDep.id, openDep.id] })
      const waits = await openDepWaits(ws.id)
      expect(waits).toHaveLength(1)
      expect(waits[0].referenceId).toBe(openDep.id)
    })

    it('the dep reaching done closes the wait (satisfied) transactionally with the terminal transition', async () => {
      const dep = await createStream('dep')
      const ws = await createStream('dependent', { dependsOn: [dep.id] })
      expect(await openDepWaits(ws.id)).toHaveLength(1)

      await dep.update({ status: 'done' })

      expect(await openDepWaits(ws.id)).toHaveLength(0)
      const [closed] = await db
        .select()
        .from(workStreamWaits)
        .where(and(eq(workStreamWaits.workStreamId, ws.id), eq(workStreamWaits.type, 'dependency')))
      expect(closed.resolution).toBe('satisfied')
      expect(closed.closedAt).not.toBeNull()
    })

    it('an aborted dep-done transaction leaves the wait OPEN (same-tx pin: no between)', async () => {
      const dep = await createStream('atomic-dep')
      const ws = await createStream('atomic-dependent', { dependsOn: [dep.id] })

      // Abort the dep's terminal transition mid-transaction: run the same
      // shape (status write + wait close) and throw before commit.
      await expect(
        db.transaction(async (tx) => {
          await tx.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, dep.id))
          await closeOpenWaits(tx, { type: 'dependency', referenceId: dep.id }, 'satisfied', {})
          throw new Error('simulated crash before commit')
        })
      ).rejects.toThrow('simulated crash before commit')

      // NEITHER happened: dep not done, wait still open.
      expect((await WorkStream.mustFind(dep.id)).status).toBe('active')
      expect(await openDepWaits(ws.id)).toHaveLength(1)
    })

    it('edge edits reconcile: removed edges close (cleared), new unsatisfied edges open, done stays closed', async () => {
      const a = await createStream('dep-a')
      const b = await createStream('dep-b')
      const ws = await createStream('editable', { dependsOn: [a.id] })
      expect((await openDepWaits(ws.id)).map((w) => w.referenceId)).toEqual([a.id])

      await ws.update({ dependsOn: [b.id] })
      const waits = await openDepWaits(ws.id)
      expect(waits.map((w) => w.referenceId)).toEqual([b.id])
      const [removed] = await db
        .select()
        .from(workStreamWaits)
        .where(and(eq(workStreamWaits.workStreamId, ws.id), eq(workStreamWaits.referenceId, a.id)))
      expect(removed.resolution).toBe('cleared')
    })

    it('syncDependencyWaits is idempotent (no duplicate open waits)', async () => {
      const dep = await createStream('idem-dep')
      const ws = await createStream('idem', { dependsOn: [dep.id] })
      await db.transaction(async (tx) => syncDependencyWaits(tx, ws.id, [dep.id]))
      await db.transaction(async (tx) => syncDependencyWaits(tx, ws.id, [dep.id]))
      expect(await openDepWaits(ws.id)).toHaveLength(1)
    })

    it('a canceled dependency does NOT satisfy the wait (never silently admitted)', async () => {
      const dep = await createStream('cancel-dep')
      const ws = await createStream('cancel-dependent', { dependsOn: [dep.id] })
      await dep.cancel()
      expect(await openDepWaits(ws.id)).toHaveLength(1)
    })
  })

  it("terminal transitions clear the stream's own remaining open waits", async () => {
    const ws = await createStream('terminal-clear')
    await ws.block({ message: 'hold one' })
    await ws.handoffForReview({ message: 'and review' })
    expect(await listOpenWaits(db, ws.id)).toHaveLength(2)

    await ws.cancel()
    expect(await listOpenWaits(db, ws.id)).toHaveLength(0)
    const rows = await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, ws.id))
    for (const row of rows) expect(row.resolution).toBe('cleared')
  })
})
