import { createHash } from 'node:crypto'
import type { VerifiedIngressEvent } from '../integrations/types'

export interface GitHubIssueDispatchFact {
  eventType: 'issues' | 'issue_comment'
  action: 'closed' | 'reopened' | 'assigned' | 'unassigned' | 'labeled' | 'unlabeled' | 'edited' | 'created'
  occurredAt: string
  actorLogin: string | null
  repository: string
  issueNumber: number
  issueTitle: string
  /** The dedupe-significant subject of the action: assignee login, label name; null otherwise. */
  detail: string | null
  nativeId: string
  providerDeliveryId: string | null
  logicalRowId: string
  url: string
}

type IssueAction = GitHubIssueDispatchFact['action']

const ACTIONS: Record<GitHubIssueDispatchFact['eventType'], ReadonlySet<IssueAction>> = {
  issues: new Set<IssueAction>(['closed', 'reopened', 'assigned', 'unassigned', 'labeled', 'unlabeled', 'edited']),
  issue_comment: new Set<IssueAction>(['created', 'edited']),
}
/** Actions whose meaning is the subject they name — a fact without one is neither describable nor dedupable. */
const DETAILED = new Set<IssueAction>(['assigned', 'unassigned', 'labeled', 'unlabeled'])
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/
// Display-only fields are bounded here so a hostile title or label cannot overflow the
// 512-char summary column (or the row payload) downstream. Identity fields are never truncated.
const TITLE_LIMIT = 200
const DETAIL_LIMIT = 100

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
/** Bound by code point, never by UTF-16 unit — a split surrogate pair is not storable text. */
const bounded = (value: string, limit: number): string => [...value].slice(0, limit).join('')

export function githubIssueLogicalRowId(
  fact: Pick<
    GitHubIssueDispatchFact,
    'eventType' | 'action' | 'occurredAt' | 'repository' | 'issueNumber' | 'nativeId' | 'detail'
  >
): string {
  const hex = createHash('sha256')
    .update(
      JSON.stringify([
        'github-issue',
        fact.repository,
        fact.issueNumber,
        fact.eventType,
        fact.action,
        fact.detail ?? '',
        fact.nativeId,
        fact.occurredAt,
      ])
    )
    .digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function isGitHubIssueDispatchFact(value: unknown): value is GitHubIssueDispatchFact {
  const fact = object(value)
  const eventType = fact?.eventType as GitHubIssueDispatchFact['eventType'] | undefined
  const action = fact?.action as IssueAction | undefined
  return Boolean(
    fact &&
    eventType &&
    Object.hasOwn(ACTIONS, eventType) &&
    typeof action === 'string' &&
    ACTIONS[eventType].has(action) &&
    timestamp(fact.occurredAt) === fact.occurredAt &&
    (fact.actorLogin === null || string(fact.actorLogin)) &&
    string(fact.repository) &&
    fact.repository === String(fact.repository).toLowerCase() &&
    REPOSITORY.test(String(fact.repository)) &&
    positiveInteger(fact.issueNumber) &&
    typeof fact.issueTitle === 'string' &&
    [...fact.issueTitle].length <= TITLE_LIMIT &&
    (DETAILED.has(action) ? Boolean(string(fact.detail)) : fact.detail === null) &&
    typeof fact.nativeId === 'string' &&
    /^[1-9][0-9]*$/.test(fact.nativeId) &&
    (fact.providerDeliveryId === null || string(fact.providerDeliveryId)) &&
    typeof fact.logicalRowId === 'string' &&
    fact.logicalRowId ===
      githubIssueLogicalRowId({
        eventType,
        action,
        occurredAt: String(fact.occurredAt),
        repository: String(fact.repository),
        issueNumber: Number(fact.issueNumber),
        nativeId: String(fact.nativeId),
        detail: fact.detail === null ? null : String(fact.detail),
      }) &&
    string(fact.url)
  )
}

/**
 * Normalize an `issues` / `issue_comment` webhook — or the issue-event poller's synthesized
 * equivalent — into the authoritative fact the Activity projection stores.
 *
 * Every attributable field comes from the payload's own nested resource and is cross-checked
 * against the delivering repository, so a payload naming another repository (or a pull request
 * dressed as an issue) yields no fact at all rather than a row attributed to the wrong resource.
 */
export function extractGitHubIssueDispatchFact(
  providerKey: string,
  event: VerifiedIngressEvent
): GitHubIssueDispatchFact | null {
  if (providerKey !== 'github' || !Object.hasOwn(ACTIONS, event.type)) return null
  const eventType = event.type as GitHubIssueDispatchFact['eventType']
  const payload = object(event.payload)
  const rawAction = string(payload?.action)
  if (!payload || !rawAction) return null
  // The poller reports GitHub's issue-event vocabulary; a rename is the title edit we track.
  const action = (eventType === 'issues' && rawAction === 'renamed' ? 'edited' : rawAction) as IssueAction
  if (!ACTIONS[eventType].has(action)) return null

  const repository = string(object(payload.repository)?.full_name)?.toLowerCase() ?? null
  if (!repository || !REPOSITORY.test(repository)) return null
  const issue = object(payload.issue)
  if (!issue) return null
  // An issue carrying a `pull_request` link IS a pull request; lane 70 owns it.
  if (issue.pull_request !== undefined && issue.pull_request !== null) return null

  const comment = object(payload.comment)
  const issueRepositoryObject = string(object(issue.repository)?.full_name)?.toLowerCase() ?? null
  const issueRepositoryFromUrl =
    string(issue.repository_url)
      ?.match(/\/repos\/([^/]+\/[^/]+)\/?$/i)?.[1]
      ?.toLowerCase() ?? null
  const commentRepositoryFromUrl =
    string(comment?.issue_url)
      ?.match(/\/repos\/([^/]+\/[^/]+)\/issues\/[1-9][0-9]*\/?$/i)?.[1]
      ?.toLowerCase() ?? null
  for (const nested of [issueRepositoryObject, issueRepositoryFromUrl, commentRepositoryFromUrl])
    if (nested && nested !== repository) return null

  const issueNumber = positiveInteger(issue.number)
  const payloadNumber = positiveInteger(payload.number)
  // A top-level number is only a consistency check, never an attribution fallback.
  if (!issueNumber || (payloadNumber !== null && payloadNumber !== issueNumber)) return null

  // A webhook `edited` covers body/title/etc.; only a title change is an Activity-worthy fact.
  if (
    eventType === 'issues' &&
    action === 'edited' &&
    rawAction !== 'renamed' &&
    !object(object(payload.changes)?.title)
  )
    return null

  const nativeIdValue = eventType === 'issues' ? issue.id : comment?.id
  const nativeId =
    positiveInteger(nativeIdValue) !== null
      ? String(nativeIdValue)
      : typeof nativeIdValue === 'string' && /^[1-9][0-9]*$/.test(nativeIdValue)
        ? nativeIdValue
        : null
  if (!nativeId) return null

  let occurredAt: string | null
  let actorLogin: string | null
  let detail: string | null = null
  if (eventType === 'issues') {
    // A close carries its own authoritative timestamp; the poller's synthesized `updated_at` is
    // the event's observation time, so only `closed_at` collapses poll and webhook onto one row.
    occurredAt =
      action === 'closed' ? (timestamp(issue.closed_at) ?? timestamp(issue.updated_at)) : timestamp(issue.updated_at)
    actorLogin = string(object(payload.sender)?.login)
    if (action === 'assigned' || action === 'unassigned') detail = string(object(payload.assignee)?.login)
    else if (action === 'labeled' || action === 'unlabeled') detail = string(object(payload.label)?.name)
  } else {
    occurredAt = action === 'created' ? timestamp(comment?.created_at) : timestamp(comment?.updated_at)
    actorLogin = string(object(comment?.user)?.login)
  }
  if (!occurredAt) return null
  if (DETAILED.has(action) && !detail) return null
  if (detail) detail = bounded(detail, DETAIL_LIMIT)

  const canonicalUrl = `https://github.com/${repository}/issues/${issueNumber}`
  const nativeUrl = eventType === 'issues' ? string(issue.html_url) : null
  const providerDeliveryId =
    event.metadata && typeof event.metadata.providerDeliveryId === 'string' && event.metadata.providerDeliveryId.trim()
      ? event.metadata.providerDeliveryId.trim()
      : null
  return {
    eventType,
    action,
    occurredAt,
    actorLogin,
    repository,
    issueNumber,
    issueTitle: bounded(string(issue.title) ?? '', TITLE_LIMIT),
    detail,
    nativeId,
    providerDeliveryId,
    logicalRowId: githubIssueLogicalRowId({
      eventType,
      action,
      occurredAt,
      repository,
      issueNumber,
      nativeId,
      detail,
    }),
    url: nativeUrl === canonicalUrl ? nativeUrl : canonicalUrl,
  }
}

/** Past-tense phrase for the fact; a detail-bearing action always names its subject (see DETAILED). */
export function describeGitHubIssueFact(
  fact: Pick<GitHubIssueDispatchFact, 'eventType' | 'action' | 'detail'>
): string {
  if (fact.eventType === 'issue_comment') return fact.action === 'edited' ? 'comment edited' : 'comment'
  switch (fact.action) {
    case 'assigned':
      return `assigned to ${fact.detail}`
    case 'unassigned':
      return `unassigned from ${fact.detail}`
    case 'labeled':
      return `labeled ${fact.detail}`
    case 'unlabeled':
      return `unlabeled ${fact.detail}`
    case 'edited':
      return 'title edited'
    default:
      return fact.action
  }
}
