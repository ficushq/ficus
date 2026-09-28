import { createHash } from 'crypto'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { IntegrationAuditEvent } from '../audit'
import type { IntegrationPluginV1, ManagedOAuthDriver } from '../plugin'
import type { NewOAuthStateRecord, OAuthStateRecord, OAuthStateRepository } from './state-repository'
import { AuthorizationFlowError, IntegrationAuthorizationService } from './service'
import { createLocalTransport, type OAuthTransport } from './transport'
import { BrokerUnconfiguredError } from './authority'
import { PlatformRequestError } from '../../platform/instance-client'
import { registerOAuthProviderAdapterForTest } from '@ficus/shared/oauth-providers'
import { createFakeAdapter } from '@ficus/shared/oauth-providers/fake'

class MemoryStateRepository implements OAuthStateRepository {
  readonly rows = new Map<string, OAuthStateRecord>()
  now = new Date('2026-08-29T00:00:00.000Z')
  finishFailures = 0
  burnFailures = 0

  async create(state: NewOAuthStateRecord) {
    this.rows.set(state.stateHash, {
      ...state,
      localFlowId: state.localFlowId ?? null,
      authority: state.authority ?? 'local',
      completionHandleHash: state.completionHandleHash ?? null,
      recoveryExpiresAt: state.recoveryExpiresAt ?? null,
      createdAt: this.now,
    })
  }

  async consume(input: { stateHash: string; providerKey: string; userId: string }) {
    const row = this.rows.get(input.stateHash)
    if (!row || row.providerKey !== input.providerKey || row.userId !== input.userId || row.expiresAt <= this.now) {
      return null
    }
    this.rows.delete(input.stateHash)
    return row
  }

  async claimByFlow(input: {
    localFlowId: string
    providerKey: string
    userId: string
    authority: 'platform_broker'
    handleHash: string
  }) {
    const entry = [...this.rows.entries()].find(
      ([, row]) =>
        row.localFlowId === input.localFlowId &&
        row.providerKey === input.providerKey &&
        row.userId === input.userId &&
        row.authority === input.authority
    )
    if (!entry) return null
    const row = entry[1]
    if (row.completionHandleHash === null) {
      if (row.expiresAt <= this.now) return null
      row.completionHandleHash = input.handleHash
      row.recoveryExpiresAt = new Date(this.now.getTime() + 24 * 60 * 60_000)
      return row
    }
    if (
      row.completionHandleHash !== input.handleHash ||
      row.recoveryExpiresAt === null ||
      row.recoveryExpiresAt <= this.now
    ) {
      return null
    }
    return row
  }

  async finishByFlow(input: { localFlowId: string; handleHash: string }) {
    if (this.finishFailures > 0) {
      this.finishFailures -= 1
      throw new Error('simulated finalization crash')
    }
    const entry = [...this.rows.entries()].find(
      ([, row]) => row.localFlowId === input.localFlowId && row.completionHandleHash === input.handleHash
    )
    if (!entry) return false
    this.rows.delete(entry[0])
    return true
  }

  async flowExists(localFlowId: string) {
    return [...this.rows.values()].some((row) => row.localFlowId === localFlowId)
  }

  async burnByFlow(input: { localFlowId: string; handleHash: string }) {
    if (this.burnFailures > 0) {
      this.burnFailures -= 1
      throw new Error('simulated burn failure')
    }
    return this.finishByFlow(input)
  }

  async deleteExpired() {
    return 0
  }
}

const provider = {
  key: 'notion',
  adapterVersion: 1,
  parseConfig: (value: unknown) => value as { workspaceId: string },
  validate: async () => ({ ok: true as const, grantedScopes: [] }),
  capabilities: {},
}

function createPlugin(): IntegrationPluginV1<{ workspaceId: string }, string> {
  return {
    manifestVersion: 1,
    key: 'notion',
    adapterVersion: 1,
    presentation: {
      label: 'Notion',
      description: 'Notion',
      icon: 'notion',
      connectionMode: 'oauth2',
      assignable: true,
      requiredCapabilities: ['read_content'],
    },
    connection: {
      parseConfiguration: provider.parseConfig,
      safeConfiguration: (value) => value,
      credential: { parse: String, serialize: String },
    },
    authorization: {
      kind: 'oauth2',
      adapter: 'notion',
      async validate() {
        return { ok: true, grantedScopes: [] }
      },
    },
    runtime: { provider },
    sandbox: {
      packages: [],
      setupSteps: [],
      initHooks: [],
      readiness: [],
      skills: [],
      extensions: [],
      protectedBindings: [],
    },
    lifecycle: { refresh: true, revoke: true },
    classifyError: () => ({ code: 'provider_error', retryable: true }),
  }
}

const completionHandle = 'c'.repeat(43)
const otherCompletionHandle = 'o'.repeat(43)

function expectFlowCode(error: unknown, code: string) {
  expect(error).toBeInstanceOf(AuthorizationFlowError)
  expect((error as AuthorizationFlowError).code).toBe(code)
}

describe('IntegrationAuthorizationService', () => {
  let states: MemoryStateRepository
  let calls: { exchanges: string[] }
  let audits: IntegrationAuditEvent[]
  let installed: unknown[]
  let transport: OAuthTransport
  let service: IntegrationAuthorizationService

  beforeEach(() => {
    states = new MemoryStateRepository()
    calls = { exchanges: [] }
    audits = []
    installed = []
    const plugin = createPlugin()
    transport = {
      authority: 'local',
      async authorizationUrl(input) {
        const url = new URL('https://api.notion.com/v1/oauth/authorize')
        url.searchParams.set('state', input.localFlowId)
        return { authorizationUrl: url.toString(), expiresAt: '2026-08-29T00:10:00.000Z' }
      },
      async completeAuthorization(input) {
        calls.exchanges.push(input.code!)
        return {
          configuration: { workspaceId: 'workspace-1' },
          tokens: { accessToken: 'access-token-SENTINEL', refreshToken: null, expiresAt: null },
          displayName: 'Workspace',
        }
      },
      async refresh() {
        throw new Error('unused')
      },
      async revoke() {},
    }
    service = new IntegrationAuthorizationService({
      states,
      resolvePlugin: (key) => (key === 'notion' ? plugin : undefined),
      transport,
      callbackUrl: () => 'https://tau.example/settings/integrations/oauth/callback',
      installGrant: async (input) => {
        installed.push({ ...input, grant: await input.exchange() })
      },
      audit: { record: async (event) => void audits.push(event) },
      randomBytes: () => Buffer.alloc(32, 7),
      now: () => new Date('2026-08-29T00:00:00.000Z'),
      uuid: () => '80000000-0000-4000-8000-000000000099',
    })
  })

  test('starts with a random plaintext state in the provider URL but persists only its SHA-256 hash', async () => {
    const result = await service.start({
      providerKey: 'notion',
      userId: 'user-1',
      returnTo: '/settings/integrations',
      intent: { kind: 'connect' },
    })
    const url = new URL(result.authorizationUrl)
    const state = url.searchParams.get('state')!
    expect(Buffer.from(state, 'base64url')).toHaveLength(32)
    expect(states.rows.has(state)).toBe(false)
    expect([...states.rows.keys()]).toEqual([new Bun.CryptoHasher('sha256').update(state).digest('hex')])
    expect([...states.rows.values()][0]).toMatchObject({
      userId: 'user-1',
      providerKey: 'notion',
      intent: 'connect',
      returnTo: '/settings/integrations',
      expiresAt: new Date('2026-08-29T00:10:00.000Z'),
    })
  })

  test('consumes state before exchange and installs only the server-owned intent', async () => {
    const started = await service.start({
      providerKey: 'notion',
      userId: 'user-1',
      returnTo: '/settings/integrations',
      intent: { kind: 'reconnect', connectionId: 'connection-1', expectedMaterialRevision: 'revision-1' },
    })
    const state = new URL(started.authorizationUrl).searchParams.get('state')!
    const result = await service.callback({ providerKey: 'notion', userId: 'user-1', state, code: 'provider-code' })

    expect(calls.exchanges).toEqual(['provider-code'])
    expect(installed).toHaveLength(1)
    expect(installed[0]).toMatchObject({
      state: { intent: 'reconnect', connectionId: 'connection-1', expectedMaterialRevision: 'revision-1' },
    })
    expect(result).toEqual({ returnTo: '/settings/integrations' })
    await service
      .callback({ providerKey: 'notion', userId: 'user-1', state, code: 'provider-code' })
      .then(() => {
        throw new Error('expected replay denial')
      })
      .catch((error) => expectFlowCode(error, 'invalid_or_expired_state'))
    expect(calls.exchanges).toHaveLength(1)
  })

  test('missing local client credentials create no state row', async () => {
    const localStates = new MemoryStateRepository()
    const localService = new IntegrationAuthorizationService({
      states: localStates,
      resolvePlugin: (key) => (key === 'notion' ? createPlugin() : undefined),
      transport: createLocalTransport({
        resolveClientCredentials: () => undefined,
        callbackUrl: () => 'https://tau.example/settings/integrations/oauth/callback',
      }),
      callbackUrl: () => 'https://tau.example/settings/integrations/oauth/callback',
      installGrant: async () => {},
      randomBytes: () => Buffer.alloc(32, 7),
    })

    await localService
      .start({ providerKey: 'notion', userId: 'user-1', returnTo: '/settings', intent: { kind: 'connect' } })
      .then(() => {
        throw new Error('expected local OAuth configuration failure')
      })
      .catch((error) => expectFlowCode(error, 'oauth_app_unconfigured'))
    expect(localStates.rows.size).toBe(0)
  })

  test('brokered completion is bound to the originating user and consumes the flow exactly once', async () => {
    transport = {
      ...transport,
      authority: 'platform_broker',
      async authorizationUrl() {
        return {
          authorizationUrl: 'https://api.notion.com/v1/oauth/authorize?state=platform-state',
          expiresAt: '2026-08-29T00:10:00.000Z',
        }
      },
      async completeAuthorization(input) {
        calls.exchanges.push(input.handle!)
        return {
          configuration: { workspaceId: 'workspace-1' },
          tokens: { accessToken: 'access-token-SENTINEL', refreshToken: null, expiresAt: null },
          displayName: 'Workspace',
        }
      },
    }
    const brokered = new IntegrationAuthorizationService({
      states,
      resolvePlugin: (key) => (key === 'notion' ? createPlugin() : undefined),
      transport,
      callbackUrl: () => 'https://tau.example/settings/integrations/oauth/callback',
      installGrant: async (input) => {
        installed.push({ ...input, grant: await input.exchange() })
      },
      randomBytes: () => Buffer.alloc(32, 7),
      uuid: () => '80000000-0000-4000-8000-000000000099',
      now: () => new Date('2026-08-29T00:00:00.000Z'),
    })
    await brokered.start({
      providerKey: 'notion',
      userId: 'user-1',
      returnTo: '/settings',
      intent: { kind: 'connect' },
    })
    const state = [...states.rows.values()][0]!
    expect(state).toMatchObject({
      localFlowId: '80000000-0000-4000-8000-000000000099',
      authority: 'platform_broker',
    })

    await brokered
      .complete({
        providerKey: 'notion',
        userId: 'user-1',
        localFlowId: state.localFlowId!,
        handle: 'truncated',
      })
      .then(() => {
        throw new Error('expected malformed handle denial')
      })
      .catch((error) => expectFlowCode(error, 'invalid_completion_handle'))
    expect(state.completionHandleHash).toBeNull()
    expect(calls.exchanges).toEqual([])

    await brokered
      .complete({
        providerKey: 'notion',
        userId: 'user-2',
        localFlowId: state.localFlowId!,
        handle: otherCompletionHandle,
      })
      .then(() => {
        throw new Error('expected wrong-user denial')
      })
      .catch((error) => expectFlowCode(error, 'invalid_or_expired_state'))
    expect(calls.exchanges).toEqual([])

    expect(
      await brokered.complete({
        providerKey: 'notion',
        userId: 'user-1',
        localFlowId: state.localFlowId!,
        handle: completionHandle,
      })
    ).toEqual({ returnTo: '/settings' })
    expect(calls.exchanges).toEqual([completionHandle])

    await brokered
      .complete({
        providerKey: 'notion',
        userId: 'user-1',
        localFlowId: state.localFlowId!,
        handle: completionHandle,
      })
      .then(() => {
        throw new Error('expected replay denial')
      })
      .catch((error) => expectFlowCode(error, 'invalid_or_expired_state'))
    expect(calls.exchanges).toEqual([completionHandle])
  })

  test('installed receipt replays logical success after coordinator and connection lifecycle deletion', async () => {
    let brokerCalls = 0
    const localFlowId = '80000000-0000-4000-8000-000000000099'
    await states.create({
      stateHash: 'installed-receipt-state',
      localFlowId,
      authority: 'platform_broker',
      completionHandleHash: createHash('sha256').update(completionHandle).digest('hex'),
      recoveryExpiresAt: new Date('2026-08-30T00:00:00.000Z'),
      providerKey: 'notion',
      userId: 'user-1',
      intent: 'connect',
      connectionId: null,
      expectedMaterialRevision: null,
      redirectUri: 'https://tau.example/callback',
      returnTo: '/settings',
      expiresAt: new Date('2026-08-29T00:10:00.000Z'),
    })
    const brokered = new IntegrationAuthorizationService({
      states,
      flowReceipts: {
        markTerminal: async () => null,
        getRecoverable: async () =>
          ({
            localFlowId,
            providerKey: 'notion',
            authority: 'platform_broker',
            initiatingUserId: 'user-1',
            returnTo: '/settings',
            completionHandleHash: createHash('sha256').update(completionHandle).digest('hex'),
            recoveryExpiresAt: new Date('2026-08-30T00:00:00.000Z'),
            installKind: 'connect',
          }) as any,
      },
      resolvePlugin: (key) => (key === 'notion' ? createPlugin() : undefined),
      transport: {
        ...transport,
        authority: 'platform_broker',
        async completeAuthorization() {
          brokerCalls += 1
          throw new Error('must not redeem an installed flow')
        },
      },
      callbackUrl: () => 'https://tau.example/settings/integrations/oauth/callback',
      installGrant: async () => {
        throw new Error('must not reinstall an installed flow')
      },
      now: () => new Date('2026-08-29T00:00:00.000Z'),
    })
    await expect(
      brokered.complete({
        providerKey: 'notion',
        userId: 'user-1',
        localFlowId,
        handle: otherCompletionHandle,
      })
    ).rejects.toMatchObject({ code: 'invalid_or_expired_state' })
    expect(
      await brokered.complete({
        providerKey: 'notion',
        userId: 'user-1',
        localFlowId,
        handle: completionHandle,
      })
    ).toEqual({ returnTo: '/settings' })
    await expect(
      brokered.complete({
        providerKey: 'notion',
        userId: 'user-1',
        localFlowId,
        handle: otherCompletionHandle,
      })
    ).rejects.toMatchObject({ code: 'invalid_or_expired_state' })
    expect(
      await brokered.complete({
        providerKey: 'notion',
        userId: 'user-1',
        localFlowId,
        handle: completionHandle,
      })
    ).toEqual({ returnTo: '/settings' })
    await expect(
      brokered.complete({
        providerKey: 'notion',
        userId: 'user-2',
        localFlowId,
        handle: completionHandle,
      })
    ).rejects.toMatchObject({ code: 'invalid_or_expired_state' })
    expect(brokerCalls).toBe(0)
  })

  test.each(['installed', 'terminal'] as const)(
    'expired %s receipt replay is rejected before broker or install calls',
    async (_disposition) => {
      let calls = 0
      const localFlowId = crypto.randomUUID()
      const handle = completionHandle
      const brokered = new IntegrationAuthorizationService({
        states,
        flowReceipts: {
          markTerminal: async () => null,
          getRecoverable: async () => null,
        },
        resolvePlugin: () => createPlugin(),
        transport: {
          ...transport,
          authority: 'platform_broker',
          completeAuthorization: async () => {
            calls += 1
            throw new Error('must not call broker')
          },
        },
        callbackUrl: () => 'https://tau.example/callback',
        installGrant: async () => void (calls += 1),
        now: () => new Date('2026-08-30T00:00:00.001Z'),
      })
      await expect(
        brokered.complete({ providerKey: 'notion', userId: 'user-1', localFlowId, handle })
      ).rejects.toMatchObject({ code: 'invalid_or_expired_state' })
      expect(calls).toBe(0)
    }
  )

  test('installed receipt replay survives a deployment authority transition without lifecycle calls', async () => {
    let calls = 0
    const localFlowId = crypto.randomUUID()
    const handle = completionHandle
    const service = new IntegrationAuthorizationService({
      states,
      flowReceipts: {
        markTerminal: async () => null,
        getRecoverable: async () =>
          ({
            localFlowId,
            providerKey: 'notion',
            authority: 'local',
            initiatingUserId: 'user-1',
            returnTo: '/settings',
            completionHandleHash: createHash('sha256').update(handle).digest('hex'),
            recoveryExpiresAt: new Date('2026-08-30T00:00:00.000Z'),
            installKind: 'connect',
          }) as any,
      },
      resolvePlugin: () => {
        throw new Error('must not resolve plugin')
      },
      transport: {
        ...transport,
        authority: 'platform_broker',
        completeAuthorization: async () => {
          throw new Error('must not call broker')
        },
      },
      callbackUrl: () => 'https://tau.example/callback',
      installGrant: async () => void (calls += 1),
      now: () => new Date('2026-08-29T00:00:00.000Z'),
    })
    await expect(service.complete({ providerKey: 'notion', userId: 'user-1', localFlowId, handle })).resolves.toEqual({
      returnTo: '/settings',
    })
    expect(calls).toBe(0)
  })

  test('brokered completion rejects an expired local flow before redeeming the handle', async () => {
    transport = { ...transport, authority: 'platform_broker' }
    const brokered = new IntegrationAuthorizationService({
      states,
      resolvePlugin: (key) => (key === 'notion' ? createPlugin() : undefined),
      transport,
      callbackUrl: () => 'https://tau.example/settings/integrations/oauth/callback',
      installGrant: async () => {},
      uuid: () => '80000000-0000-4000-8000-000000000099',
      now: () => new Date('2026-08-29T00:00:00.000Z'),
    })
    await brokered.start({
      providerKey: 'notion',
      userId: 'user-1',
      returnTo: '/settings',
      intent: { kind: 'connect' },
    })
    states.now = new Date('2026-08-29T00:10:00.001Z')
    await brokered
      .complete({
        providerKey: 'notion',
        userId: 'user-1',
        localFlowId: '80000000-0000-4000-8000-000000000099',
        handle: completionHandle,
      })
      .then(() => {
        throw new Error('expected expiry denial')
      })
      .catch((error) => expectFlowCode(error, 'invalid_or_expired_state'))
    expect(calls.exchanges).toEqual([])
  })

  test('same-handle ledger replay recovers response loss after the original TTL without duplicate install', async () => {
    let redeemAttempts = 0
    let installMutations = 0
    const installedFlows = new Set<string>()
    transport = {
      ...transport,
      authority: 'platform_broker',
      async completeAuthorization() {
        redeemAttempts += 1
        if (redeemAttempts === 1) throw new PlatformRequestError('broker_unavailable', true)
        return {
          configuration: { workspaceId: 'workspace-1' },
          tokens: { accessToken: 'access-token-SENTINEL', refreshToken: null, expiresAt: null },
          displayName: 'Workspace',
        }
      },
    }
    const brokered = new IntegrationAuthorizationService({
      states,
      resolvePlugin: (key) => (key === 'notion' ? createPlugin() : undefined),
      transport,
      callbackUrl: () => 'https://tau.example/settings/integrations/oauth/callback',
      installGrant: async (input) => {
        await input.exchange()
        if (installedFlows.has(input.state.localFlowId!)) return
        installedFlows.add(input.state.localFlowId!)
        installMutations += 1
      },
      uuid: () => '80000000-0000-4000-8000-000000000099',
      now: () => states.now,
    })
    await brokered.start({
      providerKey: 'notion',
      userId: 'user-1',
      returnTo: '/settings',
      intent: { kind: 'connect' },
    })
    const completeInput = {
      providerKey: 'notion',
      userId: 'user-1',
      localFlowId: '80000000-0000-4000-8000-000000000099',
      handle: completionHandle,
    }
    await expect(brokered.complete(completeInput)).rejects.toMatchObject({ code: 'broker_unavailable' })
    expect(JSON.stringify([...states.rows.values()])).not.toContain(completionHandle)

    await expect(brokered.complete({ ...completeInput, handle: otherCompletionHandle })).rejects.toMatchObject({
      code: 'invalid_or_expired_state',
    })
    expect(redeemAttempts).toBe(1)

    states.now = new Date('2026-08-29T00:11:00.000Z')
    expect(await brokered.complete(completeInput)).toEqual({ returnTo: '/settings' })
    expect(redeemAttempts).toBe(2)
    expect(installMutations).toBe(1)

    await expect(brokered.complete(completeInput)).rejects.toMatchObject({ code: 'invalid_or_expired_state' })
    expect(redeemAttempts).toBe(2)
    expect(installMutations).toBe(1)
  })

  test('a claimed flow fails closed after its 24-hour recovery window', async () => {
    let calls = 0
    transport = {
      ...transport,
      authority: 'platform_broker',
      async completeAuthorization() {
        calls += 1
        throw new PlatformRequestError('broker_unavailable', true)
      },
    }
    const brokered = new IntegrationAuthorizationService({
      states,
      resolvePlugin: (key) => (key === 'notion' ? createPlugin() : undefined),
      transport,
      callbackUrl: () => 'https://tau.example/settings/integrations/oauth/callback',
      installGrant: async (input) => void (await input.exchange()),
      uuid: () => '80000000-0000-4000-8000-000000000099',
      now: () => states.now,
    })
    await brokered.start({
      providerKey: 'notion',
      userId: 'user-1',
      returnTo: '/settings',
      intent: { kind: 'connect' },
    })
    const input = {
      providerKey: 'notion',
      userId: 'user-1',
      localFlowId: '80000000-0000-4000-8000-000000000099',
      handle: completionHandle,
    }
    await expect(brokered.complete(input)).rejects.toMatchObject({ code: 'broker_unavailable' })
    states.now = new Date('2026-08-30T00:00:00.001Z')
    await expect(brokered.complete(input)).rejects.toMatchObject({ code: 'invalid_or_expired_state' })
    expect(calls).toBe(1)
  })

  test('terminal completion loss burns the claimed flow while transient failures retain it', async () => {
    let calls = 0
    transport = {
      ...transport,
      authority: 'platform_broker',
      async completeAuthorization() {
        calls += 1
        throw new PlatformRequestError('completion_not_found', false, 404)
      },
    }
    const brokered = new IntegrationAuthorizationService({
      states,
      resolvePlugin: (key) => (key === 'notion' ? createPlugin() : undefined),
      transport,
      callbackUrl: () => 'https://tau.example/settings/integrations/oauth/callback',
      installGrant: async (input) => void (await input.exchange()),
      uuid: () => '80000000-0000-4000-8000-000000000099',
      now: () => states.now,
    })
    await brokered.start({
      providerKey: 'notion',
      userId: 'user-1',
      returnTo: '/settings',
      intent: { kind: 'connect' },
    })
    const input = {
      providerKey: 'notion',
      userId: 'user-1',
      localFlowId: '80000000-0000-4000-8000-000000000099',
      handle: completionHandle,
    }
    await expect(brokered.complete(input)).rejects.toMatchObject({ code: 'completion_not_found' })
    await expect(brokered.complete(input)).rejects.toMatchObject({ code: 'invalid_or_expired_state' })
    expect(calls).toBe(1)
  })

  test('terminal completion retains recovery when durable flow burn fails', async () => {
    let calls = 0
    transport = {
      ...transport,
      authority: 'platform_broker',
      async completeAuthorization() {
        calls += 1
        throw new PlatformRequestError('completion_not_found', false, 404)
      },
    }
    const brokered = new IntegrationAuthorizationService({
      states,
      resolvePlugin: (key) => (key === 'notion' ? createPlugin() : undefined),
      transport,
      callbackUrl: () => 'https://tau.example/settings/integrations/oauth/callback',
      installGrant: async (input) => void (await input.exchange()),
      uuid: () => '80000000-0000-4000-8000-000000000099',
      now: () => states.now,
    })
    await brokered.start({
      providerKey: 'notion',
      userId: 'user-1',
      returnTo: '/settings',
      intent: { kind: 'connect' },
    })
    const input = {
      providerKey: 'notion',
      userId: 'user-1',
      localFlowId: '80000000-0000-4000-8000-000000000099',
      handle: completionHandle,
    }
    states.burnFailures = 1
    await expect(brokered.complete(input)).rejects.toMatchObject({ code: 'flow_finalization_failed' })
    expect(states.rows.size).toBe(1)
    await expect(brokered.complete(input)).rejects.toMatchObject({ code: 'completion_not_found' })
    await expect(brokered.complete(input)).rejects.toMatchObject({ code: 'invalid_or_expired_state' })
    expect(calls).toBe(2)
  })

  test('an install that revokes or abandons the grant burns the completion flow', async () => {
    let calls = 0
    transport = {
      ...transport,
      authority: 'platform_broker',
      async completeAuthorization() {
        calls += 1
        return {
          configuration: { workspaceId: 'workspace-1' },
          tokens: { accessToken: 'access-token-SENTINEL', refreshToken: null, expiresAt: null },
          displayName: 'Workspace',
        }
      },
    }
    const brokered = new IntegrationAuthorizationService({
      states,
      resolvePlugin: (key) => (key === 'notion' ? createPlugin() : undefined),
      transport,
      callbackUrl: () => 'https://tau.example/settings/integrations/oauth/callback',
      installGrant: async (input) => {
        await input.exchange()
        throw Object.assign(new Error('grant abandoned'), { code: 'grant_abandoned' })
      },
      uuid: () => '80000000-0000-4000-8000-000000000099',
      now: () => states.now,
    })
    await brokered.start({
      providerKey: 'notion',
      userId: 'user-1',
      returnTo: '/settings',
      intent: { kind: 'connect' },
    })
    const input = {
      providerKey: 'notion',
      userId: 'user-1',
      localFlowId: '80000000-0000-4000-8000-000000000099',
      handle: completionHandle,
    }
    await expect(brokered.complete(input)).rejects.toMatchObject({ code: 'grant_abandoned' })
    await expect(brokered.complete(input)).rejects.toMatchObject({ code: 'invalid_or_expired_state' })
    expect(calls).toBe(1)
  })

  test('a crash after broker redemption but before local persistence replays the ledger grant', async () => {
    let redeemAttempts = 0
    let installAttempts = 0
    transport = {
      ...transport,
      authority: 'platform_broker',
      async completeAuthorization() {
        redeemAttempts += 1
        return {
          configuration: { workspaceId: 'workspace-1' },
          tokens: { accessToken: 'access-token-SENTINEL', refreshToken: null, expiresAt: null },
          displayName: 'Workspace',
        }
      },
    }
    const brokered = new IntegrationAuthorizationService({
      states,
      resolvePlugin: (key) => (key === 'notion' ? createPlugin() : undefined),
      transport,
      callbackUrl: () => 'https://tau.example/settings/integrations/oauth/callback',
      installGrant: async (input) => {
        await input.exchange()
        installAttempts += 1
        if (installAttempts === 1) throw new Error('simulated crash before local persistence')
      },
      uuid: () => '80000000-0000-4000-8000-000000000099',
      now: () => states.now,
    })
    await brokered.start({
      providerKey: 'notion',
      userId: 'user-1',
      returnTo: '/settings',
      intent: { kind: 'connect' },
    })
    const input = {
      providerKey: 'notion',
      userId: 'user-1',
      localFlowId: '80000000-0000-4000-8000-000000000099',
      handle: completionHandle,
    }
    await expect(brokered.complete(input)).rejects.toMatchObject({ code: 'grant_persistence_failed' })
    expect(await brokered.complete(input)).toEqual({ returnTo: '/settings' })
    expect(redeemAttempts).toBe(2)
    expect(installAttempts).toBe(2)
  })

  test('a finalization crash retries idempotent install and concurrent duplicates converge', async () => {
    let installMutations = 0
    const installedFlows = new Set<string>()
    transport = {
      ...transport,
      authority: 'platform_broker',
      async completeAuthorization() {
        return {
          configuration: { workspaceId: 'workspace-1' },
          tokens: { accessToken: 'access-token-SENTINEL', refreshToken: null, expiresAt: null },
          displayName: 'Workspace',
        }
      },
    }
    const brokered = new IntegrationAuthorizationService({
      states,
      resolvePlugin: (key) => (key === 'notion' ? createPlugin() : undefined),
      transport,
      callbackUrl: () => 'https://tau.example/settings/integrations/oauth/callback',
      installGrant: async (input) => {
        await input.exchange()
        if (!installedFlows.has(input.state.localFlowId!)) {
          installedFlows.add(input.state.localFlowId!)
          installMutations += 1
        }
      },
      uuid: () => '80000000-0000-4000-8000-000000000099',
      now: () => states.now,
    })
    await brokered.start({
      providerKey: 'notion',
      userId: 'user-1',
      returnTo: '/settings',
      intent: { kind: 'connect' },
    })
    const input = {
      providerKey: 'notion',
      userId: 'user-1',
      localFlowId: '80000000-0000-4000-8000-000000000099',
      handle: completionHandle,
    }
    states.finishFailures = 1
    await expect(brokered.complete(input)).rejects.toMatchObject({ code: 'flow_finalization_failed' })
    expect(await brokered.complete(input)).toEqual({ returnTo: '/settings' })
    expect(installMutations).toBe(1)

    installedFlows.clear()
    await brokered.start({
      providerKey: 'notion',
      userId: 'user-1',
      returnTo: '/settings',
      intent: { kind: 'connect' },
    })
    await Promise.all([brokered.complete(input), brokered.complete(input)])
    expect(installMutations).toBe(2)
  })

  test('a missing hosted broker configuration fails closed with broker_unconfigured', async () => {
    transport = {
      ...transport,
      authority: 'platform_broker',
      async authorizationUrl() {
        throw new BrokerUnconfiguredError()
      },
    }
    const brokered = new IntegrationAuthorizationService({
      states,
      resolvePlugin: (key) => (key === 'notion' ? createPlugin() : undefined),
      transport,
      callbackUrl: () => 'https://tau.example/settings/integrations/oauth/callback',
      installGrant: async () => {},
      uuid: () => '80000000-0000-4000-8000-000000000099',
    })
    await brokered
      .start({ providerKey: 'notion', userId: 'user-1', returnTo: '/settings', intent: { kind: 'connect' } })
      .then(() => {
        throw new Error('expected broker configuration failure')
      })
      .catch((error) => expectFlowCode(error, 'broker_unconfigured'))
  })

  test.each(['https://evil.test/authorize', 'https://api.notion.com:444/authorize'])(
    'rejects a broker authorization URL outside the exact adapter host allowlist: %s',
    async (unsafeAuthorizationUrl) => {
      transport = {
        ...transport,
        authority: 'platform_broker',
        async authorizationUrl() {
          return { authorizationUrl: unsafeAuthorizationUrl, expiresAt: '2026-08-29T00:10:00.000Z' }
        },
      }
      const brokered = new IntegrationAuthorizationService({
        states,
        resolvePlugin: (key) => (key === 'notion' ? createPlugin() : undefined),
        transport,
        callbackUrl: () => 'https://tau.example/settings/integrations/oauth/callback',
        installGrant: async () => {},
        uuid: () => '80000000-0000-4000-8000-000000000099',
        now: () => new Date('2026-08-29T00:00:00.000Z'),
      })
      await brokered
        .start({ providerKey: 'notion', userId: 'user-1', returnTo: '/settings', intent: { kind: 'connect' } })
        .then(() => {
          throw new Error('expected unsafe broker URL denial')
        })
        .catch((error) => expectFlowCode(error, 'authorization_url_failed'))
    }
  )

  test('provider denial consumes state, never exchanges, and drops raw descriptions', async () => {
    const started = await service.start({
      providerKey: 'notion',
      userId: 'user-1',
      returnTo: '/settings',
      intent: { kind: 'connect' },
    })
    const state = new URL(started.authorizationUrl).searchParams.get('state')!
    await service
      .callback({
        providerKey: 'notion',
        userId: 'user-1',
        state,
        denied: true,
      })
      .then(() => {
        throw new Error('expected provider denial')
      })
      .catch((error) => {
        expectFlowCode(error, 'provider_denied')
        expect(String(error)).not.toContain('raw-provider-description-SENTINEL')
      })
    expect(calls.exchanges).toHaveLength(0)
    expect(JSON.stringify(audits)).not.toContain('raw-provider-description-SENTINEL')
    expect(JSON.stringify(audits)).not.toContain('access-token-SENTINEL')
  })

  test('malformed code/error combinations burn state before failing', async () => {
    const started = await service.start({
      providerKey: 'notion',
      userId: 'user-1',
      returnTo: '/settings',
      intent: { kind: 'connect' },
    })
    const state = new URL(started.authorizationUrl).searchParams.get('state')!
    await service
      .callback({ providerKey: 'notion', userId: 'user-1', state, code: 'code', denied: true })
      .then(() => {
        throw new Error('expected malformed callback')
      })
      .catch((error) => expectFlowCode(error, 'malformed_callback'))
    expect(calls.exchanges).toHaveLength(0)
    await service
      .callback({ providerKey: 'notion', userId: 'user-1', state, code: 'code' })
      .then(() => {
        throw new Error('expected consumed state')
      })
      .catch((error) => expectFlowCode(error, 'invalid_or_expired_state'))
  })

  test.each([
    'https://evil.example',
    '//evil.example/path',
    '/\\evil',
    '/settings/%0aheader',
    '/settings?next=https://evil.example',
  ])('rejects unsafe return targets %#', async (returnTo) => {
    await service
      .start({ providerKey: 'notion', userId: 'user-1', returnTo, intent: { kind: 'connect' } })
      .then(() => {
        throw new Error('expected unsafe return denial')
      })
      .catch((error) => expectFlowCode(error, 'unsafe_return_target'))
    expect(states.rows.size).toBe(0)
  })
})

describe('IntegrationAuthorizationService: manual+managed provider (Slack-shaped)', () => {
  function createManualWithManagedPlugin(): IntegrationPluginV1<{ version: 1; teamId?: string }, string> {
    const managed: ManagedOAuthDriver<{ version: 1; teamId?: string }> = {
      kind: 'oauth2',
      adapter: 'slack',
      authorities: ['platform_broker'],
      identity: (configuration) => ({ teamId: configuration.teamId ?? '' }),
      async validate() {
        return { ok: true, grantedScopes: [] }
      },
    }
    return {
      manifestVersion: 1,
      key: 'slack',
      adapterVersion: 1,
      presentation: {
        label: 'Slack',
        description: 'Slack',
        icon: 'slack',
        connectionMode: 'channel',
        assignable: false,
        requiredCapabilities: [],
      },
      connection: {
        parseConfiguration: (value) => value as { version: 1; teamId?: string },
        safeConfiguration: (value) => value,
        credential: { parse: String, serialize: String },
      },
      authorization: { kind: 'manual', managed },
      runtime: {
        provider: {
          key: 'slack',
          adapterVersion: 1,
          parseConfig: (value) => value as { version: 1; teamId?: string },
          validate: async () => ({ ok: true, grantedScopes: [] }),
          capabilities: {},
        },
      },
      sandbox: {
        packages: [],
        setupSteps: [],
        initHooks: [],
        readiness: [],
        skills: [],
        extensions: [],
        protectedBindings: [],
      },
      lifecycle: { refresh: false, revoke: false },
      classifyError: () => ({ code: 'provider_unavailable', retryable: true }),
    }
  }

  test('local authority: starting Slack fails cleanly — no managed offer, no state row created', async () => {
    const states = new MemoryStateRepository()
    const plugin = createManualWithManagedPlugin()
    const transport: OAuthTransport = {
      authority: 'local',
      async authorizationUrl() {
        throw new Error('must not be reached: no OAuth flow is offered on local authority')
      },
      async completeAuthorization() {
        throw new Error('unused')
      },
      async refresh() {
        throw new Error('unused')
      },
      async revoke() {},
    }
    const service = new IntegrationAuthorizationService({
      states,
      resolvePlugin: (key) => (key === 'slack' ? plugin : undefined),
      transport,
      callbackUrl: () => 'https://tau.example/settings/integrations/oauth/callback',
      installGrant: async () => {
        throw new Error('must not be reached')
      },
      randomBytes: () => Buffer.alloc(32, 7),
    })
    await service
      .start({
        providerKey: 'slack',
        userId: 'user-1',
        returnTo: '/settings/integrations',
        intent: { kind: 'connect' },
      })
      .then(() => {
        throw new Error('expected local-authority Slack start to fail')
      })
      .catch((error) => expectFlowCode(error, 'unsupported_provider'))
    expect(states.rows.size).toBe(0)
  })

  test('platform_broker authority: starting Slack succeeds through the managed driver', async () => {
    const restoreAdapter = registerOAuthProviderAdapterForTest(
      createFakeAdapter({ responses: [], revoked: [], calls: [] }, 'slack')
    )
    try {
      const states = new MemoryStateRepository()
      const plugin = createManualWithManagedPlugin()
      const transport: OAuthTransport = {
        authority: 'platform_broker',
        async authorizationUrl(input) {
          return {
            authorizationUrl: `https://fake.test/oauth/authorize?state=${input.localFlowId}`,
            expiresAt: '2026-08-29T00:10:00.000Z',
          }
        },
        async completeAuthorization() {
          throw new Error('unused')
        },
        async refresh() {
          throw new Error('unused')
        },
        async revoke() {},
      }
      const service = new IntegrationAuthorizationService({
        states,
        resolvePlugin: (key) => (key === 'slack' ? plugin : undefined),
        transport,
        callbackUrl: () => 'https://tau.example/settings/integrations/oauth/callback',
        installGrant: async () => {
          throw new Error('unused')
        },
        randomBytes: () => Buffer.alloc(32, 7),
        uuid: () => '80000000-0000-4000-8000-000000000099',
      })
      const result = await service.start({
        providerKey: 'slack',
        userId: 'user-1',
        returnTo: '/settings/integrations',
        intent: { kind: 'connect' },
      })
      expect(result.authorizationUrl).toBe(
        'https://fake.test/oauth/authorize?state=80000000-0000-4000-8000-000000000099'
      )
      expect(states.rows.size).toBe(1)
      expect([...states.rows.values()][0]).toMatchObject({ providerKey: 'slack', authority: 'platform_broker' })
    } finally {
      restoreAdapter()
    }
  })
})
