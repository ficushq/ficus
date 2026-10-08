import { createHash } from 'node:crypto'
import type {
  GitHubAccountIdentity,
  GitHubFeedbackContent,
  GitHubFeedbackEnvelope,
  GitHubParentTextVariant,
  IntegrationOutputFact,
} from '@ficus/shared'
import { buildGitHubStatus } from './feedback-status'
import type { VerifiedIngressEvent } from '../types'

const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
export const githubNativeId = (value: unknown): string | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null
const text = (value: unknown) => (typeof value === 'string' ? value : '')
const timestamp = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
const sha = (value: unknown) =>
  typeof value === 'string' && /^[0-9a-f]{40,64}$/i.test(value) ? value.toLowerCase() : undefined
/**
 * A review comment's file path, bounded for delivery. The path is the PR author's text, not the
 * commenter's: it is kept on one line, stripped of control characters and capped, so it can
 * neither fake message structure nor carry an essay into an agent's inbox.
 */
export function safeGitHubPath(value: unknown): string {
  if (typeof value !== 'string') return ''
  const isControl = (code: number) =>
    code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
  let cleaned = ''
  let gap = false
  for (const char of value) {
    if (isControl(char.codePointAt(0)!)) {
      if (!gap) cleaned += ' '
      gap = true
    } else {
      cleaned += char
      gap = false
    }
  }
  cleaned = cleaned.trim()
  return cleaned.length > 200 ? `${cleaned.slice(0, 199)}…` : cleaned
}

export function githubContentIdentity(value: unknown): GitHubAccountIdentity | null {
  const user = record(value)
  const accountId = githubNativeId(user.id)
  return accountId &&
    ['User', 'Bot'].includes(user.type) &&
    /^[a-z0-9-]+(?:\[bot\])?$/i.test(user.login ?? '') &&
    user.login !== 'ghost'
    ? { accountId, login: user.login, accountType: user.type }
    : null
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)])
  )
}
export function githubContentHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}

/** The same caps as comment content: a bounded notification preview, a hard cap on reviewed bytes. */
const NOTIFICATION_LIMIT = 24000
const REVIEWED_LIMIT = 256 * 1024

/**
 * Hash and size of an action's COMPLETE reviewed object (identity, actor, URL and every data field,
 * including any parent text it carries), independently of transport, timestamp and event key.
 */
export function githubActionReviewed(
  identity: {
    repositoryId: string | null
    nativeId: string | null
    author: GitHubAccountIdentity | null
    attribution: GitHubFeedbackContent['attribution']
  },
  delivery: IntegrationOutputFact
): { contentHash: string; byteCount: number } {
  const reviewed = {
    normalizationVersion: 1,
    repositoryId: identity.repositoryId,
    nativeId: identity.nativeId,
    objectKind: 'action',
    author: identity.author,
    editor: null,
    attribution: identity.attribution,
    url: delivery.url,
    data: delivery.data,
  }
  return {
    contentHash: githubContentHash(reviewed),
    byteCount: Buffer.byteLength(JSON.stringify(canonical(reviewed))),
  }
}

/**
 * The factual action message plus the parent's current title and description, as plain text after
 * the facts. The full text is in `data.parentContent` (and so in the hash); the notification preview
 * is capped like a comment's and says so in `data.notificationTruncated`.
 */
export function withGitHubParentText(
  facts: IntegrationOutputFact,
  parent: { author: GitHubAccountIdentity; objectKind: 'issue' | 'pull_request'; title: string; body: string }
): IntegrationOutputFact {
  const notification = parentTextMessage(facts.body, parent)
  return {
    ...facts,
    data: {
      ...facts.data,
      parentContent: { author: parent.author, title: parent.title, body: parent.body },
      notificationTruncated: notification.length > NOTIFICATION_LIMIT,
    },
    body: notification.slice(0, NOTIFICATION_LIMIT),
  }
}

function parentTextMessage(
  factsBody: string,
  parent: { author: { login: string }; objectKind: string; title: string; body: string }
): string {
  return [
    factsBody,
    `Current ${parent.objectKind === 'pull_request' ? 'pull request' : 'issue'} title and description, written by @${parent.author.login}:`,
    parent.title,
    parent.body || '(No description.)',
  ].join('\n\n')
}

/**
 * The complete, untruncated agent-facing text of an action that carries parent text, for review:
 * the same message as the delivery, before the notification cap. Null for any other delivery.
 */
export function githubParentTextReviewText(delivery: IntegrationOutputFact): string | null {
  if (!hasGitHubParentText(delivery)) return null
  const parent = record(delivery.data.parentContent)
  return parentTextMessage(withoutGitHubParentText(delivery).body, {
    author: { login: text(record(parent.author).login) },
    objectKind: delivery.data.pullRequest ? 'pull_request' : 'issue',
    title: text(parent.title),
    body: text(parent.body),
  })
}

/** The factual action message a parent-text delivery was built from: exactly what normalization produces. */
export function withoutGitHubParentText(delivery: IntegrationOutputFact): IntegrationOutputFact {
  const { parentContent: _parent, notificationTruncated: _truncated, ...data } = delivery.data
  return { ...delivery, data, body: `${text(record(data.content).body)}\n\n${delivery.url}` }
}

/** True when an action delivery carries parent text (whoever wrote it). */
export function hasGitHubParentText(delivery: IntegrationOutputFact | null | undefined): boolean {
  return !!delivery && delivery.data.projection === 'action' && delivery.data.parentContent !== undefined
}

/** The numeric account ID of the parent author whose text a delivery carries; null when absent or malformed. */
export function githubParentTextAuthorId(delivery: IntegrationOutputFact | null | undefined): string | null {
  if (!hasGitHubParentText(delivery)) return null
  const accountId = record(record(delivery!.data.parentContent).author).accountId
  return typeof accountId === 'string' ? accountId : null
}

/** The action content with its parent-text variant selected: same identity, its own hash, size and delivery. */
export function githubParentTextContent(content: GitHubFeedbackContent): GitHubFeedbackContent | null {
  const variant = content.parentText
  if (content.objectKind !== 'action' || !variant) return null
  const { parentText: _variant, ...facts } = content
  return { ...facts, contentHash: variant.contentHash, byteCount: variant.byteCount, delivery: variant.delivery }
}

/**
 * Issue/PR actions whose only meaningful content is WHO did WHAT (assign, request review, label,
 * close/reopen an issue). The verified webhook sender is the authority. By default the parent's
 * editable title and body are not part of the projection, so a trusted actor cannot launder
 * untrusted prose. A signed webhook also offers a `parentText` variant naming the parent's author by
 * numeric ID; capture selects it only when that author is trusted and provably wrote the current
 * text (`feedback-parent.ts`). Title/body edits are not here: those remain content and are held.
 */
export const GITHUB_ACTION_EVENTS: Record<string, readonly string[]> = {
  issues: ['assigned', 'unassigned', 'labeled', 'unlabeled', 'closed', 'reopened'],
  pull_request: ['assigned', 'unassigned', 'labeled', 'unlabeled', 'review_requested', 'review_request_removed'],
}

function githubActionContent(
  event: VerifiedIngressEvent,
  fact: IntegrationOutputFact,
  parent: Record<string, any>,
  repo: string,
  repositoryId: string | null,
  resourceUrl: string
): GitHubFeedbackContent | null {
  const payload = record(event.payload)
  const action = text(payload.action)
  if (!GITHUB_ACTION_EVENTS[event.type]?.includes(action)) return null
  const parentId = githubNativeId(parent.id)
  const actor = githubContentIdentity(payload.sender)
  // Only a signed webhook names the actor. A poll's synthetic sender is fail-closed (held).
  const attribution: GitHubFeedbackContent['attribution'] =
    event.githubObservation?.kind === 'webhook' && actor ? 'creation' : 'unknown'
  const login = (value: unknown) => githubContentIdentity(value)?.login ?? ''
  const isPR = !!fact.data.pullRequest
  const number = record(fact.data.pullRequest ?? fact.data.issue).number
  const headSha = sha(parent.head?.sha)
  const assignee = login(payload.assignee)
  const requestedReviewer = login(payload.requested_reviewer)
  const requestedTeam = /^[a-z0-9_.-]+$/i.test(text(record(payload.requested_team).slug))
    ? text(record(payload.requested_team).slug)
    : ''
  const label = ['labeled', 'unlabeled'].includes(action) ? text(record(payload.label).name).slice(0, 100) : ''
  const summary = [
    `@${actor?.login ?? 'unknown'} ${action.replaceAll('_', ' ')} on ${repo} ${isPR ? 'pull request' : 'issue'} ${number}.`,
    assignee ? `Assignee: @${assignee}` : '',
    requestedReviewer ? `Requested reviewer: @${requestedReviewer}` : '',
    requestedTeam ? `Requested team: ${requestedTeam}` : '',
    label ? `Label: ${label}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  const data = {
    repository: repo,
    ...(repositoryId ? { repositoryId: Number(repositoryId) } : {}),
    ...(isPR ? { pullRequest: { number, ...(headSha ? { headSha } : {}) } } : { issue: { number } }),
    action,
    state: ['open', 'closed'].includes(parent.state) ? parent.state : '',
    actor: actor?.login ?? '',
    actorType: actor?.accountType ?? '',
    assignee,
    requestedReviewer,
    requestedTeam,
    ...(fact.data.requestedReviewerType ? { requestedReviewerType: fact.data.requestedReviewerType } : {}),
    // Logins and label names only; the predicate catalog allows rules to filter on them.
    labels: Array.isArray(fact.data.labels) ? fact.data.labels : [],
    assignees: Array.isArray(fact.data.assignees) ? fact.data.assignees : [],
    content: { title: '', body: summary },
    projection: 'action',
  }
  const delivery: IntegrationOutputFact = {
    output: fact.output,
    version: fact.version,
    resourceKey: fact.resourceKey,
    eventKey: fact.eventKey,
    occurredAt: fact.occurredAt,
    data,
    subject: `GitHub ${isPR ? 'pull request' : 'issue'} ${action.replaceAll('_', ' ')}: ${repo} ${number}`,
    body: `${summary}\n\n${resourceUrl}`,
    url: resourceUrl,
  }
  // One object per action: an assignment and a later label are separate reviewable events, so
  // out-of-order webhooks are never treated as stale versions of each other.
  const nativeId = parentId
    ? `${parentId}-${githubContentHash([action, data.assignee, data.requestedReviewer, data.requestedTeam, label, timestamp(parent.updated_at)]).slice(0, 24)}`
    : null
  const identity = { repositoryId, nativeId, author: actor, attribution }
  // The parent's CONTENT author, by numeric ID only; a missing or malformed identity offers nothing.
  const parentAuthor = githubContentIdentity(parent.user)
  let parentText: GitHubParentTextVariant | undefined
  if (attribution === 'creation' && parentAuthor && parentId && repositoryId && nativeId) {
    const objectKind = isPR ? 'pull_request' : 'issue'
    const title = text(parent.title)
    const body = text(parent.body)
    const withParent = withGitHubParentText(delivery, { author: parentAuthor, objectKind, title, body })
    const reviewed = githubActionReviewed(identity, withParent)
    // Too large to review: the factual message stands alone (it is never truncated into approval).
    if (reviewed.byteCount <= REVIEWED_LIMIT)
      parentText = {
        author: parentAuthor,
        objectKind,
        nativeId: parentId,
        title,
        body,
        unchanged:
          timestamp(parent.created_at) !== null && timestamp(parent.created_at) === timestamp(parent.updated_at),
        ...reviewed,
        delivery: withParent,
      }
  }
  return {
    normalizationVersion: 1,
    repositoryId,
    nativeId,
    objectKind: 'action',
    author: actor,
    editor: null,
    attribution,
    providerVersion: null,
    ...githubActionReviewed(identity, delivery),
    reason: null,
    delivery,
    ...(parentText ? { parentText } : {}),
  }
}

/** No raw-body fallback: every supported automatic status has an explicit allowlist. */
export function normalizeGitHubFeedback(
  event: VerifiedIngressEvent,
  fact: IntegrationOutputFact
): GitHubFeedbackEnvelope {
  const payload = record(event.payload)
  if (fact.output === 'dependabot_alert.updated') {
    const alert = record(fact.data.alert)
    const advisoryId = /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/i.test(
      text(alert.advisoryId)
    )
      ? text(alert.advisoryId)
      : undefined
    const data = {
      repository: fact.data.repository,
      repositoryId: fact.data.repositoryId,
      action: fact.data.action,
      state: fact.data.state,
      severity: fact.data.severity,
      projection: 'status',
      alert: { number: alert.number, externalId: alert.externalId, ...(advisoryId ? { advisoryId } : {}) },
    }
    return {
      content: null,
      status: buildGitHubStatus({ ...fact, data }),
    }
  }
  const parent = record(payload.pull_request ?? payload.issue)
  const repo = text(fact.data.repository)
  const number = record(fact.data.pullRequest ?? fact.data.issue).number
  const resourceUrl = `https://github.com/${repo}/${fact.data.pullRequest ? 'pull' : 'issues'}/${number}`
  const repositoryId = githubNativeId(record(payload.repository).id)
  const run = record(payload.workflow_run)
  const isCI = fact.output === 'pull_request.ci_completed'
  const lifecycle =
    event.type === 'pull_request' &&
    ['closed', 'reopened', 'synchronize', 'ready_for_review', 'converted_to_draft'].includes(payload.action)
  let status: IntegrationOutputFact | null = null
  if (isCI || lifecycle) {
    const action = isCI ? 'completed' : payload.action
    const state =
      isCI &&
      [
        'success',
        'failure',
        'neutral',
        'cancelled',
        'skipped',
        'timed_out',
        'action_required',
        'stale',
        'startup_failure',
      ].includes(run.conclusion)
        ? run.conclusion
        : !isCI
          ? parent.merged === true
            ? 'merged'
            : ['open', 'closed'].includes(parent.state)
              ? parent.state
              : 'unknown'
          : null
    const workflowId = githubNativeId(run.workflow_id)
    const runId = githubNativeId(run.id)
    if (state && (!isCI || (workflowId && runId))) {
      const headSha = sha(parent.head?.sha ?? run.head_sha)
      const data = {
        repository: repo,
        ...(repositoryId ? { repositoryId: Number(repositoryId) } : {}),
        action,
        state,
        pullRequest: { number, ...(headSha ? { headSha } : {}) },
        ...(isCI
          ? {
              ci: {
                workflowId: workflowId!,
                runId: runId!,
                runNumber: githubNativeId(run.run_number) ?? '',
                runAttempt: githubNativeId(run.run_attempt) ?? '',
              },
            }
          : {
              pullRequestState: state,
              ...(typeof parent.draft === 'boolean' ? { draft: parent.draft } : {}),
              ...(parent.mergeable_state === 'dirty' ? { mergeConflict: true } : {}),
            }),
        projection: 'status',
      }
      status = buildGitHubStatus({ ...fact, data })
    }
  }
  if (isCI) return { content: null, status }
  const actionContent = githubActionContent(event, fact, parent, repo, repositoryId, resourceUrl)
  if (actionContent) return { content: actionContent, status }
  const objectKind =
    event.type === 'issue_comment'
      ? 'issue_comment'
      : event.type === 'pull_request_review'
        ? 'review'
        : event.type === 'pull_request_review_comment'
          ? 'review_comment'
          : event.type === 'pull_request'
            ? 'pull_request'
            : 'issue'
  const item = record(
    objectKind === 'review'
      ? payload.review
      : ['issue_comment', 'review_comment'].includes(objectKind)
        ? payload.comment
        : parent
  )
  const nativeId = githubNativeId(item.id)
  const author = githubContentIdentity(item.user)
  const creation = ['created', 'opened', 'submitted'].includes(payload.action)
  const verifiedWebhook = event.githubObservation?.kind === 'webhook'
  // REST reviews expose submitted_at, not an edit clock. Synthetic sender is NOT an editor.
  const unchangedCreation =
    objectKind !== 'review' &&
    timestamp(item.created_at) !== null &&
    timestamp(item.created_at) === timestamp(item.updated_at ?? item.created_at)
  const attribution =
    creation && (verifiedWebhook || unchangedCreation)
      ? 'creation'
      : payload.action === 'edited' &&
          !['issue', 'pull_request'].includes(objectKind) &&
          verifiedWebhook &&
          githubContentIdentity(payload.sender)
        ? 'verified_edit'
        : 'unknown'
  const editor = attribution === 'verified_edit' ? githubContentIdentity(payload.sender) : null
  const providerVersion =
    objectKind === 'review' || (event.githubObservation?.kind === 'poll' && objectKind === 'issue')
      ? null
      : timestamp(item.updated_at)
  const fragment = nativeId
    ? objectKind === 'issue_comment'
      ? `#issuecomment-${nativeId}`
      : objectKind === 'review_comment'
        ? `#discussion_r${nativeId}`
        : objectKind === 'review'
          ? `#pullrequestreview-${nativeId}`
          : ''
    : ''
  const url = resourceUrl + fragment
  const body = text(item.body)
  const title = ['issue', 'pull_request'].includes(objectKind) ? text(item.title) : ''
  // The file path is chosen by whoever wrote the pull request, not by the (trusted) commenter.
  const path = objectKind === 'review_comment' ? safeGitHubPath(item.path) : ''
  const line =
    Number.isSafeInteger(item.line ?? item.original_line) && (item.line ?? item.original_line) > 0
      ? (item.line ?? item.original_line)
      : null
  const state =
    objectKind === 'review' &&
    ['approved', 'changes_requested', 'commented', 'dismissed', 'pending'].includes(item.state)
      ? item.state
      : ''
  const notificationBody = [
    title,
    path ? `${path}:${line ?? '?'} — reply in this review thread.` : '',
    state ? `Review state: ${state}. This is not a Ficus approval.` : '',
    url,
    body,
  ]
    .filter(Boolean)
    .join('\n\n')
  const data = {
    notificationTruncated: notificationBody.length > 24000,
    repository: repo,
    ...(repositoryId ? { repositoryId: Number(repositoryId) } : {}),
    ...(fact.data.pullRequest ? { pullRequest: { number } } : { issue: { number } }),
    action: text(payload.action),
    state,
    actor: author?.login ?? '',
    actorType: author?.accountType ?? '',
    content: { body, title, ...(path ? { path, line } : {}) },
    projection: 'content',
  }
  const delivery: IntegrationOutputFact = {
    output: fact.output,
    version: fact.version,
    resourceKey: fact.resourceKey,
    eventKey: fact.eventKey,
    occurredAt: fact.occurredAt,
    data,
    subject: `GitHub ${objectKind.replaceAll('_', ' ')}: ${repo} ${number}`,
    body: notificationBody.slice(0, 24000),
    url,
  }
  // Hash the COMPLETE reviewed object, independently of transport/timestamp/event key.
  const reviewed = {
    normalizationVersion: 1,
    repositoryId,
    nativeId,
    objectKind,
    author,
    editor,
    attribution,
    url,
    data,
  }
  const bytes = Buffer.byteLength(JSON.stringify(canonical(reviewed)))
  const contentHash = githubContentHash(reviewed)
  return {
    content: {
      normalizationVersion: 1,
      repositoryId,
      nativeId,
      objectKind,
      author,
      editor,
      attribution,
      providerVersion,
      contentHash,
      byteCount: bytes,
      reason: bytes > 256 * 1024 ? 'content_unavailable' : null,
      delivery: bytes > 256 * 1024 ? null : delivery,
    },
    status,
  }
}
