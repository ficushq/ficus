import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../../../db'
import {
  users,
  integrationOauthStates,
  integrationAuthorizationFlowReceipts,
  integrationAuditEvents,
  integrationCredentialCleanupJobs,
  integrationDeviceAuthorizations,
} from '../../../db/schema'
import { DbOAuthStateRepository } from '../authorization/db-state-repository'
import {
  DbAuthorizationFlowReceiptRepository,
  authorizationCredentialReference,
} from '../authorization/flow-repository'
import { DbDeviceAuthorizationRepository } from '../authorization/db-device-repository'
import { ConnectionAuthorizationLease } from '../authorization/connection-lease'
import { GitHubPersonalOAuthFinalizer } from './personal-oauth-finalizer'
import { createTestGitHubConnection } from '../../../test-utils/github-connection'
import { getSecretStore } from '../../secrets'
import { githubPlugin } from './plugin'
import { createGitHubIdentityRouter } from '../../../routes/github-identity'
import { createIntegrationsRouter, type IntegrationRoutesService } from '../../../routes/integrations'
import { authzSentinel } from '../../../middleware/authz-sentinel'
import { getGitHubPersonalIdentity, unlinkGitHubIdentity } from './personal-identity'
import type { Identity } from '../../rbac'
import { GitHubOAuthError } from '@ficus/shared/oauth-providers/github/client'

const implementation = await import('./identity-authorization').catch(() => null)

async function fixture(authority: 'local' | 'platform_broker' = 'local', mode: 'browser' | 'device' = 'browser') {
  expect(implementation?.GitHubIdentityAuthorization).toBeDefined()
  const connection = await createTestGitHubConnection()
  const userId = crypto.randomUUID(),
    otherUserId = crypto.randomUUID()
  await db.insert(users).values([userId, otherUserId].map((id) => ({ id, email: `${id}@identity-orchestration.test` })))
  const identity = { type: 'user' as const, userId }
  const states = new DbOAuthStateRepository(),
    receipts = new DbAuthorizationFlowReceiptRepository()
  const lease = new ConnectionAuthorizationLease(),
    secrets = getSecretStore()
  const calls: string[] = [],
    flows: string[] = []
  let profileFailure = false
  const uuid = () => {
    const id = crypto.randomUUID()
    flows.push(id)
    return id
  }
  const finalizer = new GitHubPersonalOAuthFinalizer({
    receipts,
    secrets,
    lease,
    client: {
      currentIdentity: async () => {
        calls.push('personal-profile')
        if (profileFailure) throw new GitHubOAuthError('provider_unavailable')
        return { id: 101, login: 'alice', type: 'User' }
      },
    },
  })
  const runtime = new implementation!.GitHubIdentityAuthorization({
    authorization: {
      states,
      flowReceipts: receipts,
      resolvePlugin: (key) => (key === 'github' ? githubPlugin : undefined),
      callbackUrl: () => 'https://ficus.test/callback',
      uuid,
      transport: {
        authority,
        authorizationUrl: async (input) => ({
          authorizationUrl: `https://github.com/login/oauth/authorize?state=${input.localFlowId}`,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
        completeAuthorization: async () => {
          calls.push('exchange')
          return {
            configuration: {},
            tokens: { accessToken: 'PERSONAL_SECRET_SENTINEL', refreshToken: null, expiresAt: null },
            displayName: 'unverified',
          }
        },
        refresh: async () => {
          throw new Error('unused')
        },
        revoke: async () => {
          calls.push('remote-revoke')
        },
      },
      installGrant: async (input) => {
        calls.push('integration-install')
        await input.exchange()
      },
    },
    device: {
      repository: new DbDeviceAuthorizationRepository(),
      receipts,
      lease,
      uuid,
      now: () => new Date(Date.now() + 6000),
      requireLocal: () => {
        if (authority !== 'local') throw new Error('hosted device forbidden')
      },
      resolveClient: () => ({ clientId: 'public' }),
      client: {
        startDevice: async () => {
          calls.push('device-start')
          return {
            deviceCode: 'DEVICE_SECRET',
            userCode: 'ABCD',
            verificationUri: 'https://github.com/login/device',
            expiresIn: 900,
            interval: 5,
          }
        },
        pollDevice: async () => {
          calls.push('device-poll')
          return {
            status: 'authorized',
            tokens: { accessToken: 'PERSONAL_SECRET_SENTINEL', refreshToken: null, expiresAt: null },
          }
        },
        currentUser: async () => {
          calls.push('integration-profile')
          return { version: 1, userId: 101, login: 'alice' }
        },
      },
      install: async () => {
        calls.push('device-integration-install')
      },
    },
    finalizer,
    configuration: () => ({ configured: true, authority, mode }),
    initializeIntegrationDefaults: async () => {
      calls.push('defaults')
    },
  })
  const appFor = (principal?: Identity) => {
    const app = new Hono()
    app.use('*', async (c, next) => {
      if (principal) c.set('identity', principal)
      await next()
    })
    app.use('/api/*', authzSentinel)
    app.route('/api/github-identity', createGitHubIdentityRouter(runtime.personal))
    const unused = async () => {
      throw new Error('unused')
    }
    const service = {
      authorization: runtime.common,
      get: unused,
      list: unused,
      providerFor: unused,
      create: unused,
      validate: unused,
      enable: unused,
      disable: unused,
      replaceCredential: unused,
      remove: unused,
    } as unknown as IntegrationRoutesService
    app.route('/api/integrations', createIntegrationsRouter(service))
    return app
  }
  return {
    runtime,
    identity,
    userId,
    otherUserId,
    calls,
    flows,
    appFor,
    profileFails: (v: boolean) => {
      profileFailure = v
    },
    async close() {
      for (const id of flows) {
        await db.delete(integrationOauthStates).where(eq(integrationOauthStates.localFlowId, id))
        await db
          .delete(integrationCredentialCleanupJobs)
          .where(eq(integrationCredentialCleanupJobs.authorizationFlowId, id))
        await db
          .delete(integrationAuthorizationFlowReceipts)
          .where(eq(integrationAuthorizationFlowReceipts.localFlowId, id))
        await secrets.delete(authorizationCredentialReference(id))
      }
      await db.delete(integrationOauthStates).where(inArray(integrationOauthStates.userId, [userId, otherUserId]))
      await db.delete(integrationAuditEvents).where(inArray(integrationAuditEvents.userId, [userId, otherUserId]))
      await db.delete(users).where(inArray(users.id, [userId, otherUserId]))
      await connection.dispose()
    },
  }
}
const post = (path: string, body: unknown) =>
  new Request(`https://ficus.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

test.each(['local', 'platform_broker'] as const)(
  'actual %s browser orchestration carries literal human, returns proof and never initializes integrations',
  async (authority) => {
    const h = await fixture(authority)
    try {
      const app = h.appFor(h.identity)
      const response = await app.request(post('/api/github-identity/authorization/start', { returnTo: '/settings' }))
      expect(response.status).toBe(200)
      const start = await response.json()
      const state = new URL(start.authorizationUrl).searchParams.get('state')!
      const path = `/api/integrations/providers/github/authorization/${authority === 'local' ? 'callback' : 'complete'}`
      const body = authority === 'local' ? { state, code: 'code' } : { localFlowId: state, handle: 'a'.repeat(43) }
      expect((await h.appFor({ type: 'user', userId: h.otherUserId }).request(post(path, body))).status).toBe(403)
      expect(h.calls).toEqual([])
      expect((await app.request(post(path, body))).status).toBe(200)
      expect(h.calls).toEqual(['exchange', 'personal-profile'])
      const status = await (await app.request('/api/github-identity')).json()
      expect(status.confirmation).toMatchObject({ accountId: '101', login: 'alice' })
      expect(JSON.stringify(status)).not.toContain('SECRET')
      expect(await getGitHubPersonalIdentity(h.identity)).toBeNull()
      expect((await app.request(post(`/api/github-identity/${status.confirmation.id}/confirm`, {}))).status).toBe(200)
      expect(await getGitHubPersonalIdentity(h.identity)).toMatchObject({ accountId: '101' })
      expect((await app.request(post(path, body))).status).toBe(200)
      expect(h.calls).toEqual(['exchange', 'personal-profile'])
      // A delegated owner ID is not literal human authority, even at the internal boundary.
      const delegated = {
        type: 'agent' as const,
        agentId: crypto.randomUUID(),
        squadId: crypto.randomUUID(),
        userId: h.userId,
      }
      await expect(
        authority === 'local'
          ? h.runtime.common.callback({
              providerKey: 'github',
              userId: h.userId,
              state,
              code: 'code',
              identity: delegated,
            })
          : h.runtime.common.complete({
              providerKey: 'github',
              userId: h.userId,
              localFlowId: state,
              handle: 'a'.repeat(43),
              identity: delegated,
            })
      ).rejects.toMatchObject({ code: 'human_required' })
    } finally {
      await h.close()
    }
  }
)

test('local callback staged proof recovery is self-bound and does not reexchange the code', async () => {
  const h = await fixture()
  try {
    const start = await h.runtime.personal.start(h.identity, '/settings')
    if (!('authorizationUrl' in start)) throw new Error('Expected browser start')
    const state = new URL(start.authorizationUrl).searchParams.get('state')!
    const input = { providerKey: 'github', userId: h.userId, state, code: 'code', identity: h.identity }
    h.profileFails(true)
    const refusal = await h
      .appFor(h.identity)
      .request(post('/api/integrations/providers/github/authorization/callback', { state, code: 'code' }))
    expect(refusal.status).toBe(502)
    expect(await refusal.json()).toMatchObject({ code: 'provider_unavailable' })
    h.profileFails(false)
    expect(await h.runtime.common.callback(input)).toEqual({ returnTo: '/settings' })
    expect(h.calls).toEqual(['exchange', 'personal-profile', 'personal-profile'])
  } finally {
    await h.close()
  }
})

test('retired browser generation propagates a real coordinator-domain conflict before any provider calls', async () => {
  const h = await fixture()
  try {
    const app = h.appFor(h.identity)
    const start = await h.runtime.personal.start(h.identity, '/settings')
    if (!('authorizationUrl' in start)) throw new Error('Expected browser start')
    const state = new URL(start.authorizationUrl).searchParams.get('state')!
    await unlinkGitHubIdentity(h.identity)
    const response = await app.request(
      post('/api/integrations/providers/github/authorization/callback', { state, code: 'code' })
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'identity_generation_changed' })
    expect(h.calls).toEqual([])
  } finally {
    await h.close()
  }
})

test('personal device routes reject integration IDs and foreign/delegated owners before polling/decryption', async () => {
  const h = await fixture('local', 'device')
  try {
    const start = await h.runtime.personal.start(h.identity, '/settings')
    if (!('kind' in start)) throw new Error('Expected device start')
    expect(start.kind).toBe('device')
    expect(
      (
        await h
          .appFor({ type: 'user', userId: h.otherUserId })
          .request(post(`/api/github-identity/authorization/device/${start.id}/poll`, {}))
      ).status
    ).toBe(409)
    expect(h.calls).toEqual(['device-start'])
    const app = h.appFor(h.identity)
    const response = await app.request(
      post(`/api/integrations/providers/github/authorization/device/${start.id}/poll`, {})
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'complete', returnTo: '/settings' })
    expect(h.calls).toEqual(['device-start', 'device-poll', 'personal-profile'])
    expect((await app.request(post(`/api/github-identity/authorization/device/${start.id}/poll`, {}))).status).toBe(200)
    expect(h.calls).toEqual(['device-start', 'device-poll', 'personal-profile'])
    const integration = await h.runtime.integrationDevice.start({ userId: h.userId, returnTo: '/settings' })
    const row = (
      await db
        .select()
        .from(integrationDeviceAuthorizations)
        .where(eq(integrationDeviceAuthorizations.id, integration.id))
    )[0]!
    await db
      .update(integrationDeviceAuthorizations)
      .set({ encryptedDeviceCode: 'INVALID_DO_NOT_DECRYPT' })
      .where(eq(integrationDeviceAuthorizations.id, row.id))
    const refused = await app.request(post(`/api/github-identity/authorization/device/${integration.id}/cancel`, {}))
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ code: 'identity_flow_mismatch' })
    expect(h.calls).toEqual(['device-start', 'device-poll', 'personal-profile', 'device-start'])
  } finally {
    await h.close()
  }
})

test('ordinary integration browser callback still uses only integration installer and defaults', async () => {
  const h = await fixture()
  try {
    const start = await h.runtime.integrationAuthorization.start({
      providerKey: 'github',
      userId: h.userId,
      returnTo: '/settings',
      intent: { kind: 'connect' },
    })
    await h.runtime.common.callback({
      providerKey: 'github',
      userId: h.userId,
      state: new URL(start.authorizationUrl).searchParams.get('state')!,
      code: 'code',
    })
    expect(h.calls).toEqual(['integration-install', 'exchange', 'defaults'])
  } finally {
    await h.close()
  }
})
