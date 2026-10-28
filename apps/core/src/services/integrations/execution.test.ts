import { describe, expect, test } from 'bun:test'
import { IntegrationExecutionService, executionVariableNames } from './execution'
import { linearPlugin } from './linear/plugin'
import { githubPlugin } from './github/plugin'
import type { AssignedIntegrationConnectionRecord } from './connection-repository'

const now = new Date('2026-10-28T00:00:00Z')
const row: AssignedIntegrationConnectionRecord = {
  id: 'account',
  squadId: 'squad',
  providerKey: 'linear',
  adapterVersion: 1,
  clientAuthority: 'local',
  authorizationFlowId: null,
  displayName: 'fixture',
  configuration: { version: 1 },
  credentialRef: 'synthetic-ref',
  materialRevision: 'r1',
  validatedRevision: 'r1',
  enabled: true,
  authState: 'authenticated',
  healthState: 'healthy',
  grantedScopes: [],
  validatedAt: now,
  validationExpiresAt: new Date(now.getTime() + 60_000),
  lastErrorCode: null,
  updatedAt: now,
}
function fixture(
  connection: AssignedIntegrationConnectionRecord | null = row,
  credential: unknown = 'synthetic-linear-token'
) {
  const reads: string[] = []
  const arbitrary = {
    ...linearPlugin,
    key: 'example',
    execution: {
      binaries: ['example'],
      environment: { EXAMPLE_TOKEN: ({ credential }: { credential: string }) => credential },
    },
  }
  const service = new IntegrationExecutionService({
    plugins: [linearPlugin, githubPlugin, arbitrary],
    assignments: {
      getAssigned: async (squad, provider) =>
        connection?.squadId === squad && connection.providerKey === provider ? connection : null,
      getAssignedById: async (squad, provider, id) =>
        connection?.squadId === squad && connection.providerKey === provider && connection.id === id
          ? connection
          : null,
    },
    readCredential: async (ref) => {
      reads.push(ref)
      return credential
    },
    authority: () => 'local',
    now: () => now,
  })
  return { service, reads }
}

describe('generic per-command execution', () => {
  test('maps any declared provider, not just hardcoded providers', async () => {
    const { service } = fixture({ ...row, providerKey: 'example' })
    expect(await service.environment('squad', 'example')).toEqual({ EXAMPLE_TOKEN: 'synthetic-linear-token' })
    expect(executionVariableNames([linearPlugin, githubPlugin])).toEqual([
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GITHUB_USER',
      'LINEAR_API_KEY',
    ])
  })
  test('resolves defaults and explicit attached accounts; refuses other squads/accounts', async () => {
    const { service } = fixture()
    expect(await service.environment('squad', 'linear')).toEqual({ LINEAR_API_KEY: 'synthetic-linear-token' })
    expect(await service.environment('squad', 'linear', 'account')).toEqual({
      LINEAR_API_KEY: 'synthetic-linear-token',
    })
    expect(await service.environment('squad', 'linear', 'not-attached')).toBeNull()
    expect(await service.environment('other', 'linear')).toBeNull()
    expect(await service.environment('squad', 'channel')).toBeNull()
  })
  test.each([
    { enabled: false },
    { authState: 'invalid' },
    { healthState: 'degraded' },
    { validatedRevision: 'old' },
    { validationExpiresAt: now },
    { validationExpiresAt: null },
    { adapterVersion: 2 },
  ])('refuses unusable connections before reading credentials: %j', async (override) => {
    const { service, reads } = fixture({ ...row, ...override } as AssignedIntegrationConnectionRecord)
    expect(await service.environment('squad', 'linear')).toBeNull()
    expect(reads).toEqual([])
  })
  test('refuses unassigned and malformed credentials', async () => {
    expect(await fixture(null).service.environment('squad', 'linear')).toBeNull()
    expect(await fixture(row, null).service.environment('squad', 'linear')).toBeNull()
  })
  test('GitHub declares account login and fresh OAuth tokens; rejects authority and expiry', async () => {
    const github = { ...row, providerKey: 'github', configuration: { version: 1, userId: 7, login: 'fixture' } }
    const credential = {
      version: 1,
      accessToken: 'synthetic-gh-access',
      refreshToken: null,
      tokenRevision: 1,
      expiresAt: null,
    }
    expect(await fixture(github, JSON.stringify(credential)).service.environment('squad', 'github')).toEqual({
      GH_TOKEN: 'synthetic-gh-access',
      GITHUB_TOKEN: 'synthetic-gh-access',
      GITHUB_USER: 'fixture',
    })
    expect(
      await fixture(
        { ...github, clientAuthority: 'platform_broker' } as AssignedIntegrationConnectionRecord,
        JSON.stringify(credential)
      ).service.environment('squad', 'github')
    ).toBeNull()
    expect(
      await fixture(github, JSON.stringify({ ...credential, expiresAt: now.toISOString() })).service.environment(
        'squad',
        'github'
      )
    ).toBeNull()
  })
})
