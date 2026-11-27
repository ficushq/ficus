import '../test-utils/require-test-db'
import { afterAll, describe, expect, it } from 'bun:test'
import { sql } from 'drizzle-orm'
import { createPostgresConnection, getConnectionString } from './connection'
import { db } from './index'
import { runDetachedFromQueryCancellation, runWithQueryCancellation, withQueryCancellation } from './query-cancellation'

// Against a real Postgres: an aborted scope must stop the query on the server and
// hand the connection back, which no fake client can show.

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

// One connection, so a query that kept it would block the next one.
const single = withQueryCancellation(createPostgresConnection(getConnectionString(), { max: 1, onnotice: () => {} }))

afterAll(async () => {
  await single.end({ timeout: 5 })
})

describe('query cancellation', () => {
  it('stops an in-flight query when its scope aborts and frees the connection', async () => {
    const abandoned = new AbortController()
    const started = performance.now()
    const query = runWithQueryCancellation(abandoned.signal, () => single`select pg_sleep(30)`)
    await Bun.sleep(200)
    abandoned.abort()
    expect(pgCode(await rejection(query))).toBe(CANCELED)
    const [row] = await single<{ ok: number }[]>`select 1 as ok`
    expect(row!.ok).toBe(1)
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  it('drops a query still waiting for a connection and leaves queries outside the scope alone', async () => {
    const outside = single`select pg_sleep(0.5), 'kept' as kept`
    // Start it, so the scoped query below queues behind it.
    void outside.then(
      () => undefined,
      () => undefined
    )
    const abandoned = new AbortController()
    const queued = runWithQueryCancellation(abandoned.signal, () => single.unsafe('select 1'))
    await Bun.sleep(50)
    abandoned.abort()
    expect(pgCode(await rejection(queued))).toBe(CANCELED)
    const [row] = await outside
    expect(row!.kept).toBe('kept')
  })

  it('never sends a query started after its scope aborted', async () => {
    const abandoned = new AbortController()
    abandoned.abort()
    const error = await rejection(runWithQueryCancellation(abandoned.signal, () => single`select 1`))
    expect(pgCode(error)).toBe(CANCELED)
  })

  it('cancels a query inside a transaction and rolls the transaction back', async () => {
    const abandoned = new AbortController()
    const transaction = runWithQueryCancellation(abandoned.signal, () =>
      single.begin(async (tx) => {
        // A session-level setting made inside a transaction survives only if it commits.
        await tx`select set_config('ficus.cancel_probe', 'committed', false)`
        await tx`select pg_sleep(30)`
      })
    )
    await Bun.sleep(200)
    abandoned.abort()
    expect(pgCode(await rejection(transaction))).toBe(CANCELED)
    const [row] = await single<{ probe: string | null }[]>`select current_setting('ficus.cancel_probe', true) as probe`
    expect(row!.probe).not.toBe('committed')
  })

  it('lets work detached from the scope run to completion', async () => {
    const abandoned = new AbortController()
    const detached = runWithQueryCancellation(abandoned.signal, () =>
      runDetachedFromQueryCancellation(() => single`select pg_sleep(0.3), 'done' as done`)
    )
    await Bun.sleep(50)
    abandoned.abort()
    const [row] = await detached
    expect(row!.done).toBe('done')
  })

  it('cancels drizzle queries on the main pool, plain and in a transaction', async () => {
    // Drizzle builds its query when awaited, so await it inside the scope as a handler does.
    const plain = new AbortController()
    const query = runWithQueryCancellation(plain.signal, async () => await db.execute(sql`select pg_sleep(30)`))
    await Bun.sleep(200)
    plain.abort()
    expect(pgCode(await rejection(query))).toBe(CANCELED)

    const inTransaction = new AbortController()
    const transaction = runWithQueryCancellation(inTransaction.signal, () =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select pg_sleep(30)`)
      })
    )
    await Bun.sleep(200)
    inTransaction.abort()
    expect(pgCode(await rejection(transaction))).toBe(CANCELED)

    const rows = await db.execute<{ ok: number }>(sql`select 1 as ok`)
    expect(rows[0]!.ok).toBe(1)
  })
})
