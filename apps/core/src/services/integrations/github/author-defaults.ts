import {
  parseGitHubConfiguration,
  type GitHubConnectionConfiguration,
} from '@ficus/shared/oauth-providers/github/config'
import { globalIntegrationDefault } from '../scope-settings'
import {
  resolveGitHubAuthorAssignment,
  resolveGitHubConnection,
  resolveInstanceGitHubConnection,
} from './resolve-connection'

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

interface PublicProfile {
  id: unknown
  name: unknown
  email: unknown
}

const PROFILE_FRESH_MS = 300_000
const PROFILE_RETRY_MS = 15_000
const PROFILE_CACHE_LIMIT = 100

/**
 * The last public profile GitHub returned for each connected account, plus when
 * to ask again. Only public profile fields are kept; no token is stored here,
 * and whether the account may be used at all is re-read from the database on
 * every resolution, so a cached entry can never outlive a disabled, unassigned
 * or reauthorization-required connection.
 *
 * A loaded profile is never replaced by the login-only fallback. The author
 * identity is hashed into each box's provisioning marker, so flipping between
 * "Profile Name" and "login" because one profile request failed (or because the
 * token was mid-refresh and could not be used) reprovisioned every box of the
 * squad twice: once on the downgrade and once on the recovery.
 *
 * Process-local on purpose. Persisting the profile on the connection would
 * remove the one remaining cold-start case (a process that has not yet loaded
 * the profile resolves login-only while the token is unusable), but the
 * connection configuration is a closed three-key schema shared with the OAuth
 * broker and used for account-identity comparison, so it needs a new column, a
 * migration and writes in every validation path.
 */
const profiles = new Map<string, { profile?: PublicProfile; retryAt: number }>()

async function fetchProfile(
  accessToken: string,
  userId: number,
  request: typeof fetch
): Promise<PublicProfile | undefined> {
  try {
    const response = await request('https://api.github.com/user', {
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    })
    if (!response.ok) return undefined
    const profile = await response.json()
    if (!profile || typeof profile !== 'object') return undefined
    const { id, name, email } = profile as Record<string, unknown>
    // A profile for another account is not this account's profile; keep what was loaded.
    return id === userId ? { id, name, email } : undefined
  } catch {
    /* Commit identity remains available when GitHub is temporarily unreachable. */
    return undefined
  }
}

/**
 * Git author defaults for a squad's assigned GitHub account, or for the
 * instance account when no squad is given.
 *
 * For a squad, WHICH account applies comes from the assignment
 * ({@link resolveGitHubAuthorAssignment}) and does not depend on the token's
 * momentary health. The token itself is still obtained only through the strict
 * {@link resolveGitHubConnection}, pinned to that same connection, and only to
 * read the public profile; when it is unavailable the last loaded profile (or
 * the login-only fallback) is used and no request is made.
 */
export async function getGitHubAuthorDefaults(
  squadId?: string | null,
  request: typeof fetch = fetch,
  now: () => number = Date.now
): Promise<GitHubAuthorDefaults | undefined> {
  let connectionId: string
  let account: GitHubConnectionConfiguration
  let accessToken: () => Promise<string | undefined>
  if (squadId) {
    const assignment = await resolveGitHubAuthorAssignment(squadId)
    if (!assignment) return undefined
    connectionId = assignment.id
    account = assignment.configuration
    accessToken = async () => (await resolveGitHubConnection(squadId, assignment.id))?.credential.accessToken
  } else {
    const resolved = await resolveInstanceGitHubConnection((await globalIntegrationDefault('github')) ?? undefined)
    if (!resolved) return undefined
    connectionId = resolved.connection.id
    account = parseGitHubConfiguration(resolved.connection.configuration)
    accessToken = async () => resolved.credential.accessToken
  }

  const cacheKey = `${connectionId}:${account.userId}`
  const cached = profiles.get(cacheKey)
  if (cached && cached.retryAt > now()) return gitHubAuthorFromProfile(account, cached.profile)

  const token = await accessToken()
  const loaded = token ? await fetchProfile(token, account.userId, request) : undefined
  const profile = loaded ?? cached?.profile
  profiles.delete(cacheKey)
  if (profiles.size >= PROFILE_CACHE_LIMIT) profiles.delete(profiles.keys().next().value!)
  profiles.set(cacheKey, { profile, retryAt: now() + (loaded ? PROFILE_FRESH_MS : PROFILE_RETRY_MS) })
  return gitHubAuthorFromProfile(account, profile)
}
