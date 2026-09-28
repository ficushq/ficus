import { getOAuthProviderAdapter } from '@ficus/shared/oauth-providers'
import type { OAuthClientBinding, OAuthProviderGrant } from '@ficus/shared/oauth-providers/types'
import { resolveOAuthCallbackUrl } from './public-url'
import type { OAuthAuthority } from './authority'

export type { OAuthAuthority } from './authority'

export interface OAuthAuthorizationUrlInput {
  providerKey: string
  localFlowId: string
  intent: 'connect' | 'reconnect'
  returnTo: string
  /** Core's persisted callback snapshot; local transport must use the same value. */
  redirectUri?: string
}

export type PreparedOAuthAuthorization = (
  input: OAuthAuthorizationUrlInput
) => Promise<{ authorizationUrl: string; expiresAt: string }>

export interface OAuthTransport {
  readonly authority: OAuthAuthority
  /** Captures any guard material once, before Core persists the corresponding state. */
  prepareAuthorization?(providerKey: string): PreparedOAuthAuthorization
  /** Compatibility preflight for transports without a prepared-call seam. */
  requireConfigured?(providerKey: string): void
  authorizationUrl(input: OAuthAuthorizationUrlInput): Promise<{ authorizationUrl: string; expiresAt: string }>
  /** Local transports exchange a code; broker transports redeem a completion handle. */
  completeAuthorization(input: {
    providerKey: string
    localFlowId: string
    code?: string
    handle?: string
    redirectUri?: string
  }): Promise<OAuthProviderGrant>
  refresh(input: {
    providerKey: string
    connectionId: string
    materialRevision: string
    tokenRevision: number
    refreshToken: string
    clientBinding?: OAuthClientBinding
  }): Promise<OAuthProviderGrant>
  revoke(input: {
    providerKey: string
    credentialRef: string
    token: string
    clientBinding?: OAuthClientBinding
  }): Promise<void>
}

export class OAuthTransportError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'OAuthTransportError'
  }
}

export function createLocalTransport(deps: {
  resolveClientCredentials(
    providerKey: string,
    binding?: OAuthClientBinding
  ): { clientId: string; clientSecret: string; clientBinding?: OAuthClientBinding } | undefined
  callbackUrl?: () => string
  now?: () => Date
}): OAuthTransport {
  const callbackUrl = deps.callbackUrl ?? resolveOAuthCallbackUrl
  const now = deps.now ?? (() => new Date())

  const adapterAndCredentials = (providerKey: string, binding?: OAuthClientBinding) => {
    const adapter = getOAuthProviderAdapter(providerKey)
    if (!adapter) throw new OAuthTransportError('unsupported_provider')
    const credentials = deps.resolveClientCredentials(providerKey, binding)
    if (!credentials) throw new OAuthTransportError('oauth_app_unconfigured')
    return { adapter, credentials }
  }

  const prepareAuthorization = (providerKey: string): PreparedOAuthAuthorization => {
    const { adapter, credentials } = adapterAndCredentials(providerKey)
    if (providerKey === 'github' && !credentials.clientSecret)
      throw new OAuthTransportError('device_authorization_required')
    return async (input) => {
      if (input.providerKey !== providerKey) throw new OAuthTransportError('unsupported_provider')
      const authorizationUrl = adapter.buildAuthorizationUrl({
        clientId: credentials.clientId,
        redirectUri: input.redirectUri ?? callbackUrl(),
        state: input.localFlowId,
      })
      return {
        authorizationUrl: authorizationUrl.toString(),
        expiresAt: new Date(now().getTime() + 10 * 60_000).toISOString(),
      }
    }
  }

  return {
    authority: 'local',
    prepareAuthorization,
    requireConfigured(providerKey) {
      adapterAndCredentials(providerKey)
    },
    authorizationUrl(input) {
      return prepareAuthorization(input.providerKey)(input)
    },
    async completeAuthorization(input) {
      if (!input.code || !input.redirectUri) throw new OAuthTransportError('malformed_callback')
      const { adapter, credentials } = adapterAndCredentials(input.providerKey)
      const grant = await adapter.exchangeCode({
        code: input.code,
        redirectUri: input.redirectUri,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
      })
      return { ...grant, ...(credentials.clientBinding ? { clientBinding: credentials.clientBinding } : {}) }
    },
    async refresh(input) {
      const { adapter, credentials } = adapterAndCredentials(input.providerKey, input.clientBinding)
      return adapter.refresh({
        refreshToken: input.refreshToken,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
      })
    },
    async revoke(input) {
      const { adapter, credentials } = adapterAndCredentials(input.providerKey, input.clientBinding)
      await adapter.revoke({
        token: input.token,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
      })
    },
  }
}
