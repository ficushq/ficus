import { storedLegacyWorkStream } from '../test-utils/stored-legacy-work-stream'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray, sql, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, squads, workStreams } from '../db'
import { Squad } from '../entities/Squad'
import { WorkStream } from '../entities/WorkStream'
import { identityMiddleware } from '../middleware/identity'
import { authHeaders, cleanupTestRbac, createTestAdmin, type TestUser } from '../test-utils'
import { promoteEligibleQueuedStreams } from '../services/work-streams/admission'
import { holdRowLock, waitForBlockedBy } from '../test-utils/db-lock'
import { squadsRouter } from './squads'
import { workStreamsRouter } from './work-streams'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/squads', squadsRouter)
app.route('/api/workstreams', workStreamsRouter)

const rbacPrefix = `metadata-concurrency-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix: rbacPrefix })
})

afterAll(async () => {
  await cleanupTestRbac(rbacPrefix)
})

const createdSquads: string[] = []
const createdStreams: string[] = []

afterEach(async () => {
  if (createdStreams.length) await db.delete(workStreams).where(inArray(workStreams.id, createdStreams))
  if (createdSquads.length) await db.delete(squads).where(inArray(squads.id, createdSquads))
  createdStreams.length = 0
  createdSquads.length = 0
})

async function patchJson(path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'PATCH',
    headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function queueTwoUpdates(lockStatement: SQL, first: () => Promise<Response>, second: () => Promise<Response>) {
  const holder = await holdRowLock(lockStatement)
  let released = false
  try {
    const firstRequest = first()
    const firstPid = await waitForBlockedBy([holder.pid])
    const secondRequest = second()
    await waitForBlockedBy([holder.pid, firstPid], [firstPid])
    await holder.release()
    released = true
    const responses = await Promise.all([firstRequest, secondRequest])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
  } finally {
    if (!released) await holder.release()
  }
}

type Harness = {
  lock: SQL
  update: (delta: Record<string, unknown>) => Promise<Response>
  read: () => Promise<Record<string, unknown>>
}

async function createHarness(kind: 'squad' | 'work stream', metadata: Record<string, unknown>): Promise<Harness> {
  const squad = await Squad.create({ name: `Metadata concurrency ${kind}`, purpose: 'test', metadata })
  createdSquads.push(squad.id)
  if (kind === 'squad') {
    return {
      lock: sql`select id from ${squads} where ${squads.id} = ${squad.id} for update`,
      update: (delta) => patchJson(`/api/squads/${squad.id}`, { metadata: delta }),
      read: async () => (await Squad.mustFind(squad.id)).metadata,
    }
  }

  const stream = await storedLegacyWorkStream({ squadId: squad.id, title: 'Metadata concurrency stream', metadata })
  createdStreams.push(stream.id)
  return {
    lock: sql`select id from ${workStreams} where ${workStreams.id} = ${stream.id} for update`,
    update: (delta) => patchJson(`/api/workstreams/${stream.id}`, { metadata: delta }),
    read: async () => (await WorkStream.mustFind(stream.id)).metadata,
  }
}

describe('serialized metadata updates', () => {
  test.each(['squad', 'work stream'] as const)('%s preserves two different nested-key deltas', async (kind) => {
    const harness = await createHarness(kind, {
      ledger: { left: 0, right: 0, neighbor: 'keep' },
      outside: 'keep',
    })

    await queueTwoUpdates(
      harness.lock,
      () => harness.update({ ledger: { left: 1 } }),
      () => harness.update({ ledger: { right: 2 } })
    )

    expect(await harness.read()).toEqual({
      ...(kind === 'squad' ? { memory: { enabled: true } } : {}),
      ledger: { left: 1, right: 2, neighbor: 'keep' },
      outside: 'keep',
    })
  })

  test.each(['squad', 'work stream'] as const)('%s does not resurrect a concurrently deleted key', async (kind) => {
    const harness = await createHarness(kind, {
      obsolete: 'remove',
      ledger: { neighbor: 'keep' },
      outside: 'keep',
    })

    await queueTwoUpdates(
      harness.lock,
      () => harness.update({ obsolete: null }),
      () => harness.update({ ledger: { current: 7 } })
    )

    expect(await harness.read()).toEqual({
      ...(kind === 'squad' ? { memory: { enabled: true } } : {}),
      ledger: { neighbor: 'keep', current: 7 },
      outside: 'keep',
    })
  })

  test.each(['squad', 'work stream'] as const)(
    '%s applies same-array-key replacements in observed serialization order',
    async (kind) => {
      const harness = await createHarness(kind, { labels: ['initial'], neighbor: 'keep' })

      await queueTwoUpdates(
        harness.lock,
        () => harness.update({ labels: ['first'] }),
        () => harness.update({ labels: ['second'] })
      )

      expect(await harness.read()).toEqual({
        ...(kind === 'squad' ? { memory: { enabled: true } } : {}),
        labels: ['second'],
        neighbor: 'keep',
      })
    }
  )

  test('metadata PATCH serializes squad before stream against finite-cap promotion', async () => {
    const squad = await Squad.create({ name: 'Metadata promotion lock order', purpose: 'test' })
    createdSquads.push(squad.id)
    await Squad.update(squad.id, { maxConcurrentWorkStreams: 6 })
    const stream = await storedLegacyWorkStream({
      squadId: squad.id,
      title: 'Promotion overlap stream',
      metadata: { ledger: { neighbor: 'keep' } },
    })
    createdStreams.push(stream.id)
    await db.update(workStreams).set({ status: 'queued' }).where(eq(workStreams.id, stream.id))

    const holder = await holdRowLock(
      sql`select id from ${workStreams} where ${workStreams.id} = ${stream.id} for update`
    )
    let released = false
    try {
      const metadataPatch = patchJson(`/api/workstreams/${stream.id}`, {
        metadata: { ledger: { current: 7 } },
      })
      const metadataPid = await waitForBlockedBy([holder.pid])
      const metadataSquadLocks = await db.execute<{ count: number }>(sql`
        select count(*)::int as count
        from pg_locks locks
        join pg_class relations on relations.oid = locks.relation
        where locks.pid = ${metadataPid} and locks.granted and relations.relname = 'squads'
      `)
      expect(metadataSquadLocks[0]!.count).toBeGreaterThan(0)

      const promotion = promoteEligibleQueuedStreams(squad.id)
      await waitForBlockedBy([metadataPid], [metadataPid])

      await holder.release()
      released = true
      const [response, promoted] = await Promise.all([metadataPatch, promotion])

      expect(response.status).toBe(200)
      expect(promoted.map((candidate) => candidate.id)).toEqual([stream.id])
      const final = await WorkStream.mustFind(stream.id)
      expect(final.status).toBe('active')
      expect(final.metadata).toEqual({ ledger: { neighbor: 'keep', current: 7 } })
      const waiting = await db.execute<{ count: number }>(sql`
        select count(*)::int as count
        from pg_stat_activity
        where wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0
      `)
      expect(waiting[0]!.count).toBe(0)
    } finally {
      if (!released) await holder.release()
    }
  })
})
