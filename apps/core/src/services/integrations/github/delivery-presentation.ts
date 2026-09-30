import type { RuntimeConnection } from '../types'

/** A presentation-only cache, not an integration output or a completion permit. */
export interface GitHubDeliverySnapshot {
  version: 1
  squadId: string
  connectionId: string
  repository: string
  number: number
  observedAt: string
  headSha: string
  headBranch?: string
  baseBranch?: string
  state: 'open' | 'closed' | 'merged' | 'unknown'
  draft: boolean
  mergeState: string
  reviewDecision: 'required' | 'approved' | 'changes_requested' | 'unknown'
  checksState: 'success' | 'failure' | 'pending' | 'unknown'
  pendingHumanReview: boolean
  /**
   * Which GitHub API observed it. REST cannot see the required-review decision,
   * so a `rest` snapshot's decision is carried from the previous same-head
   * aggregate. Absent on snapshots written before this field existed.
   */
  source?: 'graphql' | 'rest'
}

export const DELIVERY_SNAPSHOT_MAX_AGE_MS = 5 * 60_000

export function githubDeliverySnapshot(
  connection: RuntimeConnection<{ owner: string; repo: string; number: number }>,
  pr: Record<string, any>,
  observedAt: string,
  graphql = false
): GitHubDeliverySnapshot | undefined {
  const headSha = graphql ? pr.headRefOid : pr.head?.sha
  if (typeof headSha !== 'string' || !/^[a-f0-9]{40}$/.test(headSha)) return undefined
  const rawState = String(pr.state ?? '').toLowerCase()
  const checks = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state
  return {
    version: 1,
    squadId: connection.squadId,
    connectionId: connection.id,
    repository: `${connection.configuration.owner}/${connection.configuration.repo}`.toLowerCase(),
    number: connection.configuration.number,
    observedAt,
    source: graphql ? 'graphql' : 'rest',
    headSha,
    ...(typeof (graphql ? pr.headRefName : pr.head?.ref) === 'string'
      ? { headBranch: graphql ? pr.headRefName : pr.head.ref }
      : {}),
    ...(typeof (graphql ? pr.baseRefName : pr.base?.ref) === 'string'
      ? { baseBranch: graphql ? pr.baseRefName : pr.base.ref }
      : {}),
    state:
      pr.merged === true || rawState === 'merged'
        ? 'merged'
        : rawState === 'open' || rawState === 'closed'
          ? rawState
          : 'unknown',
    draft: (graphql ? pr.isDraft : pr.draft) === true,
    mergeState: String(graphql ? (pr.mergeStateStatus ?? 'unknown') : (pr.mergeable_state ?? 'unknown')).toLowerCase(),
    reviewDecision:
      pr.reviewDecision === 'REVIEW_REQUIRED'
        ? 'required'
        : pr.reviewDecision === 'APPROVED'
          ? 'approved'
          : pr.reviewDecision === 'CHANGES_REQUESTED'
            ? 'changes_requested'
            : 'unknown',
    checksState:
      checks === 'SUCCESS'
        ? 'success'
        : ['ERROR', 'FAILURE'].includes(checks)
          ? 'failure'
          : ['EXPECTED', 'PENDING'].includes(checks)
            ? 'pending'
            : 'unknown',
    pendingHumanReview:
      (graphql &&
        Array.isArray(pr.reviewRequests?.nodes) &&
        pr.reviewRequests.nodes.some((request: any) =>
          ['User', 'Team'].includes(request?.requestedReviewer?.__typename)
        )) ||
      (Array.isArray(pr.requested_reviewers) &&
        pr.requested_reviewers.some((reviewer: any) => reviewer?.type === 'User')) ||
      (Array.isArray(pr.requested_teams) &&
        pr.requested_teams.some((team: any) => typeof team?.slug === 'string' && team.slug.length > 0)),
  }
}

/** Fail closed on stale, malformed, or future-version cache entries. */
export function readGitHubDeliverySnapshot(
  cursor: unknown,
  now = Date.now(),
  allowStale = false
): GitHubDeliverySnapshot | undefined {
  const value = (cursor as { deliveryPresentation?: GitHubDeliverySnapshot } | null)?.deliveryPresentation
  if (
    !value ||
    value.version !== 1 ||
    typeof value.squadId !== 'string' ||
    typeof value.connectionId !== 'string' ||
    typeof value.repository !== 'string' ||
    !Number.isSafeInteger(value.number) ||
    value.number <= 0 ||
    typeof value.observedAt !== 'string' ||
    typeof value.draft !== 'boolean' ||
    typeof value.pendingHumanReview !== 'boolean' ||
    typeof value.mergeState !== 'string' ||
    !['open', 'closed', 'merged', 'unknown'].includes(value.state) ||
    !['required', 'approved', 'changes_requested', 'unknown'].includes(value.reviewDecision) ||
    !['success', 'failure', 'pending', 'unknown'].includes(value.checksState) ||
    (value.headBranch !== undefined && typeof value.headBranch !== 'string') ||
    (value.baseBranch !== undefined && typeof value.baseBranch !== 'string') ||
    (value.source !== undefined && value.source !== 'graphql' && value.source !== 'rest') ||
    typeof value.headSha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value.headSha)
  )
    return undefined
  const age = now - Date.parse(value.observedAt)
  return Number.isFinite(age) && age >= -60_000 && (allowStale || age <= DELIVERY_SNAPSHOT_MAX_AGE_MS)
    ? value
    : undefined
}
