import postgres from 'postgres'
import net from 'node:net'
import { Duplex } from 'node:stream'
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

export function getPoolMax(): number {
  const raw = process.env.DATABASE_POOL_MAX
  if (!raw) return DEFAULT_POOL_MAX
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    log.warn(`DATABASE_POOL_MAX='${raw}' is not a positive integer; using ${DEFAULT_POOL_MAX}`)
    return DEFAULT_POOL_MAX
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
 * Bun + postgres.js + TLS leaks every byte the server sends, forever.
 *
 * postgres.js negotiates TLS STARTTLS-style: it attaches `once('data')` to the
 * raw net.Socket for the server's 'S' reply, then `removeAllListeners()` and
 * `tls.connect({ socket })`. On Bun (1.3.8 AND 1.3.14, measured) a raw socket
 * that is not in flowing mode at upgrade time keeps receiving a copy of every
 * decrypted chunk in its own readable buffer while the TLSSocket ALSO delivers
 * it — and nothing ever reads the raw side. Node does not do this. Observed
 * live on a tenant whose dashboard polls the API ~5 req/s against DigitalOcean
 * managed Postgres: the api process swelled to ~3 GB (heap diff: +245 MB of
 * Uint8Array in 4 minutes, all reachable from TLSSocket.kSocket →
 * _readableState.buffer, 25,700 chunks per pool connection), swap-thrashing a
 * 2 GB droplet. A/B against the same database: 2.7 GB streamed → 3.3 GB heap
 * retained without this; 2 GB streamed → ~20 MB with it (and ~60% more
 * throughput, since the leak was also CPU).
 *
 * The fix hands postgres.js a socket we own (its `socket` option) and, the
 * moment postgres.js strips the listeners before the upgrade, re-attaches a
 * no-op 'data' listener so the raw side stays flowing and its copy is dropped
 * on arrival. Bun-only; Node gets postgres.js's default socket. The override
 * lives on the instance, not the prototype, and postgres.js only ever calls
 * removeAllListeners() here and on final close, where it is harmless.
 *
 * Trade-off accepted: with a caller-supplied socket postgres.js skips its own
 * multi-host round-robin (`host=a,b`), so this connects to the first host. No
 * Ficus DSN uses multiple hosts.
 */
/**
 * Idle time before the OS sends its first TCP keepalive probe. Node/Bun's
 * `setKeepAlive(true, ms)` sets only this initial delay (TCP_KEEPIDLE); the
 * per-probe interval and count stay at OS defaults and are not tunable here,
 * which is why keepalive is only a backstop (see the call site). 10s tightens
 * postgres.js's own 60s default without adding meaningful traffic on a healthy
 * idle connection.
 */
const KEEPALIVE_INITIAL_DELAY_MS = 10_000

export function createBunTlsSafeSocketFactory(connect: typeof net.connect = net.connect) {
  return async (options: {
    host?: string[] | string
    port?: number[] | number
    /** postgres.js passes `false` here (not undefined) when no unix socket path is used. */
    path?: string | false
    /** postgres.js passes its full options object here; connect_timeout is in SECONDS. */
    connect_timeout?: number
  }): Promise<net.Socket> => {
    const host = Array.isArray(options.host) ? options.host[0] : options.host
    const port = Array.isArray(options.port) ? options.port[0] : options.port
    const socket = options.path ? connect(options.path) : connect(Number(port ?? 5432), host ?? 'localhost')
    // Restore TCP keepalive that supplying a `socket` factory silently turned
    // OFF. postgres.js enables it itself (connection.js: `setKeepAlive(true,
    // 1000 * keep_alive)`, keep_alive default 60) — but ONLY on its own socket
    // path; the moment we hand it `options.socket`, that line is skipped and
    // every tenant lost keepalive when the leak fix (which added this factory)
    // shipped. Re-adding it here matches the factory-less behaviour, tightened
    // to a 10s initial probe delay.
    //
    // Scope, measured 2026-08-24 (do NOT over-trust this line): keepalive is a
    // BACKSTOP, not a cure. A graceful Postgres restart or a peer that sends
    // RST is detected in seconds regardless (postgres.js sees the close). A
    // fully black-holed peer — frozen VM, dropped packets, no FIN/RST — is what
    // keepalive is for, yet on Bun/macOS a paused peer's idle socket stayed
    // open past 240s in testing (Node exposes only the initial delay, not the
    // probe interval/count, and no TCP_USER_TIMEOUT). Recovery of the common
    // idle case rides on postgres.js's `idle_timeout` (60s here), which drops
    // an idle connection locally without the peer. The unsolved gap is a
    // connection kept continuously ACTIVE by polling whose in-flight query
    // hangs on a dead socket: idle_timeout can't reclaim it and max_lifetime
    // (30-60min) doesn't preempt it — that needs a client-side query deadline,
    // tracked separately. This was the /api/auth/status hang that blanked the
    // web UI until a manual `pm2 restart tau-api`.
    socket.setKeepAlive(true, KEEPALIVE_INITIAL_DELAY_MS)
    // postgres.js reads these off the socket (servername for TLS, error text).
    Object.assign(socket, { host, port })
    const originalRemoveAllListeners = socket.removeAllListeners.bind(socket)
    socket.removeAllListeners = ((...args: Parameters<net.Socket['removeAllListeners']>) => {
      const result = originalRemoveAllListeners(...args)
      queueMicrotask(() => {
        if (!socket.destroyed && socket.listenerCount('data') === 0) socket.on('data', dropRawTlsCopy)
      })
      return result
    }) as net.Socket['removeAllListeners']
    // This wait MUST be deadline-bounded. postgres.js arms its own
    // connect_timeout only AFTER the socket factory resolves
    // (connection.js: `socket = await createSocket()` runs before
    // `connectTimer.start()`), so the TCP connect below is otherwise the one
    // unbounded await in the whole connection path: a SYN that goes
    // unanswered (dropped under load, full accept backlog, stalled DNS)
    // neither connects nor errors, and every query on the pool then waits
    // forever with zero output. That exact silent-forever mode is what
    // rotated through CI as 60s test-budget deaths in
    // pickup.test.ts's restart matrix — a spawned worker whose first DB
    // query never came back, killed only by the test timeout, stderr empty.
    // Honouring connect_timeout here restores the same bound the default
    // (factory-less) path has. The failure is reported through the socket
    // itself (see failedConnection), not as a rejection, so postgres.js
    // releases the connection instead of leaking its pool slot.
    const timeoutSeconds = Number(options.connect_timeout)
    const timeoutMs = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds * 1000 : 30_000
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer)
          socket.off('connect', onConnect)
          socket.off('error', onError)
        }
        const onError = (error: Error) => {
          cleanup()
          reject(error)
        }
        const onConnect = () => {
          cleanup()
          resolve()
        }
        const timer = setTimeout(() => {
          cleanup()
          socket.destroy()
          // `path` is `false` (not undefined) in postgres.js's options when unused.
          const target = options.path ? options.path : `${host ?? 'localhost'}:${port ?? 5432}`
          reject(
            Object.assign(new Error(`CONNECT_TIMEOUT ${target}: TCP connect did not complete within ${timeoutMs}ms`), {
              code: 'CONNECT_TIMEOUT',
            })
          )
        }, timeoutMs)
        socket.once('connect', onConnect)
        socket.once('error', onError)
      })
    } catch (error) {
      return failedConnection(socket, error as Error, { host, port: port === undefined ? undefined : Number(port) })
    }
    return socket
  }
}

/**
 * Report a failed connect the way postgres.js's own socket does: 'error', then
 * 'close'. Do NOT reject instead. postgres.js answers a rejected socket factory
 * with error() but never runs its closed() handler, so the connection is never
 * released back to the pool: each failed connect (a database restart, a DNS
 * blip, a connect timeout) permanently used up a pool slot, and once they were
 * all gone every query on that client hung forever.
 *
 * The failed socket's own events race postgres.js attaching its listeners (its
 * 'close' can land before or after), so it is discarded and postgres.js gets a
 * stand-in that swallows writes and emits nothing by itself. postgres.js
 * attaches its listeners as soon as the factory resolves, before setImmediate
 * runs, so the failure then takes its normal release-and-reconnect path.
 */
function failedConnection(failed: net.Socket, error: Error, endpoint: { host?: string; port?: number }): net.Socket {
  failed.destroy()
  let reported = false
  const report = () => {
    if (reported) return
    reported = true
    clearTimeout(fallback)
    // Never throw an unheard 'error' out of a timer; without a listener there is
    // no pool connection to release.
    if (standIn.listenerCount('error') > 0) standIn.emit('error', error)
    standIn.emit('close', true)
    standIn.destroy()
  }
  const standIn = new Duplex({
    emitClose: false,
    read() {},
    write(_chunk, _encoding, callback) {
      callback()
      // postgres.js writes its startup (or SSL request) as soon as the factory
      // resolves, batched and flushed on setImmediate. Fail only after that
      // flush: closing first cancels the flush but leaves the batch behind,
      // and the next connection's startup is queued behind it and never sent.
      setImmediate(report)
    },
  })
  // postgres.js always writes first; this only covers a caller that never does.
  const fallback = setTimeout(report, 1_000)
  Object.assign(standIn, endpoint)
  return standIn as unknown as net.Socket
}

/** Named so a heap snapshot / listener dump says what this listener is for. */
function dropRawTlsCopy(): void {}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'

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
 * So the patch must be re-applied by `build()` itself, exactly like the #1100
 * socket factory and #1149 keepalive, so a swapped-in instance is identical to
 * the one drizzle was constructed against.
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
 * rebuilt via the same `build` closure, so the #1100 leak-guard socket factory
 * and #1149 keepalive apply to every freshly-swapped instance.
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
  // the #1100 Bun TLS leak-guard socket factory (a NEW factory per instance) and
  // the #1149 keepalive apply to each one.
  const build = (): postgres.Sql =>
    postgres(dsn, {
      max: getPoolMax(),
      idle_timeout: getIdleTimeout(),
      // Applied for every DSN, not just CA-bearing ones: `?sslmode=require`
      // without a CA takes the same leaking upgrade path, and on a plaintext
      // connection the hook only ever fires at final close (harmless).
      ...(isBun ? { socket: createBunTlsSafeSocketFactory() } : {}),
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

export async function withDedicatedConnectionSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (dedicatedConnectionsInUse >= DEDICATED_CONNECTION_LIMIT) {
    await new Promise<void>((resolve) => dedicatedConnectionWaiters.push(resolve))
  } else {
    dedicatedConnectionsInUse++
  }
  try {
    return await fn()
  } finally {
    // Transfer ownership directly. Decrementing before waking a waiter lets a
    // new caller steal the slot before the queued continuation resumes.
    const next = dedicatedConnectionWaiters.shift()
    if (next) next()
    else dedicatedConnectionsInUse--
  }
}

/**
 * Server-side liveness bounds for dedicated connections. They have no pool
 * watchdog on purpose (a watchdog must never recreate a lock-holding max:1
 * client), so a hung query would otherwise hold its row/advisory lock
 * forever; these make Postgres cancel it instead.
 */
export const DEDICATED_CONNECTION_SESSION = {
  statement_timeout: 60_000,
  idle_in_transaction_session_timeout: 120_000,
} as const

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
