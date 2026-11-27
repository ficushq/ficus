import '../test-utils/require-test-db'
import { afterAll, describe, expect, it } from 'bun:test'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { createPostgresConnection, getConnectionString } from './connection'
import { db } from './index'
import {
  MIN_RUNNING_MS_BEFORE_CANCEL,
  QueryCancellationScope,
  shareAcrossRequests,
  withQueryCancellation,
} from './query-cancellation'
import { InflightDeduper } from '../lib/infra/inflight'
import { readDeadline } from '../middleware/read-deadline'
import { ABANDONED_READ_CODE, jsonBodyErrorHandler } from '../middleware/json-body-errors'

// Against a real Postgres: an abandoned scope must stop its own queries on the server
// and hand the connection back, and must touch nothing that is not its own.

const CANCELED = '57014'

function pgCode(error: unknown): string | undefined {
  let current: unknown = error
  while (current && typeof current === 'object') {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the query to be cancelled')
    },
    (error: unknown) => error
  )
}

/** Start a query now, as a handler's `await` would. */
function started<T>(query: PromiseLike<T>): Promise<T> {
  const promise = Promise.resolve(query)
  promise.catch(() => undefined)
  return promise
}

// One connection, so a query that kept it would block the next one.
const single = withQueryCancellation(createPostgresConnection(getConnectionString(), { max: 1, onnotice: () => {} }))

afterAll(async () => {
  await single.end({ timeout: 5 })
})

describe('query cancellation', () => {
  it('cancels a running query once it has run a second, and frees the connection', async () => {
    const scope = new QueryCancellationScope()
    const begun = performance.now()
    const query = scope.run(() => started(single`select pg_sleep(30)`))
    await Bun.sleep(100)
    scope.abandon()
    expect(pgCode(await rejection(query))).toBe(CANCELED)
    const elapsed = performance.now() - begun
    // Not before the minimum running time, and promptly after it.
    expect(elapsed).toBeGreaterThanOrEqual(MIN_RUNNING_MS_BEFORE_CANCEL - 20)
    expect(elapsed).toBeLessThan(MIN_RUNNING_MS_BEFORE_CANCEL + 2_000)
    const [row] = await single<{ ok: number }[]>`select 1 as ok`
    expect(row!.ok).toBe(1)
  })

  it('lets a short running query finish instead of sending a cancel that could hit the next one', async () => {
    const scope = new QueryCancellationScope()
    const query = scope.run(() => started(single`select pg_sleep(0.3), 'finished' as result`))
    await Bun.sleep(50)
    scope.abandon()
    const [row] = await query
    expect(row!.result).toBe('finished')
  })

  it('drops its query still waiting for a connection at once, and leaves queries outside the scope alone', async () => {
    // A transaction holds the one connection, so the scoped query really waits in the pool.
    const outside = started(single.begin((tx) => tx`select pg_sleep(0.5), 'kept' as kept`))
    const scope = new QueryCancellationScope()
    const queued = scope.run(() => started(single.unsafe('select 1')))
    await Bun.sleep(50)
    const begun = performance.now()
    scope.abandon()
    expect(pgCode(await rejection(queued))).toBe(CANCELED)
    expect(performance.now() - begun).toBeLessThan(MIN_RUNNING_MS_BEFORE_CANCEL)
    const [row] = await outside
    expect(row!.kept).toBe('kept')
  })

  it('never touches a query started after the scope closed or was abandoned', async () => {
    const closed = new QueryCancellationScope()
    closed.close()
    closed.abandon()
    expect(closed.state).toBe('closed')
    const [afterClose] = await closed.run(() => single<{ ok: number }[]>`select 1 as ok`)
    expect(afterClose!.ok).toBe(1)

    const abandoned = new QueryCancellationScope()
    abandoned.abandon()
    const [afterAbandon] = await abandoned.run(() => single<{ ok: number }[]>`select 1 as ok`)
    expect(afterAbandon!.ok).toBe(1)
  })

  it('cancels a query inside a transaction and rolls the transaction back', async () => {
    const scope = new QueryCancellationScope()
    const transaction = scope.run(() =>
      started(
        single.begin(async (tx) => {
          // A session-level setting made inside a transaction survives only if it commits.
          await tx`select set_config('ficus.cancel_probe', 'committed', false)`
          await tx`select pg_sleep(30)`
        })
      )
    )
    await Bun.sleep(200)
    scope.abandon()
    expect(pgCode(await rejection(transaction))).toBe(CANCELED)
    const [row] = await single<{ probe: string | null }[]>`select current_setting('ficus.cancel_probe', true) as probe`
    expect(row!.probe).not.toBe('committed')
  })

  it('lets work shared across requests run to completion', async () => {
    const scope = new QueryCancellationScope()
    const shared = scope.run(() => shareAcrossRequests(() => started(single`select pg_sleep(1.3), 'done' as done`)))
    await Bun.sleep(50)
    scope.abandon()
    const [row] = await shared
    expect(row!.done).toBe('done')
  })

  it('cancels drizzle queries on the main pool, plain and in a transaction', async () => {
    // Drizzle builds its query when awaited, so await it inside the scope as a handler does.
    const plain = new QueryCancellationScope()
    const query = plain.run(async () => await db.execute(sql`select pg_sleep(30)`))
    await Bun.sleep(100)
    plain.abandon()
    expect(pgCode(await rejection(query))).toBe(CANCELED)

    const inTransaction = new QueryCancellationScope()
    const transaction = inTransaction.run(() =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select pg_sleep(30)`)
      })
    )
    await Bun.sleep(100)
    inTransaction.abandon()
    expect(pgCode(await rejection(transaction))).toBe(CANCELED)

    const rows = await db.execute<{ ok: number }>(sql`select 1 as ok`)
    expect(rows[0]!.ok).toBe(1)
  })
})

describe('an abandoned read, end to end through the read deadline', () => {
  function readApp() {
    const app = new Hono()
    app.use('*', readDeadline({ seconds: 10 }))
    app.onError(jsonBodyErrorHandler)
    return app
  }

  it('does not fail a write that joined shared work the abandoned read started', async () => {
    // The shape of a sandbox ensure: a read starts it, a write joins it.
    const deduper = new InflightDeduper<string>()
    const sharedWork = async () => {
      const rows = await db.execute<{ done: string }>(sql`select pg_sleep(1.5), 'woken' as done`)
      return rows[0]!.done
    }
    const app = readApp()
    app.get('/tree', async (c) => c.json({ woke: await deduper.run('squad', sharedWork) }))
    app.post('/start', async (c) => c.json({ woke: await deduper.run('squad', sharedWork) }))

    const reader = new AbortController()
    const read = app.request(new Request('http://localhost/tree', { signal: reader.signal }))
    await Bun.sleep(100)
    const write = app.request('/start', { method: 'POST' })
    await Bun.sleep(100)
    reader.abort()

    const written = await write
    expect(written.status).toBe(200)
    expect(await written.json()).toEqual({ woke: 'woken' })
    // The reader's own answer is the shared result too: nothing of its was cancelled.
    expect((await read).status).toBe(200)
  }, 10_000)

  it('keeps running the queries of a loop first started inside an abandoned read', async () => {
    const ticks: number[] = []
    let loop: ReturnType<typeof setInterval> | undefined
    const app = readApp()
    app.get('/watch', async (c) => {
      // Lazily started here and inheriting this request's context, as a registry's sweep is.
      loop ??= setInterval(() => {
        void db.execute<{ tick: number }>(sql`select 1 as tick`).then(
          (rows) => ticks.push(rows[0]!.tick),
          (error: unknown) => ticks.push(pgCode(error) === CANCELED ? -1 : -2)
        )
      }, 50)
      await db.execute(sql`select pg_sleep(30)`)
      return c.json({ ok: true })
    })
    try {
      const reader = new AbortController()
      const read = app.request(new Request('http://localhost/watch', { signal: reader.signal }))
      await Bun.sleep(150)
      reader.abort()
      const answer = await read
      // The read's own long query was cancelled and answered quietly.
      expect(answer.status).toBe(503)
      expect(((await answer.json()) as { code: string }).code).toBe(ABANDONED_READ_CODE)
      const before = ticks.length
      await Bun.sleep(400)
      const after = ticks.slice(before)
      expect(after.length).toBeGreaterThan(2)
      expect(after.every((tick) => tick === 1)).toBe(true)
    } finally {
      clearInterval(loop)
    }
  }, 10_000)
})
