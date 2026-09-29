import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { readFileSync } from 'fs'
import { SECRET_STORE_REFRESH_INTERVAL_MS } from './services/secrets'
import { join } from 'path'
import { app, runSandboxSetupValidation } from './index'
import { INTERNAL_EVENTS_PATH, internalEventToken, listen } from './lib/infra/local-events'
import { INVALID_JSON_BODY_MESSAGE } from './middleware/json-body-errors'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from './test-utils'

async function expectInvalidJson(response: Response) {
  expect(response.status).toBe(400)
  expect(response.headers.get('content-type')).toStartWith('application/json')
  expect(await response.json()).toEqual({ error: INVALID_JSON_BODY_MESSAGE })
}

describe('production JSON body boundary', () => {
  const prefix = `index-json-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let admin: TestUser
  let unprivileged: TestUser

  beforeAll(async () => {
    admin = await createTestAdmin({ prefix })
    unprivileged = await createTestUser({ prefix })
  })

  afterAll(async () => {
    await cleanupTestRbac(prefix)
  })
  it('normalizes malformed JSON on formerly caught required auth bodies', async () => {
    for (const path of ['/api/auth/register/token/verify', '/api/auth/pair/claim']) {
      await expectInvalidJson(
        await app.request(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{',
        })
      )
    }
  })

  it('preserves absent optional auth bodies but rejects malformed non-empty input', async () => {
    const absent = await app.request('/api/auth/recover/passkey', { method: 'POST' })
    expect(absent.status).toBe(200)
    expect(await absent.json()).toEqual({ ok: true })
    await expectInvalidJson(await app.request('/api/auth/recover/passkey', { method: 'POST', body: '{' }))
  })

  it('preserves authenticated permission ordering before parsing', async () => {
    const request = (token: string) =>
      app.request('/api/agent-types', {
        method: 'POST',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: '{',
      })
    expect((await request(unprivileged.token)).status).toBe(403)
    await expectInvalidJson(await request(admin.token))
  })

  it('does not parse protected bodies before identity', async () => {
    for (const path of ['/api/agent-types', '/api/squads/ssh/example/keys']) {
      const response = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      })
      expect(response.status).toBe(401)
    }
  })
})

// Boot-recovery contract: box migration fences (machine_boxes.migrating) are
// crash-recovered by the process that EXECUTES migrations — and that is the
// API: routes/machines.ts (mounted here in index.ts) calls migrateBox /
// rebalanceFleet directly, so an API crash mid-migrate is what leaves an
// orphaned fence (migrateBox's try/finally does not survive process death).
// An orphaned fence makes its box permanently unmigratable AND indefinitely
// defers every queued turn for its owners (the worker's pickup defers on the
// fence). The WORKER must never clear fences (see worker.test.ts — a fence at
// worker boot may be LIVE in this process). A unit test can't drive the whole
// API boot, so pin the wiring by source contract (same pattern as
// worker.test.ts's provider-registration guard).
describe('api subsystem ownership', () => {
  const indexSrc = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8')

  it('starts exactly one secret refresh after initialization and before invalidation', () => {
    // 5 minutes, not 60s: cross-process invalidation (the line right after) is
    // the fast path; this timer only bounds a MISSED notification.
    const starts = indexSrc.match(/store\.startPeriodicRefresh\(SECRET_STORE_REFRESH_INTERVAL_MS\)/g) ?? []
    expect(starts).toHaveLength(1)
    expect(SECRET_STORE_REFRESH_INTERVAL_MS).toBe(5 * 60_000)

    const initialize = indexSrc.indexOf('await store.initialize()')
    const periodic = indexSrc.indexOf('store.startPeriodicRefresh(SECRET_STORE_REFRESH_INTERVAL_MS)')
    const invalidation = indexSrc.indexOf('await store.startCrossProcessInvalidation()')
    expect(periodic).toBeGreaterThan(initialize)
    expect(invalidation).toBeGreaterThan(periodic)
  })

  // Periodic sandbox maintenance (the k8s 60s reconcile pass + the pod idle
  // sweep) belongs to the worker only — see worker.test.ts. The API still
  // builds a sandbox manager for the request path (ensure/exec/spawnShell),
  // but must never claim the loops, or every tick runs twice.
  it('does not claim periodic sandbox maintenance', () => {
    expect(indexSrc).not.toContain('claimPeriodicSandboxMaintenance')
  })

  it('pairs toolchain state cleanup startup and shutdown', () => {
    expect(indexSrc).toContain('startToolchainStateCleanupScheduler()')
    expect(indexSrc).toContain('stopToolchainStateCleanupScheduler()')
    expect(indexSrc).toContain("'toolchain-state-cleanup-scheduler'")
  })

  // The bind-address decision (0.0.0.0 vs localhost) used to compare
  // process.env.FICUS_SANDBOX_RUNTIME directly against 'k8s', which — unlike
  // every other runtime predicate (isK8sRuntime, isHostRuntime, ...) — does
  // NOT trim. A padded value (' k8s ' from a stray .env/shell newline) would
  // then bind to localhost inside a k8s pod, silently failing readiness
  // probes. Pin the wiring to the trimming predicate by source contract,
  // since this branch lives inside `if (import.meta.main)` and can't be
  // driven directly by a unit test.
  it('derives the k8s bind-address check from isK8sRuntime(), not a raw env comparison', () => {
    expect(indexSrc).toContain('isK8sRuntime() || !!process.env.KUBERNETES_SERVICE_HOST')
    expect(indexSrc).not.toContain("process.env.FICUS_SANDBOX_RUNTIME === 'k8s'")
  })
})

describe('api boot migration-fence recovery', () => {
  const indexSrc = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8')

  it('recovers orphaned box migration fences during API startup', () => {
    // recoverMigrationFencesOnce is the memoized once-barrier around
    // clearAllMigratingFences: the migrate/rebalance routes await the same
    // barrier, so even a request served before this async boot chain finishes
    // (Bun.serve accepts before the chain completes) runs the recovery itself
    // rather than racing it.
    expect(indexSrc).toContain('recoverMigrationFencesOnce')
  })

  it('runs the recovery inside the DB-ready boot chain (after waitForDbAndMigrate)', () => {
    // 'waitForDbAndMigrate()' with parens = the boot invocation, not the import.
    const bootIdx = indexSrc.indexOf('waitForDbAndMigrate()')
    const recoverIdx = indexSrc.indexOf('recoverMigrationFencesOnce')
    expect(bootIdx).toBeGreaterThan(-1)
    expect(recoverIdx).toBeGreaterThan(bootIdx)
  })
})

// The api has no second listener for cross-process events: tau-worker POSTs
// into the api's EXISTING Hono server. Exercise the mounted route for real
// rather than pinning it by source contract.
describe('api internal event route', () => {
  const body = JSON.stringify({ channel: 'agent_control', payload: 'stop' })

  it('rejects an unauthenticated post', async () => {
    const res = await app.request(INTERNAL_EVENTS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(401)
  })

  it('rejects a wrong token', async () => {
    const res = await app.request(INTERNAL_EVENTS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ficus-internal-token': 'nope' },
      body,
    })
    expect(res.status).toBe(401)
  })

  it('dispatches an authenticated post to this process listeners', async () => {
    const received: string[] = []
    const unlisten = await listen('agent_control', (payload) => received.push(payload))
    try {
      const res = await app.request(INTERNAL_EVENTS_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ficus-internal-token': internalEventToken() },
        body,
      })
      expect(res.status).toBe(204)
      expect(received).toEqual(['stop'])
    } finally {
      await unlisten()
    }
  })

  it('is not exposed as a GET', async () => {
    const res = await app.request(INTERNAL_EVENTS_PATH)
    expect(res.status).toBe(404)
  })
})

describe('CORS preflight', () => {
  it('allows the x-ficus-csrf header, and only that spelling, from an allowlisted web origin', async () => {
    const res = await app.request('/api/auth/me', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-ficus-csrf',
      },
    })
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(/\s*,\s*/)
    expect(allowed).toContain('x-ficus-csrf')
    expect(allowed).not.toContain('x-tau-csrf') // D14: a client-sent pre-Ficus header is never trusted // ficus-negative-test
  })
})

// validateSandboxSetup() stays NON-FATAL for the api (a missing sandbox image
// must not take the server down), but "non-fatal" must not mean invisible: the
// catch used to be empty on the claim that the error was "already logged",
// which held only for the image branch. `docker-sysbox requested but sysbox is
// not installed` came out of the same call and vanished entirely.
describe('runSandboxSetupValidation', () => {
  it('logs the failure instead of swallowing it, and never rethrows', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() =>
        runSandboxSetupValidation(() => {
          throw new Error('FICUS_SANDBOX_RUNTIME=docker-sysbox requested but the sysbox runtime is not installed')
        })
      ).not.toThrow()
      const logged = errorSpy.mock.calls.some(
        (call) =>
          call.some((arg) => typeof arg === 'string' && arg.includes('Sandbox setup validation failed')) &&
          call.some((arg) => arg instanceof Error && arg.message.includes('sysbox runtime is not installed'))
      )
      expect(logged).toBe(true)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('is silent when validation passes', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      runSandboxSetupValidation(() => {})
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})

// FICUS_SANDBOX_RUNTIME is mandatory and explicit. These BOOT THE REAL ENTRYPOINT
// in a child process — the only way to prove the contract end to end, since the
// `import.meta.main` block cannot be driven from a unit test. A junk DATABASE_URL
// and an unused port make the run safe: the guard fires before either is used.
describe('api requires an explicit FICUS_SANDBOX_RUNTIME at boot', () => {
  const RUNTIME_LIST = 'FICUS_SANDBOX_RUNTIME must be one of docker-sysbox, docker-socket, k8s, vm, host'

  async function bootApi(runtime: string | null): Promise<{ exitCode: number; stderr: string }> {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      // Unreachable (port 1) but named tau_test, because the child inherits
      // FICUS_TEST_MODE=1 from this suite and db/index.ts refuses to load in test
      // mode against any other database name.
      DATABASE_URL: 'postgres://x:x@127.0.0.1:1/tau_test',
      PORT: '39901',
      HOST: '127.0.0.1',
    }
    if (runtime === null) delete env.FICUS_SANDBOX_RUNTIME
    else env.FICUS_SANDBOX_RUNTIME = runtime
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'index.ts')], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => proc.kill('SIGKILL'), 15_000)
    try {
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
      return { exitCode, stderr }
    } finally {
      clearTimeout(timer)
    }
  }

  it('exits 1 with the five-value message on an unknown runtime', async () => {
    const { exitCode, stderr } = await bootApi('bogus')
    expect(stderr).toContain(RUNTIME_LIST)
    expect(stderr).toContain('(got "bogus")')
    expect(exitCode).toBe(1)
  }, 20_000)

  it('exits 1 saying the runtime is unset when the variable is absent', async () => {
    const { exitCode, stderr } = await bootApi(null)
    expect(stderr).toContain(RUNTIME_LIST)
    expect(stderr).toContain('(is unset)')
    expect(exitCode).toBe(1)
  }, 20_000)

  // The failure must come from the boot guard, not from a module resolving the
  // sandbox manager while it is being imported: a module-evaluation throw
  // prints a stack trace attributed to whichever module touched the factory
  // first, and it happens BEFORE the guard can say anything actionable.
  it('reports the guard, not a module-evaluation stack trace', async () => {
    const { stderr } = await bootApi('bogus')
    expect(stderr).toContain(RUNTIME_LIST)
    expect(stderr).not.toContain('loadAndEvaluateModule')
    expect(stderr).not.toContain('services/integrations/runtime.ts')
  }, 20_000)

  // The one source-level contract a process test cannot show: the guard has to
  // run BEFORE runSandboxSetupValidation, whose failure is deliberately
  // non-fatal so a missing sandbox IMAGE does not stop the api.
  it('checks the runtime before the non-fatal sandbox-setup validation', () => {
    const indexSrc = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8')
    const boot = indexSrc.slice(indexSrc.indexOf('if (import.meta.main) {'))
    expect(boot.indexOf('requireSandboxRuntime()')).toBeGreaterThan(-1)
    expect(boot.indexOf('runSandboxSetupValidation()')).toBeGreaterThan(-1)
    expect(boot.indexOf('requireSandboxRuntime()')).toBeLessThan(boot.indexOf('runSandboxSetupValidation()'))
  })
})
