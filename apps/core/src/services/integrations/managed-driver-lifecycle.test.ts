import { describe, expect, test } from 'bun:test'
import type { IntegrationPluginV1, ManagedOAuthDriver } from './plugin'
import type {
  AssignedIntegrationConnectionRecord,
  IntegrationConnectionRecord,
  IntegrationConnectionRepository,
} from './connection-repository'
import {
  connectionOAuthView,
  connectionRequiresRemoteRevocation,
  isFencedOAuthConnection,
  oauthFencingAuthority,
  refreshableOAuthProviderKeys,
} from './oauth-plugin-view'
import { IntegrationExecutionService } from './execution'
import { IntegrationConnectionService } from './connection-service'
import { IntegrationRefreshService } from './authorization/refresh-service'
import type { ConnectionAuthorizationLease } from './authorization/connection-lease'
import {
  parseOAuthCredential,
  serializeOAuthCredential,
  type OAuthCredentialBundleV1,
} from './authorization/credential-bundle'
import type { OAuthAuthority } from './authorization/authority'
import { createChannelPlugins } from './channels/plugins'
import { githubPlugin } from './github/plugin'
import { notionPlugin } from './notion/plugin'
import { linearPlugin } from './linear/plugin'

/**
 * A manual plugin that also offers a managed OAuth driver (the shape Linear's
 * agent app uses next to API keys). Every OAuth lifecycle step must apply to
 * its `oauth2` connections and to none of its `manual` connections.
 */
interface DualConfiguration {
  version: 1
  workspaceId: string
}
type DualCredential = { kind: 'key'; key: string } | { kind: 'oauth'; bundle: OAuthCredentialBundleV1 }

const now = new Date('2026-11-20T00:00:00.000Z')
const validations: string[] = []

const dualManaged: ManagedOAuthDriver<DualConfiguration> = {
  kind: 'oauth2',
  adapter: 'fake-dual-app',
  authorities: ['local', 'platform_broker'],
  identity: (configuration) => ({ workspaceId: configuration.workspaceId }),
  refreshInvalidatesPreviousTokens: true,
  validate: async ({ credential }) => {
    validations.push(credential.accessToken)
    return { ok: true, grantedScopes: [] }
  },
}

const dualPlugin: IntegrationPluginV1<DualConfiguration, DualCredential> = {
  manifestVersion: 1,
  key: 'fake-dual',
  adapterVersion: 1,
  presentation: {
    label: 'Fake dual',
    description: 'Fake dual-mode provider',
    icon: 'linear',
    connectionMode: 'credential',
    assignable: true,
    requiredCapabilities: [],
  },
  connection: {
    parseConfiguration: (value) => value as DualConfiguration,
    safeConfiguration: (value) => value,
    credential: {
      // A union codec: OAuth bundles are JSON, manual keys never are.
      parse: (value) => {
        try {
          return { kind: 'oauth', bundle: parseOAuthCredential(value) }
        } catch {
          if (typeof value !== 'string' || !value) throw new Error('invalid credential')
          return { kind: 'key', key: value }
        }
      },
      serialize: (value) => (value.kind === 'key' ? value.key : serializeOAuthCredential(value.bundle)),
    },
  },
  authorization: { kind: 'manual', managed: dualManaged },
  runtime: {
    provider: {
      key: 'fake-dual',
      adapterVersion: 1,
      parseConfig: (value) => value as DualConfiguration,
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
  execution: {
    binaries: ['fake-dual'],
    environment: {
      FAKE_DUAL_TOKEN: ({ credential }) =>
        credential.kind === 'key' ? credential.key : `Bearer ${credential.bundle.accessToken}`,
    },
  },
  lifecycle: { refresh: true, revoke: true },
  classifyError: () => ({ code: 'provider_unavailable', retryable: true }),
}

const slackPlugin = createChannelPlugins({ fetch: (async () => new Response('{}')) as unknown as typeof fetch })
  .slack as unknown as IntegrationPluginV1<unknown, unknown>

function record(overrides: Partial<AssignedIntegrationConnectionRecord> = {}): AssignedIntegrationConnectionRecord {
  return {
    id: 'connection',
    squadId: 'squad',
    providerKey: 'fake-dual',
    adapterVersion: 1,
    clientAuthority: 'local',
    authorizationKind: 'manual',
    authorizationFlowId: null,
    displayName: 'Fixture',
    configuration: { version: 1, workspaceId: 'workspace-1' },
    credentialRef: 'synthetic-ref',
    materialRevision: 'revision-1',
    validatedRevision: 'revision-1',
    enabled: true,
    authState: 'authenticated',
    healthState: 'healthy',
    grantedScopes: [],
    validatedAt: now,
    validationExpiresAt: new Date(now.getTime() + 60_000),
    lastErrorCode: null,
    updatedAt: now,
    ...overrides,
  }
}

function bundle(overrides: Partial<OAuthCredentialBundleV1> = {}): OAuthCredentialBundleV1 {
  return {
    version: 1,
    accessToken: 'synthetic-access',
    refreshToken: 'synthetic-refresh',
    expiresAt: new Date(now.getTime() + 24 * 3_600_000).toISOString(),
    tokenRevision: 1,
    ...overrides,
  }
}

const manualRow = record({ id: 'manual', authorizationKind: 'manual' })
const oauthRow = record({ id: 'oauth', authorizationKind: 'oauth2' })

describe('per-connection OAuth view', () => {
  test('only oauth2 connections of a manual+managed plugin get the managed OAuth view', () => {
    const view = connectionOAuthView(dualPlugin, oauthRow)
    expect(view?.authorization).toBe(dualManaged)
    expect(connectionOAuthView(dualPlugin, manualRow)).toBeUndefined()
    // An oauth2 row under an authority the driver is not offered under has no view.
    const brokerOnly = {
      ...dualPlugin,
      authorization: {
        kind: 'manual' as const,
        managed: { ...dualManaged, authorities: ['platform_broker' as const] },
      },
    }
    expect(connectionOAuthView(brokerOnly, oauthRow)).toBeUndefined()
  })

  test('a true OAuth2 plugin is viewed only through its oauth2 connections', () => {
    expect(connectionOAuthView(notionPlugin, { authorizationKind: 'oauth2', clientAuthority: 'local' })).toBe(
      notionPlugin as never
    )
    expect(connectionOAuthView(notionPlugin, { authorizationKind: 'manual', clientAuthority: 'local' })).toBeUndefined()
  })

  test('authority fencing applies to oauth2 connections only', () => {
    for (const authority of ['local', 'platform_broker'] as const) {
      expect(isFencedOAuthConnection(dualPlugin, { ...manualRow, clientAuthority: authority }, 'platform_broker')).toBe(
        false
      )
      expect(oauthFencingAuthority(manualRow, authority)).toBeUndefined()
      expect(oauthFencingAuthority(oauthRow, authority)).toBe(authority)
    }
    expect(isFencedOAuthConnection(dualPlugin, oauthRow, 'local')).toBe(false)
    expect(isFencedOAuthConnection(dualPlugin, oauthRow, 'platform_broker')).toBe(true)
  })

  test('remote revocation is required for oauth2 connections only', () => {
    expect(connectionRequiresRemoteRevocation(dualPlugin, oauthRow)).toBe(true)
    expect(connectionRequiresRemoteRevocation(dualPlugin, manualRow)).toBe(false)
    expect(connectionRequiresRemoteRevocation(dualPlugin, { ...oauthRow, adapterVersion: 2 })).toBe(false)
    expect(connectionRequiresRemoteRevocation(undefined, oauthRow)).toBe(false)
  })

  test('the refresh sweep covers OAuth2 plugins and managed drivers that opt into refresh', () => {
    expect(
      refreshableOAuthProviderKeys([dualPlugin, githubPlugin, notionPlugin, linearPlugin, slackPlugin]).sort()
    ).toEqual(['fake-dual', 'github', 'linear', 'notion'])
  })
})

describe('execution for a manual+managed plugin', () => {
  function service(connection: AssignedIntegrationConnectionRecord, raw: string, authority: OAuthAuthority = 'local') {
    return new IntegrationExecutionService({
      plugins: [dualPlugin],
      assignments: { getAssigned: async () => connection },
      readCredential: async () => raw,
      authority: () => authority,
      now: () => now,
    })
  }

  test('an oauth2 connection gets a fresh token and is refused once its access token expires', async () => {
    const fresh = serializeOAuthCredential(bundle())
    expect(await service(oauthRow, fresh).environment('squad', 'fake-dual')).toEqual({
      FAKE_DUAL_TOKEN: 'Bearer synthetic-access',
    })
    const expired = serializeOAuthCredential(bundle({ expiresAt: now.toISOString() }))
    expect(await service(oauthRow, expired).environment('squad', 'fake-dual')).toBeNull()
  })

  test('an oauth2 connection is fenced to its client authority', async () => {
    const fresh = serializeOAuthCredential(bundle())
    expect(await service(oauthRow, fresh, 'platform_broker').environment('squad', 'fake-dual')).toBeNull()
    expect(
      await service({ ...oauthRow, clientAuthority: 'platform_broker' }, fresh, 'platform_broker').environment(
        'squad',
        'fake-dual'
      )
    ).toEqual({ FAKE_DUAL_TOKEN: 'Bearer synthetic-access' })
  })

  test('a manual connection has no expiry check and no authority fence', async () => {
    expect(await service(manualRow, 'synthetic-key').environment('squad', 'fake-dual')).toEqual({
      FAKE_DUAL_TOKEN: 'synthetic-key',
    })
    expect(await service(manualRow, 'synthetic-key', 'platform_broker').environment('squad', 'fake-dual')).toEqual({
      FAKE_DUAL_TOKEN: 'synthetic-key',
    })
  })
})

describe('refresh for a manual+managed plugin', () => {
  function harness(connection: IntegrationConnectionRecord, raw: string, authority: OAuthAuthority = 'local') {
    let stored = raw
    const transportCalls: string[] = []
    const reauthorizations: string[] = []
    const service = new IntegrationRefreshService({
      connections: {
        get: async () => connection,
        markReauthorizationRequired: async (input) => {
          reauthorizations.push(input.code)
          return true
        },
        recordValidation: async () => true,
        recordRefreshFailure: async () => true,
      },
      credentials: {
        get: () => stored,
        refreshKey: async () => {},
        mutateSecret: async (_key, mutate) => {
          stored = mutate(stored) ?? stored
        },
      },
      resolvePlugin: (key) => (key === dualPlugin.key ? dualPlugin : undefined),
      transport: {
        authority,
        refresh: async (input) => {
          transportCalls.push(input.providerKey)
          return {
            tokens: { accessToken: 'synthetic-access-2', refreshToken: 'synthetic-refresh-2', expiresAt: null },
            configuration: null,
            displayName: 'Fixture',
          }
        },
      },
      lease: {
        runExclusive: (_resource: string, operation: () => Promise<unknown>) => operation(),
      } as never as ConnectionAuthorizationLease,
      invalidateAssignments: async () => {},
      now: () => now,
    })
    return { service, transportCalls, reauthorizations, stored: () => stored }
  }

  test('an oauth2 connection refreshes through the managed driver', async () => {
    const due = serializeOAuthCredential(bundle({ expiresAt: new Date(now.getTime() + 60_000).toISOString() }))
    const h = harness(oauthRow, due)
    expect(await h.service.refresh(oauthRow.id, 'proactive')).toEqual({ status: 'refreshed' })
    expect(h.transportCalls).toEqual(['fake-dual-app'])
    expect(parseOAuthCredential(h.stored())).toMatchObject({
      accessToken: 'synthetic-access-2',
      refreshToken: 'synthetic-refresh-2',
      tokenRevision: 2,
    })
  })

  test('a manual connection is never refreshed or reconciled for authority, whatever the reason', async () => {
    for (const authority of ['local', 'platform_broker'] as const) {
      const h = harness(manualRow, 'synthetic-key', authority)
      for (const reason of ['proactive', 'explicit', 'authentication_failure'] as const) {
        expect(await h.service.refresh(manualRow.id, reason)).toEqual({
          status: 'unchanged',
          code: 'manual_connection',
        })
      }
      expect(h.transportCalls).toEqual([])
      expect(h.reauthorizations).toEqual([])
      expect(h.stored()).toBe('synthetic-key')
    }
  })

  test('an oauth2 connection from another client authority requires reauthorization', async () => {
    const h = harness({ ...oauthRow, clientAuthority: 'platform_broker' }, serializeOAuthCredential(bundle()))
    expect(await h.service.refresh(oauthRow.id, 'proactive')).toEqual({
      status: 'reauthorization_required',
      code: 'client_authority_mismatch',
    })
    expect(h.transportCalls).toEqual([])
  })
})

describe('removal and authority reconciliation for a manual+managed plugin', () => {
  function harness(connection: IntegrationConnectionRecord, authority: OAuthAuthority = 'local') {
    let row: IntegrationConnectionRecord | null = { ...connection }
    const revoked: string[] = []
    const deleted: string[] = []
    const repository = {
      get: async (id: string) => (row?.id === id ? row : null),
      delete: async () => {
        deleted.push(row!.credentialRef)
        const retiredCredentialRef = row!.credentialRef
        row = null
        return { status: 'updated' as const, value: { retiredCredentialRef } }
      },
      deleteWithRevocation: async () => {
        revoked.push(row!.credentialRef)
        const retiredCredentialRef = row!.credentialRef
        row = null
        return { status: 'updated' as const, value: { retiredCredentialRef } }
      },
      scheduleCredentialCleanup: async () => {},
      markReauthorizationRequired: async (input: { code: string }) => {
        row = { ...row!, authState: 'reauthorization_required', lastErrorCode: input.code }
        return true
      },
      recordValidation: async () => true,
    } as unknown as IntegrationConnectionRepository
    const service = new IntegrationConnectionService({
      repository,
      assignments: { usage: async () => ({ squadCount: 0, squads: [] }) },
      credentials: { get: () => 'synthetic', set: async () => {}, delete: async () => {} },
      resolveProvider: () => dualPlugin.runtime.provider as never,
      requiresRemoteRevocation: (candidate) => connectionRequiresRemoteRevocation(dualPlugin, candidate),
      currentOAuthAuthority: (candidate) => oauthFencingAuthority(candidate, authority),
    })
    return { service, revoked, deleted, row: () => row }
  }

  test('deleting an oauth2 connection schedules provider revocation; a manual one is only deleted', async () => {
    const oauth = harness(oauthRow)
    await oauth.service.remove(oauthRow.id)
    expect(oauth.revoked).toEqual([oauthRow.credentialRef])
    expect(oauth.deleted).toEqual([])

    const manual = harness(manualRow)
    await manual.service.remove(manualRow.id)
    expect(manual.revoked).toEqual([])
    expect(manual.deleted).toEqual([manualRow.credentialRef])
  })

  test('validation reconciles client authority for oauth2 connections only', async () => {
    const oauth = harness(oauthRow, 'platform_broker')
    expect(await oauth.service.validate(oauthRow.id)).toMatchObject({ authState: 'reauthorization_required' })

    const manual = harness(manualRow, 'platform_broker')
    expect(await manual.service.validate(manualRow.id)).toMatchObject({ authState: 'authenticated' })
    expect(manual.row()?.lastErrorCode).toBeNull()
  })
})

describe('Slack regression: managed and manual connections behave as before', () => {
  // The plugin-level rules that applied before connections carried an authorization kind.
  const legacyRequiresRevocation = (clientAuthority: OAuthAuthority) =>
    Boolean(
      slackPlugin.authorization.kind === 'manual' &&
      slackPlugin.authorization.managed?.authorities.includes(clientAuthority)
    )
  const managedSlack = record({
    providerKey: 'slack',
    clientAuthority: 'platform_broker',
    authorizationKind: 'oauth2',
    configuration: { version: 1, teamId: 'T1', botUserId: 'U1' },
  })
  const manualSlack = record({ providerKey: 'slack', clientAuthority: 'local', authorizationKind: 'manual' })

  test('a managed (brokered) Slack connection is revoked on delete and usable on the hosted authority', () => {
    expect(connectionRequiresRemoteRevocation(slackPlugin, managedSlack)).toBe(
      legacyRequiresRevocation('platform_broker')
    )
    expect(connectionRequiresRemoteRevocation(slackPlugin, managedSlack)).toBe(true)
    expect(isFencedOAuthConnection(slackPlugin, managedSlack, 'platform_broker')).toBe(false)
    expect(oauthFencingAuthority(managedSlack, 'platform_broker')).toBe('platform_broker')
    expect(connectionOAuthView(slackPlugin, managedSlack)?.authorization.adapter).toBe('slack')
  })

  test('a manually entered Slack app is never revoked, fenced or refreshed', () => {
    expect(connectionRequiresRemoteRevocation(slackPlugin, manualSlack)).toBe(legacyRequiresRevocation('local'))
    expect(connectionRequiresRemoteRevocation(slackPlugin, manualSlack)).toBe(false)
    for (const authority of ['local', 'platform_broker'] as const) {
      expect(isFencedOAuthConnection(slackPlugin, manualSlack, authority)).toBe(false)
      expect(oauthFencingAuthority(manualSlack, authority)).toBeUndefined()
    }
    expect(connectionOAuthView(slackPlugin, manualSlack)).toBeUndefined()
  })

  test('Slack stays out of the proactive refresh sweep because its lifecycle does not refresh', () => {
    expect(slackPlugin.lifecycle.refresh).toBe(false)
    expect(refreshableOAuthProviderKeys([slackPlugin])).toEqual([])
  })
})
