import type {
  GitHubAccountIdentity,
  GitHubFeedbackDetail,
  GitHubFeedbackPage,
  GitHubFeedbackQueue,
  GitHubFeedbackSummary,
  GitHubTrustOrigin,
  GitHubTrustedAuthorList,
  ModerateGitHubFeedback,
} from '@ficus/shared'
import { apiFetch, ApiError } from './client'

type ApiFetcher = typeof apiFetch

/**
 * Human-only moderation and trust endpoints. The server derives author, squad, authority and
 * content from storage; these calls only carry the immutable selections a human reviewed.
 */
const base = (squadId: string) => `/squads/${encodeURIComponent(squadId)}/github-feedback`

export const getGitHubFeedbackSummary = (squadId: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<GitHubFeedbackSummary>(`${base(squadId)}/summary`)

export const listGitHubFeedback = (
  squadId: string,
  query: { queue: GitHubFeedbackQueue; cursor?: string | null; limit?: number },
  fetcher: ApiFetcher = apiFetch
) => {
  const params = new URLSearchParams({ queue: query.queue, limit: String(query.limit ?? 25) })
  if (query.cursor) params.set('cursor', query.cursor)
  return fetcher<GitHubFeedbackPage>(`${base(squadId)}/revisions?${params}`)
}

export const getGitHubFeedbackDetail = (squadId: string, revisionId: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<GitHubFeedbackDetail>(`${base(squadId)}/revisions/${encodeURIComponent(revisionId)}`)

/** 202 means the decision was persisted and release is queued, not that anything was delivered. */
export const moderateGitHubFeedback = (squadId: string, body: ModerateGitHubFeedback, fetcher: ApiFetcher = apiFetch) =>
  fetcher<{
    decisions: Array<{ revisionId: string; action: ModerateGitHubFeedback['action']; decisionVersion: number }>
  }>(`${base(squadId)}/decisions`, { method: 'POST', body: JSON.stringify(body) })

export const retryGitHubFeedbackRelease = (squadId: string, revisionId: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<{ queued: true }>(`${base(squadId)}/revisions/${encodeURIComponent(revisionId)}/retry`, {
    method: 'POST',
    body: '{}',
  })

export const setGitHubAuthorFilter = (squadId: string, enabled: boolean, fetcher: ApiFetcher = apiFetch) =>
  fetcher<{ enabled: boolean; released: number }>(`${base(squadId)}/author-filter`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })

export const listGitHubTrustedAuthors = (squadId: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<GitHubTrustedAuthorList>(`${base(squadId)}/trusted-authors`)

/** Preview only: the server resolves the login to a provider-verified account and persists nothing. */
export const resolveGitHubTrustedAuthor = (squadId: string, login: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<GitHubAccountIdentity>(`${base(squadId)}/trusted-authors/resolve`, {
    method: 'POST',
    body: JSON.stringify({ login }),
  })

/** The server re-resolves `login` and refuses the add if it no longer maps to `accountId`. */
export const addGitHubTrustedAuthor = (
  squadId: string,
  account: { login: string; accountId: string },
  fetcher: ApiFetcher = apiFetch
) =>
  fetcher<GitHubAccountIdentity>(`${base(squadId)}/trusted-authors`, {
    method: 'POST',
    body: JSON.stringify({ login: account.login, accountId: account.accountId }),
  })

export const removeGitHubTrustedAuthor = (squadId: string, accountId: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<{ removed: true; remainingOrigins: GitHubTrustOrigin[] }>(
    `${base(squadId)}/trusted-authors/${encodeURIComponent(accountId)}`,
    { method: 'DELETE' }
  )

/** Server error code, if the failure carried one. Never echoes provider or caller input. */
export function githubFeedbackErrorCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || !error.payload || typeof error.payload !== 'object') return undefined
  const code = (error.payload as Record<string, unknown>).code
  return typeof code === 'string' ? code : undefined
}

const MESSAGES: Record<string, string> = {
  squad_update_required: 'You need permission to update this squad to do that.',
  squad_read_required: 'You need access to this squad to review its GitHub events.',
  human_required: 'Only a signed-in person can do this. Agents and API tokens cannot.',
  enabled_human_required: 'Only an active Ficus user can do this.',
  moderation_selection_conflict:
    'Some selected events changed or were already decided by someone else. Review them again before deciding.',
  moderation_request_conflict: 'This decision conflicts with an earlier request. Review the selection again.',
  moderation_content_unavailable: 'The content of a selected event is unavailable, so it can only be denied.',
  moderation_author_unavailable: 'The author of a selected event is unknown, so it cannot be trusted.',
  revision_not_found: 'This event no longer exists in this squad.',
  retry_not_applicable: 'This event is not waiting for a retry.',
  unknown_account: 'GitHub has no account with that username.',
  invalid_login: 'Enter a valid GitHub username.',
  account_changed: 'That username now belongs to a different GitHub account. Look it up again.',
  account_lookup_failed: 'GitHub could not be reached. Try again.',
  lookup_rate_limited: 'Too many GitHub lookups. Wait a few minutes and try again.',
  github_account_already_linked: 'That GitHub account is already linked to another Ficus user.',
  identity_flow_expired: 'The GitHub sign-in expired. Start again.',
  identity_proof_changed: 'The GitHub sign-in changed. Start again.',
  identity_generation_changed: 'A newer link request replaced this one. Start again.',
  unverified_personal_account: 'GitHub did not verify this as a personal account.',
  broker_unconfigured: 'GitHub sign-in is not configured on this Ficus instance.',
  invalid_cursor: 'The list changed. Reload it to continue.',
}

export function githubFeedbackErrorMessage(error: unknown, fallback: string): string {
  const code = githubFeedbackErrorCode(error)
  if (code && MESSAGES[code]) return MESSAGES[code]
  if (error instanceof ApiError && error.status === 403) return MESSAGES.squad_update_required
  return fallback
}
