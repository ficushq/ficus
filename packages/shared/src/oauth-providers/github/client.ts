import type { OAuthProviderTokens } from '../types'
import { parseGitHubConfiguration, type GitHubConnectionConfiguration } from './config'

const MAX_BODY_BYTES = 256 * 1024
const MAX_TOKEN_LENGTH = 16_384
const MAX_EXPIRY_SECONDS = 366 * 24 * 60 * 60
const SAFE_ERRORS = new Set([
  'authorization_pending',
  'slow_down',
  'expired_token',
  'access_denied',
  'device_flow_disabled',
  'incorrect_client_credentials',
  'incorrect_device_code',
  'bad_verification_code',
  'bad_refresh_token',
  'redirect_uri_mismatch',
  'unsupported_grant_type',
  'unverified_user_email',
])

export class GitHubOAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
    readonly providerRateLimited?: true
  ) {
    super(code)
    this.name = 'GitHubOAuthError'
  }
}

export interface GitHubDeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export type GitHubDevicePoll =
  | { status: 'authorized'; tokens: OAuthProviderTokens }
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number | null }

export class GitHubOAuthClient {
  readonly #fetch: typeof fetch
  readonly #now: () => Date
  readonly #timeoutMs: number

  constructor(options: { fetch?: typeof fetch; now?: () => Date; timeoutMs?: number } = {}) {
    this.#fetch = options.fetch ?? fetch
    this.#now = options.now ?? (() => new Date())
    this.#timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(options.timeoutMs!, 30_000)) : 10_000
  }

  buildAuthorizationUrl(input: { clientId: string; redirectUri: string; state: string }): URL {
    const url = new URL('https://github.com/login/oauth/authorize')
    url.searchParams.set('client_id', input.clientId)
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('state', input.state)
    // Explicit connects must let users switch accounts, even after a prior authorization.
    url.searchParams.set('prompt', 'select_account')
    // GitHub Apps use installation permissions, not OAuth App scopes.
    return url
  }

  async exchangeCode(input: {
    clientId: string
    clientSecret: string
    code: string
    redirectUri: string
    signal?: AbortSignal
  }): Promise<OAuthProviderTokens> {
    return this.#tokens(
      await this.#oauth(
        '/login/oauth/access_token',
        {
          client_id: input.clientId,
          client_secret: input.clientSecret,
          code: input.code,
          redirect_uri: input.redirectUri,
        },
        input.signal
      )
    )
  }

  async refresh(input: {
    clientId: string
    clientSecret?: string
    refreshToken: string
    signal?: AbortSignal
  }): Promise<OAuthProviderTokens> {
    return this.#tokens(
      await this.#oauth(
        '/login/oauth/access_token',
        {
          client_id: input.clientId,
          ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
          grant_type: 'refresh_token',
          refresh_token: input.refreshToken,
        },
        input.signal
      )
    )
  }

  async startDevice(input: { clientId: string; signal?: AbortSignal }): Promise<GitHubDeviceAuthorization> {
    const row = record(await this.#oauth('/login/device/code', { client_id: input.clientId }, input.signal))
    if (
      !boundedString(row.device_code, 1024) ||
      !boundedString(row.user_code, 64) ||
      row.verification_uri !== 'https://github.com/login/device' ||
      !positiveInteger(row.expires_in, 3600) ||
      !positiveInteger(row.interval, 300)
    )
      throw new GitHubOAuthError('invalid_response')
    return {
      deviceCode: row.device_code,
      userCode: row.user_code,
      verificationUri: row.verification_uri,
      expiresIn: row.expires_in,
      interval: row.interval,
    }
  }

  async pollDevice(input: { clientId: string; deviceCode: string; signal?: AbortSignal }): Promise<GitHubDevicePoll> {
    try {
      const tokens = this.#tokens(
        await this.#oauth(
          '/login/oauth/access_token',
          {
            client_id: input.clientId,
            device_code: input.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          },
          input.signal
        )
      )
      return { status: 'authorized', tokens }
    } catch (error) {
      if (error instanceof GitHubOAuthError) {
        if (error.code === 'authorization_pending') return { status: 'pending' }
        if (error.code === 'slow_down') return { status: 'slow_down', interval: error.retryAfterSeconds ?? null }
      }
      throw error
    }
  }

  async currentUser(input: { accessToken: string; signal?: AbortSignal }): Promise<GitHubConnectionConfiguration> {
    const row = record(await this.#api('/user', input))
    try {
      return parseGitHubConfiguration({ version: 1, userId: row.id, login: row.login })
    } catch {
      throw new GitHubOAuthError('invalid_response')
    }
  }

  /** Fresh OAuth ownership proof, distinct from an integration's connection configuration. */
  async currentIdentity(input: {
    accessToken: string
    signal?: AbortSignal
  }): Promise<{ id: number; login: string; type: 'User' }> {
    const row = record(await this.#api('/user', input))
    if (row.type !== 'User') throw new GitHubOAuthError('invalid_response')
    try {
      const configuration = parseGitHubConfiguration({ version: 1, userId: row.id, login: row.login })
      if (configuration.login.toLowerCase() === 'ghost') throw new Error('Placeholder account')
      return { id: configuration.userId, login: configuration.login, type: 'User' }
    } catch {
      throw new GitHubOAuthError('invalid_response')
    }
  }

  async revoke(input: { clientId: string; clientSecret?: string; token: string; signal?: AbortSignal }): Promise<void> {
    if (!input.clientSecret) throw new GitHubOAuthError('manual_revocation_required')
    await this.#request(`https://api.github.com/applications/${encodeURIComponent(input.clientId)}/token`, {
      method: 'DELETE',
      headers: {
        authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`, 'utf8').toString('base64')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ access_token: input.token }),
      signal: input.signal,
    })
  }

  #api(path: string, input: { accessToken: string; signal?: AbortSignal }): Promise<unknown> {
    return this.#request(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${input.accessToken}` },
      signal: input.signal,
    })
  }

  #oauth(path: string, body: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    return this.#request(`https://github.com${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  }

  #tokens(value: unknown): OAuthProviderTokens {
    const row = record(value)
    if (
      !boundedString(row.access_token, MAX_TOKEN_LENGTH) ||
      row.token_type !== 'bearer' ||
      (row.refresh_token !== undefined && !boundedString(row.refresh_token, MAX_TOKEN_LENGTH)) ||
      (row.expires_in !== undefined && !positiveInteger(row.expires_in, MAX_EXPIRY_SECONDS)) ||
      (row.refresh_token_expires_in !== undefined && !positiveInteger(row.refresh_token_expires_in, MAX_EXPIRY_SECONDS))
    ) {
      throw new GitHubOAuthError('invalid_response')
    }
    return {
      accessToken: row.access_token,
      refreshToken: typeof row.refresh_token === 'string' ? row.refresh_token : null,
      expiresAt:
        typeof row.expires_in === 'number'
          ? new Date(this.#now().getTime() + row.expires_in * 1000).toISOString()
          : null,
    }
  }

  async #request(url: string, input: RequestInit): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs)
    const signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal
    try {
      const response = await this.#fetch(url, {
        ...input,
        redirect: 'error',
        signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'Ficus',
          'x-github-api-version': '2022-11-28',
          ...input.headers,
        },
      })
      const retryHeader = response.headers.get('retry-after')
      const retryAfter = retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) : undefined
      if (
        response.status === 429 ||
        (response.status === 403 && (retryAfter !== undefined || response.headers.get('x-ratelimit-remaining') === '0'))
      ) {
        await response.body?.cancel().catch(() => {})
        throw new GitHubOAuthError(
          'rate_limited',
          response.status,
          Number.isSafeInteger(retryAfter) ? retryAfter : undefined,
          response.status === 429 ? true : undefined
        )
      }
      if (response.status === 204) return null
      const value = await readJson(response, signal)
      const row = record(value)
      if (!response.ok || typeof row.error === 'string') {
        const raw = typeof row.error === 'string' ? row.error : ''
        const code = SAFE_ERRORS.has(raw)
          ? raw
          : response.status === 401
            ? 'invalid_auth'
            : response.status === 403 || response.status === 404
              ? 'capability_or_resource_denied'
              : response.status >= 500
                ? 'provider_unavailable'
                : 'provider_error'
        throw new GitHubOAuthError(
          code,
          response.status,
          code === 'slow_down' && positiveInteger(row.interval, 3600) ? row.interval : undefined
        )
      }
      return value
    } catch (error) {
      if (error instanceof GitHubOAuthError) throw error
      throw new GitHubOAuthError(
        controller.signal.aborted ? 'provider_timeout' : signal.aborted ? 'request_aborted' : 'provider_unavailable'
      )
    } finally {
      clearTimeout(timeout)
    }
  }
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new GitHubOAuthError('response_too_large')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new GitHubOAuthError('invalid_response')
  const chunks: Uint8Array[] = []
  let length = 0
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      length += value.byteLength
      if (length > MAX_BODY_BYTES) throw new GitHubOAuthError('response_too_large')
      chunks.push(value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      throw new GitHubOAuthError('invalid_response')
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GitHubOAuthError('invalid_response')
  return value as Record<string, unknown>
}

function positiveInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value)
}
