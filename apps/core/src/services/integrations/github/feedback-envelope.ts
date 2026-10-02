import { createHash } from 'node:crypto'
import type { GitHubAccountIdentity, GitHubFeedbackEnvelope, IntegrationOutputFact } from '@ficus/shared'
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
      status: {
        output: fact.output,
        version: fact.version,
        resourceKey: fact.resourceKey,
        eventKey: fact.eventKey,
        occurredAt: fact.occurredAt,
        data,
        subject: `Dependabot ${data.severity}: ${data.repository} alert ${alert.number}`,
        body: [
          `Dependabot alert ${alert.number}: ${data.severity} (${data.state}; ${data.action}).`,
          advisoryId ? `Advisory: ${advisoryId}.` : '',
          fact.url,
          'Provider state is not remediation acceptance or work completion.',
        ]
          .filter(Boolean)
          .join('\n'),
        url: fact.url,
        ordering: fact.ordering,
      },
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
      const url = isCI ? `https://github.com/${repo}/actions/runs/${runId}` : resourceUrl
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
      status = {
        output: fact.output,
        version: fact.version,
        eventKey: fact.eventKey,
        resourceKey: fact.resourceKey,
        occurredAt: fact.occurredAt,
        data,
        subject: isCI ? `CI ${state}: ${repo} · Workflow ${workflowId}` : `Pull request ${state}: ${repo} ${number}`,
        body: [
          isCI ? `Workflow ${workflowId}: ${state}.` : `Pull request ${number}: ${state} (${action}).`,
          headSha ? `Head: ${headSha}` : '',
          url,
        ]
          .filter(Boolean)
          .join('\n'),
        url,
        ...(isCI && fact.ordering && workflowId ? { ordering: { ...fact.ordering, key: workflowId } } : {}),
      }
    }
  }
  if (isCI) return { content: null, status }
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
  const path = objectKind === 'review_comment' ? text(item.path) : ''
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
