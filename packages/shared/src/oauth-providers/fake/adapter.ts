import type { OAuthProviderAdapter, OAuthProviderGrant } from '../types'

export class FakeProviderError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'FakeProviderError'
  }
}

export interface FakeProviderScript {
  /** Consumed in order by provider operations. A string entry throws FakeProviderError. */
  responses: (OAuthProviderGrant | string)[]
  revoked: string[]
  calls: { op: string; at: number }[]
}

const TERMINAL_CODES = new Set(['invalid_grant', 'invalid_auth', 'workspace_identity_mismatch'])

export function createFakeAdapter(script: FakeProviderScript, key = 'notion'): OAuthProviderAdapter {
  const record = (op: string): void => {
    script.calls.push({ op, at: Date.now() })
  }
  const nextGrant = (): OAuthProviderGrant => {
    const response = script.responses.shift()
    if (typeof response === 'string') throw new FakeProviderError(response)
    if (!response) throw new FakeProviderError('provider_unavailable')
    return response
  }

  return {
    key,
    authorizeHosts: ['fake.test'],
    buildAuthorizationUrl(input) {
      record('authorize')
      const url = new URL('/oauth/authorize', 'https://fake.test')
      url.searchParams.set('client_id', input.clientId)
      url.searchParams.set('redirect_uri', input.redirectUri)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('state', input.state)
      return url
    },
    async exchangeCode() {
      record('exchange')
      return nextGrant()
    },
    async refresh() {
      record('refresh')
      return nextGrant()
    },
    async revoke(input) {
      record('revoke')
      script.revoked.push(input.token)
      if (typeof script.responses[0] === 'string') throw new FakeProviderError(script.responses.shift() as string)
    },
    classifyError(error) {
      if (!(error instanceof FakeProviderError)) return { code: 'provider_error', retryable: true }
      return { code: error.code, retryable: !TERMINAL_CODES.has(error.code) }
    },
  }
}

export function fakeGrant(
  overrides: Partial<{
    accessToken: string
    refreshToken: string | null
    workspaceId: string
    botId: string
  }> = {}
): OAuthProviderGrant {
  return {
    tokens: {
      accessToken: overrides.accessToken ?? 'fake-access-token',
      refreshToken: overrides.refreshToken === undefined ? 'fake-refresh-token' : overrides.refreshToken,
      expiresAt: '2030-01-01T00:00:00.000Z',
    },
    configuration: {
      version: 1,
      workspaceId: overrides.workspaceId ?? 'fake-workspace-id',
      workspaceName: 'Fake workspace',
      workspaceIcon: null,
      botId: overrides.botId ?? 'fake-bot-id',
    },
    displayName: 'Fake workspace',
  }
}

/**
 * A Linear agent app grant as Core installs it: the token pair plus the app
 * user and workspace that `resolveGrantIdentity` reads. Pass
 * `configuration: null` to get the raw adapter shape, which carries no identity.
 */
export function fakeLinearGrant(
  overrides: Partial<{
    accessToken: string
    refreshToken: string | null
    expiresAt: string | null
    organizationId: string
    organizationName: string
    organizationUrlKey: string
    appUserId: string
    configuration: null
  }> = {}
): OAuthProviderGrant {
  const organizationName = overrides.organizationName ?? 'Fake Linear workspace'
  return {
    tokens: {
      accessToken: overrides.accessToken ?? 'fake-linear-access-token',
      refreshToken: overrides.refreshToken === undefined ? 'fake-linear-refresh-token' : overrides.refreshToken,
      expiresAt: overrides.expiresAt === undefined ? '2030-01-01T00:00:00.000Z' : overrides.expiresAt,
    },
    configuration:
      overrides.configuration === null
        ? null
        : {
            version: 2,
            mode: 'app',
            organizationId: overrides.organizationId ?? 'fake-linear-organization-id',
            organizationName,
            organizationUrlKey: overrides.organizationUrlKey ?? 'fake-linear',
            appUserId: overrides.appUserId ?? 'fake-linear-app-user-id',
            appUserName: 'Ficus',
            scopes: ['read', 'issues:create', 'comments:create', 'app:assignable', 'app:mentionable'],
          },
    displayName: overrides.configuration === null ? 'Linear' : `${organizationName} (Ficus app)`,
  }
}
