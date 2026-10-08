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

export async function githubApiGet<T>(path: string, squadId: string, connectionId?: string): Promise<T | null> {
  const token = (await resolveGitHubConnection(squadId, connectionId))?.credential.accessToken
  if (!token) return null
  let url = new URL(path, GITHUB_API_BASE)
  if (url.origin !== GITHUB_API_BASE) throw new Error('invalid_github_api_path')
  const signal = AbortSignal.timeout(15_000)
  for (let redirects = 0; ; redirects++) {
    const res = await fetch(url, {
      redirect: 'manual',
      signal,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    })
    // A renamed or transferred repository answers its old path with a redirect to
    // /repositories/<id>/…. Follow it only within the API origin, so the token never leaves it.
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (location) {
      const next = new URL(location, url)
      if (next.origin !== GITHUB_API_BASE || redirects >= MAX_REDIRECTS) return null
      url = next
      continue
    }
    if (!res.ok) return null
    return (await res.json()) as T
  }
}
