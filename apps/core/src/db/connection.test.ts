import '../test-utils/require-test-db'
import { describe, test, expect, afterEach, mock } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as net from 'node:net'
import {
  __resetPgTeardownGuardForTests,
  createPostgresConnection,
  createResilientClient,
  installPgTeardownRejectionGuard,
  isPgTeardownError,
  withDedicatedConnectionSlot,
} from './connection'
import type postgres from 'postgres'
import { RDS_CA_PATH, resolveDatabaseTls } from './tls'

// Never connects — postgres.js is lazy, so constructing against an unreachable
// DSN is safe as long as no query is issued.
const DSN = 'postgres://u:p@127.0.0.1:5432/nonexistent'

const priorPoolMax = process.env.DATABASE_POOL_MAX
const priorCaPath = process.env.DATABASE_CA_PATH

afterEach(() => {
  if (priorPoolMax === undefined) delete process.env.DATABASE_POOL_MAX
  else process.env.DATABASE_POOL_MAX = priorPoolMax
  if (priorCaPath === undefined) delete process.env.DATABASE_CA_PATH
  else process.env.DATABASE_CA_PATH = priorCaPath
})

const CA_PEM = '-----BEGIN CERTIFICATE-----\nfake-do-ca-body\n-----END CERTIFICATE-----\n'

/** Write a throwaway CA file and hand back its path. Cleaned up by the caller. */
function withCaFile(fn: (caPath: string) => void | Promise<void>): void | Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ficus-ca-'))
  const caPath = join(dir, 'ca.crt')
  writeFileSync(caPath, CA_PEM)
  const done = () => rmSync(dir, { recursive: true, force: true })
  try {
    const result = fn(caPath)
    if (result instanceof Promise) return result.finally(done)
    done()
  } catch (err) {
    done()
    throw err
  }
}

describe('createPostgresConnection health watchdog opt-in', () => {
  test('is OFF by default — special single-connection clients (liveness, locks, migrations) must not be recreated', async () => {
    const sql = createPostgresConnection(DSN)
    // No watchdog Proxy: the plain instance carries no __stopHealthWatchdog seam.
    expect((sql as unknown as { __stopHealthWatchdog?: unknown }).__stopHealthWatchdog).toBeUndefined()
    await sql.end()
  })

  test('is ON only when healthWatchdog:true — the long-lived main pool', async () => {
    const sql = createPostgresConnection(DSN, { onnotice: () => {} }, { healthWatchdog: true })
    const stop = (sql as unknown as { __stopHealthWatchdog?: () => void }).__stopHealthWatchdog
    expect(typeof stop).toBe('function')
    stop!() // stop the interval so the test leaks no timer
    await sql.end()
  })
})

describe('createPostgresConnection pool sizing', () => {
  test('defaults to 4 rather than postgres.js’s default of 10', async () => {
    delete process.env.DATABASE_POOL_MAX
    delete process.env.DATABASE_POOL_MODE
    const sql = createPostgresConnection(DSN)
    expect(sql.options.max).toBe(4)
    await sql.end()
  })

  test('behind a transaction pooler the client pool defaults to 10: client connections are pooler slots, not backends', async () => {
    delete process.env.DATABASE_POOL_MAX
    process.env.DATABASE_POOL_MODE = 'transaction'
    try {
      const sql = createPostgresConnection(DSN)
      expect(sql.options.max).toBe(10)
      await sql.end()
    } finally {
      delete process.env.DATABASE_POOL_MODE
    }
  })

  test('an explicit DATABASE_POOL_MAX still wins when pooled', async () => {
    process.env.DATABASE_POOL_MAX = '3'
    process.env.DATABASE_POOL_MODE = 'transaction'
    try {
      const sql = createPostgresConnection(DSN)
      expect(sql.options.max).toBe(3)
      await sql.end()
    } finally {
      delete process.env.DATABASE_POOL_MODE
    }
  })

  test('DATABASE_POOL_MAX overrides the default', async () => {
    process.env.DATABASE_POOL_MAX = '12'
    const sql = createPostgresConnection(DSN)
    expect(sql.options.max).toBe(12)
    await sql.end()
  })

  test('a caller-supplied max wins over the default (a single-connection user can pin max: 1)', async () => {
    delete process.env.DATABASE_POOL_MAX
    const sql = createPostgresConnection(DSN, { max: 1 })
    expect(sql.options.max).toBe(1)
    await sql.end()
  })

  test('a non-numeric or non-positive DATABASE_POOL_MAX falls back to the default', async () => {
    // A typo must not silently produce max: NaN, which postgres.js would treat
    // as an unbounded/broken pool on a shared instance.
    for (const bad of ['not-a-number', '0', '-3']) {
      process.env.DATABASE_POOL_MAX = bad
      const sql = createPostgresConnection(DSN)
      expect(sql.options.max).toBe(4)
      await sql.end()
    }
  })
})

describe('TLS handling', () => {
  // Regression: passing `ssl: undefined` EXPLICITLY is not the same as
  // omitting the key — postgres.js reads the present-but-undefined option as
  // "no TLS" and stops honouring the DSN's own ?sslmode=require. Against a
  // managed provider that rejects plaintext this failed at runtime with
  // `no pg_hba.conf entry ... no encryption`, while migrations (a different
  // code path) had already succeeded — so it read as a firewall problem.
  test("honours the DSN's sslmode=require for a non-RDS host", async () => {
    const sql = createPostgresConnection('postgres://u:p@db.example.com:25060/x?sslmode=require')
    // Before the fix this was clobbered to `undefined` — postgres.js then
    // connected in plaintext and the managed provider refused it.
    expect(sql.options.ssl).toBe('require')
    await sql.end()
  })

  test('a non-RDS dsn without sslmode stays unencrypted (unchanged behaviour)', async () => {
    const sql = createPostgresConnection('postgres://u:p@db.example.com:5432/x')
    expect(sql.options.ssl).toBe(false)
    await sql.end()
  })

  // A CA turns `sslmode=require` (encrypted but UNAUTHENTICATED — no defence
  // against an active attacker on the same VPC presenting their own
  // certificate) into verify-full: postgres.js only skips verification for
  // the bare 'require'/'allow'/'prefer' strings, so an ssl OBJECT leaves
  // node's rejectUnauthorized + servername checks on.
  test('a CA in the DSN (sslrootcert) enables full verification', async () => {
    await withCaFile(async (caPath) => {
      const sql = createPostgresConnection(
        `postgres://u:p@db.example.com:25060/x?sslmode=verify-full&sslrootcert=${encodeURIComponent(caPath)}`
      )
      expect(sql.options.ssl).toEqual({ ca: CA_PEM })
      // NOT the degraded shape this task exists to remove.
      expect((sql.options.ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized).toBeUndefined()
      await sql.end()
    })
  })

  // postgres.js does not understand `sslrootcert` (only the literal value
  // 'system'), and every query parameter it does not recognise is forwarded
  // to the SERVER in the startup packet — where postgres rejects it with
  // `FATAL: unrecognized configuration parameter "sslrootcert"` (SQLSTATE
  // 42704), verified against a real postgres. So the parameter has to be
  // consumed and STRIPPED here, or adding it to a DSN breaks every
  // connection outright.
  test('sslrootcert is consumed here, never forwarded as a server startup parameter', async () => {
    await withCaFile(async (caPath) => {
      const sql = createPostgresConnection(
        `postgres://u:p@db.example.com:25060/x?sslmode=verify-full&sslrootcert=${encodeURIComponent(caPath)}`
      )
      expect(sql.options.connection.sslrootcert).toBeUndefined()
      await sql.end()
    })
  })

  test('DATABASE_CA_PATH enables full verification for a DSN that carries no sslrootcert', async () => {
    await withCaFile(async (caPath) => {
      process.env.DATABASE_CA_PATH = caPath
      const sql = createPostgresConnection('postgres://u:p@db.example.com:25060/x?sslmode=require')
      expect(sql.options.ssl).toEqual({ ca: CA_PEM })
      await sql.end()
    })
  })

  test("the DSN's own sslrootcert wins over DATABASE_CA_PATH", async () => {
    await withCaFile(async (caPath) => {
      process.env.DATABASE_CA_PATH = '/nonexistent/would-throw-if-used.crt'
      const sql = createPostgresConnection(
        `postgres://u:p@db.example.com:25060/x?sslrootcert=${encodeURIComponent(caPath)}`
      )
      expect(sql.options.ssl).toEqual({ ca: CA_PEM })
      await sql.end()
    })
  })

  // THE point of this file. A configured-but-unreadable CA used to degrade to
  // `{ rejectUnauthorized: false }` — silently unauthenticated TLS, which is
  // exactly the posture verify-full exists to end. It must fail loudly
  // instead: on a shared VPC where tenant VMs are treated as compromisable,
  // "connected anyway" is the worst possible outcome.
  test('a configured CA that is missing THROWS — it never degrades to rejectUnauthorized: false', () => {
    process.env.DATABASE_CA_PATH = '/nonexistent/ficus-db-ca.crt'
    expect(() => createPostgresConnection('postgres://u:p@db.example.com:25060/x?sslmode=verify-full')).toThrow(
      /\/nonexistent\/ficus-db-ca\.crt/
    )
    expect(() => resolveDatabaseTls('postgres://u:p@db.example.com:25060/x')).toThrow(/DATABASE_CA_PATH/)
  })

  test('a missing sslrootcert file THROWS rather than connecting unverified', () => {
    expect(() =>
      createPostgresConnection('postgres://u:p@db.example.com:25060/x?sslmode=verify-full&sslrootcert=/nope/ca.crt')
    ).toThrow(/sslrootcert/)
  })

  // Legacy RDS seam: the bundle path is still implied by the hostname, but a
  // MISSING bundle is now the same loud failure as any other configured CA.
  test('an RDS host with no CA bundle installed THROWS instead of disabling verification', () => {
    const DSN_RDS = 'postgres://u:p@thing.rds.amazonaws.com:5432/x'
    if (existsSync(RDS_CA_PATH)) {
      // A machine that really does ship the bundle: it must be USED, not ignored.
      const sql = createPostgresConnection(DSN_RDS)
      expect((sql.options.ssl as { ca?: string }).ca).toBeTruthy()
      void sql.end()
      return
    }
    let threw: unknown
    try {
      createPostgresConnection(DSN_RDS)
    } catch (err) {
      threw = err
    }
    expect(threw).toBeInstanceOf(Error)
    expect(String(threw)).toContain(RDS_CA_PATH)
  })
})

// postgres.js keeps pooled connections open FOREVER by default, so a pool that
// ever peaked at `max` holds `max` until the process exits. Measured on a live
// tenant: 8 idle connections, four untouched for 338 seconds. On the hosted
// platform every tenant shares one managed cluster whose max_connections is
// the real cap on fleet size, so those parked connections limit how many
// customers fit — not load.
describe('idle connection timeout', () => {
  const ENV = 'DATABASE_IDLE_TIMEOUT'
  const original = process.env[ENV]
  afterEach(() => {
    if (original === undefined) delete process.env[ENV]
    else process.env[ENV] = original
  })

  test('defaults to 60s so idle connections are returned to the cluster', async () => {
    delete process.env[ENV]
    const sql = createPostgresConnection('postgres://u:p@127.0.0.1:1/db')
    expect(sql.options.idle_timeout).toBe(60)
    await sql.end()
  })

  // 0 means "never close" — the previous behaviour, kept reachable for anyone
  // who measures a reconnect cost they cannot accept.
  test('0 is honoured and means never close', async () => {
    process.env[ENV] = '0'
    const sql = createPostgresConnection('postgres://u:p@127.0.0.1:1/db')
    expect(sql.options.idle_timeout).toBe(0)
    await sql.end()
  })

  test('a malformed value falls back to the default rather than disabling the timeout', async () => {
    process.env[ENV] = 'abc'
    const sql = createPostgresConnection('postgres://u:p@127.0.0.1:1/db')
    expect(sql.options.idle_timeout).toBe(60)
    await sql.end()
  })

  // The pool max is the burst ceiling and must NOT be reduced to save
  // connections — that would make busy instances slower. The idle timeout is
  // what reclaims them, leaving peak concurrency untouched.
  test('the burst ceiling is unchanged', async () => {
    delete process.env[ENV]
    const sql = createPostgresConnection('postgres://u:p@127.0.0.1:1/db')
    expect(sql.options.max).toBe(4)
    await sql.end()
  })
})

// postgres.js 4 replaced the Bun TLS leak-guard socket factory Core used to
// supply (see KEEPALIVE_INITIAL_DELAY_SECONDS in connection.ts for why it was
// removed). These pin the jobs that factory did, now done by postgres.js
// itself: the 10s keepalive, a bounded connect, released pool slots after a
// failed connect, and recovery once the database is back.
describe('connection lifecycle on postgres.js 4 (no socket factory)', () => {
  async function withServer<T>(
    onConnection: (socket: net.Socket) => void,
    fn: (port: number) => Promise<T>
  ): Promise<T> {
    const sockets = new Set<net.Socket>()
    const server = net.createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => {})
      onConnection(socket)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      return await fn((server.address() as { port: number }).port)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((r) => server.close(() => r()))
    }
  }

  /** Settle a postgres.js query: it only runs when awaited through .then(). */
  function settle(query: PromiseLike<unknown>): Promise<unknown> {
    return Promise.resolve(query).then(
      () => 'connected',
      (error: unknown) => error
    )
  }

  test('every client asks postgres.js for a 10s keepalive and supplies no socket factory', async () => {
    const plain = createPostgresConnection(DSN)
    const pooled = createPostgresConnection(DSN, undefined, { healthWatchdog: true })
    try {
      for (const sql of [plain, pooled]) {
        expect(sql.options.keep_alive).toBe(10)
        expect((sql.options as { socket?: unknown }).socket).toBeFalsy()
      }
    } finally {
      await plain.end()
      await pooled.end()
    }
  })

  test('the keepalive reaches the TCP socket (TCP_KEEPIDLE 10s)', async () => {
    const calls: unknown[][] = []
    const original = net.Socket.prototype.setKeepAlive
    net.Socket.prototype.setKeepAlive = function (this: net.Socket, ...args: unknown[]) {
      calls.push(args)
      return (original as (...keepAliveArgs: unknown[]) => net.Socket).apply(this, args)
    } as typeof original
    try {
      // A server that accepts and never answers: the TCP connect completes,
      // which is when postgres.js applies keep_alive, and the startup then
      // times out.
      await withServer(
        () => {},
        async (port) => {
          const sql = createPostgresConnection(`postgres://u:p@127.0.0.1:${port}/db`, {
            max: 1,
            connect_timeout: 0.5,
          })
          try {
            await settle(sql`select 1`)
          } finally {
            await sql.end({ timeout: 1 })
          }
        }
      )
    } finally {
      net.Socket.prototype.setKeepAlive = original
    }
    expect(calls).toContainEqual([true, 10_000])
  })

  // The silent-forever mode that rotated through CI as 60s budget deaths in
  // pickup.test.ts's restart matrix: a connect that never completes must fail
  // at connect_timeout. v4 arms connect_timeout before it opens the socket and
  // keeps it running through TLS and startup.
  test('a connect whose handshake never completes fails at connect_timeout instead of hanging', async () => {
    await withServer(
      () => {},
      async (port) => {
        const sql = createPostgresConnection(`postgres://u:p@127.0.0.1:${port}/db`, {
          max: 1,
          connect_timeout: 0.2,
        })
        try {
          const start = Date.now()
          const outcome = await settle(sql`select 1`)
          const elapsed = Date.now() - start
          expect(outcome).toMatchObject({ code: 'CONNECT_TIMEOUT' })
          expect(elapsed).toBeGreaterThanOrEqual(150)
          expect(elapsed).toBeLessThan(5_000)
        } finally {
          await sql.end({ timeout: 1 })
        }
      }
    )
  })

  // With v3 and Core's factory, a rejected factory never released its pool
  // slot, so after `max` failed connects (a database restart, a DNS blip) every
  // later query hung forever. Each query here must settle with an error.
  test('failed connects release their pool slots, so later queries fail fast instead of hanging', async () => {
    // Port 1 on loopback: nothing listens there, so every connect is refused.
    const sql = createPostgresConnection('postgres://postgres:postgres@127.0.0.1:1/ficus_test', {
      max: 2,
      connect_timeout: 2,
      onnotice: () => {},
    })
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        const outcome = await Promise.race([
          settle(sql`select 1`),
          new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 3_000)),
        ])
        expect(outcome).toBeInstanceOf(Error)
      }
    } finally {
      await sql.end({ timeout: 1 })
    }
  })

  // v4 behaviour (different from v3): while connects keep failing, queries
  // reject at once with the last connection error, and the pool reconnects on
  // its own backoff. So once the database is reachable again the client must
  // recover by itself within a few backoff steps, without any new client.
  test('a client whose connects failed reconnects and serves queries once the database is reachable', async () => {
    const real = new URL(process.env.DATABASE_URL!)
    // Reserve a free loopback port, then leave it closed: connects are refused,
    // as during a database restart.
    const probe = net.createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>((r) => probe.close(() => r()))

    const dsn = new URL(real)
    dsn.hostname = '127.0.0.1'
    dsn.port = String(port)
    const sql = createPostgresConnection(dsn.toString(), { max: 1, connect_timeout: 2, onnotice: () => {} })
    const proxied = new Set<net.Socket>()
    const proxy = net.createServer((client) => {
      const upstream = net.connect(Number(real.port || 5432), real.hostname)
      proxied.add(client).add(upstream)
      client.on('error', () => upstream.destroy())
      upstream.on('error', () => client.destroy())
      client.pipe(upstream).pipe(client)
    })
    try {
      for (let failure = 0; failure < 3; failure++) {
        expect(await settle(sql`select 1`)).toBeInstanceOf(Error)
      }
      // The database comes back on the same address.
      await new Promise<void>((r) => proxy.listen(port, '127.0.0.1', r))
      const deadline = Date.now() + 10_000
      let outcome: unknown
      while (Date.now() < deadline) {
        outcome = await Promise.resolve(sql`select 1 as ok`).then(
          (rows) => rows,
          (error: unknown) => error
        )
        if (!(outcome instanceof Error)) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(outcome).toEqual([{ ok: 1 }])
    } finally {
      await sql.end({ timeout: 1 })
      for (const socket of proxied) socket.destroy()
      await new Promise<void>((r) => proxy.close(() => r()))
    }
  })
})

// §4.2 pool liveness watchdog. Driven entirely by injected fakes + controlled
// timers — no real Postgres, no wall-clock waits. A fake instance's `select 1`
// can be made to hang (a black-holed peer) or resolve (healthy); the interval
// and per-probe timeout are injected so probes are stepped one at a time.
describe('pool liveness watchdog (createResilientClient)', () => {
  interface FakeInstance {
    (...args: unknown[]): Promise<unknown>
    __id: number
    calls: unknown[][]
    setProbe(fn: () => Promise<unknown>): void
    hang(): void
    resolve(): void
    end: ReturnType<typeof mock>
    unsafe: ReturnType<typeof mock>
  }

  function makeFakeInstance(id: number): FakeInstance {
    let probe: () => Promise<unknown> = () => new Promise<never>(() => {}) // hang by default
    const calls: unknown[][] = []
    const fn = ((...args: unknown[]) => {
      calls.push(args)
      return probe()
    }) as FakeInstance
    fn.__id = id
    fn.calls = calls
    fn.setProbe = (p) => {
      probe = p
    }
    fn.hang = () => {
      probe = () => new Promise<never>(() => {})
    }
    fn.resolve = () => {
      probe = () => Promise.resolve([{ ok: 1 }])
    }
    fn.end = mock(() => Promise.resolve())
    fn.unsafe = mock((...a: unknown[]) => Promise.resolve(a))
    return fn
  }

  interface TimeoutRef {
    id: number
    unref: ReturnType<typeof mock>
  }

  function setup(overrides?: Partial<Parameters<typeof createResilientClient>[0]>) {
    const built: FakeInstance[] = []
    const build = () => {
      const inst = makeFakeInstance(built.length + 1)
      built.push(inst)
      return inst as unknown as postgres.Sql
    }

    // Controlled per-probe timeouts: registered synchronously, fired on demand.
    const timeouts = new Map<number, () => void>()
    let timeoutId = 0
    const fireTimeouts = () => {
      for (const [id, fn] of [...timeouts]) {
        timeouts.delete(id)
        fn()
      }
    }

    const intervalUnref = mock(() => {})
    let intervalFn: (() => void) | undefined
    const clearInterval = mock((_h: unknown) => {})

    let nowVal = 0
    const setNow = (v: number) => {
      nowVal = v
    }

    const client = createResilientClient({
      build,
      intervalMs: 100,
      probeTimeoutMs: 50,
      failuresBeforeSwap: 3,
      baseBackoffMs: 100,
      now: () => nowVal,
      scheduleInterval: (fn) => {
        intervalFn = fn
        return { unref: intervalUnref }
      },
      clearScheduledInterval: clearInterval,
      scheduleTimeout: (fn) => {
        const id = ++timeoutId
        timeouts.set(id, fn)
        return { id, unref: mock(() => {}) } as TimeoutRef
      },
      clearScheduledTimeout: (h) => {
        timeouts.delete((h as TimeoutRef).id)
      },
      ...overrides,
    })

    const probeOnce = () => (client as unknown as { __probeOnce(): Promise<void> }).__probeOnce()
    // One probe whose query hangs → its deadline fires → one counted failure.
    const failProbe = async () => {
      const p = probeOnce()
      fireTimeouts()
      await p
    }
    const currentId = () => (client as unknown as { __id: number }).__id
    const stop = () => (client as unknown as { __stopHealthWatchdog(): void }).__stopHealthWatchdog()

    return {
      client,
      built,
      fireTimeouts,
      probeOnce,
      failProbe,
      currentId,
      stop,
      intervalUnref,
      intervalFn: () => intervalFn,
      clearInterval,
      setNow,
    }
  }

  test('healthy probes never swap the pool', async () => {
    const { built, probeOnce, currentId } = setup()
    built[0].resolve()
    for (let i = 0; i < 5; i++) await probeOnce()
    expect(built).toHaveLength(1)
    expect(currentId()).toBe(1)
    expect(built[0].end).not.toHaveBeenCalled()
  })

  test('N consecutive probe timeouts trigger exactly one end({timeout:0}) + one rebuild + swap', async () => {
    const { built, failProbe, currentId } = setup()
    // First two failures: still one instance, no swap.
    await failProbe()
    await failProbe()
    expect(built).toHaveLength(1)
    expect(built[0].end).not.toHaveBeenCalled()
    // Third consecutive failure: swap.
    await failProbe()
    expect(built).toHaveLength(2)
    expect(built[0].end).toHaveBeenCalledTimes(1)
    expect(built[0].end).toHaveBeenCalledWith({ timeout: 0 })
    // Subsequent calls hit the NEW instance.
    expect(currentId()).toBe(2)
  })

  test('a single slow-then-recovered probe does not swap', async () => {
    const { built, failProbe, probeOnce } = setup()
    await failProbe() // one timeout
    built[0].resolve() // recovers before N failures
    await probeOnce()
    await probeOnce()
    await probeOnce()
    expect(built).toHaveLength(1) // never swapped
    expect(built[0].end).not.toHaveBeenCalled()
  })

  test('after a swap the Proxy forwards template calls and .unsafe to the new instance', async () => {
    const { client, built, failProbe } = setup()
    await failProbe()
    await failProbe()
    await failProbe()
    expect(built).toHaveLength(2)
    const fresh = built[1]
    fresh.resolve()

    // Tagged-template / callable form goes through the apply trap → new instance.
    await (client as unknown as (...a: unknown[]) => Promise<unknown>)`select 1`
    expect(fresh.calls.length).toBeGreaterThan(0)

    // Method access goes through the get trap → new instance.
    ;(client as unknown as { unsafe(sql: string): unknown }).unsafe('select 2')
    expect(fresh.unsafe).toHaveBeenCalledWith('select 2')
    // The old instance saw none of it.
    expect(built[0].unsafe).not.toHaveBeenCalled()
  })

  test('the watchdog interval is unref’d and stoppable', async () => {
    const { intervalUnref, clearInterval, stop, intervalFn } = setup()
    expect(intervalUnref).toHaveBeenCalledTimes(1)
    expect(typeof intervalFn()).toBe('function')
    stop()
    expect(clearInterval).toHaveBeenCalledTimes(1)
  })

  test('stopping the watchdog prevents further swaps', async () => {
    const { built, failProbe, stop } = setup()
    stop()
    await failProbe()
    await failProbe()
    await failProbe()
    // A stopped watchdog runs no probes, so no failure ever accrues.
    expect(built).toHaveLength(1)
    expect(built[0].end).not.toHaveBeenCalled()
  })

  test('the proxy end() stops the watchdog', async () => {
    const { client, clearInterval } = setup()
    await (client as unknown as { end(): Promise<void> }).end()
    expect(clearInterval).toHaveBeenCalledTimes(1)
  })

  test('exponential backoff prevents swap thrash against a genuinely-down DB', async () => {
    const { built, failProbe, setNow } = setup() // baseBackoffMs 100, now starts at 0
    // First swap at now=0.
    await failProbe()
    await failProbe()
    await failProbe()
    expect(built).toHaveLength(2)

    // Keep failing while the backoff window (100ms) is still open: three more
    // failures reach N again but the swap is suppressed — no thrash.
    await failProbe()
    await failProbe()
    await failProbe()
    await failProbe()
    expect(built).toHaveLength(2)

    // Advance past the backoff window: the next failure is allowed to swap.
    setNow(100)
    await failProbe()
    expect(built).toHaveLength(3)
  })
})

describe('pg teardown rejection guard', () => {
  test('classifies exactly the postgres.js teardown codes', () => {
    for (const code of ['CONNECTION_DESTROYED', 'CONNECTION_CLOSED', 'CONNECTION_ENDED']) {
      expect(isPgTeardownError(Object.assign(new Error(`write ${code} host:25060`), { code }))).toBe(true)
    }
    expect(isPgTeardownError(Object.assign(new Error('nope'), { code: 'ECONNRESET' }))).toBe(false)
    expect(isPgTeardownError(new Error('plain'))).toBe(false)
    expect(isPgTeardownError(undefined)).toBe(false)
    expect(isPgTeardownError('CONNECTION_DESTROYED')).toBe(false)
  })

  test('installed listener absorbs teardown rejections and rethrows everything else', () => {
    const before = new Set(process.listeners('unhandledRejection'))
    installPgTeardownRejectionGuard()
    const added = process.listeners('unhandledRejection').filter((listener) => !before.has(listener))
    // Idempotent: a second install adds nothing.
    installPgTeardownRejectionGuard()
    expect(process.listeners('unhandledRejection').filter((listener) => !before.has(listener))).toHaveLength(
      added.length
    )
    expect(added).toHaveLength(1)
    const listener = added[0] as (reason: unknown, promise: Promise<unknown>) => void
    try {
      const teardown = Object.assign(new Error('write CONNECTION_DESTROYED host:25060'), {
        code: 'CONNECTION_DESTROYED',
      })
      expect(() => listener(teardown, Promise.resolve())).not.toThrow()
      const other = new Error('genuine bug')
      expect(() => listener(other, Promise.resolve())).toThrow('genuine bug')
    } finally {
      // Leave the process default behaviour intact for the rest of the suite,
      // and let a real entrypoint install a fresh listener afterwards.
      process.off('unhandledRejection', listener)
      __resetPgTeardownGuardForTests()
    }
  })
})

describe('dedicated connection slot gate', () => {
  test('bounds concurrency at the limit and resumes queued waiters', async () => {
    let inFlight = 0
    let peak = 0
    const release: Array<() => void> = []
    const tasks = Array.from({ length: 6 }, () =>
      withDedicatedConnectionSlot(async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise<void>((resolve) => release.push(resolve))
        inFlight--
      })
    )
    // Let the first wave acquire slots.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(peak).toBe(2)
    const all = Promise.all(tasks)
    let settled = false
    void all.finally(() => {
      settled = true
    })
    while (!settled) {
      release.splice(0).forEach((resolve) => resolve())
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await all
    expect(peak).toBe(2)
    // Slots drain fully: a later acquisition proceeds immediately.
    let ran = false
    await withDedicatedConnectionSlot(async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  test('a throwing task releases its slot', async () => {
    await expect(withDedicatedConnectionSlot(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    let ran = false
    await withDedicatedConnectionSlot(async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })
})

// Regression for the noah 2026-08-29 data-corruption incident. drizzle patches
// postgres.js's json/jsonb serializers (and the timestamp handlers) to
// pass-throughs in its OWN constructor, because drizzle already serializes those
// values itself. The liveness watchdog rebuilds the postgres.js instance on a
// swap, and nothing re-runs drizzle() against the new one — so the swapped-in
// instance had postgres.js's JSON.stringify back, and every jsonb write landed
// double-encoded (a jsonb *string*) until the process was restarted.
describe('drizzle type handlers on the watchdog pool (survive a swap)', () => {
  type Handlers = {
    parsers: Record<string, (v: unknown) => unknown>
    serializers: Record<string, (v: unknown) => unknown>
  }
  const handlersOf = (sql: postgres.Sql): Handlers => (sql as unknown as { options: Handlers }).options
  const watchdogClient = () => createPostgresConnection(DSN, { onnotice: () => {} }, { healthWatchdog: true })
  const stopAndEnd = async (sql: postgres.Sql) => {
    ;(sql as unknown as { __stopHealthWatchdog?: () => void }).__stopHealthWatchdog?.()
    await sql.end()
  }

  test('the pool drizzle wraps has a pass-through jsonb serializer, NOT JSON.stringify', async () => {
    const sql = watchdogClient()
    const value = { source: 'inbox' }
    // A pass-through returns the very same object; JSON.stringify would return a
    // string, which is exactly the double-encoding that corrupted production.
    expect(handlersOf(sql).serializers['3802']!(value)).toBe(value)
    expect(handlersOf(sql).serializers['114']!(value)).toBe(value)
    await stopAndEnd(sql)
  })

  test('timestamp handlers pass through too (a swap silently truncated sub-second precision)', async () => {
    const sql = watchdogClient()
    const { parsers, serializers } = handlersOf(sql)
    const raw = '2026-08-29 05:49:55.923+00'
    const date = new Date('2026-08-29T05:49:55.923Z')
    for (const oid of ['1184', '1082', '1083', '1114']) {
      expect(parsers[oid]!(raw)).toBe(raw)
      expect(serializers[oid]!(date)).toBe(date)
    }
    await stopAndEnd(sql)
  })

  test('a rebuilt instance is patched exactly like the first — this is what a swap produces', async () => {
    const built: postgres.Sql[] = []
    const client = createResilientClient({
      build: () => {
        const sql = watchdogClient()
        built.push(sql)
        return sql
      },
      intervalMs: 60_000,
    })
    const rebuilt = built[0]!
    const value = { ref: { type: 'agent' } }
    expect(handlersOf(rebuilt).serializers['3802']!(value)).toBe(value)
    ;(client as unknown as { __stopHealthWatchdog?: () => void }).__stopHealthWatchdog?.()
    for (const sql of built) await stopAndEnd(sql)
  })

  // The other half of the contract: raw `sql` callers (migrations, ConfigSync)
  // pass OBJECTS and depend on postgres.js serializing jsonb for them. Patching
  // those clients to pass-throughs breaks their writes — it broke the model-tiers
  // migration test when this fix was first written pool-wide.
  test('plain (non-watchdog) clients keep postgres.js serialization for raw callers', async () => {
    const sql = createPostgresConnection(DSN)
    const value = { source: 'inbox' }
    expect(handlersOf(sql).serializers['3802']!(value)).not.toBe(value)
    expect(handlersOf(sql).serializers['3802']!(value)).toBe(JSON.stringify(value))
    await sql.end()
  })
})

describe('direct connection string', () => {
  const priorUrl = process.env.DATABASE_URL
  const priorDirect = process.env.DATABASE_DIRECT_URL
  afterEach(() => {
    if (priorUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = priorUrl
    if (priorDirect === undefined) delete process.env.DATABASE_DIRECT_URL
    else process.env.DATABASE_DIRECT_URL = priorDirect
  })

  test('is DATABASE_DIRECT_URL when set (a pooled host: the cluster, not the loopback pooler)', async () => {
    const { getDirectConnectionString, isTransactionPooled } = await import('./connection')
    process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:6432/x'
    process.env.DATABASE_DIRECT_URL = 'postgres://u:p@db.example.com:25060/x?sslmode=verify-full'
    expect(getDirectConnectionString()).toBe('postgres://u:p@db.example.com:25060/x?sslmode=verify-full')
    process.env.DATABASE_POOL_MODE = 'transaction'
    expect(isTransactionPooled()).toBe(true)
    delete process.env.DATABASE_POOL_MODE
    expect(isTransactionPooled()).toBe(false)
  })

  test('falls back to DATABASE_URL on an unpooled host, and throws when neither is set', async () => {
    const { getDirectConnectionString } = await import('./connection')
    delete process.env.DATABASE_DIRECT_URL
    process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:5432/x'
    expect(getDirectConnectionString()).toBe('postgres://u:p@127.0.0.1:5432/x')
    delete process.env.DATABASE_URL
    expect(() => getDirectConnectionString()).toThrow(/DATABASE_URL/)
  })
})
