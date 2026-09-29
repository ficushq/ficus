import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { agentExtraScopes, agents, db, roleAssignments, roles, squads, users } from '../db'
import { authzSentinel } from '../middleware/authz-sentinel'
import type { Identity } from '../services/rbac'
import { createIntegrationsRouter, createSquadIntegrationsRouter } from './integrations'
import type { SafeOAuthAppSettings } from '../services/integrations/authorization/client-credentials'
import { AuthorizationFlowError } from '../services/integrations/authorization/service'
import { GitHubOAuthError } from '@ficus/shared/oauth-providers/github/client'
import { GitHubSignRefused, GitHubSigningError } from '../services/integrations/github/commit-signing'

const summary = {
  id: '00000000-0000-4000-8000-000000000001',
  providerKey: 'bigbrain',
  displayName: 'Brain',
  enabled: true,
  healthState: 'healthy' as const,
}

function createApp(identity?: Identity, loadedProvider = 'bigbrain') {
  const catalog = mock(() => [
    {
      key: 'bigbrain',
      adapterVersion: 1,
      label: 'Bigbrain',
      description: 'Safe',
      icon: 'bigbrain',
      connectionMode: 'manual',
      assignable: true,
      requiredCapabilities: [],
    },
  ])
  const setEnabled = mock(async (_provider: string, enabled: boolean, _actor: string) => ({ enabled }))
  const list = mock(async () => [{ ...summary, configuration: { apiBase: 'secret' }, credentialRef: 'secret' }])
  const get = mock(async () => ({ ...summary, configuration: { version: 1 }, usage: { squadCount: 0, squads: [] } }))
  const create = mock(async () => get())
  const validate = mock(async () => get())
  const enable = mock(async () => get())
  const disable = mock(async () => {})
  const replaceCredential = mock(async () => get())
  const remove = mock(async () => {})
  const providerFor = mock(async () => loadedProvider)
  const githubRepositoryAccess = mock(async () => ({
    status: 'missing' as const,
    personalAccountInstalled: false,
    complete: true,
    installations: [],
  }))
  const oauthAppGet = mock(
    (_providerKey: string): SafeOAuthAppSettings => ({
      authority: 'local',
      configured: true,
      clientId: 'client-id',
      callbackUrl: 'https://ficus.example/settings/integrations/oauth/callback',
      requiredCapabilities: ['read_content', 'insert_content', 'update_content'],
    })
  )
  const channelGet = mock((_provider: string) => ({ fields: [] }))
  const channelConfigure = mock(async (_provider: string, _input: unknown, _actor: string) => ({ fields: [] }))
  const webhookGet = mock(() => ({ configured: true, webhookUrl: 'https://ficus.example/api/webhooks/github' }))
  const webhookConfigure = mock(async (_input: unknown, _actor: string) => webhookGet())
  const oauthAppConfigure = mock(async () => oauthAppGet('notion'))
  const authorizationStart = mock(async () => ({ authorizationUrl: 'https://provider.example/authorize' }))
  const authorizationCallback = mock(async () => ({ returnTo: '/settings/integrations' }))
  const authorizationComplete = mock(async () => ({ returnTo: '/settings/integrations' }))
  const authorizationPollDevice = mock(async () => ({ status: 'pending' as const, retryAfterSeconds: 5 }))
  const authorizationCancelDevice = mock(async () => {})
  const selection = mock(async () => ({ providerKey: 'bigbrain', assignment: summary, connections: [summary] }))
  const assign = mock(async () => summary)
  const unassign = mock(async () => true)
  const executionEnvironment = mock(async () => ({ GH_TOKEN: 'execution-only-token' }))
  const retryProjection = mock(async () => ({ status: 'pending' as const, lastErrorCode: null }))
  const githubCommitSigning = mock(async () => ({ state: 'off' as const }))
  const setGitHubCommitSigning = mock(async (_id: string, enabled: boolean, _actor: string) =>
    enabled ? { state: 'on' as const, fingerprint: 'SHA256:abc', registeredOnGitHub: true } : { state: 'off' as const }
  )
  const signGitObject = mock(
    async (_squadId: string, _agentId: string, _payload: Buffer) => '-----BEGIN SSH SIGNATURE-----\n'
  )
  const app = new Hono()
  if (identity) {
    app.use('/api/*', async (c, next) => {
      c.set('identity', identity)
      await next()
    })
  }
  app.use('/api/*', authzSentinel)
  app.route(
    '/api/integrations',
    createIntegrationsRouter({
      catalog,
      setEnabled,
      list,
      get,
      create,
      validate,
      enable,
      disable,
      replaceCredential,
      remove,
      providerFor,
      githubRepositoryAccess,
      githubCommitSigning,
      setGitHubCommitSigning,
      channelSettings: { get: channelGet, configure: channelConfigure },
      deploymentSettings: { get: channelGet, configure: channelConfigure },
      serviceSettings: { get: channelGet, configure: channelConfigure },
      githubWebhook: { get: webhookGet, configure: webhookConfigure },
      oauthApp: { get: oauthAppGet, configure: oauthAppConfigure },
      authorization: {
        start: authorizationStart,
        callback: authorizationCallback,
        complete: authorizationComplete,
        pollDevice: authorizationPollDevice,
        cancelDevice: authorizationCancelDevice,
      },
    } as any)
  )
  app.route(
    '/api/squads',
    createSquadIntegrationsRouter({ selection, assign, unassign, retryProjection, executionEnvironment, signGitObject })
  )
  return {
    app,
    calls: {
      catalog,
      setEnabled,
      list,
      get,
      create,
      validate,
      enable,
      disable,
      replaceCredential,
      remove,
      providerFor,
      githubRepositoryAccess,
      channelGet,
      channelConfigure,
      webhookGet,
      webhookConfigure,
      oauthAppGet,
      oauthAppConfigure,
      authorizationStart,
      authorizationCallback,
      authorizationComplete,
      authorizationPollDevice,
      authorizationCancelDevice,
      selection,
      assign,
      retryProjection,
      executionEnvironment,
      githubCommitSigning,
      setGitHubCommitSigning,
      signGitObject,
    },
  }
}

describe('integration routes', () => {
  test('repository access checks require GitHub read permission and the matching provider', async () => {
    for (const [scope, provider, expected] of [
      ['integrations:read:github', 'github', 200],
      ['integrations:read:notion', 'github', 403],
      ['integrations:read:github', 'notion', 404],
    ] as const) {
      const { app, calls } = createApp(
        { type: 'system', systemTokenId: 'check', name: 'check', scopes: [scope] },
        provider
      )
      const response = await app.request(`/api/integrations/connections/${summary.id}/github-repository-access`)
      expect(response.status).toBe(expected)
      expect(calls.githubRepositoryAccess).toHaveBeenCalledTimes(expected === 200 ? 1 : 0)
      if (expected === 200)
        expect(await response.json()).toEqual({
          status: 'missing',
          personalAccountInstalled: false,
          complete: true,
          installations: [],
        })
    }
  })
  // The squad guards resolve their route param, so these need a real squad: a placeholder shorter
  // than a full id is rejected before the scopes are ever consulted.
  let squadId: string

  beforeAll(async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `integrations-routes-${crypto.randomUUID()}`, purpose: 'route guard fixture' })
      .returning()
    squadId = squad.id
  })

  afterAll(async () => {
    if (squadId) await db.delete(squads).where(eq(squads.id, squadId))
  })

  test('execution credentials require use permission and never enter cacheable read responses', async () => {
    for (const scope of ['integrations:read', 'integrations:use']) {
      const { app, calls } = createApp({ type: 'system', systemTokenId: 'exec-test', name: 'test', scopes: [scope] })
      const response = await app.request(`/api/squads/${squadId}/integrations/github/execute-environment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: summary.id }),
      })
      if (scope === 'integrations:read') {
        expect(response.status).toBe(403)
        expect(calls.executionEnvironment).not.toHaveBeenCalled()
      } else {
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(calls.executionEnvironment).toHaveBeenCalledWith(squadId, 'github', summary.id)
        expect(await response.json()).toEqual({ environment: { GH_TOKEN: 'execution-only-token' } })
      }
    }
  })

  test('commit signing status needs GitHub read access and only exists for GitHub connections', async () => {
    for (const [scope, provider, expected] of [
      ['integrations:read:github', 'github', 200],
      ['integrations:read:notion', 'github', 403],
      ['integrations:read:github', 'notion', 404],
    ] as const) {
      const { app, calls } = createApp({ type: 'system', systemTokenId: 'sig', name: 'sig', scopes: [scope] }, provider)
      const response = await app.request(`/api/integrations/connections/${summary.id}/github-commit-signing`)
      expect(response.status).toBe(expected)
      expect(calls.githubCommitSigning).toHaveBeenCalledTimes(expected === 200 ? 1 : 0)
      if (expected === 200) {
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.json()).toEqual({ state: 'off' })
      }
    }
  })

  test('turning commit signing on or off takes a signed-in person with GitHub write access', async () => {
    const post = (app: Hono, body: unknown) =>
      app.request(`/api/integrations/connections/${summary.id}/github-commit-signing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    const system = createApp(
      { type: 'system', systemTokenId: 'sig', name: 'sig', scopes: ['integrations:write:github'] },
      'github'
    )
    const denied = await post(system.app, { enabled: true })
    expect(denied.status).toBe(403)
    expect(system.calls.setGitHubCommitSigning).not.toHaveBeenCalled()

    const readOnly = createApp(
      { type: 'system', systemTokenId: 'sig', name: 'sig', scopes: ['integrations:read:github'] },
      'github'
    )
    expect((await post(readOnly.app, { enabled: true })).status).toBe(403)
    expect(readOnly.calls.setGitHubCommitSigning).not.toHaveBeenCalled()
  })

  test('commit signing failures come back as actionable codes', async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `signing-${crypto.randomUUID()}@example.com` })
      .returning()
    const [role] = await db
      .insert(roles)
      .values({
        name: 'Signing writer',
        slug: `signing-${crypto.randomUUID()}`,
        permissions: ['integrations:write:github'],
      })
      .returning()
    await db
      .insert(roleAssignments)
      .values({ subjectType: 'user', subjectId: user.id, roleId: role.id, scope: 'system' })
    try {
      const { app, calls } = createApp({ type: 'user', userId: user.id }, 'github')
      const post = (body: unknown) =>
        app.request(`/api/integrations/connections/${summary.id}/github-commit-signing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      const on = await post({ enabled: true })
      expect(on.status).toBe(200)
      expect(await on.json()).toEqual({ state: 'on', fingerprint: 'SHA256:abc', registeredOnGitHub: true })
      expect(calls.setGitHubCommitSigning.mock.calls[0]?.slice(0, 2)).toEqual([summary.id, true])

      calls.setGitHubCommitSigning.mockImplementation(async () => {
        throw new GitHubSigningError('permission_missing', 'approve the updated permissions')
      })
      const missing = await post({ enabled: true })
      expect(missing.status).toBe(409)
      expect(await missing.json()).toEqual({ error: 'approve the updated permissions', code: 'permission_missing' })

      calls.setGitHubCommitSigning.mockImplementation(async () => {
        throw new GitHubSigningError('github_unavailable', 'GitHub could not be reached.')
      })
      expect((await post({ enabled: false })).status).toBe(502)
      expect((await post({ enabled: 'yes' })).status).toBe(400)
    } finally {
      await db.delete(roleAssignments).where(eq(roleAssignments.roleId, role.id))
      await db.delete(roles).where(eq(roles.id, role.id))
      await db.delete(users).where(eq(users.id, user.id))
    }
  })

  test("only the squad's agents can have commits signed, and refusals explain themselves", async () => {
    const payload = Buffer.from('tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n').toString('base64')
    const sign = (app: Hono) =>
      app.request(`/api/squads/${squadId}/integrations/github/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload }),
      })

    // A system token with the permission still is not an agent.
    const system = createApp({ type: 'system', systemTokenId: 'sig', name: 'sig', scopes: ['integrations:use'] })
    expect((await sign(system.app)).status).toBe(403)
    expect(system.calls.signGitObject).not.toHaveBeenCalled()
    const noUse = createApp({ type: 'system', systemTokenId: 'sig', name: 'sig', scopes: ['integrations:read'] })
    expect((await sign(noUse.app)).status).toBe(403)

    const [agent] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId }).returning()
    // The same grant squad agents rely on for `ficus integration exec github`.
    await db.insert(agentExtraScopes).values({ agentId: agent.id, permission: 'integrations:use' })
    try {
      const { app, calls } = createApp({ type: 'agent', agentId: agent.id, squadId })
      const signed = await sign(app)
      expect(signed.status).toBe(200)
      expect(signed.headers.get('cache-control')).toBe('no-store')
      expect(await signed.json()).toEqual({ signature: '-----BEGIN SSH SIGNATURE-----\n' })
      const [calledSquad, calledAgent, calledPayload] = calls.signGitObject.mock.calls[0]!
      expect([calledSquad, calledAgent, calledPayload.toString()]).toEqual([
        squadId,
        agent.id,
        'tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n',
      ])

      for (const [code, status] of [
        ['identity_mismatch', 403],
        ['invalid_payload', 400],
        ['signing_off', 409],
        ['not_configured', 409],
      ] as const) {
        calls.signGitObject.mockImplementation(async () => {
          throw new GitHubSignRefused(code, `refused: ${code}`)
        })
        const refused = await sign(app)
        expect(refused.status).toBe(status)
        expect(await refused.json()).toEqual({ error: `refused: ${code}`, code })
      }
    } finally {
      await db.delete(agents).where(eq(agents.id, agent.id))
    }
  })

  test('missing GitHub account reports actionable configuration guidance instead of forbidden', async () => {
    const { app, calls } = createApp({
      type: 'system',
      systemTokenId: 'exec-test',
      name: 'test',
      scopes: ['integrations:use'],
    })
    calls.executionEnvironment.mockImplementation(async () => null as never)
    const response = await app.request(`/api/squads/${squadId}/integrations/github/execute-environment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('No usable GitHub account is configured for this squad')
  })

  test('channel credentials require provider-specific integration access, not legacy secret or channel access', async () => {
    for (const scopes of [
      ['integrations:read:slack'],
      ['channels:read', 'secrets:read'],
      ['integrations:read:discord'],
    ]) {
      const { app, calls } = createApp({ type: 'system', systemTokenId: 'channel-read', name: 'test', scopes })
      const response = await app.request('/api/integrations/providers/slack/channel-settings')
      expect(response.status).toBe(scopes.includes('integrations:read:slack') ? 200 : 403)
      if (response.ok) {
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(calls.channelGet).toHaveBeenCalledWith('slack')
      } else expect(calls.channelGet).not.toHaveBeenCalled()
      const write = await app.request('/api/integrations/providers/slack/channel-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      expect(write.status).toBe(403)
      expect(calls.channelConfigure).not.toHaveBeenCalled()
    }
  })

  test('deployment credentials require provider-specific integration access, not legacy secret or channel access', async () => {
    for (const scopes of [
      ['integrations:read:vercel'],
      ['channels:read', 'secrets:read'],
      ['integrations:read:railway'],
    ]) {
      const { app, calls } = createApp({ type: 'system', systemTokenId: 'channel-read', name: 'test', scopes })
      const response = await app.request('/api/integrations/providers/vercel/deployment-settings')
      expect(response.status).toBe(scopes.includes('integrations:read:vercel') ? 200 : 403)
      if (response.ok) {
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(calls.channelGet).toHaveBeenCalledWith('vercel')
      } else expect(calls.channelGet).not.toHaveBeenCalled()
      const write = await app.request('/api/integrations/providers/vercel/deployment-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      expect(write.status).toBe(403)
      expect(calls.channelConfigure).not.toHaveBeenCalled()
    }
  })

  test('service credentials require provider-specific integration access, not legacy secret or channel access', async () => {
    for (const scopes of [
      ['integrations:read:google-cloud'],
      ['channels:read', 'secrets:read'],
      ['integrations:read:openai-services'],
    ]) {
      const { app, calls } = createApp({ type: 'system', systemTokenId: 'channel-read', name: 'test', scopes })
      const response = await app.request('/api/integrations/providers/google-cloud/service-settings')
      expect(response.status).toBe(scopes.includes('integrations:read:google-cloud') ? 200 : 403)
      if (response.ok) {
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(calls.channelGet).toHaveBeenCalledWith('google-cloud')
      } else expect(calls.channelGet).not.toHaveBeenCalled()
      const write = await app.request('/api/integrations/providers/google-cloud/service-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      expect(write.status).toBe(403)
      expect(calls.channelConfigure).not.toHaveBeenCalled()
    }
  })

  test('deny before invoking services without an identity', async () => {
    const { app, calls } = createApp()
    expect((await app.request('/api/integrations/connections?provider=bigbrain')).status).toBe(401)
    expect((await app.request(`/api/squads/${squadId}/integrations/bigbrain`)).status).toBe(401)
    expect(calls.list).not.toHaveBeenCalled()
    expect(calls.selection).not.toHaveBeenCalled()
  })

  test('webhook settings use integration permissions and never allow system-token writes', async () => {
    const path = '/api/integrations/providers/github/webhook'
    for (const scopes of [
      [],
      ['secrets:read', 'secrets:write'],
      ['integrations:read:notion'],
      ['integrations:read:github'],
      ['integrations:write:github'],
    ]) {
      const { app, calls } = createApp({ type: 'system', systemTokenId: 'webhook-settings', name: 'test', scopes })
      const response = await app.request(path)
      expect(response.status).toBe(scopes.includes('integrations:read:github') ? 200 : 403)
      const write = await app.request(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: 'candidate-secret' }),
      })
      expect(write.status).toBe(403)
      expect(calls.webhookConfigure).not.toHaveBeenCalled()
    }
    const { app, calls } = createApp()
    expect((await app.request(path)).status).toBe(401)
    expect(calls.webhookGet).not.toHaveBeenCalled()
  })

  test('integration writers can rotate webhook secrets without secret permissions; errors stay generic', async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `${crypto.randomUUID()}@example.com` })
      .returning()
    const [role] = await db
      .insert(roles)
      .values({
        name: 'Webhook writer',
        slug: `webhook-${crypto.randomUUID()}`,
        permissions: ['integrations:write:github'],
      })
      .returning()
    await db
      .insert(roleAssignments)
      .values({ subjectType: 'user', subjectId: user.id, roleId: role.id, scope: 'system' })
    try {
      const { app, calls } = createApp({ type: 'user', userId: user.id })
      const request = () =>
        app.request('/api/integrations/providers/github/webhook', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ secret: 'candidate-secret' }),
        })
      const response = await request()
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        configured: true,
        webhookUrl: 'https://ficus.example/api/webhooks/github',
      })
      expect(calls.webhookConfigure).toHaveBeenCalledWith({ secret: 'candidate-secret' }, `user:${user.id}`)
      calls.webhookConfigure.mockImplementation(async () => {
        throw new Error('candidate-secret')
      })
      const rejected = await request()
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toEqual({ error: 'Webhook configuration failed' })
    } finally {
      await db.delete(roleAssignments).where(eq(roleAssignments.roleId, role.id))
      await db.delete(roles).where(eq(roles.id, role.id))
      await db.delete(users).where(eq(users.id, user.id))
    }
  })

  test('OAuth app settings expose client ID and setup guidance but never the client secret', async () => {
    const { app } = createApp({
      type: 'system',
      systemTokenId: 'token-1',
      name: 'test',
      scopes: ['integrations:read:notion'],
    })
    const response = await app.request('/api/integrations/providers/notion/oauth-app')
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.authority).toBe('local')
    expect(body.clientId).toBe('client-id')
    expect(body.requiredCapabilities).toContain('read_content')
    expect(JSON.stringify(body)).not.toContain('client-secret')
  })

  test('OAuth app PUT retains self-hosted success and generic configuration failures', async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `${crypto.randomUUID()}@example.com` })
      .returning()
    const [role] = await db
      .insert(roles)
      .values({
        name: `OAuth app writer ${crypto.randomUUID()}`,
        slug: `oauth-app-writer-${crypto.randomUUID()}`,
        permissions: ['integrations:write'],
      })
      .returning()
    await db.insert(roleAssignments).values({
      subjectType: 'user',
      subjectId: user.id,
      roleId: role.id,
      scope: 'system',
    })
    try {
      const { app, calls } = createApp({ type: 'user', userId: user.id })
      const request = () =>
        app.request('/api/integrations/providers/notion/oauth-app', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientId: 'client-id',
            clientSecret: 'client-secret',
            capabilitiesAcknowledged: true,
          }),
        })

      const configured = await request()
      expect(configured.status).toBe(200)
      expect(await configured.json()).toMatchObject({ authority: 'local', configured: true })

      calls.oauthAppConfigure.mockRejectedValueOnce(new Error('must-not-cross-the-route'))
      const rejected = await request()
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toEqual({ error: 'OAuth application configuration failed' })

      calls.oauthAppGet.mockReturnValue({
        authority: 'platform_broker',
        configured: true,
        clientId: null,
        callbackUrl: 'https://ficus.example/settings/integrations/oauth/callback',
        requiredCapabilities: [],
      })
      const configureCalls = calls.oauthAppConfigure.mock.calls.length
      const hosted = await app.request('/api/integrations/providers/notion/oauth-app', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientSecret: 'must-not-be-parsed', capabilitiesAcknowledged: false }),
      })
      expect(hosted.status).toBe(400)
      expect(await hosted.json()).toEqual({ error: 'OAuth application configuration failed' })
      expect(calls.oauthAppConfigure).toHaveBeenCalledTimes(configureCalls)

      calls.oauthAppGet.mockImplementation((providerKey: string) => {
        if (providerKey === 'github') throw new Error('Unsupported OAuth application provider')
        return {
          authority: 'platform_broker',
          configured: true,
          clientId: null,
          callbackUrl: 'https://ficus.example/settings/integrations/oauth/callback',
          requiredCapabilities: [],
        }
      })
      const unsupported = await app.request('/api/integrations/providers/github/oauth-app', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(unsupported.status).toBe(400)
      expect(await unsupported.json()).toEqual({ error: 'OAuth application configuration failed' })
      expect(calls.oauthAppConfigure).toHaveBeenCalledTimes(configureCalls)
    } finally {
      await db.delete(roleAssignments).where(eq(roleAssignments.roleId, role.id))
      await db.delete(roles).where(eq(roles.id, role.id))
      await db.delete(users).where(eq(users.id, user.id))
    }
  })

  test('authorization routes require an initiating user even when a system token has provider write scope', async () => {
    const { app, calls } = createApp({
      type: 'system',
      systemTokenId: 'token-1',
      name: 'test',
      scopes: ['integrations:write:notion'],
    })
    const response = await app.request('/api/integrations/providers/notion/authorization/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ returnTo: '/settings/integrations' }),
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'Sign in with your Ficus account to connect Notion.',
      code: 'user_session_required',
    })
    expect(calls.authorizationStart).not.toHaveBeenCalled()
  })

  test('the bootstrap password session is told to finish admin setup before connecting an account', async () => {
    // No admin holds a passkey in this suite's database, so FICUS_PASSWORD is still a
    // live identity: it passes admin RBAC, but there is no person to connect for.
    const { app, calls } = createApp({ type: 'legacy' })
    const response = await app.request('/api/integrations/providers/github/authorization/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ returnTo: '/settings/integrations' }),
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'Finish setting up your admin account to connect GitHub.',
      code: 'first_admin_incomplete',
    })
    expect(calls.authorizationStart).not.toHaveBeenCalled()
  })

  test('safe catalog is available to any authenticated caller without global pool access', async () => {
    const { app } = createApp({ type: 'system', systemTokenId: 'token-1', name: 'test', scopes: [] })
    expect((await app.request('/api/integrations/catalog')).status).toBe(200)
    expect((await app.request('/api/integrations/connections?provider=bigbrain')).status).toBe(403)
  })

  test('provider-exact instance grant cannot read another provider', async () => {
    const { app, calls } = createApp({
      type: 'system',
      systemTokenId: 'token-1',
      name: 'test',
      scopes: ['integrations:read:bigbrain'],
    })
    expect((await app.request('/api/integrations/connections?provider=bigbrain')).status).toBe(200)
    const catalog = await app.request('/api/integrations/catalog')
    expect(catalog.status).toBe(200)
    expect(await catalog.json()).toEqual({ integrations: createApp().calls.catalog() })
    expect((await app.request('/api/integrations/connections?provider=github')).status).toBe(403)
    expect(calls.list).toHaveBeenCalledTimes(1)
  })

  test('bare instance grant can create a provider-subselected connection', async () => {
    const { app, calls } = createApp({
      type: 'system',
      systemTokenId: 'token-1',
      name: 'test',
      scopes: ['integrations:write'],
    })
    const response = await app.request('/api/integrations/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'bigbrain',
        displayName: 'Brain',
        configuration: { version: 1, apiBase: 'https://brain.example' },
        credential: 'bearer',
      }),
    })
    expect(response.status).toBe(201)
    expect(calls.create).toHaveBeenCalledWith(expect.objectContaining({ providerKey: 'bigbrain' }))
  })

  test('provider-exact write grant is denied for a loaded connection from another provider', async () => {
    const { app, calls } = createApp(
      { type: 'system', systemTokenId: 'token-1', name: 'test', scopes: ['integrations:write:bigbrain'] },
      'github'
    )
    const response = await app.request(`/api/integrations/connections/${summary.id}/disable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(403)
    expect(calls.disable).not.toHaveBeenCalled()
  })

  test.each(['bigbrain', 'github'])('bare instance write grant authorizes loaded %s connections', async (provider) => {
    const { app, calls } = createApp(
      { type: 'system', systemTokenId: 'token-1', name: 'test', scopes: ['integrations:write'] },
      provider
    )
    const response = await app.request(`/api/integrations/connections/${summary.id}/disable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(200)
    expect(calls.disable).toHaveBeenCalled()
  })

  test('malformed persisted provider metadata fails closed before lifecycle authorization', async () => {
    const { app, calls } = createApp(
      { type: 'system', systemTokenId: 'token-1', name: 'test', scopes: ['integrations:write'] },
      'BIGBRAIN:*'
    )
    const response = await app.request(`/api/integrations/connections/${summary.id}/disable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(404)
    expect(calls.disable).not.toHaveBeenCalled()
  })

  test('picker response contains only redacted summaries', async () => {
    const { app } = createApp({
      type: 'system',
      systemTokenId: 'token-1',
      name: 'test',
      scopes: ['integrations:read'],
    })
    const response = await app.request(`/api/squads/${squadId}/integrations/bigbrain`)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({
      providerKey: 'bigbrain',
      assignment: summary,
      connections: [summary],
    })
    for (const forbidden of [
      'configuration',
      'credentialRef',
      'grantedScopes',
      'validatedAt',
      'lastErrorCode',
      'materialRevision',
      'usage',
    ]) {
      expect(text).not.toContain(forbidden)
    }
  })
})

describe('instance versus squad permission scope', () => {
  let cleanup: (() => Promise<void>) | undefined
  afterEach(async () => cleanup?.())

  test('user instance role with bare write can mutate a loaded provider-qualified connection', async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `${crypto.randomUUID()}@example.com` })
      .returning()
    const [role] = await db
      .insert(roles)
      .values({
        name: `Pool writer ${crypto.randomUUID()}`,
        slug: `pool-writer-${crypto.randomUUID()}`,
        permissions: ['integrations:write'],
      })
      .returning()
    await db.insert(roleAssignments).values({
      subjectType: 'user',
      subjectId: user.id,
      roleId: role.id,
      scope: 'system',
    })
    cleanup = async () => {
      await db.delete(roleAssignments).where(eq(roleAssignments.roleId, role.id))
      await db.delete(roles).where(eq(roles.id, role.id))
      await db.delete(users).where(eq(users.id, user.id))
    }

    const { app, calls } = createApp({ type: 'user', userId: user.id }, 'github')
    const response = await app.request(`/api/integrations/connections/${summary.id}/disable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(200)
    expect(calls.disable).toHaveBeenCalled()
  })

  test('user instance provider write role can start and complete authenticated authorization', async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `${crypto.randomUUID()}@example.com` })
      .returning()
    const [role] = await db
      .insert(roles)
      .values({
        name: `Notion authorizer ${crypto.randomUUID()}`,
        slug: `notion-authorizer-${crypto.randomUUID()}`,
        permissions: ['integrations:write:notion'],
      })
      .returning()
    await db.insert(roleAssignments).values({
      subjectType: 'user',
      subjectId: user.id,
      roleId: role.id,
      scope: 'system',
    })
    cleanup = async () => {
      await db.delete(roleAssignments).where(eq(roleAssignments.roleId, role.id))
      await db.delete(roles).where(eq(roles.id, role.id))
      await db.delete(users).where(eq(users.id, user.id))
    }

    const { app, calls } = createApp({ type: 'user', userId: user.id })
    const start = await app.request('/api/integrations/providers/notion/authorization/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ returnTo: '/settings/integrations' }),
    })
    expect(start.status).toBe(200)
    expect(calls.authorizationStart).toHaveBeenCalledWith({
      providerKey: 'notion',
      userId: user.id,
      returnTo: '/settings/integrations',
      connectionId: undefined,
    })

    calls.authorizationStart.mockImplementationOnce(async () => {
      throw new AuthorizationFlowError('broker_unconfigured')
    })
    const unconfigured = await app.request('/api/integrations/providers/notion/authorization/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ returnTo: '/settings/integrations' }),
    })
    expect(unconfigured.status).toBe(503)
    expect(await unconfigured.json()).toEqual({ error: 'broker_unconfigured', code: 'broker_unconfigured' })

    const callback = await app.request('/api/integrations/providers/notion/authorization/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 's'.repeat(43), code: 'provider-code' }),
    })
    expect(callback.status).toBe(200)
    expect(calls.authorizationCallback).toHaveBeenCalledWith({
      providerKey: 'notion',
      userId: user.id,
      state: 's'.repeat(43),
      code: 'provider-code',
      error: undefined,
      denied: undefined,
    })

    const localFlowId = crypto.randomUUID()
    const completionHandle = 'c'.repeat(43)
    const malformed = await app.request('/api/integrations/providers/notion/authorization/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ localFlowId, handle: 'truncated' }),
    })
    expect(malformed.status).toBe(400)
    expect(calls.authorizationComplete).not.toHaveBeenCalled()

    const complete = await app.request('/api/integrations/providers/notion/authorization/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ localFlowId, handle: completionHandle }),
    })
    expect(complete.status).toBe(200)
    expect(calls.authorizationComplete).toHaveBeenCalledWith({
      providerKey: 'notion',
      userId: user.id,
      localFlowId,
      handle: completionHandle,
    })
  })

  test('GitHub authorization failures return typed, user-safe errors and are logged at warn', async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `${crypto.randomUUID()}@example.com` })
      .returning()
    const [role] = await db
      .insert(roles)
      .values({
        name: `GitHub authorizer ${crypto.randomUUID()}`,
        slug: `github-authorizer-${crypto.randomUUID()}`,
        permissions: ['integrations:write:github'],
      })
      .returning()
    await db.insert(roleAssignments).values({
      subjectType: 'user',
      subjectId: user.id,
      roleId: role.id,
      scope: 'system',
    })
    cleanup = async () => {
      await db.delete(roleAssignments).where(eq(roleAssignments.roleId, role.id))
      await db.delete(roles).where(eq(roles.id, role.id))
      await db.delete(users).where(eq(users.id, user.id))
    }
    const warnings: string[] = []
    const warn = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    })
    try {
      const { app, calls } = createApp({ type: 'user', userId: user.id }, 'github')
      const start = () =>
        app.request('/api/integrations/providers/github/authorization/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ returnTo: '/onboarding' }),
        })
      const cases = [
        [new GitHubOAuthError('provider_unavailable'), 502, "GitHub couldn't be reached from this computer."],
        [new GitHubOAuthError('provider_timeout'), 504, "GitHub couldn't be reached from this computer."],
        [new GitHubOAuthError('device_flow_disabled', 400), 400, 'Device authorization is disabled'],
        [new GitHubOAuthError('incorrect_client_credentials', 400), 400, "GitHub rejected this app's client ID"],
        [new GitHubOAuthError('capability_or_resource_denied', 404), 502, 'GitHub refused the request'],
        [new GitHubOAuthError('invalid_response'), 502, 'GitHub returned an unexpected response'],
        [new GitHubOAuthError('provider_error', 422), 502, "GitHub couldn't complete the authorization request"],
      ] as const
      for (const [error, status, message] of cases) {
        calls.authorizationStart.mockImplementationOnce(async () => {
          throw error
        })
        const response = await start()
        expect(response.status).toBe(status)
        const body = (await response.json()) as { error: string; code: string }
        expect(body.code).toBe(error.code)
        expect(body.error).toContain(message)
        expect(warnings.at(-1)).toContain(`github authorization start failed at GitHub: ${error.code}`)
      }

      calls.authorizationStart.mockImplementationOnce(async () => {
        throw new GitHubOAuthError('rate_limited', 429, 30, true)
      })
      const limited = await start()
      expect(limited.status).toBe(429)
      expect(limited.headers.get('retry-after')).toBe('30')
      expect(((await limited.json()) as { code: string }).code).toBe('rate_limited')

      calls.authorizationStart.mockImplementationOnce(async () => {
        throw new AuthorizationFlowError('oauth_app_unconfigured')
      })
      const unconfigured = await start()
      expect(unconfigured.status).toBe(400)
      expect(await unconfigured.json()).toEqual({ error: 'oauth_app_unconfigured', code: 'oauth_app_unconfigured' })
      expect(warnings.at(-1)).toContain('github authorization start rejected: oauth_app_unconfigured (HTTP 400)')

      calls.authorizationPollDevice.mockImplementationOnce(async () => {
        throw new AuthorizationFlowError('invalid_or_expired_state')
      })
      const poll = await app.request(`/api/integrations/providers/github/authorization/device/${summary.id}/poll`, {
        method: 'POST',
      })
      expect(poll.status).toBe(400)
      expect(((await poll.json()) as { code: string }).code).toBe('invalid_or_expired_state')
      expect(warnings.at(-1)).toContain('github authorization poll rejected: invalid_or_expired_state')
    } finally {
      warn.mockRestore()
    }
  })

  test('squad-only write can assign but cannot invoke global lifecycle', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `Routes ${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    const [user] = await db
      .insert(users)
      .values({ email: `${crypto.randomUUID()}@example.com` })
      .returning()
    const [role] = await db
      .insert(roles)
      .values({
        name: `Picker ${crypto.randomUUID()}`,
        slug: `picker-${crypto.randomUUID()}`,
        permissions: ['integrations:write'],
      })
      .returning()
    await db.insert(roleAssignments).values({
      subjectType: 'user',
      subjectId: user.id,
      roleId: role.id,
      scope: 'squad',
      squadId: squad.id,
    })
    cleanup = async () => {
      await db.delete(roleAssignments).where(eq(roleAssignments.roleId, role.id))
      await db.delete(roles).where(eq(roles.id, role.id))
      await db.delete(users).where(eq(users.id, user.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
    const { app, calls } = createApp({ type: 'user', userId: user.id })
    const assignment = await app.request(`/api/squads/${squad.id}/integrations/bigbrain/assignment`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectionId: summary.id }),
    })
    expect(assignment.status).toBe(200)
    expect(calls.assign).toHaveBeenCalledWith(squad.id, 'bigbrain', summary.id, { userId: user.id })
    const retry = await app.request(`/api/squads/${squad.id}/integrations/bigbrain/projection/retry`, {
      method: 'POST',
    })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ projection: { status: 'pending', lastErrorCode: null } })
    expect(calls.retryProjection).toHaveBeenCalledWith(squad.id, 'bigbrain')

    const global = await app.request(`/api/integrations/connections/${summary.id}/disable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(global.status).toBe(403)
    expect(calls.disable).not.toHaveBeenCalled()
  })
})

test('provider switches require provider write permission and a strict boolean body', async () => {
  for (const writable of [false, true]) {
    const { app, calls } = createApp({
      type: 'system',
      systemTokenId: 'switch-test',
      name: 'test',
      scopes: [writable ? 'integrations:write:bigbrain' : 'integrations:read:bigbrain'],
    })
    const response = await app.request('/api/integrations/providers/bigbrain/enabled', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(response.status).toBe(writable ? 200 : 403)
    expect(calls.setEnabled.mock.calls.length).toBe(writable ? 1 : 0)
    if (writable) {
      expect(await response.json()).toEqual({ enabled: false })
      const invalid = await app.request('/api/integrations/providers/bigbrain/enabled', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: 'false' }),
      })
      expect(invalid.status).toBe(400)
      expect(calls.setEnabled.mock.calls.length).toBe(1)
    }
  }
})

test('output catalog exposes event-specific predicate types only to authenticated callers', async () => {
  expect((await createApp().app.request('/api/integrations/outputs')).status).toBe(401)
  const { app, calls } = createApp({ type: 'system', systemTokenId: 'token-1', name: 'test', scopes: [] })
  const response = await app.request('/api/integrations/outputs')
  expect(response.status).toBe(200)
  const catalog: import('@ficus/shared').IntegrationOutputDescriptor[] = await response.json()
  const assigned = catalog.find((event) => event.integration === 'github' && event.output === 'issue.assigned')!
  expect(assigned.predicateFields!['issue.number'].type).toBe('number')
  expect(assigned.predicateFields!.labels.type).toBe('string[]')
  expect(assigned.predicateFields!['pullRequest.number']).toBeUndefined()
  expect(assigned.predicateFields!.body).toBeUndefined()
  expect(calls.list).not.toHaveBeenCalled()
  expect(calls.get).not.toHaveBeenCalled()
})
