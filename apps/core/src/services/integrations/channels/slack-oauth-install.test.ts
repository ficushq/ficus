import { describe, expect, test } from 'bun:test'
import type { OAuthStateRecord } from '../authorization/state-repository'
import { serializeOAuthCredential, parseOAuthCredential } from '../authorization/credential-bundle'
import { OAuthConnectionAuthorizer, AuthorizationGrantAbandonedError } from '../authorization/connection-authorizer'
import type { IntegrationConnectionRecord } from '../connection-repository'
import { oauthPluginView } from '../oauth-plugin-view'
import { createChannelPlugins } from './plugins'

/**
 * The managed Slack driver installed through the same provider-neutral
 * `OAuthConnectionAuthorizer` GitHub/Notion use, proving a Slack broker grant
 * lands as a `platform_broker` connection row carrying the OAuth bundle
 * credential (bot token in `accessToken`) rather than the manual codec.
 */

/** A fake Slack auth.test keyed by bearer token, so validate() never touches the network. */
function fakeSlackFetch(routes: Record<string, { teamId: string; userId: string }>) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).includes('auth.test')) return new Response('not found', { status: 404 })
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    const token = auth.replace('Bearer ', '')
    const identity = routes[token]
    if (!identity) return Response.json({ ok: false, error: 'invalid_auth' })
    return Response.json({ ok: true, team_id: identity.teamId, user_id: identity.userId, team: 'Acme' })
  }) as typeof fetch
}

const grant = {
  configuration: { version: 1 as const, teamId: 'T1', botUserId: 'U1', teamName: 'Acme', appId: 'A1' },
  credential: {
    version: 1 as const,
    accessToken: 'xoxb-managed-token',
    refreshToken: null,
    expiresAt: null,
    tokenRevision: 1,
  },
  displayName: 'Acme',
}

function connectIntent(): OAuthStateRecord {
  return {
    stateHash: 'hash',
    localFlowId: '80000000-0000-4000-8000-000000000099',
    authority: 'platform_broker',
    completionHandleHash: null,
    recoveryExpiresAt: null,
    providerKey: 'slack',
    userId: 'user-1',
    intent: 'connect',
    connectionId: null,
    expectedMaterialRevision: null,
    redirectUri: 'https://ficus.example/callback',
    returnTo: '/settings/integrations',
    expiresAt: new Date(),
    createdAt: new Date(),
  }
}

function harness(fetchImpl: typeof fetch) {
  const slackOAuthPlugin = oauthPluginView(createChannelPlugins({ fetch: fetchImpl }).slack, 'platform_broker')!
  const staged = new Map<string, string>()
  const creates: unknown[] = []
  const enabled: string[] = []
  const revoked: string[] = []
  let created: IntegrationConnectionRecord | null = null

  const receipts = new Map<string, Record<string, unknown>>()
  const receiptFor = (localFlowId: string, adapterVersion: number | null = null) => {
    let receipt = receipts.get(localFlowId)
    if (!receipt) {
      receipt = {
        localFlowId,
        providerKey: 'slack',
        authority: 'platform_broker',
        intent: 'connect',
        initiatingUserId: 'user-1',
        returnTo: '/settings/integrations',
        completionHandleHash: 'a'.repeat(64),
        adapterVersion,
        sourceConnectionId: null,
        sourceMaterialRevision: null,
        artifactCredentialRef: `__integration-credential:authorization-flow:${localFlowId}:bearer`,
        stagingStartedAt: null,
        installKind: null,
        installedConnectionId: null,
        installedMaterialRevision: null,
        installedAt: null,
        terminalCode: null,
        terminalAt: null,
        revocationRequiredAt: null,
        revocationSettledAt: null,
        cleanupRequiredAt: null,
        cleanupSettledAt: null,
        recoveryExpiresAt: new Date('2026-08-30T00:00:00.000Z'),
        retainUntil: new Date('2026-08-30T00:00:00.000Z'),
      }
      receipts.set(localFlowId, receipt)
    }
    return receipt
  }

  const authorizer = new OAuthConnectionAuthorizer({
    identity: slackOAuthPlugin.authorization.identity!,
    repository: {
      get: async () => created,
      getByAuthorizationFlow: async () => null,
      list: async () => (created ? [created] : []),
      installAuthorizedMaterial: async () => ({ status: 'not_found' }),
      enqueueRevocation: async () => {},
      ownsRevocation: async () => false,
      abandonPendingAuthorization: async () => 'not_found',
    },
    flowReceipts: {
      getRecoverable: async (localFlowId) => receiptFor(localFlowId) as never,
      get: async (localFlowId) => receiptFor(localFlowId) as never,
      beginStaging: async (localFlowId, adapterVersion) => {
        const receipt = receiptFor(localFlowId, adapterVersion)
        receipt.stagingStartedAt ??= new Date()
        return receipt as never
      },
      markTerminal: async (localFlowId, code) => {
        const receipt = receiptFor(localFlowId)
        receipt.terminalCode ??= code
        receipt.terminalAt ??= new Date()
        return receipt as never
      },
      requireRevocation: async ({ localFlowId, code }) => {
        const receipt = receiptFor(localFlowId)
        receipt.terminalCode ??= code
        receipt.terminalAt ??= new Date()
        receipt.revocationRequiredAt ??= new Date()
        return receipt as never
      },
      requireCleanup: async (localFlowId, code) => {
        const receipt = receiptFor(localFlowId)
        receipt.terminalCode ??= code
        receipt.terminalAt ??= new Date()
        receipt.cleanupRequiredAt ??= new Date()
        return receipt as never
      },
    },
    stageRevocationArtifact: async (input) => {
      staged.set(input.credentialRef, input.credential)
    },
    connectionService: {
      create: async (input) => {
        creates.push(input)
        created = {
          id: 'new-slack-connection',
          providerKey: 'slack',
          adapterVersion: 1,
          clientAuthority: input.clientAuthority,
          authorizationFlowId: input.authorizationFlowId ?? null,
          displayName: input.displayName,
          configuration: input.configuration,
          credentialRef: `__integration-credential:authorization-flow:${input.authorizationFlowId}:bearer`,
          materialRevision: 'material-revision-1',
          validatedRevision: null,
          enabled: false,
          authState: 'pending',
          healthState: 'unknown',
          grantedScopes: [],
          validatedAt: null,
          validationExpiresAt: null,
          lastErrorCode: null,
          updatedAt: new Date(),
        }
        return { id: created.id }
      },
      validate: async () => {},
      enable: async (id) => {
        enabled.push(id)
        if (created) {
          created.enabled = true
          created.authState = 'authenticated'
        }
      },
      remove: async () => {},
      rollbackPendingLocal: async () => {},
    },
    credentials: {
      set: async (key, value) => {
        staged.set(key, value)
      },
      delete: async (key) => {
        staged.delete(key)
      },
    },
    plugin: slackOAuthPlugin,
    transport: {
      authority: 'platform_broker',
      revoke: async ({ token }) => {
        revoked.push(token)
      },
    },
    uuid: () => 'uuid-1',
    lease: {
      runExclusiveMany: async <T>(_resources: readonly string[], operation: () => Promise<T>): Promise<T> =>
        operation(),
    },
  })

  return { authorizer, staged, creates, enabled, revoked, getCreated: () => created }
}

describe('managed Slack OAuth install (OAuthConnectionAuthorizer over the Slack managed driver)', () => {
  test('a Slack broker grant installs as a platform_broker row carrying the OAuth bundle credential', async () => {
    const h = harness(fakeSlackFetch({ 'xoxb-managed-token': { teamId: 'T1', userId: 'U1' } }))
    await h.authorizer.install({ grant, intent: connectIntent(), userId: 'user-1' })

    expect(h.creates).toHaveLength(1)
    expect(h.creates[0]).toMatchObject({
      providerKey: 'slack',
      adapterVersion: 1,
      clientAuthority: 'platform_broker',
      configuration: { version: 1, teamId: 'T1', botUserId: 'U1', teamName: 'Acme', appId: 'A1' },
    })
    expect(h.enabled).toEqual(['new-slack-connection'])
    expect(h.revoked).toEqual([])

    const created = h.getCreated()!
    expect(created.clientAuthority).toBe('platform_broker')
    const serializedCredential = (h.creates[0] as { credential: string }).credential
    expect(parseOAuthCredential(serializedCredential)).toEqual({
      version: 1,
      accessToken: 'xoxb-managed-token',
      refreshToken: null,
      expiresAt: null,
      tokenRevision: 1,
    })
    expect(serializedCredential).toBe(serializeOAuthCredential(grant.credential))
  })

  test('the managed driver validates identity before install: a mismatched grant is abandoned, not persisted', async () => {
    // The fake API reports a different team/user than the grant's configuration claims.
    const h = harness(fakeSlackFetch({ 'xoxb-managed-token': { teamId: 'T-actual', userId: 'U-actual' } }))
    const error = await h.authorizer
      .install({ grant, intent: connectIntent(), userId: 'user-1' })
      .catch((value) => value)
    expect(error).toBeInstanceOf(AuthorizationGrantAbandonedError)
    expect(h.creates).toEqual([])
    expect(h.enabled).toEqual([])
  })
})
