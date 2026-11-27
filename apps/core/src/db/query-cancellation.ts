import { AsyncLocalStorage } from 'node:async_hooks'
import type postgres from 'postgres'

/**
 * Cancel the database work of a read nobody is waiting for any more.
 *
 * The read deadline (middleware/read-deadline.ts) answers a slow read with a 503,
 * and a client can hang up on its own, but the handler behind either keeps running
 * and keeps a pool connection busy until its query finishes. Under load that is
 * exactly the connection the next request needs. So the middleware runs each read
 * in a {@link QueryCancellationScope}, and the main pool (db/index.ts) records the
 * queries started in it.
 *
 * The rule, which keeps the cancellation inside the abandoned request:
 *
 * 1. A scope records queries only while its handler is pending. Once the handler
 *    has answered, or the scope was abandoned, nothing more is recorded, so a timer
 *    or loop that a read happened to start (and that inherits its async context)
 *    is never touched by a later abandonment, and the scope holds no queries.
 * 2. Abandoning a scope cancels only the queries it recorded that are still in
 *    flight at that moment, in a way that keeps the cancel off other requests:
 *    - A query that has no connection yet (waiting in the pool's queue) is dropped
 *      from the queue at once. Nothing was sent, so no cancel request is involved.
 *    - A query already sent on a connection is cancelled only once the server has
 *      run it for {@link MIN_RUNNING_MS_BEFORE_CANCEL}, counted from when it is
 *      seen at the front of its connection (no earlier than the abandonment). A
 *      Postgres cancel request targets the backend, not a query: sent for a short
 *      query, or for one still pipelined behind another (postgres.js would send it
 *      the moment that query reaches the front), it can arrive after the query
 *      finished and cancel the next query on the connection, which belongs to
 *      someone else. A query that finishes within the second is simply left to
 *      finish, and its connection is freed then.
 *    A cancelled query fails with 57014 ("canceling statement due to user
 *    request"); a transaction around it rolls back. A long query is cancelled about
 *    a second late, and a cancel can still race a query that finishes in the few
 *    milliseconds the cancel takes to arrive after it has run a full second; that
 *    residual window is accepted.
 * 3. Work that is shared beyond the request that started it (a promise other
 *    callers join, such as a sandbox ensure behind an InflightDeduper) must not
 *    belong to that request: start it in {@link shareAcrossRequests}, which runs it
 *    outside any scope. Its owner is the process, not the first caller.
 *
 * Only the main pool is wrapped. Dedicated connections (locks, migrations,
 * withDedicatedDbTransaction) are never cancelled this way.
 */

/** How long a running query must have run before an abandoned scope cancels it. */
export const MIN_RUNNING_MS_BEFORE_CANCEL = 1_000

/** The postgres.js Query internals this module reads (postgres 4.x, src/query.js and src/pool.js). */
type TrackedQuery = Promise<unknown> & {
  cancel(): Promise<void>
  readonly executed?: boolean
  readonly settled?: boolean
  /** Set once postgres.js has placed it on a connection (sent or pipelined). */
  readonly connection?: unknown
  /** True while it is the query its connection's backend is running (not queued or pipelined behind). */
  readonly active?: boolean
}

type Recorded = { query: TrackedQuery }

/** How often a sent query of an abandoned scope is checked until it may be cancelled or settles. */
const SENT_QUERY_CHECK_MS = 50

/** Drop settled queries once a long handler has recorded this many. */
const PRUNE_AT = 256

export class QueryCancellationScope {
  #state: 'live' | 'closed' | 'abandoned' = 'live'
  #recorded: Recorded[] = []
  #reason: unknown

  /** 'live' while the handler is pending; 'closed' once it answered; 'abandoned' once nobody waits for it. */
  get state(): 'live' | 'closed' | 'abandoned' {
    return this.#state
  }

  get reason(): unknown {
    return this.#reason
  }

  /** Run `fn` with the queries it starts recorded in this scope. */
  run<T>(fn: () => T): T {
    return scopes.run(this, fn)
  }

  /** The handler answered: stop recording and forget its queries. */
  close(): void {
    if (this.#state !== 'live') return
    this.#state = 'closed'
    this.#recorded = []
  }

  /** Nobody waits for the answer: cancel the queries still in flight (see the module rule). */
  abandon(reason?: unknown, now: () => number = () => performance.now()): void {
    if (this.#state !== 'live') return
    this.#state = 'abandoned'
    this.#reason = reason
    const recorded = this.#recorded
    this.#recorded = []
    for (const { query } of recorded) {
      if (!query.executed || query.settled) continue
      // Not on a connection: postgres.js drops it from the pool queue, no cancel request.
      if (!query.connection) {
        query.cancel().catch(noop)
        continue
      }
      cancelOnceRunLongEnough(query, now)
    }
  }

  /** @internal Called by the wrapped pool for each query it starts. */
  record(query: TrackedQuery): void {
    if (this.#state !== 'live') return
    if (this.#recorded.length >= PRUNE_AT) this.#recorded = this.#recorded.filter(({ query: q }) => !q.settled)
    this.#recorded.push({ query })
  }
}

const scopes = new AsyncLocalStorage<QueryCancellationScope>()

function noop(): void {}

/**
 * Cancel a query already sent on a connection only after the server has run it for
 * {@link MIN_RUNNING_MS_BEFORE_CANCEL} as the front query of that connection. Until
 * then nothing is sent, so a query that finishes, or that is still pipelined behind
 * another request's query, is never the target of a cancel request.
 */
function cancelOnceRunLongEnough(query: TrackedQuery, now: () => number): void {
  let frontSince: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => clearTimeout(timer)
  const check = () => {
    timer = undefined
    if (query.settled) return
    if (!query.active) frontSince = undefined
    else frontSince ??= now()
    if (frontSince !== undefined && now() - frontSince >= MIN_RUNNING_MS_BEFORE_CANCEL) {
      query.cancel().catch(noop)
      return
    }
    timer = setTimeout(check, SENT_QUERY_CHECK_MS)
    timer.unref?.()
  }
  check()
  // Stop checking as soon as it settles, so nothing holds the query longer than needed.
  query.then(stop, stop)
}

/**
 * Run `fn` outside any request's cancellation scope. Use it where work is started
 * that other callers may join or that outlives the request: a promise kept in a
 * map for later callers, a lazily started loop or timer, a one-time setup.
 */
export function shareAcrossRequests<T>(fn: () => T): T {
  return scopes.exit(fn)
}

/** The scope queries started here would be recorded in, if any. */
export function currentQueryCancellationScope(): QueryCancellationScope | undefined {
  return scopes.getStore()
}

function pgCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * Whether `error` is a query this request's own abandonment cancelled: the request
 * is gone, so it is expected, not a failure to log or report.
 */
export function isAbandonedQueryError(error: unknown): boolean {
  return currentQueryCancellationScope()?.state === 'abandoned' && pgCode(error) === '57014'
}

function isQuery(value: unknown): value is TrackedQuery {
  // A postgres.js Query is a Promise subclass with `cancel`; fragments such as
  // identifiers and builders are neither.
  return value instanceof Promise && typeof (value as Partial<TrackedQuery>).cancel === 'function'
}

function record<T>(value: T): T {
  const scope = scopes.getStore()
  if (scope && isQuery(value)) scope.record(value)
  return value
}

type Callable = (...args: unknown[]) => unknown

/** A transaction or savepoint callback receives its own `sql`; wrap that one too. */
function wrapCallbacks(args: unknown[]): unknown[] {
  return args.map((arg) =>
    typeof arg === 'function' ? (sql: postgres.Sql) => (arg as Callable)(withQueryCancellation(sql)) : arg
  )
}

/**
 * Wrap a postgres.js client so the queries it starts inside a live
 * {@link QueryCancellationScope} are recorded there. Outside a scope it behaves
 * exactly like the client it wraps.
 */
export function withQueryCancellation<T extends postgres.Sql>(sql: T): T {
  return new Proxy(sql, {
    apply(target, thisArg, args: unknown[]) {
      return record(Reflect.apply(target as unknown as Callable, thisArg, args))
    },
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown
      if (typeof value !== 'function') return value
      const method = value as Callable
      switch (prop) {
        case 'unsafe':
        case 'file':
          return (...args: unknown[]) => record(method(...args))
        case 'begin':
        case 'savepoint':
          return (...args: unknown[]) => method(...wrapCallbacks(args))
        default:
          return value
      }
    },
  })
}
