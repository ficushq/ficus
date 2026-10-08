import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import { CSRF_HEADER } from '@ficus/shared/http-headers'
import { db } from '../db'
import { integrationAuditEvents, users } from '../db/schema'
import { authzSentinel } from '../middleware/authz-sentinel'
import { csrfProtection } from '../middleware/csrf'
import { SESSION_COOKIE_NAME } from '../services/auth/session-cookie'
import { hasPermission, type Identity } from '../services/rbac'
import * as personal from '../services/integrations/github/personal-identity'

const routes = await import('./github-identity').catch(() => null)

async function fixture() {
  expect(routes?.createGitHubIdentityRouter).toBeDefined()
  const userId = crypto.randomUUID(),
    otherUserId = crypto.randomUUID()
  await db.insert(users).values([userId, otherUserId].map((id) => ({ id, email: `${id}@identity-route.test` })))
  const human = { type: 'user' as const, userId }
  let starts = 0,
    polls = 0,
    cancels = 0
  const service = {
    get: async (identity: Identity | undefined) => ({
      linked: await personal.getGitHubPersonalIdentity(identity),
      confirmation: await personal.getPendingGitHubIdentityProof(identity),
      authorization: { configured: true, authority: 'local' as const, mode: 'browser' as const },
    }),
    start: async (identity: Identity | undefined, returnTo: string) => {
      starts++
      await personal.beginGitHubIdentityLink(identity)
      expect(returnTo).toBe('/settings')
      return { authorizationUrl: 'https://github.com/login/oauth/authorize?state=opaque' }
    },
    poll: async (_identity: Identity | undefined, _id: string) => {
      polls++
      return { status: 'pending' as const, retryAfterSeconds: 5 }
    },
    cancel: async (_identity: Identity | undefined, _id: string) => {
      cancels++
    },
    confirm: personal.confirmGitHubIdentityProof,
    unlink: personal.unlinkGitHubIdentity,
  }
  const appFor = (identity?: Identity) => {
    const app = new Hono()
    app.use('*', async (c, next) => {
      if (identity) c.set('identity', identity)
      await next()
    })
    app.use('/api/*', csrfProtection, authzSentinel)
    app.route('/api/github-identity', routes!.createGitHubIdentityRouter(service))
    return app
  }
  return {
    userId,
    otherUserId,
    human,
    appFor,
    service,
    counters: () => ({ starts, polls, cancels }),
    async proof() {
      const generation = await personal.beginGitHubIdentityLink(human)
      return personal.saveGitHubIdentityProof({
        identity: human,
        profile: { id: 101, login: 'alice', type: 'User' },
        state: {
          stateHash: new Bun.CryptoHasher('sha256').update(crypto.randomUUID()).digest('hex'),
          localFlowId: crypto.randomUUID(),
          authority: 'local',
          completionHandleHash: null,
          recoveryExpiresAt: null,
          providerKey: 'github',
          purpose: 'github_identity',
          linkGeneration: generation,
          userId,
          intent: 'connect',
          connectionId: null,
          expectedMaterialRevision: null,
          redirectUri: 'https://ficus.test/callback',
          returnTo: '/settings',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      })
    },
    async close() {
      await db.delete(integrationAuditEvents).where(inArray(integrationAuditEvents.userId, [userId, otherUserId]))
      await db.delete(users).where(inArray(users.id, [userId, otherUserId]))
    },
  }
}
const json = (value: unknown = {}) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })

test('ordinary enabled humans can inspect/start personal linking without integration administration', async () => {
  const h = await fixture()
  try {
    expect(await hasPermission(h.human, 'integrations:write:github')).toBe(false)
    const app = h.appFor(h.human)
    const status = await app.request('/api/github-identity')
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({ linked: null, confirmation: null })
    expect(status.headers.get('cache-control')).toBe('no-store')
    const started = await app.request('/api/github-identity/authorization/start', {
      method: 'POST',
      ...json({ returnTo: '/settings' }),
    })
    expect(started.status).toBe(200)
    expect(h.counters()).toEqual({ starts: 1, polls: 0, cancels: 0 })
  } finally {
    await h.close()
  }
})

test('agents/delegated/system/legacy/missing/disabled identities cannot access or mutate personal flow state', async () => {
  const h = await fixture()
  try {
    const proofId = crypto.randomUUID(),
      flowId = crypto.randomUUID()
    const identities: Array<Identity | undefined> = [
      { type: 'agent', agentId: crypto.randomUUID(), squadId: crypto.randomUUID(), userId: h.userId },
      { type: 'system', systemTokenId: crypto.randomUUID(), name: 'admin', scopes: ['*'] },
      { type: 'legacy' },
      undefined,
    ]
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, h.otherUserId))
    identities.push({ type: 'user', userId: h.otherUserId })
    for (const identity of identities) {
      const app = h.appFor(identity)
      for (const [path, method, body] of [
        ['', 'GET', undefined],
        ['/authorization/start', 'POST', { returnTo: '/settings' }],
        [`/authorization/device/${flowId}/poll`, 'POST', {}],
        [`/authorization/device/${flowId}/cancel`, 'POST', {}],
        [`/${proofId}/confirm`, 'POST', {}],
        ['', 'DELETE', undefined],
      ] as const) {
        const response = await app.request(`/api/github-identity${path}`, {
          method,
          ...(body === undefined ? {} : json(body)),
        })
        expect(response.status).toBe(403)
      }
    }
    expect(h.counters()).toEqual({ starts: 0, polls: 0, cancels: 0 })
  } finally {
    await h.close()
  }
})

test('pending proof visibility is self-only and confirmations accept no caller-supplied profile', async () => {
  const h = await fixture()
  try {
    const proof = await h.proof()
    const app = h.appFor(h.human)
    const status = await app.request('/api/github-identity')
    expect((await status.json()).confirmation).toMatchObject({ id: proof.id, accountId: '101', login: 'alice' })
    const other = h.appFor({ type: 'user', userId: h.otherUserId })
    expect((await (await other.request('/api/github-identity')).json()).confirmation).toBeNull()
    expect(
      (await other.request(`/api/github-identity/${proof.id}/confirm`, { method: 'POST', ...json() })).status
    ).toBe(409)
    expect(
      (
        await app.request(`/api/github-identity/${proof.id}/confirm`, {
          method: 'POST',
          ...json({ accountId: '999', login: 'forged', userId: h.otherUserId }),
        })
      ).status
    ).toBe(400)
    expect(await personal.getGitHubPersonalIdentity(h.human)).toBeNull()
    expect((await app.request(`/api/github-identity/${proof.id}/confirm`, { method: 'POST', ...json() })).status).toBe(
      200
    )
    expect(await personal.getGitHubPersonalIdentity(h.human)).toMatchObject({ accountId: '101', login: 'alice' })
  } finally {
    await h.close()
  }
})

test('unlink fences old confirmation and removes it from the pending view', async () => {
  const h = await fixture()
  try {
    const proof = await h.proof(),
      app = h.appFor(h.human)
    expect((await app.request('/api/github-identity', { method: 'DELETE' })).status).toBe(200)
    expect((await app.request(`/api/github-identity/${proof.id}/confirm`, { method: 'POST', ...json() })).status).toBe(
      409
    )
    expect((await (await app.request('/api/github-identity')).json()).confirmation).toBeNull()
    expect(await personal.getGitHubPersonalIdentity(h.human)).toBeNull()
  } finally {
    await h.close()
  }
})

test('personal mutations retain cookie CSRF protection and reject start authority overrides', async () => {
  const h = await fixture()
  try {
    const app = h.appFor(h.human)
    const request = json({ returnTo: '/settings' })
    expect(
      (
        await app.request('/api/github-identity/authorization/start', {
          method: 'POST',
          ...request,
          headers: { ...request.headers, cookie: `${SESSION_COOKIE_NAME}=session` },
        })
      ).status
    ).toBe(403)
    expect(
      (
        await app.request('/api/github-identity/authorization/start', {
          method: 'POST',
          ...json({ returnTo: '/settings', purpose: 'integration', userId: h.otherUserId, linkGeneration: 99 }),
        })
      ).status
    ).toBe(400)
    expect(h.counters().starts).toBe(0)
    const allowed = await app.request('/api/github-identity/authorization/start', {
      method: 'POST',
      ...request,
      headers: { ...request.headers, cookie: `${SESSION_COOKIE_NAME}=session`, [CSRF_HEADER]: '1' },
    })
    expect(allowed.status).toBe(200)
  } finally {
    await h.close()
  }
})

test('personal authorization failures expose safe retry metadata, not provider/token error text', async () => {
  const { GitHubOAuthError } = await import('@ficus/shared/oauth-providers/github/client')
  const h = await fixture()
  try {
    const app = h.appFor(h.human)
    h.service.start = async () => {
      throw new GitHubOAuthError('rate_limited', 429, 7)
    }
    const transient = await app.request('/api/github-identity/authorization/start', {
      method: 'POST',
      ...json({ returnTo: '/settings' }),
    })
    expect(transient.status).toBe(429)
    expect(transient.headers.get('retry-after')).toBe('7')
    h.service.start = async () => {
      const error = new GitHubOAuthError('invalid_response', 502)
      error.message = 'opaque-token-should-never-appear'
      throw error
    }
    const unknown = await app.request('/api/github-identity/authorization/start', {
      method: 'POST',
      ...json({ returnTo: '/settings' }),
    })
    expect(unknown.status).toBe(502)
    expect(await unknown.text()).not.toContain('opaque-token-should-never-appear')
  } finally {
    await h.close()
  }
})
