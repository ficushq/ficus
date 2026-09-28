import { useEnabledIntegrationFixtures } from '../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('github')
const githubFixtures: Awaited<ReturnType<typeof createTestGitHubConnection>>[] = []
afterEach(async () => {
  for (const fixture of githubFixtures.splice(0)) await fixture.dispose()
})
import { createTestGitHubConnection } from '../test-utils/github-connection'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { Hono } from 'hono'
import onboardingRouter from './onboarding'
import { app as realApp } from '../index'
import { identityMiddleware } from '../middleware/identity'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from '../test-utils'
import { getSecretStore, resetSecretStore } from '../services/secrets'
import { getSettingsStore, resetSettingsStore } from '../services/settings'
import { EXE_PROVIDER_SSH_KEY } from '../services/machines/provider-credentials'
import * as onboardingEvents from '../services/onboarding/events'

const prefix = `onboarding-route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

describe('onboarding routes', () => {
  let admin: TestUser
  let unprivileged: TestUser
  let priorEncryptionKey: string | undefined
  let priorGitHubToken: string | undefined

  const app = new Hono()
  app.use('*', identityMiddleware)
  app.route('/onboarding', onboardingRouter)

  function req(method = 'GET', body?: unknown, token = admin.token) {
    return {
      method,
      headers: { ...authHeaders(token), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }
  }

  beforeAll(async () => {
    admin = await createTestAdmin({ prefix })
    unprivileged = await createTestUser({ prefix })

    priorEncryptionKey = process.env.FICUS_ENCRYPTION_KEY
    process.env.FICUS_ENCRYPTION_KEY = priorEncryptionKey ?? '0'.repeat(64)
    priorGitHubToken = process.env.GITHUB_TOKEN
    delete process.env.GITHUB_TOKEN
    resetSecretStore()
    await getSecretStore().initialize()
    resetSettingsStore()
    await getSettingsStore().initialize()
  })

  afterAll(async () => {
    try {
      await cleanupTestRbac(prefix)
    } finally {
      if (priorEncryptionKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
      else process.env.FICUS_ENCRYPTION_KEY = priorEncryptionKey
      if (priorGitHubToken === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = priorGitHubToken
      resetSecretStore()
      resetSettingsStore()
    }
  })

  afterEach(async () => {
    await getSecretStore().delete('GITHUB_TOKEN')
    await getSecretStore().delete(EXE_PROVIDER_SSH_KEY)
    await getSettingsStore().set('onboarding.skips', JSON.stringify([]), 'test-cleanup')
  })

  it('rejects unauthenticated and unprivileged access to the status endpoint', async () => {
    expect((await app.request('/onboarding/status')).status).toBe(401)
    expect((await app.request('/onboarding/status', req('GET', undefined, unprivileged.token))).status).toBe(403)
  })

  it('rejects unauthenticated and unprivileged access to the skip/unskip endpoints', async () => {
    expect((await app.request('/onboarding/items/github/skip', { method: 'POST' })).status).toBe(401)
    expect(
      (await app.request('/onboarding/items/github/skip', req('POST', undefined, unprivileged.token))).status
    ).toBe(403)
    expect((await app.request('/onboarding/items/github/unskip', { method: 'POST' })).status).toBe(401)
    expect(
      (await app.request('/onboarding/items/github/unskip', req('POST', undefined, unprivileged.token))).status
    ).toBe(403)
  })

  it('returns the full status shape for an admin', async () => {
    const res = await app.request('/onboarding/status', req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.ready).toBe('boolean')
    expect(Array.isArray(body.items)).toBe(true)
    expect(body.items).toHaveLength(3)
    expect(body.items.map((i: { id: string }) => i.id).sort()).toEqual(['ai_provider', 'first_squad', 'github'].sort())
    for (const item of body.items) {
      expect(['todo', 'done', 'skipped']).toContain(item.state)
      expect(typeof item.required).toBe('boolean')
    }
    // Never leaks secret material.
    expect(JSON.stringify(body)).not.toMatch(/ghp_|xoxb-|sk-/)
  })

  // Regression: there is no `exe_key` onboarding item at all — ORCHESTRATOR
  // DECISION on do-machine-mode-part2 Task 7 review. It was never part of the
  // shipped six-item checklist; the three legacy exe tenants are being
  // decommissioned rather than migrated; and the recovery case (machine
  // exists, key missing) is already served by the Secrets & Keys page
  // keeping the exe row visible (SecretsSection's `exeBacked` flag).
  // Exercised in both directions of the exe.dev key so re-wiring a signal
  // back into getLiveSignals regresses loudly here, not silently in the UI.
  it('never emits exe_key when this instance is not exe-backed (the do_droplet default)', async () => {
    const res = await app.request('/onboarding/status', req())
    const body = await res.json()
    expect(body.items).toHaveLength(3)
    expect(body.items.map((i: { id: string }) => i.id)).not.toContain('exe_key')
  })

  it('never emits exe_key even when the exe.dev account key IS configured', async () => {
    await getSecretStore().set(EXE_PROVIDER_SSH_KEY, 'a-private-key-body', 'test')

    const res = await app.request('/onboarding/status', req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(3)
    expect(body.items.map((i: { id: string }) => i.id)).not.toContain('exe_key')
    // Never leaks the key itself.
    expect(JSON.stringify(body)).not.toContain('a-private-key-body')
  })

  it('skip/unskip round-trips for an optional item', async () => {
    await getSecretStore().delete('GITHUB_TOKEN')

    const skipRes = await app.request('/onboarding/items/github/skip', req('POST'))
    expect(skipRes.status).toBe(200)
    const skipBody = await skipRes.json()
    expect(skipBody.items.find((i: { id: string }) => i.id === 'github')?.state).toBe('skipped')

    const unskipRes = await app.request('/onboarding/items/github/unskip', req('POST'))
    expect(unskipRes.status).toBe(200)
    const unskipBody = await unskipRes.json()
    expect(unskipBody.items.find((i: { id: string }) => i.id === 'github')?.state).toBe('todo')
  })

  it('rejects skipping a required item with 400', async () => {
    const res = await app.request('/onboarding/items/ai_provider/skip', req('POST'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/required/i)

    const res2 = await app.request('/onboarding/items/first_squad/skip', req('POST'))
    expect(res2.status).toBe(400)
  })

  it('notifies onboarding on both skip and unskip', async () => {
    await getSecretStore().delete('GITHUB_TOKEN')
    const spy = spyOn(onboardingEvents, 'notifyOnboardingChanged')
    try {
      const skipRes = await app.request('/onboarding/items/github/skip', req('POST'))
      expect(skipRes.status).toBe(200)
      expect(spy).toHaveBeenCalledTimes(1)

      const unskipRes = await app.request('/onboarding/items/github/unskip', req('POST'))
      expect(unskipRes.status).toBe(200)
      expect(spy).toHaveBeenCalledTimes(2)
    } finally {
      spy.mockRestore()
    }
  })

  it('does not expose skip actions for optional setup tools', async () => {
    for (const id of ['voice_memory', 'invite_users', 'chat_channel', 'remote_hosts']) {
      expect((await app.request(`/onboarding/items/${id}/skip`, req('POST'))).status).toBe(400)
    }
  })

  it('rejects an unknown item id with 400', async () => {
    const res = await app.request('/onboarding/items/not_a_real_item/skip', req('POST'))
    expect(res.status).toBe(400)
  })

  it('skipping an already-done optional item is a 200 no-op — it still reads done', async () => {
    githubFixtures.push(await createTestGitHubConnection())

    const res = await app.request('/onboarding/items/github/skip', req('POST'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items.find((i: { id: string }) => i.id === 'github')?.state).toBe('done')
  })

  // "This repo has already shipped a router that typechecked and passed its
  // own tests while being registered nowhere" — so exercise the ACTUAL
  // exported app (apps/core/src/index.ts), not a locally re-mounted copy.
  describe('mounted on the real app', () => {
    it('GET /api/onboarding/status is reachable (not 404) and admin-gated on the real app', async () => {
      const unauth = await realApp.request('/api/onboarding/status')
      expect(unauth.status).not.toBe(404)
      expect(unauth.status).toBe(401)

      const forbidden = await realApp.request('/api/onboarding/status', {
        headers: authHeaders(unprivileged.token),
      })
      expect(forbidden.status).toBe(403)

      const ok = await realApp.request('/api/onboarding/status', { headers: authHeaders(admin.token) })
      expect(ok.status).toBe(200)
      const body = await ok.json()
      expect(Array.isArray(body.items)).toBe(true)
    })

    it('POST /api/onboarding/items/:id/skip is reachable on the real app', async () => {
      await getSecretStore().delete('GITHUB_TOKEN')
      const res = await realApp.request('/api/onboarding/items/github/skip', {
        method: 'POST',
        headers: authHeaders(admin.token),
      })
      expect(res.status).not.toBe(404)
      expect(res.status).toBe(200)
    })
  })
})
