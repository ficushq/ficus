import { useEnabledIntegrationFixtures } from '../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('github')
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { Hono } from 'hono'
import { identityMiddleware } from '../middleware/identity'
import * as connections from '../services/integrations/github/resolve-connection'
import * as derivation from '../services/public-voice/derive'
import { derivationOwners } from '../services/public-voice/operation'
import { publicVoicesRoutes } from './public-voices'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'

const selectedId = 'a1111111-1111-4111-8111-111111111111'
const differentId = 'b2222222-2222-4222-8222-222222222222'
const prefix = `connection-voice-${Date.now()}`
const app = new Hono().use('*', identityMiddleware).route('/api/public-voices', publicVoicesRoutes)
let admin: TestUser
const restricted: TestUser[] = []
const spies: Array<{ mockRestore(): void }> = []
beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
  for (const permissions of [['agent-types:update'], ['integrations:use']]) {
    const user = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })
    restricted.push(user)
  }
})
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  derivationOwners.clear()
})
afterAll(() => cleanupTestRbac(prefix))
function request(user = admin, connectionId = selectedId, accept = 'application/json', extra = {}) {
  return app.request('/api/public-voices/derive', {
    method: 'POST',
    headers: { ...authHeaders(user.token), 'content-type': 'application/json', accept },
    body: JSON.stringify({ connectionId, login: 'octocat', ...extra }),
  })
}
function usable() {
  spies.push(
    spyOn(connections, 'resolveInstanceGitHubConnection').mockResolvedValue({
      credential: { accessToken: 'fixture-selected-token' },
    } as any)
  )
}
test('requires both instance permissions and rejects invalid or extra fields', async () => {
  for (const user of restricted) expect((await request(user)).status).toBe(403)
  expect((await request(admin, selectedId, 'application/json', { login: '-bad' })).status).toBe(400)
  expect((await request(admin, selectedId, 'application/json', { squadId: 'other' })).status).toBe(400)
  expect((await request(admin, '')).status).toBe(400)
})
test('unknown and malformed selected connections return a specific 4xx, never a fallback', async () => {
  spies.push(spyOn(connections, 'resolveInstanceGitHubConnection').mockResolvedValue(undefined))
  for (const id of [crypto.randomUUID(), 'not-a-connection-id']) {
    const response = await request(admin, id)
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'github_connection_unavailable' })
  }
})
test('JSON passes the connection target with person attribution and no squad', async () => {
  usable()
  const calls: derivation.DerivePublicVoiceInput[] = []
  const result = { login: 'octocat', draft: { base: 'Keep complete sentences.', surfaces: {} } }
  spies.push(
    spyOn(derivation, 'derivePublicVoice').mockImplementation(async (input) => {
      calls.push(input)
      return result as any
    })
  )
  expect(await (await request()).json()).toEqual(result)
  // The stream validates the full fixture, supplied by the shared derivation tests below.
  expect(calls[0]).toMatchObject({ source: { kind: 'connection', connectionId: selectedId }, userId: admin.id })
  expect(calls[0]!.squadId).toBeUndefined()
})
test('locks by connection, not by person, and releases after completion', async () => {
  usable()
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  let callCount = 0
  let bothStarted!: () => void
  const entered = new Promise<void>((resolve) => {
    bothStarted = resolve
  })
  spies.push(
    spyOn(derivation, 'derivePublicVoice').mockImplementation(async () => {
      if (++callCount === 2) bothStarted()
      await waiting
      return {} as any
    })
  )
  const first = request()
  try {
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await request()).status).toBe(429)
    expect((await request(admin, selectedId.toUpperCase())).status).toBe(429)
    const second = request(admin, differentId)
    await entered
    expect(derivationOwners.size).toBe(2)
    release()
    expect((await second).status).toBe(200)
    expect((await first).status).toBe(200)
    expect(derivationOwners.size).toBe(0)
  } finally {
    release()
    await first
  }
})

test('agent, automation and bootstrap identities cannot derive even with full instance permissions', async () => {
  const { hasPermission } = await import('../services/rbac')
  const { db, agents } = await import('../db')
  const { eq } = await import('drizzle-orm')
  const agentId = crypto.randomUUID()
  await db.insert(agents).values({ id: agentId, agentTypeId: 'system-manager', ownerUserId: admin.id, status: 'idle' })
  const identities = [
    { type: 'agent', agentId, squadId: null, userId: admin.id },
    { type: 'system', systemTokenId: 'fixture', name: 'Service', scopes: ['*'] },
    { type: 'legacy' },
  ] as const
  // Authorization is independent of authentication: inject the resolved identity, using real permission checks.
  try {
    for (const identity of identities) {
      const scoped = new Hono()
        .use('*', async (c, next) => {
          c.set('identity', identity as any)
          await next()
        })
        .route('/api/public-voices', publicVoicesRoutes)
      expect(await hasPermission(identity as any, 'agent-types:update')).toBe(true)
      expect(await hasPermission(identity as any, 'integrations:use')).toBe(true)
      const res = await scoped.request('/api/public-voices/derive', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId: selectedId, login: 'octo' }),
      })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'derivation_requires_person' })
      const listing = await scoped.request('/api/public-voices/github-accounts')
      expect(listing.status).toBe(403)
      expect(await listing.json()).toEqual({ error: 'derivation_requires_person' })
    }
  } finally {
    await db.delete(agents).where(eq(agents.id, agentId))
  }
})

test('real selected connection is revalidated and never replaced by a squad default', async () => {
  // The provider fixture is registered at module scope below; only encrypted synthetic accounts are used.
  const { createTestGitHubConnection } = await import('../test-utils/github-connection')
  const { db, squads, integrationConnections } = await import('../db')
  const { eq } = await import('drizzle-orm')
  const { collectGitHubActivity } = await import('../services/public-voice/github-activity')
  const squadId = crypto.randomUUID()
  await db.insert(squads).values({ id: squadId, name: prefix, purpose: 'selected token proof' })
  const defaultAccount = await createTestGitHubConnection({ squadId, login: 'squad-default' })
  const selected = await createTestGitHubConnection({ login: 'selected-account' })
  const person = await createTestUser({ prefix })
  const role = await createTestRole({ prefix, permissions: ['agent-types:update', 'integrations:use'] })
  await assignRole({ userId: person.id, roleId: role.id, scope: 'system' })
  const realDerive = derivation.derivePublicVoice
  const attribution: unknown[] = []
  const authorization: Array<string | null> = []
  spies.push(
    spyOn(derivation, 'derivePublicVoice').mockImplementation((input) =>
      realDerive(input, {
        collect: (args) => collectGitHubActivity(args),
        session: async (args) => {
          attribution.push(args.attribution)
          return JSON.stringify({ base: 'Lead with the result.', observations: ['Use complete sentences.'] })
        },
      })
    )
  )
  spies.push(
    spyOn(globalThis, 'fetch').mockImplementation((async (_, init) => {
      authorization.push(new Headers(init?.headers).get('authorization'))
      return Response.json({
        data: {
          user: {
            id: 'user-node',
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: Array.from({ length: 20 }, (_, i) => ({
                title: `Synthetic improvement ${i}`,
                body: `This synthetic candidate ${i} explains the fix in complete sentences.`,
                repository: { nameWithOwner: 'example/library', isPrivate: true },
                createdAt: '2026-01-01T00:00:00Z',
              })),
            },
            issueComments: null,
            contributionsCollection: null,
          },
        },
      })
    }) as typeof fetch)
  )
  try {
    const before = await db.select().from(squads).where(eq(squads.id, squadId))
    for (const accept of ['application/json', 'text/event-stream']) {
      const res = await request(person, selected.id, accept, {
        filters: { surfaces: ['pull-requests'], before: '2026-09-01' },
      })
      expect(res.status).toBe(200)
      if (accept === 'application/json') expect((await res.json()).draft.base).toContain('Lead with the result.')
      else {
        expect(res.headers.get('cache-control')).toBe('no-store, no-transform')
        const events = (await res.text())
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => JSON.parse(line.slice(6)))
        expect(events[0].type).toBe('started')
        expect(events.at(-1).type).toBe('complete')
        expect(events.some((e) => e.type === 'counts')).toBe(true)
        expect(JSON.stringify(events)).not.toContain('This synthetic candidate')
      }
    }
    expect(authorization).toEqual([`Bearer test-access-${selected.id}`, `Bearer test-access-${selected.id}`])
    expect(attribution).toEqual([
      { userId: person.id, squadId: null },
      { userId: person.id, squadId: null },
    ])
    expect(await db.select().from(squads).where(eq(squads.id, squadId))).toEqual(before)
    for (const patch of [
      { enabled: false },
      { enabled: true, healthState: 'unreachable' as const },
      { healthState: 'healthy' as const, validationExpiresAt: new Date(0) },
    ]) {
      await db.update(integrationConnections).set(patch).where(eq(integrationConnections.id, selected.id))
      const res = await request(admin, selected.id)
      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ error: 'github_connection_unavailable' })
    }
    await db
      .update(integrationConnections)
      .set({ healthState: 'healthy', validationExpiresAt: new Date(Date.now() + 600_000) })
      .where(eq(integrationConnections.id, selected.id))
    const { getSecretStore } = await import('../services/secrets')
    const { serializeOAuthCredential } = await import('../services/integrations/authorization/credential-bundle')
    const credential = (await connections.resolveInstanceGitHubConnection(selected.id))!.credential
    await getSecretStore().set(
      selected.credentialRef,
      serializeOAuthCredential({ ...credential, expiresAt: new Date(0).toISOString() }),
      'test'
    )
    expect((await request(admin, selected.id)).status).toBe(422)
    expect((await request(admin, crypto.randomUUID())).status).toBe(422)
    expect(authorization.length).toBe(2)
  } finally {
    await selected.dispose()
    await defaultAccount.dispose()
    await db.delete(squads).where(eq(squads.id, squadId))
  }
})

test('instance cancellation releases the connection lock and never publishes a late draft', async () => {
  usable()
  let started!: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  let resolveWork!: (result: any) => void
  spies.push(
    spyOn(derivation, 'derivePublicVoice').mockImplementation(() => {
      started()
      return new Promise((resolve) => {
        resolveWork = resolve
      })
    })
  )
  const abort = new AbortController()
  const response = app.request('/api/public-voices/derive', {
    method: 'POST',
    headers: { ...authHeaders(admin.token), 'content-type': 'application/json' },
    signal: abort.signal,
    body: JSON.stringify({ connectionId: selectedId, login: 'octo' }),
  })
  await entered
  abort.abort()
  const res = await response
  expect(res.status).toBe(499)
  expect(derivationOwners.size).toBe(0)
  resolveWork({ draft: { base: 'Late draft must be ignored.' } })
  expect(await res.text()).toBe('')
})

test('instance derivation uses a 90-second deadline and sends a safe SSE timeout', async () => {
  usable()
  const operations = await import('../services/public-voice/operation')
  const realAcquire = operations.acquireDerivation
  const deadlines: unknown[] = []
  spies.push(
    spyOn(operations, 'acquireDerivation').mockImplementation((key, signal, deadline) => {
      deadlines.push(deadline)
      return realAcquire(key, signal, 10)
    })
  )
  spies.push(spyOn(derivation, 'derivePublicVoice').mockImplementation(() => new Promise(() => {})))
  const response = await request(admin, selectedId, 'text/event-stream')
  const text = await response.text()
  expect(deadlines).toEqual([90_000])
  expect(text).toContain('derivation_timed_out')
  expect(text).not.toContain('complete')
  expect(derivationOwners.size).toBe(0)
})

test('account selection needs only the two derive grants, not administrative integration read', async () => {
  const user = await createTestUser({ prefix })
  const role = await createTestRole({ prefix, permissions: ['agent-types:update', 'integrations:use'] })
  await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })
  const { hasPermission } = await import('../services/rbac')
  const identity = { type: 'user' as const, userId: user.id }
  expect(await hasPermission(identity, 'integrations:read:github')).toBe(false)
  const { createIntegrationsRouter } = await import('./integrations')
  const poolApp = new Hono()
    .use('*', identityMiddleware)
    .route('/api/integrations', createIntegrationsRouter({} as any))
  expect(
    (await poolApp.request('/api/integrations/connections?provider=github', { headers: authHeaders(user.token) }))
      .status
  ).toBe(403)
  for (const path of ['/api/public-voices', '/api/public-voices/default']) {
    expect((await app.request(path, { headers: authHeaders(user.token) })).status).toBe(403)
  }
  const { createTestGitHubConnection } = await import('../test-utils/github-connection')
  const fixture = await createTestGitHubConnection({ login: 'selected-account' })
  try {
    const res = await app.request('/api/public-voices/github-accounts', { headers: authHeaders(user.token) })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const accounts = await res.json()
    expect(accounts).toContainEqual({ id: fixture.id, login: 'selected-account' })
    expect(JSON.stringify(accounts)).not.toContain(fixture.credentialRef)
    expect(JSON.stringify(accounts)).not.toContain('test-access-')
    for (const account of accounts)
      expect(Object.keys(account).sort()).toEqual(
        account.displayName ? ['displayName', 'id', 'login'] : ['id', 'login']
      )
    spies.push(
      spyOn(derivation, 'derivePublicVoice').mockResolvedValue({
        login: 'selected-account',
        draft: { base: 'A synthetic draft.', surfaces: {} },
      } as any)
    )
    expect((await request(user, fixture.id)).status).toBe(200)
  } finally {
    await fixture.dispose()
  }
})

test('the safe account list denies each missing grant and all non-person callers', async () => {
  expect((await app.request('/api/public-voices/github-accounts')).status).toBe(401)
  for (const user of restricted) {
    expect((await app.request('/api/public-voices/github-accounts', { headers: authHeaders(user.token) })).status).toBe(
      403
    )
  }
  for (const identity of [
    { type: 'system', systemTokenId: crypto.randomUUID(), name: 'Service', scopes: ['*'] },
    { type: 'agent', agentId: crypto.randomUUID(), squadId: null },
    { type: 'legacy' },
  ]) {
    const deniedApp = new Hono()
      .use('*', async (c, next) => {
        c.set('identity', identity as any)
        await next()
      })
      .route('/api/public-voices', publicVoicesRoutes)
    expect((await deniedApp.request('/api/public-voices/github-accounts')).status).toBe(403)
  }
})

test('the safe list exposes only identity fields from usable current-authority accounts, without provider calls', async () => {
  const { createTestGitHubConnection } = await import('../test-utils/github-connection')
  const { db, integrationConnections } = await import('../db')
  const { eq } = await import('drizzle-orm')
  const fixture = await createTestGitHubConnection({ login: 'account-login' })
  const list = () => app.request('/api/public-voices/github-accounts', { headers: authHeaders(admin.token) })
  spies.push(
    spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('Account listing must never probe a provider')
    })
  )
  try {
    await db
      .update(integrationConnections)
      .set({ displayName: 'Personal account' })
      .where(eq(integrationConnections.id, fixture.id))
    expect(await (await list()).json()).toContainEqual({
      id: fixture.id,
      login: 'account-login',
      displayName: 'Personal account',
    })
    const original = (
      await db.select().from(integrationConnections).where(eq(integrationConnections.id, fixture.id))
    )[0]!
    for (const patch of [
      { providerKey: 'notion' },
      { enabled: false },
      { healthState: 'degraded' as const },
      { authState: 'invalid' as const },
      { validationExpiresAt: new Date(0) },
      { validatedRevision: crypto.randomUUID() },
      { adapterVersion: 99 },
      { clientAuthority: original.clientAuthority === 'local' ? ('platform_broker' as const) : ('local' as const) },
      { configuration: { version: 1, login: 'invalid-config' } },
    ]) {
      await db
        .update(integrationConnections)
        .set({ ...original, ...patch })
        .where(eq(integrationConnections.id, fixture.id))
      const response = await list()
      expect(response.status).toBe(200)
      expect((await response.json()).some((account: { id: string }) => account.id === fixture.id)).toBe(false)
    }
    await db.update(integrationConnections).set(original).where(eq(integrationConnections.id, fixture.id))
    const { serializeOAuthCredential } = await import('../services/integrations/authorization/credential-bundle')
    const { getSecretStore } = await import('../services/secrets')
    const credential = (await connections.resolveInstanceGitHubConnection(fixture.id))!.credential
    await getSecretStore().set(
      fixture.credentialRef,
      serializeOAuthCredential({ ...credential, expiresAt: new Date(0).toISOString() }),
      'test'
    )
    expect((await (await list()).json()).some((account: { id: string }) => account.id === fixture.id)).toBe(false)
    await getSecretStore().delete(fixture.credentialRef)
    expect((await (await list()).json()).some((account: { id: string }) => account.id === fixture.id)).toBe(false)
    const { setIntegrationEnabled } = await import('../services/integrations/provider-state')
    await setIntegrationEnabled('github', false, 'test')
    expect(await (await list()).json()).toEqual([])
  } finally {
    await fixture.dispose()
  }
})
