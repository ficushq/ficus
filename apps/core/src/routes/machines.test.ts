import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { createHash } from 'crypto'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { eventEmitter, type EventMap } from '../lib/infra/event-emitter'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { Permissions } from '@ficus/shared'
import { createMachinesRouter, forceMigrationActor } from './machines'
import { identityMiddleware } from '../middleware/identity'
import { agentExtraScopes, agents, db, machineBoxes, machines, squads } from '../db'
import { getSecretStore, resetSecretStore } from '../services/secrets'
import {
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestRole,
  createTestUser,
  assignRole,
  type TestUser,
} from '../test-utils'
import { getMachineProvider, registerMachineProvider, unregisterMachineProvider } from '../services/machines/provider'
import type { MachineProvider, MachineSpec } from '../services/machines/provider'
import { EXE_PROVIDER_SSH_KEY } from '../services/machines/provider-credentials'
import { resolveMachineUnitCapacity, unitWeightForSandboxId } from '../services/machines/placement'
import { claimMachineForBootstrap, insertMachine, stampArtifactVersion } from '../services/machines/queries'
import { RebalanceInProgressError } from '../services/machines/rebalance'
import { MachineTunnelManager } from '../services/machines/tunnel-manager'
import { createDeviceToken, revokeDeviceToken } from '../services/auth/device-tokens'

const prefix = `mach-route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

function fakeProvider(overrides: Partial<MachineProvider> = {}): MachineProvider {
  return {
    key: 'ssh',
    provision: async () => {
      throw new Error('byo machines are registered, not provisioned')
    },
    terminate: async () => {},
    status: async () => 'running',
    ...overrides,
  }
}

/**
 * The bootstrap route is fire-and-forget (202): the run continues after the
 * response. Tests therefore assert the ROW, once it settles, rather than the
 * response body. Polls briefly instead of sleeping a fixed amount, so a fast
 * fake settles immediately and a slow one still passes.
 */
/**
 * Wait for a specific machine.status event to be emitted. The terminal emit
 * happens in the background task's .finally, which lands an unpredictable
 * number of ticks after the row is written — a fixed sleep passes alone and
 * fails under full-file load, so poll for the condition instead.
 */
async function waitForEmittedStatus(
  spy: { mock: { calls: unknown[][] } },
  machineId: string,
  status: string,
  timeoutMs = 3000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = spy.mock.calls.some(
      ([event, payload]) =>
        event === 'machine.status' &&
        (payload as { machineId?: string; status?: string })?.machineId === machineId &&
        (payload as { status?: string })?.status === status
    )
    if (hit) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return false
}

async function waitForMachineStatus(id: string, want: string, timeoutMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let seen = ''
  while (Date.now() < deadline) {
    const [row] = await db.select().from(machines).where(eq(machines.id, id))
    seen = row?.status ?? ''
    if (seen === want) return seen
    await new Promise((r) => setTimeout(r, 10))
  }
  return seen
}

async function getMachineLastError(id: string): Promise<string | null> {
  const [row] = await db.select().from(machines).where(eq(machines.id, id))
  return row?.lastError ?? null
}

describe('machines routes', () => {
  let admin: TestUser
  let unprivileged: TestUser
  let priorKey: string | undefined

  beforeAll(async () => {
    priorKey = process.env.FICUS_ENCRYPTION_KEY
    process.env.FICUS_ENCRYPTION_KEY = priorKey ?? '0'.repeat(64) // 32-byte hex test key
    resetSecretStore()
    await getSecretStore().initialize()

    admin = await createTestAdmin({ prefix })
    unprivileged = await createTestUser({ prefix })
  })

  afterAll(async () => {
    await cleanupTestRbac(prefix)
    if (priorKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = priorKey
    resetSecretStore()
  })

  afterEach(async () => {
    const all = await db.select({ id: machines.id, name: machines.name }).from(machines)
    for (const m of all) {
      if (m.name.startsWith(prefix)) {
        await db.delete(machines).where(eq(machines.id, m.id))
        // The register route mints a `machine-ssh:<id>` secret per machine; the
        // DELETE route removes it, but rows torn down here directly would leak
        // the key into the shared test DB, so drop it too (no-op if absent).
        await getSecretStore().delete(`machine-ssh:${m.id}`)
      }
    }
  })

  function authedRouter(deps: Parameters<typeof createMachinesRouter>[0] = {}) {
    const app = new Hono()
    app.use('*', identityMiddleware)
    app.route('/', createMachinesRouter(deps))
    return app
  }

  function req(method = 'GET', body?: unknown, token = admin.token) {
    return {
      method,
      headers: { ...authHeaders(token), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }
  }

  async function createMachine(router: Hono, overrides: Record<string, unknown> = {}) {
    const res = await router.request(
      '/',
      req('POST', {
        name: `${prefix}-${Math.random().toString(36).slice(2, 8)}`,
        sshHost: '10.0.0.1',
        sshUser: 'tau',
        ...overrides,
      })
    )
    expect(res.status).toBe(201)
    return res.json()
  }

  it('rejects unauthenticated and unprivileged access', async () => {
    const router = authedRouter()
    expect((await router.request('/')).status).toBe(401)
    expect(
      (
        await router.request(
          '/',
          req('POST', { name: `${prefix}-unauth`, sshHost: 'h', sshUser: 'u' }, unprivileged.token)
        )
      ).status
    ).toBe(403)
  })

  it('registers a machine, returning the public key and never any private key material', async () => {
    const router = authedRouter()
    const created = await createMachine(router, { name: `${prefix}-a` })

    expect(created.sshPublicKey).toContain('ssh-ed25519')
    expect(created.sshKeyId).toBeUndefined()
    expect(created.status).toBe('registered')
    expect(created.provider).toBe('ssh')
    expect(JSON.stringify(created)).not.toContain('PRIVATE KEY')

    const getRes = await router.request(`/${created.id}`, req('GET'))
    expect(getRes.status).toBe(200)
    const getBody = await getRes.json()
    expect(getBody.sshPublicKey).toBe(created.sshPublicKey)
    expect(getBody.sshKeyId).toBeUndefined()
    expect(getBody.boxes).toEqual([])
    expect(JSON.stringify(getBody)).not.toContain('PRIVATE KEY')
  })

  it('defaults egressPolicy to false and accepts an explicit opt-in', async () => {
    const router = authedRouter()
    const off = await createMachine(router, { name: `${prefix}-egress-off` })
    expect(off.egressPolicy).toBe(false)

    const on = await createMachine(router, { name: `${prefix}-egress-on`, egressPolicy: true })
    expect(on.egressPolicy).toBe(true)
  })

  it('rejects duplicate names with 409', async () => {
    const router = authedRouter()
    const payload = { name: `${prefix}-dup`, sshHost: '10.0.0.2', sshUser: 'tau' }
    expect((await router.request('/', req('POST', payload))).status).toBe(201)
    expect((await router.request('/', req('POST', payload))).status).toBe(409)
  })

  it('validates the request body', async () => {
    const router = authedRouter()
    const res = await router.request('/', req('POST', { name: '', sshHost: '10.0.0.3' }))
    expect(res.status).toBe(400)
  })

  it('lists machines', async () => {
    const router = authedRouter()
    const created = await createMachine(router, { name: `${prefix}-list` })
    const res = await router.request('/', req('GET'))
    expect(res.status).toBe(200)
    const list = await res.json()
    expect(list.some((m: { id: string }) => m.id === created.id)).toBe(true)
  })

  it('returns 404 for a missing machine', async () => {
    const router = authedRouter()
    expect((await router.request('/00000000-0000-0000-0000-000000000000', req('GET'))).status).toBe(404)
  })

  it('bootstraps a machine via the injected bootstrap fn, returning 202 immediately and settling the row to ready', async () => {
    let calledWith: string | undefined
    const router = authedRouter({
      bootstrap: async (machine) => {
        calledWith = machine.id
        await db.update(machines).set({ status: 'ready', bootstrapVersion: 'v1' }).where(eq(machines.id, machine.id))
        return {}
      },
    })
    const created = await createMachine(router, { name: `${prefix}-boot` })

    const res = await router.request(`/${created.id}/bootstrap`, req('POST'))
    // 202 + 'bootstrapping': the response says STARTED. Holding the request
    // open for the real 15-minute run is what made a proxied tenant show a 502
    // error page for a bootstrap that was succeeding.
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.status).toBe('bootstrapping')
    expect(calledWith).toBe(created.id)
    // The outcome lives on the row, which is what every caller now watches.
    expect(await waitForMachineStatus(created.id, 'ready')).toBe('ready')
  })

  it('is inert while another bootstrap holds the machine (e.g. the worker boot reconcile)', async () => {
    let runs = 0
    const router = authedRouter({
      bootstrap: async () => {
        runs++
        return {}
      },
    })
    const created = await createMachine(router, { name: `${prefix}-boot-held` })
    // The worker's drift reconcile claims through the same query.
    expect(await claimMachineForBootstrap(created.id, ['registered'])).not.toBeNull()

    const res = await router.request(`/${created.id}/bootstrap`, req('POST'))
    expect(res.status).toBe(202)
    expect((await res.json()).status).toBe('bootstrapping')
    expect(runs).toBe(0)
  })

  it('returns 404 bootstrapping a missing machine', async () => {
    const router = authedRouter({ bootstrap: async () => ({}) })
    expect((await router.request('/00000000-0000-0000-0000-000000000000/bootstrap', req('POST'))).status).toBe(404)
  })

  it('a failing bootstrap still returns 202 and settles the row to unreachable, persisting the error message', async () => {
    const router = authedRouter({
      bootstrap: async () => {
        // This injected implementation throws WITHOUT itself stamping the row
        // (unlike the real bootstrapMachine) — exercising the route's OWN
        // guard-catch, which must also persist lastError so a throw before
        // bootstrapMachine's own catch (or any alternate implementation)
        // still leaves an operator-visible reason on the row.
        throw new Error('bootstrap.sh failed on x (exit 1): apt-get: boom')
      },
    })
    const created = await createMachine(router, { name: `${prefix}-boot-fail` })

    const res = await router.request(`/${created.id}/bootstrap`, req('POST'))
    // Async: the caller is told the run STARTED. The failure is recorded on the
    // row (and logged by bootstrapMachine) rather than returned inline — the UI
    // and platform provisioning poll the row to see WHY.
    expect(res.status).toBe(202)
    expect(await waitForMachineStatus(created.id, 'unreachable')).toBe('unreachable')
    expect(await getMachineLastError(created.id)).toContain('apt-get: boom')
  })

  it('exposes lastError on the GET detail/list payloads once a bootstrap has failed (not a secret, not stripped)', async () => {
    const router = authedRouter({
      bootstrap: async () => {
        throw new Error('bootstrap.sh failed on x (exit 1): disk full')
      },
    })
    const created = await createMachine(router, { name: `${prefix}-lasterror-api` })
    await router.request(`/${created.id}/bootstrap`, req('POST'))
    await waitForMachineStatus(created.id, 'unreachable')

    const detail = await (await router.request(`/${created.id}`, req('GET'))).json()
    expect(detail.lastError).toContain('disk full')

    const list = await (await router.request('/', req('GET'))).json()
    const entry = list.find((m: { id: string }) => m.id === created.id)
    expect(entry.lastError).toContain('disk full')
  })

  it('checks status via the injected provider, updating lastSeenAt and status to ready', async () => {
    const router = authedRouter({ getProvider: () => fakeProvider({ status: async () => 'running' }) })
    const created = await createMachine(router, { name: `${prefix}-check-ready` })

    const res = await router.request(`/${created.id}/check`, req('POST'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ready')
    expect(body.lastSeenAt).toBeString()
  })

  it('check self-heals a provider-registry miss by re-registering once (api boot race)', async () => {
    // Simulate the api process whose boot-time registration lost the race with
    // secret-store init: getProvider throws until registerProviders runs.
    let registered = false
    const router = authedRouter({
      getProvider: (key: string) => {
        if (!registered) throw new Error(`unknown machine provider: ${key}`)
        return fakeProvider({ status: async () => 'running' })
      },
      registerProviders: async () => {
        registered = true
      },
    })
    const created = await createMachine(router, { name: `${prefix}-check-selfheal` })
    registered = false // the register route re-registers; reset to simulate the standing miss

    const res = await router.request(`/${created.id}/check`, req('POST'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ready')
    expect(registered).toBe(true)
  })

  it('marks unreachable on a non-running result WITHOUT bumping lastSeenAt', async () => {
    const router = authedRouter({ getProvider: () => fakeProvider({ status: async () => 'gone' }) })
    const created = await createMachine(router, { name: `${prefix}-check-gone` })
    // A freshly-registered machine has never been seen, so lastSeenAt is null;
    // a failed probe must leave it null (only a running probe bumps it).
    expect(created.lastSeenAt).toBeNull()

    const res = await router.request(`/${created.id}/check`, req('POST'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('unreachable')
    expect(body.lastSeenAt).toBeNull()
  })

  it('a successful /check clears a stale bootstrap-era lastError instead of carrying it onto a ready row', async () => {
    // Reproduces the reviewer's finding: fail a bootstrap (unreachable +
    // lastError), then a LATER /check reporting the machine running must not
    // leave the old bootstrap error attached to the now-ready row.
    const router = authedRouter({
      bootstrap: async () => {
        throw new Error('bootstrap.sh failed on x (exit 1): disk full')
      },
    })
    const created = await createMachine(router, { name: `${prefix}-check-clears-error` })
    await router.request(`/${created.id}/bootstrap`, req('POST'))
    expect(await waitForMachineStatus(created.id, 'unreachable')).toBe('unreachable')
    expect(await getMachineLastError(created.id)).toContain('disk full')

    const checkRouter = authedRouter({ getProvider: () => fakeProvider({ status: async () => 'running' }) })
    const res = await checkRouter.request(`/${created.id}/check`, req('POST'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ready')
    expect(body.lastError).toBeNull()
    expect(await getMachineLastError(created.id)).toBeNull()
  })

  it('a failed /check on a previously-ready machine names the reachability probe, never a bootstrap-era reason', async () => {
    const router = authedRouter({ getProvider: () => fakeProvider({ status: async () => 'gone' }) })
    const created = await createMachine(router, { name: `${prefix}-check-probe-error` })
    expect(await getMachineLastError(created.id)).toBeNull()

    const res = await router.request(`/${created.id}/check`, req('POST'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('unreachable')
    expect(body.lastError).toBeString()
    expect(body.lastError).not.toContain('bootstrap')
    expect(await getMachineLastError(created.id)).not.toContain('bootstrap')
  })

  it('409s deleting a machine with boxes, then deletes cleanly (row + stored key) once boxes are gone', async () => {
    const router = authedRouter({ getProvider: () => fakeProvider() })
    const created = await createMachine(router, { name: `${prefix}-del` })

    await db
      .insert(machineBoxes)
      .values({ sandboxId: `${prefix}-box`, machineId: created.id, unixUser: 'tau', port: 50100 })

    expect((await router.request(`/${created.id}`, req('DELETE'))).status).toBe(409)

    await db.delete(machineBoxes).where(eq(machineBoxes.sandboxId, `${prefix}-box`))

    const secretKey = `machine-ssh:${created.id}`
    expect(getSecretStore().get(secretKey)).toBeString()

    const deleteRes = await router.request(`/${created.id}`, req('DELETE'))
    expect(deleteRes.status).toBe(204)
    expect(getSecretStore().get(secretKey)).toBeUndefined()
    expect(await db.select().from(machines).where(eq(machines.id, created.id))).toEqual([])
  })

  it('returns 404 deleting a missing machine', async () => {
    const router = authedRouter({ getProvider: () => fakeProvider() })
    expect((await router.request('/00000000-0000-0000-0000-000000000000', req('DELETE'))).status).toBe(404)
  })

  it("409s deleting a machine the reaper has claimed ('reaping') without touching the provider", async () => {
    // Cross-process double-terminate guard: the worker's empty-machine reaper
    // claims a machine (status 'reaping') before provider.terminate; a DELETE
    // racing it must not fire a second terminate. The claim resolves within a
    // tick (row deleted, or restored to 'ready' on failure), so 409-retry is
    // always resolvable.
    const terminated: string[] = []
    const router = authedRouter({
      getProvider: () =>
        fakeProvider({
          terminate: async (m) => {
            terminated.push(m.id)
          },
        }),
    })
    const created = await createMachine(router, { name: `${prefix}-del-reaping` })
    await db.update(machines).set({ status: 'reaping' }).where(eq(machines.id, created.id))

    const res = await router.request(`/${created.id}`, req('DELETE'))
    expect(res.status).toBe(409)
    expect(terminated).toEqual([])
    // Row untouched — the reaper still owns it.
    const [row] = await db.select().from(machines).where(eq(machines.id, created.id))
    expect(row?.status).toBe('reaping')
  })

  it('closes the shared tunnel master on delete even when THIS process holds no master record', async () => {
    // DELETE is the one place the shared ControlMaster itself must die: a
    // deleted-but-still-running BYO machine would otherwise keep its master —
    // including the -R reverse listener from the no-longer-trusted host into
    // core's API port — alive indefinitely. And the recordless map is the
    // COMMON delete case: the api process serves DELETE while the worker
    // establishes most masters, and after any restart the in-memory map is
    // empty even though the orphan master survives on disk. So drive a REAL
    // MachineTunnelManager (fake ssh spawn, empty masters map) and assert the
    // `-O exit` still targets the machine's deterministic socket path.
    const sshCalls: string[][] = []
    const fakeSpawn = ((args: string[]) => {
      sshCalls.push(args)
      return { stdout: '', stderr: '', exited: Promise.resolve(0), kill() {} }
    }) as unknown as typeof Bun.spawn
    // Short prefix: the derived socket path must stay under the manager's
    // 90-byte sun_path guard even on macOS's long /var/folders tmpdir — the
    // owner socket name (`owner-<pid>-<12hex>.sock`) is longer than the master
    // name this comment originally accounted for, so use /tmp on darwin.
    const controlDir = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'tau-mrt-'))
    const tunnels = new MachineTunnelManager({ spawn: fakeSpawn, controlDir })

    const router = authedRouter({ getProvider: () => fakeProvider(), tunnels })
    const created = await createMachine(router, { name: `${prefix}-del-tunnel` })

    const res = await router.request(`/${created.id}`, req('DELETE'))
    expect(res.status).toBe(204)

    // socketPathFor derives <controlDir>/<sha256(machineId)[:12]>.sock.
    const socketPath = join(controlDir, `${createHash('sha256').update(created.id).digest('hex').slice(0, 12)}.sock`)
    const exitCalls = sshCalls.filter((c) => {
      const i = c.indexOf('-O')
      return i >= 0 && c[i + 1] === 'exit'
    })
    expect(exitCalls).toHaveLength(1)
    expect(exitCalls[0]).toContain(socketPath)
  })

  describe('lifecycle events', () => {
    /** Payloads emitted for a given event name during the spy's lifetime. */
    /**
     * Events of one type seen by the spy, optionally NARROWED TO ONE MACHINE.
     *
     * The machineId filter is load-bearing, not convenience: bootstrap now runs
     * in the background and its terminal event can land while a LATER test is
     * spying, so an unfiltered `toHaveLength(0)` on a no-op assertion fails
     * intermittently depending on scheduling. Filtering by the machine the test
     * created makes each assertion depend only on its own subject.
     */
    function emitted<K extends keyof EventMap>(
      spy: ReturnType<typeof spyOn>,
      event: K,
      machineId?: string
    ): EventMap[K][] {
      return spy.mock.calls
        .filter((c: unknown[]) => c[0] === event)
        .map((c: unknown[]) => c[1] as EventMap[K])
        .filter((p: EventMap[K]) => machineId === undefined || (p as { machineId?: string })?.machineId === machineId)
    }

    it('emits machine.created after a successful register', async () => {
      const router = authedRouter()
      const spy = spyOn(eventEmitter, 'emit')
      try {
        const created = await createMachine(router, { name: `${prefix}-ev-created` })
        expect(emitted(spy, 'machine.created')).toContainEqual({ machineId: created.id })
      } finally {
        spy.mockRestore()
      }
    })

    it('emits machine.status on a bootstrap status transition', async () => {
      const router = authedRouter({
        bootstrap: async (machine) => {
          await db.update(machines).set({ status: 'ready' }).where(eq(machines.id, machine.id))
          return {}
        },
      })
      const created = await createMachine(router, { name: `${prefix}-ev-boot` })

      const spy = spyOn(eventEmitter, 'emit')
      try {
        await router.request(`/${created.id}/bootstrap`, req('POST'))
        // Two transitions now, because the run is async and the UI needs both:
        // registered→bootstrapping when it starts (this status previously had
        // no writer at all), then →ready when it settles.
        expect(emitted(spy, 'machine.status')).toContainEqual({ machineId: created.id, status: 'bootstrapping' })
        expect(await waitForMachineStatus(created.id, 'ready')).toBe('ready')
        expect(await waitForEmittedStatus(spy, created.id, 'ready')).toBe(true)
      } finally {
        spy.mockRestore()
      }
    })

    it('emits machine.status on a check status transition (registered → ready)', async () => {
      const router = authedRouter({ getProvider: () => fakeProvider({ status: async () => 'running' }) })
      const created = await createMachine(router, { name: `${prefix}-ev-check` })

      const spy = spyOn(eventEmitter, 'emit')
      try {
        await router.request(`/${created.id}/check`, req('POST'))
        expect(await waitForEmittedStatus(spy, created.id, 'ready')).toBe(true)
      } finally {
        spy.mockRestore()
      }
    })

    it('does NOT emit a spurious machine.status when a check leaves the status unchanged', async () => {
      const router = authedRouter({ getProvider: () => fakeProvider({ status: async () => 'running' }) })
      const created = await createMachine(router, { name: `${prefix}-ev-noop` })
      // First check moves registered → ready.
      await router.request(`/${created.id}/check`, req('POST'))

      // Ensure a real liveness change without depending on successive checks
      // landing in different milliseconds on a fast host.
      await db
        .update(machines)
        .set({ lastSeenAt: new Date('2000-01-01T00:00:00Z') })
        .where(eq(machines.id, created.id))

      const spy = spyOn(eventEmitter, 'emit')
      try {
        // Second check: ready → ready, no status flip → machine.updated, not machine.status.
        await router.request(`/${created.id}/check`, req('POST'))
        expect(emitted(spy, 'machine.status', created.id)).toHaveLength(0)
        expect(emitted(spy, 'machine.updated')).toContainEqual({ machineId: created.id })
      } finally {
        spy.mockRestore()
      }
    })

    it('does NOT emit any event on a repeat check that leaves an already-unreachable machine unchanged', async () => {
      const router = authedRouter({ getProvider: () => fakeProvider({ status: async () => 'gone' }) })
      const created = await createMachine(router, { name: `${prefix}-ev-unreachable-noop` })
      // First check: registered → unreachable (a genuine status flip).
      await router.request(`/${created.id}/check`, req('POST'))

      const spy = spyOn(eventEmitter, 'emit')
      try {
        // Second check: unreachable → unreachable, and a failed probe never bumps
        // lastSeenAt, so the row is byte-identical — nothing should emit.
        await router.request(`/${created.id}/check`, req('POST'))
        expect(emitted(spy, 'machine.status', created.id)).toHaveLength(0)
        expect(emitted(spy, 'machine.updated', created.id)).toHaveLength(0)
      } finally {
        spy.mockRestore()
      }
    })

    it('a repeat bootstrap on a ready machine announces the re-run (bootstrapping) and returns to ready', async () => {
      const router = authedRouter({
        bootstrap: async (machine) => {
          await db
            .update(machines)
            .set({ status: 'ready', bootstrapVersion: 'v-fixed', capabilities: { arch: 'x86_64' } })
            .where(eq(machines.id, machine.id))
          return {}
        },
      })
      const created = await createMachine(router, { name: `${prefix}-ev-boot-noop` })
      const spy = spyOn(eventEmitter, 'emit')
      try {
        // A 202 response only acknowledges startup. Wait for the first run's
        // terminal event before testing a new run; otherwise the second request
        // can correctly return the still-running bootstrap without starting one.
        const first = await router.request(`/${created.id}/bootstrap`, req('POST'))
        expect(first.status).toBe(202)
        expect(await waitForEmittedStatus(spy, created.id, 'ready')).toBe(true)
        spy.mockClear()

        // Second bootstrap on a READY machine. Under the ASYNC route this is
        // no longer silent: re-running it is a real state change an operator
        // should see (ready → bootstrapping → ready). The UI hides the button
        // once ready, so this path is API-only.
        const second = await router.request(`/${created.id}/bootstrap`, req('POST'))
        expect(second.status).toBe(202)
        expect(await waitForEmittedStatus(spy, created.id, 'bootstrapping')).toBe(true)
        expect(await waitForMachineStatus(created.id, 'ready')).toBe('ready')
        expect(await waitForEmittedStatus(spy, created.id, 'ready')).toBe(true)
      } finally {
        spy.mockRestore()
      }
    })

    it('emits machine.status (unreachable) after a failing bootstrap, having returned 202', async () => {
      // bootstrapMachine stamps the row `unreachable` before rethrowing; the route
      // must broadcast that real registered→unreachable flip (from its background
      // task, after responding 202) so the UI badge does
      // not stay stale at `registered`, THEN return the 502.
      const router = authedRouter({
        bootstrap: async (machine) => {
          await db.update(machines).set({ status: 'unreachable' }).where(eq(machines.id, machine.id))
          throw new Error('bootstrap.sh failed on x (exit 1): boom')
        },
      })
      const created = await createMachine(router, { name: `${prefix}-ev-boot-fail` })

      const spy = spyOn(eventEmitter, 'emit')
      try {
        const res = await router.request(`/${created.id}/bootstrap`, req('POST'))
        expect(res.status).toBe(202)
        expect(await waitForMachineStatus(created.id, 'unreachable')).toBe('unreachable')
        expect(await waitForEmittedStatus(spy, created.id, 'unreachable')).toBe(true)
      } finally {
        spy.mockRestore()
      }
    })

    it('emits machine.deleted after a successful delete', async () => {
      const router = authedRouter({ getProvider: () => fakeProvider() })
      const created = await createMachine(router, { name: `${prefix}-ev-del` })

      const spy = spyOn(eventEmitter, 'emit')
      try {
        const res = await router.request(`/${created.id}`, req('DELETE'))
        expect(res.status).toBe(204)
        expect(emitted(spy, 'machine.deleted')).toContainEqual({ machineId: created.id })
      } finally {
        spy.mockRestore()
      }
    })
  })

  describe('forced migration actor provenance', () => {
    it('accepts attributable users/agents and rejects system/legacy identities', () => {
      expect(forceMigrationActor({ type: 'user', userId: 'user-1' })).toEqual({ type: 'user', id: 'user-1' })
      expect(forceMigrationActor({ type: 'agent', agentId: 'agent-1', squadId: null })).toEqual({
        type: 'agent',
        id: 'agent-1',
      })
      expect(forceMigrationActor({ type: 'system', systemTokenId: 'token-1', name: 'test', scopes: ['*'] })).toBeNull()
      expect(forceMigrationActor({ type: 'legacy' })).toBeNull()
      expect(forceMigrationActor(undefined)).toBeNull()
    })
  })

  describe('quiesce + release', () => {
    it('POST /:id/quiesce fences the machine and returns the sandbox ids it now holds', async () => {
      const calls: Array<[string, unknown]> = []
      const router = authedRouter({
        quiesceMachine: async (machineId, opts) => {
          calls.push([machineId, opts])
          return { quiesced: ['agent_a', 'squad_b'], refused: [] }
        },
      })
      const created = await createMachine(router, { name: `${prefix}-q-ok` })

      const res = await router.request(`/${created.id}/quiesce`, req('POST', {}))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ quiesced: ['agent_a', 'squad_b'] })
      expect(calls).toEqual([[created.id, {}]])
    })

    it('409s with the refusing boxes when any box is mid-turn', async () => {
      const refused = [{ sandboxId: 'squad_b', activeExecutionCount: 3 }]
      const router = authedRouter({
        quiesceMachine: async () => ({ quiesced: [], refused }),
      })
      const created = await createMachine(router, { name: `${prefix}-q-busy` })

      const res = await router.request(`/${created.id}/quiesce`, req('POST', {}))
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error: string; refused: unknown }
      // The count is surfaced, not swallowed — an operator deciding whether to
      // wait or force needs to know how busy the machine actually is.
      expect(body.refused).toEqual(refused)
      expect(body.error).toMatch(/no fences were left in place/i)
    })

    it('an empty machine is a 200 with an empty list, NOT a 409', async () => {
      // `refused.length`, never `quiesced.length`, is what distinguishes success
      // — a machine with no boxes has nothing to fence and nothing to refuse.
      const router = authedRouter({ quiesceMachine: async () => ({ quiesced: [], refused: [] }) })
      const created = await createMachine(router, { name: `${prefix}-q-empty` })

      const res = await router.request(`/${created.id}/quiesce`, req('POST', {}))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ quiesced: [] })
    })

    it('404s for an unknown machine', async () => {
      let called = false
      const router = authedRouter({
        quiesceMachine: async () => {
          called = true
          return { quiesced: [], refused: [] }
        },
      })
      const res = await router.request('/00000000-0000-0000-0000-000000000000/quiesce', req('POST', {}))
      expect(res.status).toBe(404)
      expect(called).toBe(false)
    })

    it('rejects an unprivileged caller', async () => {
      const router = authedRouter({ quiesceMachine: async () => ({ quiesced: [], refused: [] }) })
      const created = await createMachine(router, { name: `${prefix}-q-perm` })
      const res = await router.request(`/${created.id}/quiesce`, req('POST', {}, unprivileged.token))
      expect(res.status).toBe(403)
    })

    it('AWAITS the fence-recovery barrier before quiescing', async () => {
      // Same hazard as migrate-box: a request served before the boot chain runs
      // would otherwise have its fresh fences cleared by the later recovery.
      const order: string[] = []
      const router = authedRouter({
        recoverFences: async () => {
          order.push('recover')
          return 0
        },
        quiesceMachine: async () => {
          order.push('quiesce')
          return { quiesced: [], refused: [] }
        },
      })
      const created = await createMachine(router, { name: `${prefix}-q-recover` })

      expect((await router.request(`/${created.id}/quiesce`, req('POST', {}))).status).toBe(200)
      expect(order).toEqual(['recover', 'quiesce'])
    })

    describe('force', () => {
      it('refuses a caller without machines:force-migrate, and never runs the quiesce', async () => {
        let called = false
        const router = authedRouter({
          quiesceMachine: async () => {
            called = true
            return { quiesced: [], refused: [] }
          },
        })
        const created = await createMachine(router, { name: `${prefix}-q-force-denied` })

        const res = await router.request(
          `/${created.id}/quiesce`,
          req('POST', { force: { reason: 'evacuating' } }, unprivileged.token)
        )
        expect(res.status).toBe(403)
        expect(called).toBe(false)
      })

      it('passes an attributable actor and the reason through when the caller is authorized', async () => {
        let received: unknown
        const router = authedRouter({
          quiesceMachine: async (_machineId, opts) => {
            received = opts
            return { quiesced: ['agent_a'], refused: [] }
          },
        })
        const created = await createMachine(router, { name: `${prefix}-q-force-ok` })

        const res = await router.request(
          `/${created.id}/quiesce`,
          req('POST', { force: { reason: 'evacuating a dying host' } })
        )
        expect(res.status).toBe(200)
        expect(received).toEqual({
          force: { actor: `user:${admin.id}`, reason: 'evacuating a dying host' },
        })
      })

      it('requires a non-empty reason', async () => {
        const router = authedRouter({ quiesceMachine: async () => ({ quiesced: [], refused: [] }) })
        const created = await createMachine(router, { name: `${prefix}-q-force-noreason` })
        const res = await router.request(`/${created.id}/quiesce`, req('POST', { force: { reason: '  ' } }))
        expect(res.status).toBe(400)
      })
    })

    it('POST /:id/release lifts exactly the sandbox ids it is given', async () => {
      const calls: string[][] = []
      const router = authedRouter({
        releaseMachine: async (sandboxIds) => {
          calls.push(sandboxIds)
          return sandboxIds.length
        },
      })
      const created = await createMachine(router, { name: `${prefix}-rel` })

      const res = await router.request(`/${created.id}/release`, req('POST', { sandboxIds: ['agent_a', 'squad_b'] }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ released: 2 })
      // The EXPLICIT list, never re-derived from the machine's current boxes —
      // one of those could be fenced by a concurrent migrate-box.
      expect(calls).toEqual([['agent_a', 'squad_b']])
    })

    it('POST /:id/release accepts an empty list', async () => {
      const router = authedRouter({ releaseMachine: async () => 0 })
      const created = await createMachine(router, { name: `${prefix}-rel-empty` })
      const res = await router.request(`/${created.id}/release`, req('POST', { sandboxIds: [] }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ released: 0 })
    })

    it('POST /:id/release 404s for an unknown machine and rejects a missing sandboxIds', async () => {
      const router = authedRouter({ releaseMachine: async () => 0 })
      const created = await createMachine(router, { name: `${prefix}-rel-bad` })
      expect(
        (await router.request('/00000000-0000-0000-0000-000000000000/release', req('POST', { sandboxIds: [] }))).status
      ).toBe(404)
      expect((await router.request(`/${created.id}/release`, req('POST', {}))).status).toBe(400)
    })
  })

  describe('migrate-box + rebalance', () => {
    it('POST /rebalance passes dryRun through to the service and returns the plan', async () => {
      let calledWith: { dryRun?: boolean } | undefined
      const plan = {
        moves: [{ sandboxId: 'agent_a', fromMachineId: 'm1', toMachineId: 'm2' }],
        skippedActive: ['agent_b'],
        unplaceable: ['agent_c'],
        unresolvable: ['m3'],
        results: [],
      }
      const router = authedRouter({
        rebalance: async (opts) => {
          calledWith = opts
          return plan
        },
      })

      const res = await router.request('/rebalance', req('POST', { dryRun: true }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(plan)
      expect(calledWith).toEqual({ dryRun: true })
    })

    it('POST /rebalance without dryRun executes and returns the plan with results', async () => {
      let calledWith: { dryRun?: boolean } | undefined
      const executed = {
        moves: [{ sandboxId: 'agent_a', fromMachineId: 'm1', toMachineId: 'm2' }],
        skippedActive: [],
        unplaceable: [],
        unresolvable: [],
        results: [{ sandboxId: 'agent_a', result: { moved: true } }],
      }
      const router = authedRouter({
        rebalance: async (opts) => {
          calledWith = opts
          return executed
        },
      })

      const res = await router.request('/rebalance', req('POST', {}))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(executed)
      expect(calledWith).toEqual({})
    })

    it('409s POST /rebalance when an execute is already in flight', async () => {
      const router = authedRouter({
        rebalance: async () => {
          throw new RebalanceInProgressError()
        },
      })

      const res = await router.request('/rebalance', req('POST', {}))
      expect(res.status).toBe(409)
      expect(((await res.json()) as { error: string }).error).toMatch(/in progress/i)
    })

    it('both handlers AWAIT the fence-recovery barrier BEFORE executing (a request can beat the boot chain)', async () => {
      // Bun.serve accepts requests before index.ts's async boot chain finishes,
      // so the boot-time clearAllMigratingFences may not have run yet when the
      // first migrate/rebalance arrives. Awaiting the memoized once-barrier in
      // the handler guarantees recovery is strictly-before every migrate — the
      // boot chain can then never clear a fence a request-side migrate holds.
      const order: string[] = []
      const router = authedRouter({
        recoverFences: async () => {
          order.push('recover')
          return 0
        },
        migrate: async () => {
          order.push('migrate')
          return { moved: true }
        },
        rebalance: async () => {
          order.push('rebalance')
          return { moves: [], skippedActive: [], unplaceable: [], unresolvable: [], results: [] }
        },
      })
      const created = await createMachine(router, { name: `${prefix}-mig-recover` })

      const migrateRes = await router.request(`/${created.id}/migrate-box`, req('POST', { sandboxId: 'agent_r' }))
      expect(migrateRes.status).toBe(200)
      const rebalanceRes = await router.request('/rebalance', req('POST', {}))
      expect(rebalanceRes.status).toBe(200)

      expect(order).toEqual(['recover', 'migrate', 'recover', 'rebalance'])
    })

    it('POST /:id/migrate-box calls migrateBox with the body sandboxId and the path machine id', async () => {
      const calls: Array<[string, string]> = []
      const router = authedRouter({
        migrate: async (sandboxId, targetMachineId) => {
          calls.push([sandboxId, targetMachineId])
          return { moved: true }
        },
      })
      const created = await createMachine(router, { name: `${prefix}-mig` })

      const res = await router.request(`/${created.id}/migrate-box`, req('POST', { sandboxId: 'agent_abc' }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ moved: true })
      expect(calls).toEqual([['agent_abc', created.id]])
    })

    // The route is the ONLY path production callers take (CLI, web control,
    // platform resize all go over HTTP), so the default has to be pinned HERE,
    // not just in box-migrate's unit tests. Without this, rewriting the handler
    // as `{ allowSquad: Boolean(allowSquad) }` — which refuses every default
    // squad migration in production — passes the entire route suite.
    it('omits allowSquad entirely when the body does not set it, so the migrate default governs', async () => {
      let seenOpts: { allowSquad?: boolean } | undefined
      const router = authedRouter({
        migrate: async (_sandboxId, _targetMachineId, opts) => {
          seenOpts = opts
          return { moved: true }
        },
      })
      const created = await createMachine(router, { name: `${prefix}-mig-default` })

      const res = await router.request(`/${created.id}/migrate-box`, req('POST', { sandboxId: 'squad_abc' }))
      expect(res.status).toBe(200)
      // Not `false`, and not coerced: undefined is what lets migrateBox apply
      // its own default. A Boolean() coercion here would read as an explicit
      // refusal downstream.
      expect(seenOpts?.allowSquad).toBeUndefined()
    })

    it('forwards an explicit allowSquad:false as the opt-OUT, not as an absent field', async () => {
      let seenOpts: { allowSquad?: boolean } | undefined
      const router = authedRouter({
        migrate: async (_sandboxId, _targetMachineId, opts) => {
          seenOpts = opts
          return { moved: false, reason: 'squad-box' }
        },
      })
      const created = await createMachine(router, { name: `${prefix}-mig-optout` })

      const res = await router.request(
        `/${created.id}/migrate-box`,
        req('POST', { sandboxId: 'squad_abc', allowSquad: false })
      )
      expect(res.status).toBe(200)
      expect(seenOpts?.allowSquad).toBe(false)
    })

    it('forwards allowSquad from the body to migrateBox (opt-in squad move)', async () => {
      let seenOpts: { allowSquad?: boolean } | undefined
      const router = authedRouter({
        migrate: async (_sandboxId, _targetMachineId, opts) => {
          seenOpts = opts
          return { moved: true }
        },
      })
      const created = await createMachine(router, { name: `${prefix}-mig-squad` })

      const res = await router.request(
        `/${created.id}/migrate-box`,
        req('POST', { sandboxId: 'squad_abc', allowSquad: true })
      )
      expect(res.status).toBe(200)
      expect(seenOpts?.allowSquad).toBe(true)
    })

    // The SSE branch is a SEPARATE call into migrateBox from the JSON branch,
    // and it is the one the CLI uses — so it needs its own default pin. Without
    // this, coercing allowSquad on the streaming path alone refuses every
    // default squad migration from the CLI while the whole suite stays green.
    it('omits allowSquad on the STREAMING path too, so the CLI gets the migrate default', async () => {
      let seenOpts: { allowSquad?: boolean } | undefined
      const router = authedRouter({
        migrate: async (_sandboxId, _targetMachineId, opts) => {
          seenOpts = opts
          return { moved: true }
        },
      })
      const created = await createMachine(router, { name: `${prefix}-mig-stream-default` })

      const res = await router.request(`/${created.id}/migrate-box`, {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ sandboxId: 'squad_abc' }),
      })
      expect(res.status).toBe(200)
      await res.text()
      expect(seenOpts?.allowSquad).toBeUndefined()
    })

    // Structured force reaches migrateBox on BOTH
    // response paths — and the CLI, the only caller that can set it, uses the
    // STREAMING one. A rename or a dropped field on either branch would leave
    // an operator's `--force` silently doing nothing while the fleet burns.
    it('forwards authenticated structured force on JSON and STREAMING paths, and omits it otherwise', async () => {
      const seen: Array<{ force?: unknown }> = []
      const router = authedRouter({
        migrate: async (_sandboxId, _targetMachineId, opts) => {
          seen.push({ force: opts?.force })
          return { moved: true }
        },
      })
      const created = await createMachine(router, { name: `${prefix}-mig-force` })

      expect(
        (
          await router.request(
            `/${created.id}/migrate-box`,
            req('POST', {
              sandboxId: 'squad_11111111-1111-4111-8111-111111111111',
              force: { reason: 'Evacuate failing host', requestId: '22222222-2222-4222-8222-222222222222' },
            })
          )
        ).status
      ).toBe(200)

      const streamed = await router.request(`/${created.id}/migrate-box`, {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          sandboxId: 'squad_11111111-1111-4111-8111-111111111111',
          force: { reason: 'Evacuate failing host', requestId: '22222222-2222-4222-8222-222222222222' },
        }),
      })
      expect(streamed.status).toBe(200)
      await streamed.text()

      // Absent in the body must stay absent (never coerced to false), so
      // migrateBox's own default governs.
      expect((await router.request(`/${created.id}/migrate-box`, req('POST', { sandboxId: 'agent_f' }))).status).toBe(
        200
      )

      expect(seen[0]?.force).toMatchObject({
        actor: { type: 'user' },
        reason: 'Evacuate failing host',
        requestId: '22222222-2222-4222-8222-222222222222',
      })
      expect(seen[1]?.force).toMatchObject({ actor: { type: 'user' }, reason: 'Evacuate failing host' })
      expect(seen[2]?.force).toBeUndefined()
    })

    it('allows an attributable agent and denies system/legacy identities at the route', async () => {
      const [squad] = await db
        .insert(squads)
        .values({ name: `${prefix}-force-agent`, purpose: 'test' })
        .returning()
      const [agent] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
      await db.insert(agentExtraScopes).values([
        { agentId: agent.id, permission: 'machines:write' },
        { agentId: agent.id, permission: Permissions.MACHINES_FORCE_MIGRATE },
      ])
      const target = await insertMachine({
        name: `${prefix}-force-identity`,
        provider: 'ssh',
        sshHost: '10.0.0.1',
        sshUser: 'tau',
        sshKeyId: 'test',
        sshPublicKey: 'ssh-ed25519 AAAA',
        status: 'ready',
      })
      const force = { reason: 'Evacuate host', requestId: crypto.randomUUID() }
      const seen: any[] = []
      const requestAs = async (identity: any) => {
        const app = new Hono()
        app.use('*', async (c, next) => {
          c.set('identity', identity)
          await next()
        })
        app.route(
          '/',
          createMachinesRouter({
            migrate: async (_s, _t, opts) => {
              seen.push(opts?.force)
              return { moved: true }
            },
          })
        )
        return app.request(`/${target.id}/migrate-box`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sandboxId: `squad_${squad.id}`, force }),
        })
      }
      try {
        expect((await requestAs({ type: 'agent', agentId: agent.id, squadId: squad.id })).status).toBe(200)
        expect(seen[0]?.actor).toEqual({ type: 'agent', id: agent.id })
        expect((await requestAs({ type: 'system', scopes: ['machines:*'] })).status).toBe(403)
        expect((await requestAs({ type: 'legacy' })).status).toBe(403)
        expect(seen).toHaveLength(1)
      } finally {
        await db.delete(squads).where(eq(squads.id, squad.id))
      }
    })

    it('denies force to a user with machines:write but without machines:force-migrate', async () => {
      const limited = await createTestUser({ prefix })
      const role = await createTestRole({ prefix, permissions: ['machines:write'] })
      await assignRole({ userId: limited.id, roleId: role.id, scope: 'system' })
      let called = false
      const router = authedRouter({
        migrate: async () => {
          called = true
          return { moved: true }
        },
      })
      const created = await createMachine(router, { name: `${prefix}-force-denied` })
      const response = await router.request(
        `/${created.id}/migrate-box`,
        req(
          'POST',
          {
            sandboxId: `squad_${crypto.randomUUID()}`,
            force: { reason: 'Evacuate host', requestId: crypto.randomUUID() },
          },
          limited.token
        )
      )
      expect(response.status).toBe(403)
      expect(called).toBe(false)
    })

    it('rejects empty and overlong force reasons before the service runs', async () => {
      let called = false
      const router = authedRouter({
        migrate: async () => {
          called = true
          return { moved: true }
        },
      })
      const created = await createMachine(router, { name: `${prefix}-force-reason` })
      for (const reason of ['   ', 'x'.repeat(501)]) {
        const response = await router.request(
          `/${created.id}/migrate-box`,
          req('POST', {
            sandboxId: `squad_${crypto.randomUUID()}`,
            force: { reason, requestId: crypto.randomUUID() },
          })
        )
        expect(response.status).toBe(400)
      }
      expect(called).toBe(false)
    })

    it('closes a device SSE response on revoke while admitted migration finishes, then rejects reconnect', async () => {
      let migrationStarted!: () => void
      let finishMigration!: () => void
      const started = new Promise<void>((resolve) => (migrationStarted = resolve))
      const finish = new Promise<void>((resolve) => (finishMigration = resolve))
      let completed = false
      const router = authedRouter({
        migrate: async () => {
          migrationStarted()
          await finish
          completed = true
          return { moved: true as const }
        },
      })
      const machine = await createMachine(router, { name: `${prefix}-device-stream` })
      const device = await createDeviceToken({ userId: admin.id, name: 'CLI', platform: 'cli' })
      const request = () =>
        router.request(`/${machine.id}/migrate-box`, {
          method: 'POST',
          headers: { ...authHeaders(device.token), 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({ sandboxId: 'agent_device_stream' }),
        })
      const response = await request()
      await started
      const reader = response.body!.getReader()
      await revokeDeviceToken(admin.id, device.id)

      const closed = await Promise.race([
        reader.read(),
        Bun.sleep(1_000).then(() => {
          throw new Error('revoked SSE response did not close')
        }),
      ])
      expect(closed.done).toBe(true)
      expect(completed).toBe(false)

      finishMigration()
      while (!completed) await Bun.sleep(1)
      expect(Boolean(completed)).toBe(true)
      expect((await request()).status).toBe(401)
    })

    it('streams phase progress then the final result as SSE when the client asks for text/event-stream', async () => {
      const router = authedRouter({
        migrate: async (sandboxId, _targetMachineId, opts) => {
          // An external driver tails these to know which phase is running without
          // waiting for the move to finish.
          opts?.onProgress?.({ phase: 'fence', sandboxId })
          opts?.onProgress?.({ phase: 'archive', sandboxId })
          return { moved: true }
        },
      })
      const created = await createMachine(router, { name: `${prefix}-mig-stream` })

      const res = await router.request(`/${created.id}/migrate-box`, {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ sandboxId: 'squad_abc', allowSquad: true }),
      })
      expect(res.status).toBe(200)
      const text = await res.text()
      // Phase records arrive as `progress` events, in order, BEFORE the terminal
      // `result` event that carries the MigrateResult.
      expect(text).toContain('event: progress')
      expect(text).toContain('"phase":"fence"')
      expect(text).toContain('"phase":"archive"')
      expect(text).toContain('event: result')
      expect(text).toContain('"moved":true')
      expect(text.indexOf('"phase":"fence"')).toBeLessThan(text.indexOf('"phase":"archive"'))
      expect(text.indexOf('"phase":"archive"')).toBeLessThan(text.indexOf('event: result'))
    })

    it('returns a structured non-move result verbatim (still 200)', async () => {
      const router = authedRouter({
        migrate: async () => ({ moved: false, reason: 'active-turn' as const }),
      })
      const created = await createMachine(router, { name: `${prefix}-mig-busy` })

      const res = await router.request(`/${created.id}/migrate-box`, req('POST', { sandboxId: 'agent_busy' }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ moved: false, reason: 'active-turn' })
    })

    it('400s a migrate-box body missing sandboxId, never calling the service', async () => {
      let called = false
      const router = authedRouter({
        migrate: async () => {
          called = true
          return { moved: true }
        },
      })
      const created = await createMachine(router, { name: `${prefix}-mig-badbody` })

      const res = await router.request(`/${created.id}/migrate-box`, req('POST', {}))
      expect(res.status).toBe(400)
      expect(called).toBe(false)
    })

    it('404s migrate-box on a missing machine', async () => {
      const router = authedRouter({ migrate: async () => ({ moved: true }) })
      const res = await router.request(
        '/00000000-0000-0000-0000-000000000000/migrate-box',
        req('POST', { sandboxId: 'agent_x' })
      )
      expect(res.status).toBe(404)
    })

    it('403s both routes for a caller without machines:write', async () => {
      const router = authedRouter({
        migrate: async () => ({ moved: true }),
        rebalance: async () => ({ moves: [], skippedActive: [], unplaceable: [], unresolvable: [], results: [] }),
      })
      const created = await createMachine(router, { name: `${prefix}-mig-perm` })

      const migrateRes = await router.request(
        `/${created.id}/migrate-box`,
        req('POST', { sandboxId: 'agent_x' }, unprivileged.token)
      )
      expect(migrateRes.status).toBe(403)

      const rebalanceRes = await router.request('/rebalance', req('POST', { dryRun: true }, unprivileged.token))
      expect(rebalanceRes.status).toBe(403)
    })
  })

  describe('artifact versions + utilization', () => {
    it('exposes artifactVersions and utilization on list and detail, keeping secrets stripped', async () => {
      const router = authedRouter()
      const created = await createMachine(router, { name: `${prefix}-util` })

      // A mixed box set: one squad box (heavy) + two agent boxes (light). The box
      // authToken is a live credential and must never reach the API surface; the
      // squad box also carries a `syncedHashes` stamp (unsalted content hashes of
      // secret files) that must be stripped too — seed one so the assertion bites.
      await db.insert(machineBoxes).values([
        {
          sandboxId: `squad_${prefix}_s`,
          machineId: created.id,
          unixUser: 'tau',
          port: 50100,
          authToken: 'SECRET-BOX-TOKEN',
          syncedHashes: { 'identity.pem': 'SECRET-CONTENT-HASH' },
        },
        { sandboxId: `agent_${prefix}_a`, machineId: created.id, unixUser: 'tau', port: 50101 },
        { sandboxId: `agent_${prefix}_b`, machineId: created.id, unixUser: 'tau', port: 50102 },
      ])

      // Expected numbers come from the SAME packer weight table the API shares —
      // never re-hardcoded here, so a weight/capacity change can't silently drift.
      const expectedUsed =
        unitWeightForSandboxId(`squad_${prefix}_s`) +
        unitWeightForSandboxId(`agent_${prefix}_a`) +
        unitWeightForSandboxId(`agent_${prefix}_b`)
      const expectedCapacity = resolveMachineUnitCapacity()

      const detail = await (await router.request(`/${created.id}`, req('GET'))).json()
      expect(detail.artifactVersions).toEqual({})
      expect(detail.utilization).toEqual({ unitsUsed: expectedUsed, unitCapacity: expectedCapacity })
      // Box secrets are stripped everywhere in the detail payload: the authToken
      // credential AND the syncedHashes content-verification oracle.
      expect(JSON.stringify(detail.boxes)).not.toContain('SECRET-BOX-TOKEN')
      expect(JSON.stringify(detail.boxes)).not.toContain('SECRET-CONTENT-HASH')
      for (const box of detail.boxes) {
        expect(box.authToken).toBeUndefined()
        expect(box.syncedHashes).toBeUndefined()
      }
      expect(detail.sshKeyId).toBeUndefined()

      const list = await (await router.request('/', req('GET'))).json()
      const entry = list.find((m: { id: string }) => m.id === created.id)
      expect(entry.artifactVersions).toEqual({})
      expect(entry.utilization).toEqual({ unitsUsed: expectedUsed, unitCapacity: expectedCapacity })
      expect(entry.sshKeyId).toBeUndefined()
    })

    it('reflects stamped artifact versions on detail and list', async () => {
      const router = authedRouter()
      const created = await createMachine(router, { name: `${prefix}-artifacts` })
      await stampArtifactVersion(created.id, 'server', 'abc1234')

      const detail = await (await router.request(`/${created.id}`, req('GET'))).json()
      expect(detail.artifactVersions).toEqual({ server: 'abc1234' })

      const list = await (await router.request('/', req('GET'))).json()
      const entry = list.find((m: { id: string }) => m.id === created.id)
      expect(entry.artifactVersions).toEqual({ server: 'abc1234' })
    })

    it('reports zero utilization for a machine with no boxes', async () => {
      const router = authedRouter()
      const created = await createMachine(router, { name: `${prefix}-util-empty` })
      const detail = await (await router.request(`/${created.id}`, req('GET'))).json()
      expect(detail.utilization).toEqual({ unitsUsed: 0, unitCapacity: resolveMachineUnitCapacity() })
    })
  })

  it('deletes the just-created ssh key when the machine row insert fails (M1 compensation)', async () => {
    // The keypair is persisted to the secret store BEFORE the row insert; if the
    // insert throws (e.g. a dup-name race between pre-check and insert) the key
    // must not orphan. Force the insert to fail and assert the key was removed.
    const before = new Set(
      (await getSecretStore().list()).map((s) => s.key).filter((k) => k.startsWith('machine-ssh:'))
    )

    const router = authedRouter({
      insert: async () => {
        throw new Error('duplicate key value violates unique constraint "machines_name_unique"')
      },
    })

    const res = await router.request(
      '/',
      req('POST', { name: `${prefix}-compensate`, sshHost: '10.0.0.7', sshUser: 'tau' })
    )
    expect(res.status).toBe(500)

    // No new machine-ssh:* secret survived the failed registration.
    const after = (await getSecretStore().list()).map((s) => s.key).filter((k) => k.startsWith('machine-ssh:'))
    expect(after.filter((k) => !before.has(k))).toEqual([])
  })

  it('provisions an exe machine: no per-machine key, row references the shared account key', async () => {
    let provisionSpec: MachineSpec | undefined
    const exeProvider = fakeProvider({
      key: 'exe',
      provision: async (spec) => {
        provisionSpec = spec
        return { sshHost: 'vm-1.exe.xyz', sshPort: 2222, sshUser: 'exedev', providerRef: 'vm-1' }
      },
    })
    const router = authedRouter({ getProvider: () => exeProvider, getSshKey: async () => 'exe-key' })

    // No sshHost/sshUser sent: an exe VM's endpoint comes from provision, not the client.
    const res = await router.request('/', req('POST', { name: `${prefix}-exe`, provider: 'exe' }))
    expect(res.status).toBe(201)
    const body = await res.json()

    expect(body.provider).toBe('exe')
    expect(body.providerRef).toBe('vm-1')
    expect(body.sshHost).toBe('vm-1.exe.xyz')
    expect(body.sshPort).toBe(2222)
    expect(body.sshUser).toBe('exedev')
    expect(body.status).toBe('registered')
    // exe rejects per-VM keys, so no keypair is generated: no public key material,
    // and (like every machine) the private-key handle is stripped from the response.
    expect(body.sshPublicKey).toBe('')
    expect(body.sshKeyId).toBeUndefined()

    // No public key is threaded to provision — the account key already reaches the VM.
    expect(provisionSpec?.name).toBe(`${prefix}-exe`)
    expect(provisionSpec?.publicKey).toBeUndefined()

    // The row's ssh identity is the SHARED account-key secret, not a per-machine one.
    const [row] = await db.select().from(machines).where(eq(machines.id, body.id))
    expect(row.sshKeyId).toBe(EXE_PROVIDER_SSH_KEY)
  })

  it('registers exe on demand when the token is set after boot — real getMachineProvider path, no 500', async () => {
    // Reproduces the boot-snapshot vs live-read desync: at boot no token, so exe
    // is absent from the registry; a token is configured afterward. The POST's
    // 400-gate passes (live read) but a naive getMachineProvider('exe') would
    // throw → 500 until restart. The fix re-runs registerBuiltinMachineProviders
    // on demand. getProvider is NOT injected here, so resolution goes through the
    // REAL module registry.
    let provisioned = false
    const fakeExe = fakeProvider({
      key: 'exe',
      provision: async () => {
        provisioned = true
        return { sshHost: 'vm-od.exe.xyz', sshPort: 22, sshUser: 'exedev', providerRef: 'vm-od' }
      },
    })
    // Snapshot the real registry's exe slot so this test never leaks a fake exe
    // provider into other suites sharing the process (box-manager's BYO tests
    // rely on defaultGetExeProvider() being null).
    let priorExe: MachineProvider | undefined
    try {
      priorExe = getMachineProvider('exe')
    } catch {
      priorExe = undefined
    }
    try {
      const router = authedRouter({
        getSshKey: async () => 'exe-key',
        // On-demand registration into the REAL registry (stands in for the real
        // registerBuiltinMachineProviders re-reading a now-live token).
        registerProviders: async () => {
          registerMachineProvider(fakeExe)
        },
      })

      const res = await router.request('/', req('POST', { name: `${prefix}-exe-ondemand`, provider: 'exe' }))
      expect(res.status).toBe(201)
      expect(provisioned).toBe(true)
    } finally {
      if (priorExe) registerMachineProvider(priorExe)
      else unregisterMachineProvider('exe')
    }
  })

  it('rejects a provider:exe request with 400 when no exe.dev token is configured', async () => {
    const router = authedRouter({ getProvider: () => fakeProvider({ key: 'exe' }), getSshKey: async () => null })
    const res = await router.request('/', req('POST', { name: `${prefix}-exe-notoken`, provider: 'exe' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('exe.dev credentials')
  })

  it('terminates the just-provisioned exe VM when the row insert fails (no billed orphan)', async () => {
    // Dup-name race (or a transient DB error) between the pre-check and the insert:
    // provision() already succeeded, so the exe VM is BILLED. If insert throws, the
    // catch must terminate that VM before rethrowing — otherwise it orphans with no
    // row (findReady* never see it) as an invisible paid VM. Mirrors placement.ts.
    let provisionCount = 0
    let terminatedRef: string | undefined
    const exeProvider = fakeProvider({
      key: 'exe',
      provision: async () => {
        provisionCount++
        return { sshHost: 'vm-orphan.exe.xyz', sshPort: 22, sshUser: 'exedev', providerRef: 'vm-orphan' }
      },
      terminate: async (machine) => {
        terminatedRef = machine.providerRef ?? undefined
      },
    })
    const router = authedRouter({
      getProvider: () => exeProvider,
      getSshKey: async () => 'exe-key',
      insert: async () => {
        throw new Error('duplicate key value violates unique constraint "machines_name_unique"')
      },
    })

    const res = await router.request('/', req('POST', { name: `${prefix}-exe-orphan`, provider: 'exe' }))
    // The original insert failure still surfaces (terminate must not mask it).
    expect(res.status).toBe(500)
    // The billed VM was provisioned once and then terminated by its providerRef.
    expect(provisionCount).toBe(1)
    expect(terminatedRef).toBe('vm-orphan')
  })

  it('destroys the VM (provider.terminate) when deleting an exe machine', async () => {
    let terminatedId: string | undefined
    const exeProvider = fakeProvider({
      key: 'exe',
      provision: async () => ({ sshHost: 'vm-2.exe.xyz', sshPort: 22, sshUser: 'exedev', providerRef: 'vm-2' }),
      terminate: async (machine) => {
        terminatedId = machine.id
      },
    })
    const router = authedRouter({ getProvider: () => exeProvider, getSshKey: async () => 'exe-key' })

    const createRes = await router.request('/', req('POST', { name: `${prefix}-exe-del`, provider: 'exe' }))
    expect(createRes.status).toBe(201)
    const created = await createRes.json()

    const del = await router.request(`/${created.id}`, req('DELETE'))
    expect(del.status).toBe(204)
    expect(terminatedId).toBe(created.id)
  })

  it('deleting an exe machine does NOT delete the shared account-key secret (other exe VMs keep working)', async () => {
    // Every exe machine's row references the SAME account-key secret. If DELETE
    // deleted it, all the tenant's OTHER exe VMs would lose their SSH identity.
    // Seed the shared secret, provision two exe machines, delete one, and assert
    // the shared secret survives.
    await getSecretStore().set(EXE_PROVIDER_SSH_KEY, 'ACCOUNT-PRIVATE-KEY', 'system')
    let refCounter = 0
    const exeProvider = fakeProvider({
      key: 'exe',
      provision: async () => ({
        sshHost: `vm-${++refCounter}.exe.xyz`,
        sshPort: 22,
        sshUser: 'exedev',
        providerRef: `vm-shared-${refCounter}`,
      }),
      terminate: async () => {},
    })
    // Inject a no-op registerProviders: this test seeds the REAL account-key
    // secret, and the default (real) registerBuiltinMachineProviders would then
    // register a real exe provider into the shared module registry, leaking it
    // into sibling suites. getProvider is injected, so no real registration is
    // needed here.
    const router = authedRouter({
      getProvider: () => exeProvider,
      getSshKey: async () => 'exe-key',
      registerProviders: async () => {},
    })
    try {
      const a = await (await router.request('/', req('POST', { name: `${prefix}-exe-keep-a`, provider: 'exe' }))).json()
      const b = await (await router.request('/', req('POST', { name: `${prefix}-exe-keep-b`, provider: 'exe' }))).json()

      const del = await router.request(`/${a.id}`, req('DELETE'))
      expect(del.status).toBe(204)

      // The shared account key is untouched, so machine B still resolves its identity.
      expect(getSecretStore().get(EXE_PROVIDER_SSH_KEY)).toBe('ACCOUNT-PRIVATE-KEY')
      const [rowB] = await db.select().from(machines).where(eq(machines.id, b.id))
      expect(rowB.sshKeyId).toBe(EXE_PROVIDER_SSH_KEY)
    } finally {
      await getSecretStore().delete(EXE_PROVIDER_SSH_KEY)
    }
  })
})
