export interface OAuthProviderTokens {
  accessToken: string
  refreshToken: string | null
  /** ISO instant with milliseconds, or null when the provider states no expiry. Never invented. */
  expiresAt: string | null
}

/** A grant as the provider reports it. Configuration remains opaque to the broker. */
export interface OAuthProviderGrant {
  tokens: OAuthProviderTokens
  configuration: unknown
  displayName: string
  /** Local-only issuing app binding. Broker DTOs deliberately exclude this. */
  clientBinding?: OAuthClientBinding
}

export interface OAuthClientBinding {
  clientId: string
  /** Immutable encrypted local app credential reference; absent for public device clients. */
  credentialRef?: string
}

export interface OAuthProviderFailure {
  code: string
  retryable: boolean
  /** Present only when the provider's HTTP response status was genuinely 429. */
  providerRateLimited?: true
  /** Sanitized delta-seconds hint from Retry-After. Platform policy applies bounds. */
  retryAfterSeconds?: number
}

export interface OAuthProviderAdapter {
  readonly key: string
  /** Hosts the authorization URL may point at. Both the platform and Core check against this. */
  readonly authorizeHosts: readonly string[]
  /**
   * `intent` is `reconnect` when an existing connection is authorized again; an adapter may use it
   * to ask the provider to update the existing grant (Linear's `update_scopes_on_existing_token`).
   */
  buildAuthorizationUrl(input: {
    clientId: string
    redirectUri: string
    state: string
    intent?: 'connect' | 'reconnect'
  }): URL
  exchangeCode(input: {
    code: string
    redirectUri: string
    clientId: string
    clientSecret: string
    signal?: AbortSignal
  }): Promise<OAuthProviderGrant>
  /** Returns the identity reported by the provider on this refresh; the caller compares it. */
  refresh(input: {
    refreshToken: string
    clientId: string
    clientSecret: string
    signal?: AbortSignal
  }): Promise<OAuthProviderGrant>
  revoke(input: { token: string; clientId: string; clientSecret: string; signal?: AbortSignal }): Promise<void>
  classifyError(error: unknown): OAuthProviderFailure
}
