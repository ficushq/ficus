import postgres from 'postgres'
import { createLogger } from '../lib/infra/logger'
import { resolveDatabaseTls } from './tls'

const log = createLogger('db')

/**
 * Default pool size. postgres.js's own default is 10 per pool, and a Ficus
 * instance opens a query pool in each of two processes (api + worker) — so the
 * ceiling multiplies. (It used to multiply harder: pg LISTEN/NOTIFY held a
 * listener plus a notifier connection per process until cross-process events
 * moved onto the loopback HTTP transport in lib/infra/local-events.ts.)
 * That is invisible on a dedicated database, but on a SHARED Postgres
 * instance (one database + role per tenant) total connections are the scarce
 * resource that caps tenants per instance, well before RAM or disk do.
 *
 * 4 is deliberate rather than tuned: postgres.js QUEUES when a pool is
 * saturated rather than erroring, so the cost of it being too small is added
 * latency, not failure. Raise DATABASE_POOL_MAX on any instance that shows
 * query queueing.
 *
 * Hold-and-wait — a pooled transaction that acquires a SECOND pool
 * connection while open — self-deadlocks a pool once enough of those
 * transactions run at once, and it happened live (noah tenant, 2026-08-27):
 * concurrent Subagent.dispatch calls wedged all 4 connections, the liveness
 * watchdog swapped the pool, and the swap's debris crashed the worker in a
 * loop. The known offenders were since moved off the pool: transactions that
 * must hold a lock across pool work run on a dedicated connection
 * (db/index.ts withDedicatedDbTransaction — Subagent.dispatch,
 * sandbox/death/notifier; memory/WriteService uses a dedicated session
 * lock), and the remaining in-transaction pool reads were hoisted or handed
 * the tx (WorkStream#update, Squad.update, Schedule#reenable). New
 * transaction bodies MUST NOT call global-pool helpers (entity statics,
 * InboxMessage.send, nested db.transaction) — pass the tx down or use
 * withDedicatedDbTransaction. One rare known residue: routes/auth.ts
 * first-admin bootstrap (Role.findBySlug inside its advisory-lock tx).
 * Residual hazard: a dedicated transaction that holds a ROW lock across pool
 * work (Subagent.dispatch's parent lock) no longer occupies a pool slot, but
 * pool-run writers blocked on that same row still do — keep such critical
 * sections short.
 */
const DEFAULT_POOL_MAX = 4

/**
 * Behind a transaction-mode pooler (setup-host's per-host PgBouncer,
 * DATABASE_POOL_MODE=transaction) a client connection is a pooler slot, not a
 * server backend: the server pool is sized on the pooler. So the client pool
 * goes back to postgres.js's own default of 10 — more in-flight work per
 * process, and the hold-and-wait self-deadlock (see DEFAULT_POOL_MAX) needs
 * ten wedged connections instead of four.
 */
const POOLED_DEFAULT_POOL_MAX = 10

/** True when DATABASE_URL points at a transaction-mode pooler (set by setup-host when database.pool.enabled). */
export function isTransactionPooled(): boolean {
  return process.env.DATABASE_POOL_MODE === 'transaction'
}

export function getPoolMax(): number {
  const fallback = isTransactionPooled() ? POOLED_DEFAULT_POOL_MAX : DEFAULT_POOL_MAX
  const raw = process.env.DATABASE_POOL_MAX
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    log.warn(`DATABASE_POOL_MAX='${raw}' is not a positive integer; using ${fallback}`)
    return fallback
  }
  return parsed
}

/**
 * Seconds an unused pooled connection is kept before it is closed.
 *
 * postgres.js keeps connections open FOREVER by default, so a pool that ever
 * peaked at `max` holds `max` connections until the process exits. Measured on
 * a live tenant: 8 idle connections, four of them untouched for 338 seconds —
 * one burst was still costing four connections long after it ended.
 *
 * On the hosted platform every tenant shares one managed cluster whose
 * `max_connections` is the real cap on fleet size, so those permanently-parked
 * connections are what limits how many customers fit — not load.
 *
 * Deliberately NOT addressed by lowering `max`: that caps burst capacity and
 * makes busy instances slower, which is the opposite trade. This releases
 * connections only when they are genuinely unused, leaving peak concurrency
 * untouched; the cost is one reconnect (a TLS handshake, tens of ms) on the
 * first query after a quiet spell.
 *
 * 60s stays warm through continuous work — a request burst, an agent turn, a
 * migration — and hands connections back during real idleness.
 */
const DEFAULT_IDLE_TIMEOUT_SECONDS = 60

function getIdleTimeout(): number {
  const raw = process.env.DATABASE_IDLE_TIMEOUT
  if (!raw) return DEFAULT_IDLE_TIMEOUT_SECONDS
  const parsed = Number.parseInt(raw, 10)
  // 0 must survive: postgres.js reads it as "never close", which is the old
  // behaviour and the escape hatch for anyone who measures a reconnect cost
  // they cannot accept.
  if (!Number.isFinite(parsed) || parsed < 0) {
    log.warn(`DATABASE_IDLE_TIMEOUT='${raw}' is not a non-negative integer; using ${DEFAULT_IDLE_TIMEOUT_SECONDS}`)
    return DEFAULT_IDLE_TIMEOUT_SECONDS
  }
  return parsed
}

/**
 * How often the pool liveness watchdog probes the database with `select 1`
 * (§4.2 of the DB pool self-heal design). 10s is frequent enough to notice a
 * wedged pool within tens of seconds without adding meaningful traffic on a
 * healthy connection.
 */
const DEFAULT_HEALTHCHECK_INTERVAL_MS = 10_000

function getHealthcheckIntervalMs(): number {
  const raw = process.env.DATABASE_HEALTHCHECK_INTERVAL_MS
  if (!raw) return DEFAULT_HEALTHCHECK_INTERVAL_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    log.warn(
      `DATABASE_HEALTHCHECK_INTERVAL_MS='${raw}' is not a positive integer; using ${DEFAULT_HEALTHCHECK_INTERVAL_MS}`
    )
    return DEFAULT_HEALTHCHECK_INTERVAL_MS
  }
  return parsed
}

/**
 * Consecutive failed liveness probes before the watchdog recreates the pool.
 * 3 × 10s ≈ 30s of no liveness before a swap — conservative, so a single slow
 * probe or a transient stall never triggers a needless recreate.
 */
const DEFAULT_FAILURES_BEFORE_SWAP = 3

function getFailuresBeforeSwap(): number {
  const raw = process.env.DATABASE_FAILURES_BEFORE_SWAP
  if (!raw) return DEFAULT_FAILURES_BEFORE_SWAP
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    log.warn(`DATABASE_FAILURES_BEFORE_SWAP='${raw}' is not a positive integer; using ${DEFAULT_FAILURES_BEFORE_SWAP}`)
    return DEFAULT_FAILURES_BEFORE_SWAP
  }
  return parsed
}

/** How long a single liveness probe waits before it counts as a failure. */
const PROBE_TIMEOUT_MS = 5_000

/**
 * Idle seconds before the OS sends its first TCP keepalive probe, passed to
 * postgres.js as `keep_alive`. postgres.js turns it into
 * `setKeepAlive(true, 1000 * keep_alive)` on every connection (src/startup.js),
 * which sets only this initial delay (TCP_KEEPIDLE); the per-probe interval and
 * count stay at OS defaults and are not tunable here. 10s tightens postgres.js's
 * own 60s default (#1149) without adding meaningful traffic on a healthy idle
 * connection.
 *
 * Scope, measured 2026-08-24 (do NOT over-trust this setting): keepalive is a
 * BACKSTOP, not a cure. A graceful Postgres restart or a peer that sends RST is
 * detected in seconds regardless (postgres.js sees the close). A fully
 * black-holed peer — frozen VM, dropped packets, no FIN/RST — is what keepalive
 * is for, yet on Bun/macOS a paused peer's idle socket stayed open past 240s in
 * testing (no probe interval/count or TCP_USER_TIMEOUT is exposed). Recovery of
 * the common idle case rides on `idle_timeout` (60s here), which drops an idle
 * connection locally without the peer. The unsolved gap is a connection kept
 * continuously ACTIVE by polling whose in-flight query hangs on a dead socket:
 * idle_timeout can't reclaim it and max_lifetime (30-60min) doesn't preempt it —
 * that needs a client-side query deadline, tracked separately.
 *
 * History: postgres.js v3 skipped its own keepalive whenever a `socket` factory
 * was supplied, so the Bun TLS leak guard (#1100) had to call setKeepAlive
 * itself. That guard was removed with the postgres.js 4 upgrade: v4's STARTTLS
 * upgrade detaches its raw-socket listeners with off(), and measured on Bun
 * 1.4.2 v4 retains none of the bytes streamed over TLS without any guard (v3
 * without the guard retained all of them). v4 also bounds the whole connect
 * attempt with connect_timeout and releases a failed connect's pool slot itself,
 * the other two jobs the factory did. db/bun-tls-leak.test.ts keeps the leak
 * from coming back unnoticed.
 */
const KEEPALIVE_INITIAL_DELAY_SECONDS = 10

/**
 * Re-apply the type handlers drizzle installs in its own constructor.
 *
 * postgres.js registers `JSON.stringify` as the serializer for the json/jsonb
 * OIDs and its own date handlers for the timestamp OIDs (node_modules/postgres/
 * src/types.js). drizzle already serializes those itself, so `drizzle(client)`
 * overwrites both with pass-throughs (node_modules/drizzle-orm/postgres-js/
 * driver.js) — otherwise every jsonb value is JSON.stringify'd a SECOND time and
 * lands in the column as a jsonb *string* rather than an object.
 *
 * That patch is applied once, to the `client.options` object that exists when
 * `drizzle()` runs. The liveness watchdog's pool swap builds a brand-new
 * postgres.js instance with a brand-new options object (postgres.js rebuilds
 * `serializers` in parseOptions), and nothing re-runs `drizzle()` against it —
 * the Proxy forwards `.options` straight through to the new instance, so the
 * patch is silently gone from the swap onward.
 *
 * Live consequence (noah, 2026-08-29): after one swap, ~90% of every jsonb write
 * — messages.metadata, inbox.metadata and squad_activity.ref alike — was written
 * double-encoded until the process was restarted, which is what re-ran
 * `drizzle()`. The surviving ~10% were writes on dedicated connections, which
 * call `drizzle()` per call and were therefore always patched. Timestamps were
 * quietly damaged too: the restored date handlers truncate sub-second precision.
 *
 * So the patch must be re-applied by `build()` itself, exactly like the #1149
 * keepalive, so a swapped-in instance is identical to the one drizzle was
 * constructed against.
 */
export function applyDrizzleTypeHandlers(client: postgres.Sql): postgres.Sql {
  const transparent = (value: unknown) => value
  const options = (
    client as unknown as { options: { parsers: Record<string, unknown>; serializers: Record<string, unknown> } }
  ).options
  // Mirrors drizzle-orm/postgres-js/driver.js: timestamp OIDs get BOTH a
  // pass-through parser and serializer; json (114) and jsonb (3802) only need
  // the serializer, since drizzle's own mapFromDriverValue parses on read.
  for (const oid of ['1184', '1082', '1083', '1114']) {
    options.parsers[oid] = transparent
    options.serializers[oid] = transparent
  }
  options.serializers['114'] = transparent
  options.serializers['3802'] = transparent
  return client
}

interface IntervalHandle {
  unref?: () => void
}
interface TimeoutHandle {
  unref?: () => void
}

/**
 * Options for {@link createResilientClient}. Every timing/scheduling dependency
 * is injectable so the watchdog can be driven by fake timers in a unit test
 * without a real Postgres or real wall-clock waits. Production callers pass only
 * `build`; the rest default to the real interval/timeout constants.
 */
export interface ResilientClientOptions {
  /** Constructs a fresh postgres.js instance. Called once at boot and again on every swap. */
  build: () => postgres.Sql
  /** Liveness probe cadence. Default: `DATABASE_HEALTHCHECK_INTERVAL_MS` (10s). */
  intervalMs?: number
  /** Per-probe timeout before it counts as a failure. Default 5s. */
  probeTimeoutMs?: number
  /** Consecutive probe failures before a swap. Default: `DATABASE_FAILURES_BEFORE_SWAP` (3). */
  failuresBeforeSwap?: number
  /** Clock source for backoff math. Default `Date.now`. */
  now?: () => number
  /** First backoff window after a swap; doubles per repeated swap. Default = intervalMs. */
  baseBackoffMs?: number
  /** Ceiling for the exponential swap backoff. Default 5min. */
  maxBackoffMs?: number
  /** Interval scheduler. Default real `setInterval` (the handle is unref'd). */
  scheduleInterval?: (fn: () => void, ms: number) => IntervalHandle
  clearScheduledInterval?: (handle: IntervalHandle) => void
  /** Timeout scheduler used for the per-probe deadline. Default real `setTimeout`. */
  scheduleTimeout?: (fn: () => void, ms: number) => TimeoutHandle
  clearScheduledTimeout?: (handle: TimeoutHandle) => void
}

/**
 * §4.2 pool liveness watchdog. Wraps a mutable `current` postgres.js instance in
 * a Proxy so drizzle and every raw `client\`…\`` consumer keep a stable handle
 * while the underlying pool can be transparently recreated. A background
 * `setInterval` probes `current\`select 1\`` (raced against a timeout); after N
 * consecutive failures the wedged pool is destroyed (`end({ timeout: 0 })`) and
 * rebuilt via the same `build` closure, so the #1149 keepalive applies to every
 * freshly-swapped instance.
 *
 * The returned value is the Proxy (typed as `postgres.Sql`). It additionally
 * carries a non-enumerable `__stopHealthWatchdog()` (reachable only via property
 * access, never via enumeration, so it does not leak into postgres.js's surface)
 * to stop the watchdog for clean shutdown and tests.
 */
export function createResilientClient(opts: ResilientClientOptions): postgres.Sql {
  const {
    build,
    intervalMs = getHealthcheckIntervalMs(),
    probeTimeoutMs = PROBE_TIMEOUT_MS,
    failuresBeforeSwap = getFailuresBeforeSwap(),
    now = Date.now,
    baseBackoffMs = intervalMs,
    maxBackoffMs = 5 * 60_000,
    scheduleInterval = (fn, ms) => setInterval(fn, ms),
    clearScheduledInterval = (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    scheduleTimeout = (fn, ms) => setTimeout(fn, ms),
    clearScheduledTimeout = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = opts

  const state = { current: build() }
  let consecutiveFailures = 0
  let probeOutstanding = false
  let swapCount = 0
  // Earliest wall-clock at which another swap is permitted (exponential backoff,
  // so a genuinely-down DB keeps failing fast rather than being recreated on
  // every probe).
  let nextSwapAllowedAt = 0
  let stopped = false

  /** Race a probe query against a deadline; rejects if the query hangs. */
  function probeWithTimeout(query: Promise<unknown> | unknown): Promise<void> {
    let handle: TimeoutHandle | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      handle = scheduleTimeout(() => reject(new Error('probe timeout')), probeTimeoutMs)
      handle.unref?.()
    })
    return Promise.race([Promise.resolve(query), deadline])
      .then(() => undefined)
      .finally(() => {
        if (handle) clearScheduledTimeout(handle)
      })
  }

  function maybeSwap(): void {
    const t = now()
    // Backoff window still open: skip the swap. The pool keeps failing fast,
    // which is the correct behaviour for a database that is genuinely gone.
    if (t < nextSwapAllowedAt) return
    const approxDownSeconds = Math.round((failuresBeforeSwap * intervalMs) / 1000)
    // `createLogger('db')` already prefixes `[db]`, so this reads
    // `[db] pool unresponsive for ~Ns — recreating` on the wire.
    log.error(`pool unresponsive for ~${approxDownSeconds}s — recreating`)
    const old = state.current
    // Best-effort: destroy sockets immediately, swallow any error. A rejected
    // promise here must not become an unhandled rejection.
    try {
      const ended = old.end({ timeout: 0 }) as unknown
      if (ended && typeof (ended as Promise<unknown>).then === 'function') {
        void (ended as Promise<unknown>).catch(() => {})
      }
    } catch {
      // ignore — the old instance is being discarded anyway.
    }
    state.current = build()
    consecutiveFailures = 0
    swapCount++
    const backoff = Math.min(baseBackoffMs * 2 ** (swapCount - 1), maxBackoffMs)
    nextSwapAllowedAt = t + backoff
  }

  async function runProbe(): Promise<void> {
    // Never overlap probes: a single outstanding probe means we never swap while
    // a probe that might yet succeed is in flight.
    if (stopped || probeOutstanding) return
    probeOutstanding = true
    const instance = state.current
    try {
      await probeWithTimeout(instance`select 1`)
      // Healthy: clear the failure streak and reset the swap backoff.
      consecutiveFailures = 0
      swapCount = 0
      nextSwapAllowedAt = 0
    } catch {
      consecutiveFailures++
      if (consecutiveFailures >= failuresBeforeSwap) maybeSwap()
    } finally {
      probeOutstanding = false
    }
  }

  const intervalHandle = scheduleInterval(() => {
    void runProbe()
  }, intervalMs)
  // Never keep the process alive for the watchdog.
  intervalHandle.unref?.()

  function stopWatchdog(): void {
    if (stopped) return
    stopped = true
    clearScheduledInterval(intervalHandle)
  }

  const proxy = new Proxy(function () {} as unknown as postgres.Sql, {
    apply(_target, _thisArg, args: unknown[]) {
      // Tagged-template / callable form: `client\`…\`` — forward to the current
      // instance so a swap is transparent.
      return Reflect.apply(state.current as unknown as (...a: unknown[]) => unknown, undefined, args)
    },
    get(_target, prop) {
      if (prop === '__stopHealthWatchdog') return stopWatchdog
      // Internal test seam: run exactly one probe and await it.
      if (prop === '__probeOnce') return runProbe
      if (prop === 'end') {
        // Intentional close: stop healing, then end the current instance.
        return (...args: unknown[]) => {
          stopWatchdog()
          return (state.current.end as (...a: unknown[]) => unknown)(...args)
        }
      }
      const value = (state.current as unknown as Record<PropertyKey, unknown>)[prop]
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(state.current) : value
    },
    set(_target, prop, value) {
      ;(state.current as unknown as Record<PropertyKey, unknown>)[prop] = value
      return true
    },
    has(_target, prop) {
      return prop in (state.current as object)
    },
  })

  return proxy as postgres.Sql
}

/**
 * Create a postgres.js connection with the correct SSL config.
 * All postgres connections should go through this function.
 *
 * Returns a Proxy over a mutable postgres.js instance guarded by the §4.2
 * liveness watchdog — swapping the underlying pool is transparent to drizzle and
 * every raw `client` consumer, so the 182 call sites are unchanged.
 */
export function createPostgresConnection(
  connectionString: string,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- postgres.js generic default
  options?: Omit<postgres.Options<{}>, 'ssl'>,
  resilience?: {
    /**
     * Wrap the connection in the §4.2 liveness watchdog (Proxy + pool-swap on a
     * wedged pool). OPT-IN, and ONLY for the long-lived main application pool.
     * It must NEVER be enabled for a dedicated single-connection client — e.g.
     * process-liveness holds one session advisory lock for the worker's whole
     * life ("losing it is fatal, never reconnect in-place"), and the watchdog
     * probing that busy max:1 connection would time out, recreate the pool,
     * DESTROY the lock connection, and trip the exact fatal-loss handler it was
     * meant to guard against — SIGTERMing the worker into a crash loop
     * (observed on tenant chowmein). Migration/lock/one-shot clients likewise
     * do not want a self-recreating pool. Default: OFF.
     */
    healthWatchdog?: boolean
  }
): postgres.Sql {
  // Only set `ssl` when we actually have a CA. Passing `ssl: undefined`
  // EXPLICITLY is not the same as omitting the key: postgres.js treats the
  // present-but-undefined option as "no TLS" and stops honouring the DSN's
  // own `?sslmode=require`. Against DigitalOcean's managed Postgres that
  // surfaces as
  //   no pg_hba.conf entry for host "...", user "...", database "...", no encryption
  // i.e. the server rejecting a plaintext connection — which read as a
  // firewall/permission problem and broke every tenant's runtime while
  // migrations (run by a different code path) had already succeeded.
  //
  // `dsn` is NOT `connectionString`: resolveDatabaseTls consumes and strips
  // `sslrootcert`, which postgres.js would otherwise forward to the server as
  // an unknown GUC and be refused outright. See db/tls.ts.
  const { connectionString: dsn, ca } = resolveDatabaseTls(connectionString)
  // Factored out so every freshly-swapped `current` gets an identical instance:
  // the #1149 keepalive applies to each one.
  const build = (): postgres.Sql =>
    postgres(dsn, {
      max: getPoolMax(),
      idle_timeout: getIdleTimeout(),
      keep_alive: KEEPALIVE_INITIAL_DELAY_SECONDS,
      // Caller-supplied options win, so a single-connection user can pin max: 1
      // without inheriting the pool default.
      ...options,
      ...(ca === undefined ? {} : { ssl: { ca } }),
    })

  // Only the main application pool opts into the liveness watchdog; every other
  // caller (process-liveness, migrations, run-lock, toolchain state, cli-bundle)
  // gets a plain instance the watchdog can never recreate out from under.
  //
  // The watchdog client is ALSO the one and only client drizzle wraps
  // (db/index.ts), so it — and every instance a swap rebuilds in its place —
  // must carry drizzle's type handlers. Plain instances deliberately do NOT get
  // them: raw `sql` callers (migrations, ConfigSync) pass objects and rely on
  // postgres.js serializing jsonb for them, so patching those to pass-throughs
  // would break exactly the writes drizzle isn't doing.
  return resilience?.healthWatchdog
    ? createResilientClient({ build: () => applyDrizzleTypeHandlers(build()) })
    : build()
}

/**
 * Returns the DATABASE_URL or throws.
 */
/**
 * Cap on concurrently-open DEDICATED (off-pool) connections per process.
 *
 * withDedicatedDbTransaction / the WriteService advisory lock deliberately
 * bypass the pool so lock-holding transactions cannot hold-and-wait a pool
 * slot — but on the hosted platform every tenant shares one managed cluster
 * whose max_connections is the scarce resource, so unbounded dedicated
 * connections would trade a bounded client-side queue for hard server-side
 * "too many clients" failures with cross-tenant blast radius. The slot gate
 * restores bounded queueing without putting the transactions back on the
 * pool. A dedicated-transaction body must NEVER itself acquire another
 * dedicated slot — that recreates hold-and-wait one level up.
 *
 * 2 per process, budgeted against the platform's per-tenant role cap
 * (TENANT_CONNECTION_LIMIT=16): two pools of 4 + two processes × 2 dedicated
 * = 12, plus the worker's one process-liveness session, leaving 3 connections
 * of operational headroom. VM setup, toolchain reconciliation and integration
 * authorization must share this gate too; max:1 on a fresh pool per call is
 * not a process-wide limit. The original 8 was
 * mis-budgeted — under retry load it could saturate the entire role by
 * itself (2026-08-27 noah incident: every agent turn failed with "too many
 * connections for role"). Additional work waits for an owned connection to
 * close instead of opening another pool that can exhaust the tenant role.
 */
const DEDICATED_CONNECTION_LIMIT = 2
let dedicatedConnectionsInUse = 0
const dedicatedConnectionWaiters: Array<() => void> = []

/**
 * Take a dedicated-connection slot and hand back its release. For the one
 * site whose connection outlives a callback (the update run-lock returns a
 * handle that is released minutes later); everything else uses
 * withDedicatedConnectionSlot. Release exactly once.
 */
export async function acquireDedicatedConnectionSlot(): Promise<() => void> {
  if (dedicatedConnectionsInUse >= DEDICATED_CONNECTION_LIMIT) {
    await new Promise<void>((resolve) => dedicatedConnectionWaiters.push(resolve))
  } else {
    dedicatedConnectionsInUse++
  }
  let released = false
  return () => {
    if (released) return
    released = true
    releaseDedicatedConnectionSlot()
  }
}

/** Non-queueing variant for interactive recovery: never launch stale work later. */
export function tryAcquireDedicatedConnectionSlot(): (() => void) | null {
  if (dedicatedConnectionsInUse >= DEDICATED_CONNECTION_LIMIT) return null
  dedicatedConnectionsInUse++
  let released = false
  return () => {
    if (released) return
    released = true
    releaseDedicatedConnectionSlot()
  }
}

export async function withDedicatedConnectionSlot<T>(fn: () => Promise<T>): Promise<T> {
  const release = await acquireDedicatedConnectionSlot()
  try {
    return await fn()
  } finally {
    release()
  }
}

function releaseDedicatedConnectionSlot(): void {
  // Transfer ownership directly. Decrementing before waking a waiter lets a
  // new caller steal the slot before the queued continuation resumes.
  const next = dedicatedConnectionWaiters.shift()
  if (next) next()
  else dedicatedConnectionsInUse--
}

/**
 * Server-side liveness bounds for dedicated connections. They have no pool
 * watchdog on purpose (a watchdog must never recreate a lock-holding max:1
 * client), so a hung query would otherwise hold its row/advisory lock
 * forever; these make Postgres cancel it instead.
 *
 * Applied with applyDedicatedSessionSettings after connecting, never as
 * startup parameters: a managed endpoint that is itself a PgBouncer (a
 * DigitalOcean Advanced cluster's) refuses unknown startup parameters with
 * `08P01 unsupported startup parameter`, even inside `options`.
 */
export const DEDICATED_CONNECTION_SESSION = {
  statement_timeout: 60_000,
  idle_in_transaction_session_timeout: 120_000,
} as const

/** A postgres.js tagged-template query function (a client, a reserved session, or a transaction). */
type TaggedQuery = (strings: TemplateStringsArray, ...values: never[]) => PromiseLike<unknown>

/**
 * Apply DEDICATED_CONNECTION_SESSION to a dedicated connection with
 * set_config: for the session (`'session'`, right after reserve) or for the
 * current transaction only (`'transaction'`, the first statement inside it).
 */
export async function applyDedicatedSessionSettings(
  query: TaggedQuery,
  scope: 'session' | 'transaction'
): Promise<void> {
  const local = scope === 'transaction'
  const run = query as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown>
  await run`select set_config('statement_timeout', ${String(DEDICATED_CONNECTION_SESSION.statement_timeout)}, ${local}), set_config('idle_in_transaction_session_timeout', ${String(DEDICATED_CONNECTION_SESSION.idle_in_transaction_session_timeout)}, ${local})`
}

/**
 * postgres.js error codes raised when a pool is torn down out from under its
 * in-flight queries — exactly what the §4.2 watchdog's pool swap (and any
 * deliberate `end({ timeout: 0 })`) produces. Queries whose callers await them
 * surface these as ordinary rejections; the handful of fire-and-forget query
 * sites have NO awaiter, so the same rejection becomes an unhandledRejection
 * and kills the process. Observed live (noah tenant, 2026-08-27): a wedged
 * pool tripped the watchdog, the swap's CONNECTION_DESTROYED debris crashed
 * the worker, and systemd restart-looped it — turning a 30s recovery
 * mechanism into a repeating full-worker outage that aborted every running
 * execution.
 */
const PG_TEARDOWN_CODES = new Set(['CONNECTION_DESTROYED', 'CONNECTION_CLOSED', 'CONNECTION_ENDED'])

export function isPgTeardownError(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false
  const code = (reason as { code?: unknown }).code
  return typeof code === 'string' && PG_TEARDOWN_CODES.has(code)
}

let pgTeardownGuardInstalled = false

/** Test-only: allow re-installing the guard in a fresh listener. */
export function __resetPgTeardownGuardForTests(): void {
  pgTeardownGuardInstalled = false
}

/**
 * Install a process-level guard that absorbs unhandled pool-teardown
 * rejections and preserves crash-on-unhandled semantics for everything else
 * (rethrowing from the handler escalates to uncaughtException → default
 * print-and-exit). Call once from each long-lived entrypoint (api, worker);
 * never from library code or tests.
 */
export function installPgTeardownRejectionGuard(): void {
  if (pgTeardownGuardInstalled) return
  pgTeardownGuardInstalled = true
  process.on('unhandledRejection', (reason) => {
    if (isPgTeardownError(reason)) {
      log.warn('absorbed unhandled pool-teardown rejection (pool was recreated or closed):', reason)
      return
    }
    // Rethrowing from inside a listener replaces the rejection's own stack
    // with this frame in the crash output (measured on Bun 1.3.8) — log the
    // origin first so the crash is still attributable.
    log.error('unhandled rejection — crashing:', reason instanceof Error ? (reason.stack ?? reason) : reason)
    throw reason
  })
}

export function getConnectionString(): string {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required')
  }
  return connectionString
}

/**
 * The DSN that reaches Postgres DIRECTLY, bypassing any transaction pooler.
 * Everything session-scoped must use it: session advisory locks (migrations,
 * the update run-lock, memory writes, provisioning leases, the worker's
 * process-liveness session) and the dedicated-connection transactions — a
 * transaction pooler hands a backend to a client only for one transaction,
 * so a session lock taken through it is released (or lands on another
 * backend) the moment the statement ends. On an unpooled host it is simply
 * DATABASE_URL.
 */
export function getDirectConnectionString(): string {
  return process.env.DATABASE_DIRECT_URL || getConnectionString()
}
