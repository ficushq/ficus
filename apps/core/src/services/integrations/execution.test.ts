import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setLinearAppReadinessForTest } from './linear/app-readiness'
import { IntegrationExecutionService, executionVariableNames } from './execution'
import { linearPlugin } from './linear/plugin'
import { notionPlugin } from './notion/plugin'
import { githubPlugin } from './github/plugin'
import type { AssignedIntegrationConnectionRecord } from './connection-repository'

const now = new Date('2026-10-28T00:00:00Z')
const row: AssignedIntegrationConnectionRecord = {
  id: 'account',
  squadId: 'squad',
  providerKey: 'linear',
  adapterVersion: 1,
  clientAuthority: 'local',
  authorizationKind: 'manual',
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
    // An opaque string credential: Linear's own codec parses a key/OAuth union.
    connection: {
      ...linearPlugin.connection,
      credential: { parse: (value: unknown) => String(value), serialize: String },
    },
    execution: {
      binaries: ['example'],
      environment: { EXAMPLE_TOKEN: ({ credential }: { credential: string }) => credential },
    },
  }
  const service = new IntegrationExecutionService({
    plugins: [linearPlugin, githubPlugin, notionPlugin, arbitrary],
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
      'LINEAR_GRAPHQL_ENDPOINT',
      'LINEAR_IGNORE_ENV_FILE',
    ])
  })
  test('resolves defaults and explicit attached accounts; refuses other squads/accounts', async () => {
    const { service } = fixture()
    const linearEnvironment = {
      LINEAR_API_KEY: 'synthetic-linear-token',
      LINEAR_GRAPHQL_ENDPOINT: 'https://api.linear.app/graphql',
      LINEAR_IGNORE_ENV_FILE: '1',
    }
    expect(await service.environment('squad', 'linear')).toEqual(linearEnvironment)
    expect(await service.environment('squad', 'linear', 'account')).toEqual(linearEnvironment)
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
    const github = {
      ...row,
      providerKey: 'github',
      authorizationKind: 'oauth2' as const,
      configuration: { version: 1, userId: 7, login: 'fixture' },
    }
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

const notion = {
  ...row,
  providerKey: 'notion',
  authorizationKind: 'oauth2' as const,
  configuration: { version: 1, workspaceId: 'workspace', workspaceName: null, workspaceIcon: null, botId: 'bot' },
}
const notionCredential = {
  version: 1,
  accessToken: 'synthetic-notion-access',
  refreshToken: 'synthetic-notion-refresh',
  tokenRevision: 1,
  expiresAt: null,
}
test('Notion resolves default and explicit accounts per command and scrubs its token across providers', async () => {
  const { service } = fixture(notion, JSON.stringify(notionCredential))
  expect(await service.environment('squad', 'notion')).toEqual({ NOTION_API_TOKEN: notionCredential.accessToken })
  expect(await service.environment('squad', 'notion', 'account')).toEqual({
    NOTION_API_TOKEN: notionCredential.accessToken,
  })
  expect(await service.environment('squad', 'notion', 'detached')).toBeNull()
  expect(await service.environment('other', 'notion')).toBeNull()
  expect(executionVariableNames([linearPlugin, githubPlugin, notionPlugin])).toContain('NOTION_API_TOKEN')
})
test.each([
  { enabled: false },
  { authState: 'invalid' },
  { healthState: 'degraded' },
  { validatedRevision: 'old' },
  { validationExpiresAt: now },
  { clientAuthority: 'platform_broker' },
])('Notion refuses revoked, stale or wrong-authority credentials before reading: %j', async (override) => {
  const { service, reads } = fixture(
    { ...notion, ...override } as AssignedIntegrationConnectionRecord,
    JSON.stringify(notionCredential)
  )
  expect(await service.environment('squad', 'notion')).toBeNull()
  expect(reads).toEqual([])
})
test('Notion refuses expired or malformed OAuth bundles', async () => {
  for (const raw of ['malformed', JSON.stringify({ ...notionCredential, expiresAt: now.toISOString() })]) {
    expect(await fixture(notion, raw).service.environment('squad', 'notion')).toBeNull()
  }
})

test('Notion keeps explicit attached workspaces separate from the default and never falls back after detach', async () => {
  const alternate = {
    ...notion,
    id: 'alternate',
    credentialRef: 'alternate-ref',
    configuration: { ...notion.configuration, workspaceId: 'alternate-workspace' },
  }
  const attached = new Map([
    [notion.id, notion],
    [alternate.id, alternate],
  ])
  const service = new IntegrationExecutionService({
    plugins: [notionPlugin],
    authority: () => 'local',
    now: () => now,
    assignments: {
      getAssigned: async () => attached.get(notion.id) ?? null,
      getAssignedById: async (_squad, _provider, id) => attached.get(id) ?? null,
    },
    readCredential: async (ref) =>
      JSON.stringify({
        ...notionCredential,
        accessToken: ref === alternate.credentialRef ? 'synthetic-alternate-notion' : notionCredential.accessToken,
      }),
  })
  expect(await service.environment('squad', 'notion', alternate.id)).toEqual({
    NOTION_API_TOKEN: 'synthetic-alternate-notion',
  })
  expect(await service.environment('squad', 'notion')).toEqual({ NOTION_API_TOKEN: notionCredential.accessToken })
  attached.delete(notion.id)
  expect(await service.environment('squad', 'notion')).toBeNull()
  expect(await service.environment('squad', 'notion', alternate.id)).toEqual({
    NOTION_API_TOKEN: 'synthetic-alternate-notion',
  })
  attached.delete(alternate.id)
  expect(await service.environment('squad', 'notion', alternate.id)).toBeNull()
})

describe('Linear app connections', () => {
  let restoreReadiness: () => void
  beforeEach(() => {
    restoreReadiness = setLinearAppReadinessForTest({ local: true, platform_broker: true })
  })
  afterEach(() => restoreReadiness())

  const app = {
    ...row,
    authorizationKind: 'oauth2' as const,
    configuration: {
      version: 2,
      mode: 'app',
      organizationId: 'org-1',
      organizationName: 'Acme',
      organizationUrlKey: 'acme',
      appUserId: 'app-user',
      appUserName: 'Ficus',
      scopes: ['read', 'issues:create', 'comments:create', 'app:assignable', 'app:mentionable'],
    },
  }
  const bundle = {
    version: 1,
    accessToken: 'synthetic-linear-app-access',
    refreshToken: 'synthetic-linear-app-refresh',
    tokenRevision: 1,
    expiresAt: '2026-10-29T00:00:00.000Z',
  }

  test('inject the access token as a Bearer Authorization value', async () => {
    expect(await fixture(app, JSON.stringify(bundle)).service.environment('squad', 'linear')).toEqual({
      LINEAR_API_KEY: 'Bearer synthetic-linear-app-access',
      LINEAR_GRAPHQL_ENDPOINT: 'https://api.linear.app/graphql',
      LINEAR_IGNORE_ENV_FILE: '1',
    })
  })

  test('refuse expired tokens and connections fenced to another authority', async () => {
    expect(
      await fixture(app, JSON.stringify({ ...bundle, expiresAt: now.toISOString() })).service.environment(
        'squad',
        'linear'
      )
    ).toBeNull()
    const { service, reads } = fixture(
      { ...app, clientAuthority: 'platform_broker' } as AssignedIntegrationConnectionRecord,
      JSON.stringify(bundle)
    )
    expect(await service.environment('squad', 'linear')).toBeNull()
    expect(reads).toEqual([])
  })

  test('API-key connections are never fenced or expiry-checked as OAuth', async () => {
    const { service } = fixture(
      { ...row, clientAuthority: 'platform_broker' } as AssignedIntegrationConnectionRecord,
      'lin_api_synthetic'
    )
    expect((await service.environment('squad', 'linear'))?.LINEAR_API_KEY).toBe('lin_api_synthetic')
  })
})
