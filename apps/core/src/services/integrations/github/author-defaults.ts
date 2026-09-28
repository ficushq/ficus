import {
  parseGitHubConfiguration,
  type GitHubConnectionConfiguration,
} from '@ficus/shared/oauth-providers/github/config'
import { globalIntegrationDefault } from '../scope-settings'
import { resolveGitHubConnection, resolveInstanceGitHubConnection } from './resolve-connection'

export interface GitHubAuthorDefaults {
  gitUserName: string
  gitUserEmail: string
  login: string
}

function profileText(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.trim() &&
    value.length <= 254 &&
    !/[\r\n<>]/.test(value) &&
    !value.includes(String.fromCharCode(0))
    ? value.trim()
    : undefined
}

/** Private profiles use GitHub's account-specific noreply address; no email-list permission is needed. */
export function gitHubAuthorFromProfile(
  account: GitHubConnectionConfiguration,
  profile?: { id?: unknown; name?: unknown; email?: unknown }
): GitHubAuthorDefaults {
  const matched = profile?.id === account.userId ? profile : undefined
  const email = profileText(matched?.email)
  return {
    login: account.login,
    gitUserName: profileText(matched?.name) ?? account.login,
    gitUserEmail:
      email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        ? email
        : `${account.userId}+${account.login}@users.noreply.github.com`,
  }
}

// Cache only public profile data. Live connection authorization is checked on every resolution.
const profiles = new Map<string, { until: number; value: GitHubAuthorDefaults }>()
export async function getGitHubAuthorDefaults(
  squadId?: string | null,
  request: typeof fetch = fetch
): Promise<GitHubAuthorDefaults | undefined> {
  const resolved = squadId
    ? await resolveGitHubConnection(squadId)
    : await resolveInstanceGitHubConnection((await globalIntegrationDefault('github')) ?? undefined)
  if (!resolved) return undefined
  const account = parseGitHubConfiguration(resolved.connection.configuration)
  const cacheKey = `${resolved.connection.id}:${resolved.connection.materialRevision}:${account.login}`
  const cached = profiles.get(cacheKey)
  if (cached && cached.until > Date.now()) return cached.value
  let value = gitHubAuthorFromProfile(account)
  let loaded = false
  try {
    const response = await request('https://api.github.com/user', {
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
      headers: {
        authorization: `Bearer ${resolved.credential.accessToken}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    })
    if (response.ok) {
      const profile = await response.json()
      if (profile && typeof profile === 'object') {
        value = gitHubAuthorFromProfile(account, profile)
        loaded = true
      }
    }
  } catch {
    /* Commit identity remains available when GitHub is temporarily unreachable. */
  }
  if (profiles.size >= 100) profiles.clear()
  profiles.set(cacheKey, { value, until: Date.now() + (loaded ? 300_000 : 15_000) })
  return value
}
