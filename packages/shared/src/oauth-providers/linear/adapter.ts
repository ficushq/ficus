import type { OAuthProviderAdapter, OAuthProviderFailure } from '../types'
import { LINEAR_IDENTITY_ADAPTER_KEY, LinearOAuthClient, LinearOAuthError } from './client'

export { LINEAR_IDENTITY_ADAPTER_KEY }

const RETRYABLE = new Set(['provider_timeout', 'provider_unavailable', 'provider_error'])
const NON_RETRYABLE = new Set([
  'invalid_grant',
  'invalid_client',
  'invalid_auth',
  'invalid_request',
  'already_revoked',
  'not_app_actor',
  'not_user_actor',
  'workspace_identity_mismatch',
  'capability_or_resource_denied',
  'invalid_response',
  'response_too_large',
])

export function classifyLinearOAuthError(error: unknown): OAuthProviderFailure {
  if (!(error instanceof LinearOAuthError)) return { code: 'provider_error', retryable: true }
  if (error.code === 'rate_limited') {
    return {
      code: 'rate_limited',
      retryable: true,
      ...(error.providerRateLimited ? { providerRateLimited: true as const } : {}),
      ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    }
  }
  if (NON_RETRYABLE.has(error.code)) return { code: error.code, retryable: false }
  if (RETRYABLE.has(error.code)) return { code: error.code, retryable: true }
  return { code: 'provider_error', retryable: true }
}

export function createLinearAdapter(client = new LinearOAuthClient()): OAuthProviderAdapter {
  const grant = (tokens: { accessToken: string; refreshToken: string | null; expiresAt: string | null }) => ({
    tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt },
    // Linear's token response carries no identity. Core persists the pair
    // first, then reads the app user and workspace (resolveGrantIdentity).
    configuration: null,
    displayName: 'Linear',
  })
  return {
    key: 'linear',
    authorizeHosts: ['linear.app'],
    buildAuthorizationUrl: (input) => client.buildAuthorizationUrl(input),
    exchangeCode: async (input) => grant(await client.exchangeCode(input)),
    // Each refresh rotates the pair. Keep this free of further fallible calls:
    // Core persists the result before validating it against the saved identity.
    refresh: async (input) => grant(await client.refresh(input)),
    revoke: (input) => client.revoke(input),
    classifyError: classifyLinearOAuthError,
  }
}

export const linearAdapter = createLinearAdapter()

/**
 * The same Linear OAuth app, authorized as a person (`actor=user`, `read`): Ficus reads the viewer
 * and workspace once and discards the token. Token exchange and revocation match the app adapter.
 */
export function createLinearIdentityAdapter(client = new LinearOAuthClient()): OAuthProviderAdapter {
  const app = createLinearAdapter(client)
  return {
    ...app,
    key: LINEAR_IDENTITY_ADAPTER_KEY,
    buildAuthorizationUrl: (input) => client.buildUserAuthorizationUrl(input),
  }
}

export const linearIdentityAdapter = createLinearIdentityAdapter()
