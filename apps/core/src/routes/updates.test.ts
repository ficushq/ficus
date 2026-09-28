import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import { createUpdatesRouter } from './updates'
import { UnsupportedDeploymentError, UpdateLockedError } from '../services/updates'
import { identityMiddleware } from '../middleware/identity'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from '../test-utils'

describe('updates routes', () => {
  const prefix = `b14-updates-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let admin: TestUser
  let unprivileged: TestUser

  beforeAll(async () => {
    admin = await createTestAdmin({ prefix, canonicalAdmin: true })
    unprivileged = await createTestUser({ prefix })
  })

  afterAll(async () => {
    await cleanupTestRbac(prefix)
  })

  function authedRouter(deps: Parameters<typeof createUpdatesRouter>[0] = {}) {
    const app = new Hono()
    app.use('*', identityMiddleware)
    app.route('/', createUpdatesRouter(deps))
    return app
  }

  function req(method = 'GET', body?: unknown, token = admin.token) {
    return {
      method,
      headers: { ...authHeaders(token), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }
  }

  it('denies unauthenticated and unprivileged update access', async () => {
    const router = authedRouter({ store: fakeStore(), updater: fakeUpdater() })
    expect((await router.request('/settings')).status).toBe(401)
    expect((await router.request('/status', req('GET', undefined, unprivileged.token))).status).toBe(403)
    expect((await router.request('/settings', req('PATCH', { enabled: true }, unprivileged.token))).status).toBe(403)
    expect((await router.request('/apply', req('POST', undefined, unprivileged.token))).status).toBe(403)
  })

  it('returns disabled automatic updates for missing settings', async () => {
    const router = authedRouter({
      store: {
        getTyped: () => undefined,
        set: async () => {},
      },
      updater: fakeUpdater(),
    })

    const res = await router.request('/settings', req())

    expect(res.status).toBe(200)
    expect((await res.json()).settings).toEqual({
      enabled: false,
      intervalMinutes: 30,
      remote: 'origin',
      branch: 'main',
    })
  })

  it('reports managed=true on a platform-managed instance and false otherwise', async () => {
    const router = authedRouter({ store: fakeStore(), updater: fakeUpdater() })
    const prior = process.env.FICUS_MANAGED
    try {
      process.env.FICUS_MANAGED = '1'
      expect((await (await router.request('/settings', req())).json()).managed).toBe(true)
      delete process.env.FICUS_MANAGED
      expect((await (await router.request('/settings', req())).json()).managed).toBe(false)
    } finally {
      if (prior === undefined) delete process.env.FICUS_MANAGED
      else process.env.FICUS_MANAGED = prior
    }
  })

  it('patches updater settings', async () => {
    const router = authedRouter({ store: fakeStore(), updater: fakeUpdater() })
    const res = await router.request('/settings', req('PATCH', { enabled: true, intervalMinutes: 60 }))
    expect(res.status).toBe(200)
    expect((await res.json()).settings.enabled).toBe(true)
  })

  it('delegates check apply and status', async () => {
    const router = authedRouter({ store: fakeStore(), updater: fakeUpdater() })
    expect((await router.request('/check', req('POST'))).status).toBe(200)
    expect((await router.request('/apply', req('POST'))).status).toBe(200)
    expect((await router.request('/status', req())).status).toBe(200)
  })

  it('returns a controlled conflict when check runs during an active update', async () => {
    const router = authedRouter({
      store: fakeStore(),
      updater: {
        ...fakeUpdater(),
        check: async () => {
          throw new UpdateLockedError()
        },
        status: () => ({ active: true, latest: { id: 'run-1', status: 'running' } }),
      },
    })

    const res = await router.request('/check', req('POST'))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'An update is already running',
      status: { active: true, latest: { id: 'run-1', status: 'running' } },
    })
  })

  it('starts apply in the background so API restarts do not break the response', async () => {
    const applyInBackground = mock(() => ({ id: 'run-1', status: 'running' }))
    const apply = mock(async () => ({ id: 'run-1', status: 'succeeded' }))
    const router = authedRouter({
      store: fakeStore(),
      updater: { ...fakeUpdater(), apply, applyInBackground },
    })

    const res = await router.request('/apply', req('POST'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'run-1', status: 'running' })
    expect(applyInBackground).toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it('returns a controlled conflict when apply targets an unsupported deployment flavor', async () => {
    const router = authedRouter({
      store: fakeStore(),
      updater: {
        ...fakeUpdater(),
        applyInBackground: () => {
          throw new UnsupportedDeploymentError(
            'Unknown process supervisor; set FICUS_UPDATE_SUPERVISOR=pm2 or =systemd'
          )
        },
      },
    })

    const res = await router.request('/apply', req('POST'))

    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('FICUS_UPDATE_SUPERVISOR')
  })

  it('apply-target accepts allowed targets and delegates to applyInBackground', async () => {
    const applyInBackground = mock(() => ({ id: 'run-2', status: 'running', selectedTasks: ['web'] }))
    const router = authedRouter({
      store: fakeStore(),
      updater: { ...fakeUpdater(), applyInBackground },
    })

    const res = await router.request('/apply-target', req('POST', { targets: ['web', 'core'] }))

    expect(res.status).toBe(200)
    expect(applyInBackground).toHaveBeenCalledWith(expect.objectContaining({ manual: true, tasks: ['web', 'core'] }))
  })

  it('apply-target rejects empty or invalid targets with 400', async () => {
    const router = authedRouter({ store: fakeStore(), updater: fakeUpdater() })
    const empty = await router.request('/apply-target', req('POST', { targets: [] }))
    expect(empty.status).toBe(400)
    const bad = await router.request('/apply-target', req('POST', { targets: ['install'] }))
    expect(bad.status).toBe(400)
    const wrong = await router.request('/apply-target', req('POST', { targets: 'web' }))
    expect(wrong.status).toBe(400)
  })

  it('apply-target returns 409 when another update is active', async () => {
    const router = authedRouter({
      store: fakeStore(),
      updater: {
        ...fakeUpdater(),
        applyInBackground: () => {
          throw new UpdateLockedError()
        },
        status: () => ({ active: true, latest: { id: 'run-1', status: 'running' } }),
      },
    })

    const res = await router.request('/apply-target', req('POST', { targets: ['web'] }))

    expect(res.status).toBe(409)
  })

  it('apply-target returns a controlled conflict for the sandbox target on unsupported runtimes', async () => {
    const router = authedRouter({
      store: fakeStore(),
      updater: {
        ...fakeUpdater(),
        applyInBackground: () => {
          throw new UnsupportedDeploymentError('Sandbox image rebuild is only automated for local k3d installs')
        },
      },
    })

    const res = await router.request('/apply-target', req('POST', { targets: ['sandbox'] }))

    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('Sandbox image rebuild is only automated for local k3d installs')
  })
})

function fakeStore() {
  const values = new Map<string, string>()
  return {
    getTyped: (k: string) =>
      values.get(k) ??
      (
        {
          LOCAL_AUTO_UPDATE_ENABLED: false,
          LOCAL_AUTO_UPDATE_INTERVAL_MINUTES: 30,
          LOCAL_AUTO_UPDATE_REMOTE: 'origin',
          LOCAL_AUTO_UPDATE_BRANCH: 'main',
        } as any
      )[k],
    set: async (k: string, v: string) => values.set(k, v),
  } as any
}
function fakeUpdater() {
  return {
    check: async () => ({ available: false }),
    apply: async () => ({ status: 'succeeded' }),
    applyInBackground: () => ({ status: 'running' }),
    status: () => ({ active: false, latest: null }),
  } as any
}
