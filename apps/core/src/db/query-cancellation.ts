import { AsyncLocalStorage } from 'node:async_hooks'
import type postgres from 'postgres'

/**
 * Cancel the database work of a request nobody is waiting for any more.
 *
 * The read deadline (middleware/read-deadline.ts) answers a slow read with a 503,
 * and a client can hang up on its own, but the handler behind either keeps running
 * and keeps a pool connection busy until its query finishes. Under load that is
 * exactly the connection the next request needs. So the middleware runs each read
 * inside {@link runWithQueryCancellation}, and every query the main pool starts in
 * that scope (drizzle, raw tagged templates, and queries inside a transaction)
 * carries the scope's signal. When the signal aborts, postgres.js cancels the query:
 * one still waiting for a connection is dropped from the queue, one in flight gets a
 * Postgres cancel request (it fails with 57014, "canceling statement due to user
 * request"), and the connection goes back to the pool.
 *
 * Only the main pool (db/index.ts) is wrapped. Dedicated connections (locks,
 * migrations, withDedicatedDbTransaction) are never cancelled this way.
 */
const scope = new AsyncLocalStorage<AbortSignal>()

/** Run `fn` with every main-pool query it starts tied to `signal`. */
export function runWithQueryCancellation<T>(signal: AbortSignal, fn: () => T): T {
  return scope.run(signal, fn)
}

/**
 * Run `fn` outside any cancellation scope, for work a read starts that must outlive
 * the request (a background write it kicks off, for example).
 */
export function runDetachedFromQueryCancellation<T>(fn: () => T): T {
  return scope.exit(fn)
}

/** The signal queries started here would carry, if any. */
export function currentQueryCancellationSignal(): AbortSignal | undefined {
  return scope.getStore()
}

type SignalledQuery = { signal(signal: AbortSignal): unknown }

function isQuery(value: unknown): value is SignalledQuery {
  // A postgres.js Query is a Promise subclass with `signal`; fragments such as
  // identifiers and builders are neither.
  return value instanceof Promise && typeof (value as Partial<SignalledQuery>).signal === 'function'
}

function attach<T>(value: T): T {
  const signal = scope.getStore()
  if (signal && isQuery(value)) value.signal(signal)
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
 * Wrap a postgres.js client so the queries it starts inside a
 * {@link runWithQueryCancellation} scope are cancelled when the scope's signal
 * aborts. Outside a scope it behaves exactly like the client it wraps.
 */
export function withQueryCancellation<T extends postgres.Sql>(sql: T): T {
  return new Proxy(sql, {
    apply(target, thisArg, args: unknown[]) {
      return attach(Reflect.apply(target as unknown as Callable, thisArg, args))
    },
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown
      if (typeof value !== 'function') return value
      const method = value as Callable
      switch (prop) {
        case 'unsafe':
        case 'file':
          return (...args: unknown[]) => attach(method(...args))
        case 'begin':
        case 'savepoint':
          return (...args: unknown[]) => method(...wrapCallbacks(args))
        default:
          return value
      }
    },
  })
}
