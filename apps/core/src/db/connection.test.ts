import { describe, test, expect, afterEach, mock } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as net from 'node:net'
import {
  __resetPgTeardownGuardForTests,
  createBunTlsSafeSocketFactory,
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
    const sql = createPostgresConnection(DSN)
    expect(sql.options.max).toBe(4)
    await sql.end()
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

describe('Bun TLS-upgrade leak guard (createBunTlsSafeSocketFactory)', () => {
  async function withServer<T>(fn: (port: number, server: net.Server) => Promise<T>): Promise<T> {
    const server = net.createServer()
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      return await fn((server.address() as { port: number }).port, server)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  }

  test('connects to the first host/port and exposes host/port like postgres.js expects', async () => {
    await withServer(async (port) => {
      const socket = await createBunTlsSafeSocketFactory()({ host: ['127.0.0.1', 'unused.example'], port: [port, 1] })
      try {
        expect((socket as unknown as { host: string }).host).toBe('127.0.0.1')
        expect((socket as unknown as { port: number }).port).toBe(port)
        expect(socket.remotePort).toBe(port)
      } finally {
        socket.destroy()
      }
    })
  })

  test('enables TCP keepalive so a vanished server is detected and the pool self-heals', async () => {
    await withServer(async (port) => {
      // Spy on the socket the factory creates, before it is returned, to prove
      // setKeepAlive(true, …) was called — without it a dead peer (Postgres
      // restart) leaves a zombie connection in the pool that hangs the next
      // query for the kernel's multi-minute TCP retransmission timeout.
      const calls: Array<[boolean, number | undefined]> = []
      const spyingConnect = ((...args: Parameters<typeof net.connect>) => {
        const socket = net.connect(...(args as Parameters<typeof net.connect>))
        const original = socket.setKeepAlive.bind(socket)
        socket.setKeepAlive = ((enable?: boolean, initialDelay?: number) => {
          calls.push([enable ?? false, initialDelay])
          return original(enable, initialDelay)
        }) as typeof socket.setKeepAlive
        return socket
      }) as typeof net.connect
      const socket = await createBunTlsSafeSocketFactory(spyingConnect)({ host: '127.0.0.1', port })
      try {
        expect(calls).toHaveLength(1)
        expect(calls[0][0]).toBe(true)
        expect(calls[0][1]).toBeGreaterThan(0)
      } finally {
        socket.destroy()
      }
    })
  })

  test("re-attaches a draining 'data' listener after postgres.js strips listeners for the TLS upgrade", async () => {
    await withServer(async (port) => {
      const socket = await createBunTlsSafeSocketFactory()({ host: '127.0.0.1', port })
      try {
        // postgres.js's secure(): once('data') for the 'S' byte, then removeAllListeners().
        socket.once('data', () => {})
        socket.removeAllListeners()
        expect(socket.listenerCount('data')).toBe(0)
        await new Promise<void>((r) => queueMicrotask(r))
        // The raw side must stay consumed, or Bun retains every decrypted chunk here.
        expect(socket.listenerCount('data')).toBe(1)
        expect(socket.readableFlowing).toBe(true)
      } finally {
        socket.destroy()
      }
    })
  })

  test('does not stack listeners when removeAllListeners runs repeatedly, and skips a destroyed socket', async () => {
    await withServer(async (port) => {
      const socket = await createBunTlsSafeSocketFactory()({ host: '127.0.0.1', port })
      socket.removeAllListeners()
      socket.removeAllListeners()
      await new Promise<void>((r) => queueMicrotask(r))
      expect(socket.listenerCount('data')).toBe(1)
      socket.destroy()
      socket.removeAllListeners()
      await new Promise<void>((r) => queueMicrotask(r))
      expect(socket.listenerCount('data')).toBe(0)
    })
  })

  // How postgres.js's own socket reports a failure, and what releases the pool
  // slot: 'error', then 'close', after postgres.js has attached its listeners.
  async function failureEvents(socket: net.Socket) {
    const events: string[] = []
    let error: unknown
    socket.on('error', (value) => {
      events.push('error')
      error = value
    })
    await new Promise<void>((resolve) =>
      socket.on('close', () => {
        events.push('close')
        resolve()
      })
    )
    return { events, error }
  }

  test('a failed TCP connect is reported as error then close on the returned socket, not a rejection', async () => {
    // Port 1 on loopback: nothing listens there.
    const socket = await createBunTlsSafeSocketFactory()({ host: '127.0.0.1', port: 1 })
    const { events, error } = await failureEvents(socket)
    expect(events).toEqual(['error', 'close'])
    expect((error as NodeJS.ErrnoException).code).toBe('ECONNREFUSED')
  })

  // postgres.js reports a rejected socket factory through error() but never
  // runs its closed() handler, so the connection is never released back to the
  // pool. With the factory rejecting, every failed connect permanently used up
  // a pool slot: after `max` failures (a database restart, a DNS blip) every
  // later query on that client hung forever instead of failing. Mutation check:
  // make the factory reject again and the third query below hangs.
  test('failed connects release their pool slots, so later queries fail fast instead of hanging', async () => {
    const { default: postgresClient } = await import('postgres')
    // Port 1 on loopback: nothing listens there, so every connect is refused.
    const sql = postgresClient('postgres://postgres:postgres@127.0.0.1:1/tau_test', {
      max: 2,
      connect_timeout: 2,
      socket: createBunTlsSafeSocketFactory(),
      onnotice: () => {},
      // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- postgres.js generic default
    } as postgres.Options<{}>)
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        const outcome = await Promise.race([
          sql`select 1`.then(
            () => 'connected',
            (error: Error) => error
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 3_000)),
        ])
        expect(outcome).toBeInstanceOf(Error)
      }
    } finally {
      await sql.end({ timeout: 1 })
    }
  })

  test('a client whose connects failed reconnects and serves queries once the database is reachable', async () => {
    const { default: postgresClient } = await import('postgres')
    const real = new URL(process.env.DATABASE_URL!)
    let attempts = 0
    // The first three connects are refused, as during a database restart.
    const flaky = ((port: number, host: string) =>
      attempts++ < 3
        ? net.connect(1, '127.0.0.1')
        : net.connect(Number(real.port), real.hostname)) as unknown as typeof net.connect
    const sql = postgresClient(process.env.DATABASE_URL!, {
      max: 1,
      connect_timeout: 2,
      socket: createBunTlsSafeSocketFactory(flaky),
      onnotice: () => {},
      // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- postgres.js generic default
    } as postgres.Options<{}>)
    try {
      for (let failure = 0; failure < 3; failure++) {
        // postgres.js queries run only when awaited through .then(), which
        // expect().rejects does not call, so settle the query explicitly.
        const outcome = await sql`select 1`.then(
          () => 'connected',
          (error: Error) => error
        )
        expect(outcome).toBeInstanceOf(Error)
      }
      const [row] = await sql`select 1 as ok`
      expect(row).toEqual({ ok: 1 })
    } finally {
      await sql.end({ timeout: 1 })
    }
  })

  // postgres.js arms its connect_timeout only AFTER the socket factory
  // resolves, so the factory must bound its own connect wait. Without that
  // bound, a SYN that goes unanswered (neither 'connect' nor 'error') hangs
  // every query on the pool forever and silently — the mode that rotated
  // through CI as 60s budget deaths in pickup.test.ts's restart matrix.
  // Mutation check: removing the factory's internal timeout makes this test
  // itself hang to its own test timeout.
  test('a connect that never completes fails at connect_timeout instead of hanging forever', async () => {
    let created: net.Socket | undefined
    const neverConnect = (() => {
      created = new net.Socket()
      return created
    }) as unknown as typeof net.connect
    const start = Date.now()
    const socket = await createBunTlsSafeSocketFactory(neverConnect)({
      host: '10.255.255.1',
      port: 5432,
      connect_timeout: 0.1,
    })
    const { events, error } = await failureEvents(socket)
    expect(events).toEqual(['error', 'close'])
    expect(error).toMatchObject({ code: 'CONNECT_TIMEOUT' })
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(90)
    expect(elapsed).toBeLessThan(5000)
    // The stuck socket must be torn down, not leaked mid-connect.
    expect(created!.destroyed).toBe(true)
  })

  test('a connect that completes is not failed later by the connect deadline', async () => {
    await withServer(async (port) => {
      const socket = await createBunTlsSafeSocketFactory()({ host: '127.0.0.1', port, connect_timeout: 0.05 })
      try {
        // Give the (cleared) 50ms deadline a chance to misfire if it survived.
        await new Promise((resolve) => setTimeout(resolve, 120))
        expect(socket.destroyed).toBe(false)
      } finally {
        socket.destroy()
      }
    })
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
