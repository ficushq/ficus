import { resolveGitHubConnection } from '../integrations/github/resolve-connection'

const GITHUB_API_BASE = 'https://api.github.com'

export interface GitHubIssueApiLabel {
  name?: string | null
}

/** Provider-native identity: the numeric `id` (not the editable login) is what trust binds to. */
export interface GitHubIssueApiUser {
  id?: number
  login?: string | null
  type?: string
}

export interface GitHubIssueApiItem {
  id?: number
  number: number
  title: string
  body?: string | null
  html_url: string
  state: string
  labels?: GitHubIssueApiLabel[]
  user?: GitHubIssueApiUser | null
  updated_at: string
  created_at?: string
  pull_request?: unknown
}

export interface GitHubIssueApiComment {
  id?: number
  body?: string | null
  html_url?: string
  user?: GitHubIssueApiUser | null
  created_at: string
  updated_at: string
}

const MAX_REDIRECTS = 3

/**
 * Thrown by `githubApiGet(..., { distinguishUnavailable: true })` when GitHub could not answer:
 * no usable token, a network error or timeout, 401, 429, a rate-limited 403, 5xx, or any other
 * response that is not an explicit denial. Callers that settle on a denial must retry on this.
 */
export class GitHubApiUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`github_api_unavailable:${reason}`)
    this.name = 'GitHubApiUnavailableError'
  }
}

/** GitHub signals both primary and secondary rate limits on 403 through these headers. */
function isRateLimited(res: Response) {
  return res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')
}

/**
 * One read-only GraphQL query through the squad's assigned GitHub connection.
 *
 * Returns `data`, or null for an explicit denial (404, a 403 that is not a rate limit) or a response
 * carrying GraphQL errors (for example a node the token cannot see). Every other failure (no usable
 * token, network, 401, 429, a rate-limited 403, 5xx, an unreadable body) throws
 * {@link GitHubApiUnavailableError} so the caller can retry later instead of deciding.
 */
export async function githubApiGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
  squadId: string,
  connectionId?: string
): Promise<T | null> {
  const token = (await resolveGitHubConnection(squadId, connectionId))?.credential.accessToken
  if (!token) throw new GitHubApiUnavailableError('no_token')
  let res: Response
  try {
    res = await fetch(`${GITHUB_API_BASE}/graphql`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    })
  } catch {
    throw new GitHubApiUnavailableError('network')
  }
  if (res.status === 404 || (res.status === 403 && !isRateLimited(res))) return null
  if (!res.ok) throw new GitHubApiUnavailableError(`http_${res.status}`)
  let body: { data?: T | null; errors?: Array<{ type?: string }> }
  try {
    body = (await res.json()) as typeof body
  } catch {
    throw new GitHubApiUnavailableError('invalid_body')
  }
  if (body.errors?.some((error) => error?.type === 'RATE_LIMITED')) throw new GitHubApiUnavailableError('rate_limited')
  if (body.errors?.length || !body.data) return null
  return body.data
}

/**
 * GET an assigned GitHub API path. Returns null when the read fails.
 *
 * With `distinguishUnavailable`, null means only an explicit denial from GitHub under a usable
 * token (404, 410, a 403 that is not a rate limit, or a redirect it will not follow); every other
 * failure throws {@link GitHubApiUnavailableError} instead.
 */
export async function githubApiGet<T>(
  path: string,
  squadId: string,
  connectionId?: string,
  options: { distinguishUnavailable?: boolean } = {}
): Promise<T | null> {
  const unavailable = (reason: string) => {
    if (options.distinguishUnavailable) throw new GitHubApiUnavailableError(reason)
    return null
  }
  const token = (await resolveGitHubConnection(squadId, connectionId))?.credential.accessToken
  if (!token) return unavailable('no_token')
  let url = new URL(path, GITHUB_API_BASE)
  if (url.origin !== GITHUB_API_BASE) throw new Error('invalid_github_api_path')
  const signal = AbortSignal.timeout(15_000)
  for (let redirects = 0; ; redirects++) {
    let res: Response
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
        },
      })
    } catch (error) {
      if (options.distinguishUnavailable) throw new GitHubApiUnavailableError('network')
      throw error
    }
    // A renamed or transferred repository answers its old path with a redirect to
    // /repositories/<id>/…. Follow it only within the API origin, so the token never leaves it.
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (location) {
      const next = new URL(location, url)
      if (next.origin !== GITHUB_API_BASE || redirects >= MAX_REDIRECTS) return null
      url = next
      continue
    }
    if (res.status === 404 || res.status === 410 || (res.status === 403 && !isRateLimited(res))) return null
    if (!res.ok) return unavailable(`http_${res.status}`)
    try {
      return (await res.json()) as T
    } catch (error) {
      if (options.distinguishUnavailable) throw new GitHubApiUnavailableError('invalid_body')
      throw error
    }
  }
}
