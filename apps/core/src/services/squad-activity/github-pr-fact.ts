import { createHash } from 'node:crypto'
import type { VerifiedIngressEvent } from '../integrations/types'

export interface GitHubPrDispatchFact {
  eventType: 'pull_request' | 'issue_comment' | 'pull_request_review' | 'pull_request_review_comment'
  action: string
  occurredAt: string
  actorLogin: string | null
  repository: string
  prNumber: number
  nativeId: string
  providerDeliveryId: string | null
  logicalRowId: string
  url: string
}

const ACTIONS: Record<GitHubPrDispatchFact['eventType'], ReadonlySet<string>> = {
  pull_request: new Set(['closed', 'reopened', 'synchronize']),
  issue_comment: new Set(['created', 'edited']),
  pull_request_review: new Set(['submitted']),
  pull_request_review_comment: new Set(['created', 'edited']),
}
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const string = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)
const positiveInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
const timestamp = (value: unknown): string | null => {
  const raw = string(value)
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString()
}

export function githubPrLogicalRowId(
  fact: Pick<GitHubPrDispatchFact, 'eventType' | 'action' | 'occurredAt' | 'repository' | 'prNumber' | 'nativeId'>
): string {
  const hex = createHash('sha256')
    .update(
      JSON.stringify([
        'github',
        fact.repository,
        fact.prNumber,
        fact.eventType,
        fact.action,
        fact.nativeId,
        fact.occurredAt,
      ])
    )
    .digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function isGitHubPrDispatchFact(value: unknown): value is GitHubPrDispatchFact {
  const fact = object(value)
  const eventType = fact?.eventType as GitHubPrDispatchFact['eventType'] | undefined
  const action = string(fact?.action)
  return Boolean(
    fact &&
    eventType &&
    Object.hasOwn(ACTIONS, eventType) &&
    action &&
    (ACTIONS[eventType].has(action) || (eventType === 'pull_request' && action === 'merged')) &&
    timestamp(fact.occurredAt) === fact.occurredAt &&
    (fact.actorLogin === null || string(fact.actorLogin)) &&
    string(fact.repository) &&
    fact.repository === String(fact.repository).toLowerCase() &&
    REPOSITORY.test(String(fact.repository)) &&
    positiveInteger(fact.prNumber) &&
    typeof fact.nativeId === 'string' &&
    /^[1-9][0-9]*$/.test(fact.nativeId) &&
    (fact.providerDeliveryId === null || string(fact.providerDeliveryId)) &&
    typeof fact.logicalRowId === 'string' &&
    fact.logicalRowId ===
      githubPrLogicalRowId({
        eventType,
        action,
        occurredAt: String(fact.occurredAt),
        repository: String(fact.repository),
        prNumber: Number(fact.prNumber),
        nativeId: String(fact.nativeId),
      }) &&
    string(fact.url)
  )
}

export function extractGitHubPrDispatchFact(
  providerKey: string,
  event: VerifiedIngressEvent
): GitHubPrDispatchFact | null {
  if (providerKey !== 'github' || !Object.hasOwn(ACTIONS, event.type)) return null
  const eventType = event.type as GitHubPrDispatchFact['eventType']
  const payload = object(event.payload)
  const action = string(payload?.action)
  if (!payload || !action || !ACTIONS[eventType].has(action)) return null

  const repositoryObject = object(payload.repository)
  const repository = string(repositoryObject?.full_name)?.toLowerCase() ?? null
  if (!repository || !REPOSITORY.test(repository)) return null
  const pullRequest = object(payload.pull_request)
  const issue = object(payload.issue)
  const review = object(payload.review)
  const comment = object(payload.comment)
  const issuePr = object(issue?.pull_request)
  const pullRequestBaseRepository = string(object(object(pullRequest?.base)?.repo)?.full_name)?.toLowerCase() ?? null
  const issueRepositoryObject = string(object(issue?.repository)?.full_name)?.toLowerCase() ?? null
  const issueRepositoryUrl = string(issue?.repository_url)
  const issueRepositoryFromUrl = issueRepositoryUrl?.match(/\/repos\/([^/]+\/[^/]+)\/?$/i)?.[1]?.toLowerCase() ?? null
  const reviewPullRequestUrl = string(review?.pull_request_url)
  const commentPullRequestUrl = string(comment?.pull_request_url)
  const resourceRepositoryFromUrl =
    (reviewPullRequestUrl ?? commentPullRequestUrl)
      ?.match(/\/repos\/([^/]+\/[^/]+)\/pulls\/[1-9][0-9]*\/?$/i)?.[1]
      ?.toLowerCase() ?? null
  for (const nestedRepository of [
    pullRequestBaseRepository,
    issueRepositoryObject,
    issueRepositoryFromUrl,
    resourceRepositoryFromUrl,
  ])
    if (nestedRepository && nestedRepository !== repository) return null
  const payloadNumber = positiveInteger(payload.number)
  const nestedPrNumber = positiveInteger(pullRequest?.number)
  const prNumber = eventType === 'issue_comment' ? (issuePr ? positiveInteger(issue?.number) : null) : nestedPrNumber
  // Every supported non-issue webhook has a concrete pull_request object.
  // A top-level number is only a consistency check, never an attribution fallback.
  if (!prNumber || (payloadNumber !== null && payloadNumber !== prNumber)) return null
  const nativeIdValue =
    eventType === 'pull_request' ? pullRequest?.id : eventType === 'pull_request_review' ? review?.id : comment?.id
  const nativeId =
    typeof nativeIdValue === 'number' && Number.isSafeInteger(nativeIdValue) && nativeIdValue > 0
      ? String(nativeIdValue)
      : typeof nativeIdValue === 'string' && /^[1-9][0-9]*$/.test(nativeIdValue)
        ? nativeIdValue
        : null
  if (!nativeId) return null

  let occurredAt: string | null
  let actorLogin: string | null = null
  if (eventType === 'pull_request') {
    occurredAt =
      action === 'closed'
        ? pullRequest?.merged === true
          ? timestamp(pullRequest.merged_at)
          : timestamp(pullRequest?.closed_at)
        : timestamp(pullRequest?.updated_at)
  } else if (eventType === 'pull_request_review') {
    occurredAt = timestamp(review?.submitted_at)
    actorLogin = string(object(review?.user)?.login)
  } else {
    occurredAt = action === 'created' ? timestamp(comment?.created_at) : timestamp(comment?.updated_at)
    actorLogin = string(object(comment?.user)?.login)
  }
  if (!occurredAt) return null

  const canonicalUrl = `https://github.com/${repository}/pull/${prNumber}`
  const nativeUrl = string(pullRequest?.html_url) ?? string(issuePr?.html_url)
  const providerDeliveryId =
    event.metadata && typeof event.metadata.providerDeliveryId === 'string' && event.metadata.providerDeliveryId.trim()
      ? event.metadata.providerDeliveryId.trim()
      : null
  const normalizedAction =
    eventType === 'pull_request' && action === 'closed' && pullRequest?.merged === true ? 'merged' : action
  const logicalRowId = githubPrLogicalRowId({
    eventType,
    action: normalizedAction,
    occurredAt,
    repository,
    prNumber,
    nativeId,
  })
  return {
    eventType,
    action: normalizedAction,
    occurredAt,
    actorLogin,
    repository,
    prNumber,
    nativeId,
    providerDeliveryId,
    logicalRowId,
    url: nativeUrl === canonicalUrl ? nativeUrl : canonicalUrl,
  }
}
