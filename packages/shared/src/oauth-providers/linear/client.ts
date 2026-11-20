import type { OAuthProviderTokens } from '../types'

const AUTHORIZE_URL = 'https://linear.app/oauth/authorize'
const TOKEN_URL = 'https://api.linear.app/oauth/token'
const REVOKE_URL = 'https://api.linear.app/oauth/revoke'
const GRAPHQL_URL = 'https://api.linear.app/graphql'
const MAX_BODY_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TOKEN_LENGTH = 16_384
const MAX_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60

/**
 * What the Ficus agent app asks for when it is installed with `actor=app`.
 * `read` is always granted; `issues:create` and `comments:create` cover the
 * writes Ficus makes; the two `app:` scopes make the app delegable and
 * mentionable. `admin` is not allowed for app actors.
 */
export const LINEAR_APP_SCOPES = ['read', 'issues:create', 'comments:create', 'app:assignable', 'app:mentionable'] as const

const PROVIDER_ERROR_CODES: Readonly<Record<string, string>> = {
  invalid_grant: 'invalid_grant',
  invalid_client: 'invalid_client',
  unauthorized_client: 'invalid_client',
  invalid_request: 'provider_error',
  invalid_scope: 'provider_error',
  unsupported_grant_type: 'provider_error',
}

export class LinearOAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly providerRateLimited?: true,
    readonly retryAfterSeconds?: number
  ) {
    super(code)
    this.name = 'LinearOAuthError'
  }
}

export interface LinearTokenResponse extends OAuthProviderTokens {
  /** Scopes Linear reports for the grant. */
  scopes: string[]
}

export interface LinearAppIdentity {
  appUserId: string
  appUserName: string
  organizationId: string
  organizationName: string
  organizationUrlKey: string
}

type LinearFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface LinearOAuthClientOptions {
  fetch?: LinearFetch
  timeoutMs?: number
  now?: () => Date
}

const IDENTITY_QUERY = 'query FicusLinearIdentity { viewer { id name app } organization { id name urlKey } }'

export class LinearOAuthClient {
  readonly #fetch: LinearFetch
  readonly #timeoutMs: number
  readonly #now: () => Date

  constructor(options: LinearOAuthClientOptions = {}) {
    this.#fetch = options.fetch ?? fetch
    this.#timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.min(options.timeoutMs!, 30_000))
      : DEFAULT_TIMEOUT_MS
    this.#now = options.now ?? (() => new Date())
  }

  /** Installs the app for the whole workspace (`actor=app`, needs a workspace admin). */
  buildAuthorizationUrl(input: { clientId: string; redirectUri: string; state: string }): URL {
    const url = new URL(AUTHORIZE_URL)
    url.searchParams.set('client_id', input.clientId)
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', LINEAR_APP_SCOPES.join(','))
    url.searchParams.set('state', input.state)
    url.searchParams.set('actor', 'app')
    url.searchParams.set('prompt', 'consent')
    return url
  }

  exchangeCode(input: {
    code: string
    redirectUri: string
    clientId: string
    clientSecret: string
    signal?: AbortSignal
  }): Promise<LinearTokenResponse> {
    return this.#token(
      { grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri },
      input
    )
  }

  /** Linear rotates the pair on every refresh: the old refresh token stops working. */
  refresh(input: {
    refreshToken: string
    clientId: string
    clientSecret: string
    signal?: AbortSignal
  }): Promise<LinearTokenResponse> {
    return this.#token({ grant_type: 'refresh_token', refresh_token: input.refreshToken }, input)
  }

  /**
   * `400` means Linear cannot revoke the token (for example it is already
   * revoked) and `401` that the client cannot authenticate; the broker treats
   * both as the goal state.
   */
  async revoke(input: { token: string; clientId: string; clientSecret: string; signal?: AbortSignal }): Promise<void> {
    const response = await this.#send(REVOKE_URL, {
      method: 'POST',
      headers: { ...basicAuth(input.clientId, input.clientSecret), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: input.token, token_type_hint: 'access_token' }).toString(),
      signal: input.signal,
    })
    await response.body?.cancel().catch(() => {})
    if (response.ok) return
    if (response.status === 400) throw new LinearOAuthError('already_revoked', 400)
    if (response.status === 401) throw new LinearOAuthError('invalid_auth', 401)
    throw new LinearOAuthError(response.status >= 500 ? 'provider_unavailable' : 'provider_error', response.status)
  }

  /**
   * Reads the app user and its workspace. A token whose viewer is not an app
   * user (a person's `actor=user` token) is refused, so it can never be
   * stored as an app connection.
   */
  async identity(input: { accessToken: string; signal?: AbortSignal }): Promise<LinearAppIdentity> {
    const response = await this.#send(GRAPHQL_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${input.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: IDENTITY_QUERY }),
      signal: input.signal,
    })
    const value = await this.#json(response)
    if (!response.ok) {
      throw new LinearOAuthError(
        response.status === 401 || response.status === 403 ? 'invalid_auth' : providerStatusCode(response.status),
        response.status
      )
    }
    const row = requireRecord(value)
    if (Array.isArray(row.errors) && row.errors.length > 0) throw new LinearOAuthError(graphqlErrorCode(row.errors))
    const data = requireRecord(row.data)
    const viewer = requireRecord(data.viewer)
    const organization = requireRecord(data.organization)
    if (viewer.app !== true) throw new LinearOAuthError('not_app_actor')
    if (
      !isBoundedString(viewer.id, 256) ||
      !isBoundedString(viewer.name, 512) ||
      !isBoundedString(organization.id, 256) ||
      !isBoundedString(organization.name, 512) ||
      !isBoundedString(organization.urlKey, 256)
    ) {
      throw new LinearOAuthError('invalid_response')
    }
    return {
      appUserId: viewer.id,
      appUserName: viewer.name,
      organizationId: organization.id,
      organizationName: organization.name,
      organizationUrlKey: organization.urlKey,
    }
  }

  async #token(
    body: Record<string, string>,
    client: { clientId: string; clientSecret: string; signal?: AbortSignal }
  ): Promise<LinearTokenResponse> {
    const response = await this.#send(TOKEN_URL, {
      method: 'POST',
      headers: {
        ...basicAuth(client.clientId, client.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(body).toString(),
      signal: client.signal,
    })
    const value = await this.#json(response)
    if (!response.ok) throw parseTokenError(value, response.status)
    return parseTokenResponse(value, this.#now())
  }

  /** Sends one request with a timeout and no redirects; rate limiting is raised here. */
  async #send(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs)
    const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal
    let response: Response
    try {
      response = await this.#fetch(url, {
        ...init,
        headers: { accept: 'application/json', ...(init.headers as Record<string, string>) },
        redirect: 'error',
        signal,
      })
    } catch {
      throw new LinearOAuthError(controller.signal.aborted ? 'provider_timeout' : 'provider_unavailable')
    } finally {
      clearTimeout(timeout)
    }
    if (response.status === 429) {
      await response.body?.cancel().catch(() => {})
      const retryAfter = response.headers.get('retry-after')
      const retryAfterSeconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined
      throw new LinearOAuthError(
        'rate_limited',
        429,
        true,
        Number.isSafeInteger(retryAfterSeconds) ? retryAfterSeconds : undefined
      )
    }
    return response
  }

  async #json(response: Response): Promise<unknown> {
    try {
      return JSON.parse(await readBoundedBody(response))
    } catch (error) {
      if (error instanceof LinearOAuthError) throw error
      throw new LinearOAuthError(
        response.ok ? 'invalid_response' : providerStatusCode(response.status),
        response.status
      )
    }
  }
}

function basicAuth(clientId: string, clientSecret: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}` }
}

function parseTokenResponse(value: unknown, now: Date): LinearTokenResponse {
  const row = requireRecord(value)
  if (
    !isBoundedString(row.access_token, MAX_TOKEN_LENGTH) ||
    (typeof row.token_type === 'string' && row.token_type.toLowerCase() !== 'bearer') ||
    (row.refresh_token !== undefined && row.refresh_token !== null && !isBoundedString(row.refresh_token, MAX_TOKEN_LENGTH))
  ) {
    throw new LinearOAuthError('invalid_response')
  }
  let expiresAt: string | null = null
  if (row.expires_in !== undefined && row.expires_in !== null) {
    if (
      !Number.isSafeInteger(row.expires_in) ||
      (row.expires_in as number) <= 0 ||
      (row.expires_in as number) > MAX_EXPIRES_IN_SECONDS
    ) {
      throw new LinearOAuthError('invalid_response')
    }
    expiresAt = new Date(now.getTime() + (row.expires_in as number) * 1_000).toISOString()
  }
  return {
    accessToken: row.access_token,
    refreshToken: typeof row.refresh_token === 'string' ? row.refresh_token : null,
    expiresAt,
    scopes: parseScopes(row.scope),
  }
}

/** Linear reports a space- or comma-separated string; apps created before 2023 may see an array. */
function parseScopes(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : []
  const scopes = raw.filter((scope): scope is string => typeof scope === 'string' && /^[a-z:_-]{1,64}$/i.test(scope))
  return [...new Set(scopes)].slice(0, 32)
}

function parseTokenError(value: unknown, status: number): LinearOAuthError {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const raw = typeof row.error === 'string' ? row.error : ''
  const code = PROVIDER_ERROR_CODES[raw] ?? (status === 401 ? 'invalid_client' : providerStatusCode(status))
  return new LinearOAuthError(code, status)
}

function graphqlErrorCode(errors: unknown[]): string {
  for (const error of errors) {
    const extensions =
      error && typeof error === 'object' ? (error as { extensions?: { code?: unknown } }).extensions : undefined
    const code = typeof extensions?.code === 'string' ? extensions.code.toUpperCase() : ''
    if (code === 'AUTHENTICATION_ERROR') return 'invalid_auth'
    if (code === 'FORBIDDEN') return 'capability_or_resource_denied'
    if (code === 'RATELIMITED') return 'rate_limited'
  }
  return 'provider_error'
}

function providerStatusCode(status: number): string {
  return status >= 500 ? 'provider_unavailable' : 'provider_error'
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new LinearOAuthError('response_too_large', response.status)
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {})
      throw new LinearOAuthError('response_too_large', response.status)
    }
    chunks.push(value)
  }
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(body)
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LinearOAuthError('invalid_response')
  return value as Record<string, unknown>
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max && !/[\r\n\0]/.test(value)
}
