import { linearOutputCatalog, type IntegrationOutputFact } from '@ficus/shared'
import { createHash } from 'node:crypto'
import type { IntegrationOutputAdapter } from '../outputs/types'
import type { VerifiedIngressEvent } from '../types'

const outputTitles = Object.fromEntries(linearOutputCatalog.map((event) => [event.output, event.title]))

/**
 * Server-owned context the agent app ingress passes in `VerifiedIngressEvent.metadata`. It is
 * never read from a payload: the ingress sets it from the connection the event was routed to.
 */
export const LINEAR_APP_USER_METADATA_KEY = 'linearAppUserId'

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : undefined
}
function text(value: unknown, max = 500) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}
function positive(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}
/** The first value that reads as a timestamp; Linear omits fields on older payloads. */
function when(...values: unknown[]) {
  for (const value of values) {
    const stamp = text(value, 64)
    if (stamp && Number.isFinite(Date.parse(stamp))) return stamp
  }
  return ''
}
function key(parts: unknown[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}
function webhookTime(payload: Record<string, any>) {
  return typeof payload.webhookTimestamp === 'number' && Math.abs(payload.webhookTimestamp) < 8.64e15
    ? new Date(payload.webhookTimestamp).toISOString()
    : ''
}
function labelNames(source: Record<string, any>) {
  const labels = Array.isArray(source.labels) ? source.labels : record(source.labels)?.nodes
  return Array.isArray(labels)
    ? labels
        .slice(0, 100)
        .map((label: unknown) => text(record(label)?.name, 200))
        .filter(Boolean)
    : []
}

/** The issue fields every Linear output shares, read from an issue object or an Issue payload. */
function issueFields(source: Record<string, any>, id: string) {
  const title = text(source.title)
  const number = positive(source.number)
  const identifier = text(source.identifier, 100)
  const team = record(source.team)
  const teamKey = text(team?.key, 100).toLowerCase()
  return {
    title,
    identifier,
    issue: { id, title, ...(number === undefined ? {} : { number }), ...(identifier ? { identifier } : {}) },
    teamId: text(source.teamId, 200) || text(team?.id, 200),
    ...(teamKey ? { teamKey } : {}),
    state: text(record(source.state)?.type, 100),
    labels: labelNames(source),
  }
}

function subject(output: string, identifier: string, id: string, title: string) {
  return `Linear ${(outputTitles[output] ?? 'issue updated').toLowerCase()}: ${`${identifier || id} ${title}`.trim()}`.slice(
    0,
    500
  )
}

/**
 * What opened an agent session, as far as its payload tells. `unknown` is a session with no person
 * to attribute it to (no creator, or the app user itself) that was not opened by a comment: a
 * delegation by an automation or another agent user, or a session opened with the app's token
 * outside Ficus. Routing settles it with the live delegate (`resolveUnattributedLinearSession`).
 *
 * Ficus's own `--linear-session` sessions are never classified here: they are recognised by their
 * local record (`linear_agent_sessions.trigger = 'proactive'`, `isProactiveLinearSession`).
 */
export type LinearSessionTrigger = 'delegation' | 'mention' | 'unknown'

/** The root comment Linear writes, without an author, when a session starts without a comment. */
const SYSTEM_THREAD_COMMENT = /^This thread is for an agent session with /

/**
 * Whether the session's root comment has no author and is not Linear's thread comment. Such a
 * comment reads as a mention (a mention synced from another tool), so if Linear rewords its thread
 * comment, delegations would silently turn into mentions; the acknowledger logs every one.
 */
export function hasUnrecognisedLinearRootComment(session: Record<string, any>): boolean {
  const comment = record(session.comment)
  if (!comment || !(text(session.commentId, 200) || text(comment.id, 200))) return false
  if (text(comment.userId, 200) || text(record(comment.user)?.id, 200)) return false
  return !SYSTEM_THREAD_COMMENT.test(text(comment.body))
}

/**
 * What opened a session, from an `AgentSessionEvent` `agentSession` (or the poller's equivalent).
 *
 * Linear gives every session a root comment, a delegation included: for a delegation it is a system
 * comment with no author ("This thread is for an agent session with ficus."), so a root comment alone
 * does not mean a mention. In order:
 *
 * 1. A root comment with an author (`comment.userId`, or `comment.user.id` when polled) is a mention.
 * 2. Linear's webhook schema always carries `comment` with `commentId`; a payload with only the ID
 *    has no author information and is read as before, as a mention.
 * 3. A session whose issue is delegated to the app (only a polled issue carries its delegate) is a
 *    delegation.
 * 4. Any other authorless root comment that is not Linear's thread comment (a mention synced from
 *    another tool, for example) stays a mention.
 * 5. Linear's thread comment, or no root comment: a delegation when a person created the session.
 *    Linear sets `creator` to the responsible person for a delegation, documented also when an
 *    automation delegates. Without a creator (or with the app user as creator) it is `unknown`:
 *    the session is acknowledged, and routing reads the issue's live delegate to decide between a
 *    delegation and telling the manager. A missing creator never makes a session the app's own.
 */
export function linearSessionTrigger(session: Record<string, any>, appUserId: string): LinearSessionTrigger {
  const creator = text(session.creatorId, 200) || text(record(session.creator)?.id, 200)
  const comment = record(session.comment)
  const commentId = text(session.commentId, 200) || text(comment?.id, 200)
  if (comment && (text(comment.userId, 200) || text(record(comment.user)?.id, 200))) return 'mention'
  if (commentId && !comment) return 'mention'
  const issue = record(session.issue) ?? {}
  const delegatedToApp =
    !!appUserId && (text(issue.delegateId, 200) || text(record(issue.delegate)?.id, 200)) === appUserId
  if (delegatedToApp) return 'delegation'
  const systemComment = !commentId || SYSTEM_THREAD_COMMENT.test(text(comment?.body))
  if (!systemComment) return 'mention'
  return creator && creator !== appUserId ? 'delegation' : 'unknown'
}

/**
 * Settles an `unknown` session's facts with the issue's live delegate, read by the routing probe.
 * Delegated to the app: a delegation (`issue.delegated`, trigger `delegation`). Otherwise the
 * request cannot be attributed, and it is routed as `issue.mentioned` (trigger kept `unknown`) so
 * the default rule tells the manager; it is never dropped. Other facts pass through unchanged.
 */
export function resolveUnattributedLinearSession(
  facts: IntegrationOutputFact[],
  liveDelegate: string,
  appUserId: string
): { facts: IntegrationOutputFact[]; resolution: 'delegation' | 'unknown' } | null {
  const created = facts.find(
    (fact) => fact.output === 'agent_session.created' && record(fact.data.session)?.trigger === 'unknown'
  )
  if (!created) return null
  const sessionId = text(record(created.data.session)?.id, 200)
  const delegated = !!appUserId && liveDelegate === appUserId
  const next = facts.map((fact): IntegrationOutputFact => {
    if (fact === created)
      return delegated
        ? { ...fact, data: { ...fact.data, session: { ...record(fact.data.session), trigger: 'delegation' } } }
        : fact
    if (delegated || fact.output !== 'issue.delegated' || text(record(fact.data.session)?.id, 200) !== sessionId)
      return fact
    const commentId = text(record(created.data.comment)?.id, 200)
    const output = 'issue.mentioned'
    const issue = record(fact.data.issue) ?? {}
    return {
      ...fact,
      output,
      eventKey: key([output, sessionId]),
      data: {
        ...fact.data,
        action: 'mentioned',
        delegate: '',
        ...(commentId ? { comment: { id: commentId } } : {}),
        session: { id: sessionId },
      },
      subject: subject(output, text(issue.identifier, 100), fact.resourceKey, text(issue.title)),
    }
  })
  return { facts: next, resolution: delegated ? 'delegation' : 'unknown' }
}

/** `AgentSessionEvent`: the session facts plus exactly one delegated or mentioned fact for `created`. */
function normalizeSessionEvent(payload: Record<string, any>): IntegrationOutputFact[] {
  const action = text(payload.action, 100)
  if (action !== 'created' && action !== 'prompted') return []
  const session = record(payload.agentSession)
  const sessionId = text(session?.id, 200)
  const appUserId = text(payload.appUserId, 200) || text(session?.appUserId, 200)
  if (!session || !sessionId || !appUserId) return []
  const issue = record(session.issue) ?? {}
  const issueId = text(session.issueId, 200) || text(issue.id, 200)
  // A session outside an issue (a document mention, for example) has nothing to route; it is closed politely.
  if (!issueId) return []
  const at = when(payload.createdAt, webhookTime(payload))
  if (!at) return []
  const fields = issueFields(issue, issueId)
  const url = text(issue.url, 2000)
  const sessionUrl = text(session.url, 2000)
  const commentId = text(session.commentId, 200) || text(record(session.comment)?.id, 200)
  const base = {
    issue: fields.issue,
    teamId: fields.teamId,
    ...(fields.teamKey ? { teamKey: fields.teamKey } : {}),
    assignee: text(issue.assigneeId, 200) || text(record(issue.assignee)?.id, 200),
    delegate: text(issue.delegateId, 200) || text(record(issue.delegate)?.id, 200),
    state: fields.state,
    labels: fields.labels,
    actorType: 'unknown',
  }
  const fact = (output: string, eventKey: string, data: Record<string, unknown>, body: string) => ({
    output,
    version: 1,
    resourceKey: issueId,
    occurredAt: at,
    eventKey,
    data: { ...base, ...data },
    subject: subject(output, fields.identifier, issueId, fields.title),
    // Prompt content is evidence, never instructions: every delivery template says so.
    body: [url, body].filter(Boolean).join('\n\n').slice(0, 30000),
    ...(url ? { url } : {}),
  })
  if (action === 'prompted') {
    const activity = record(payload.agentActivity) ?? {}
    const activityId = text(activity.id, 200)
    if (!activityId) return []
    const prompt = text(activity.body, 30000) || text(record(activity.content)?.body, 30000)
    return [
      fact(
        'agent_session.prompted',
        key(['agent_session.prompted', activityId]),
        {
          action: 'prompted',
          // The author is confirmed by the live probe; a payload claim is never trusted on its own.
          actor: text(activity.userId, 200) || text(record(activity.user)?.id, 200),
          session: { id: sessionId, appUserId },
          activity: { id: activityId },
          prompt: { signal: activity.signal === 'stop' ? 'stop' : '' },
          ...(text(activity.sourceCommentId, 200) ? { comment: { id: text(activity.sourceCommentId, 200) } } : {}),
        },
        prompt
      ),
    ]
  }
  const trigger = linearSessionTrigger(session, appUserId)
  const mention = trigger === 'mention'
  const creator = text(session.creatorId, 200) || text(record(session.creator)?.id, 200)
  // An `unknown` session has no person to attribute it to: no actor, so no account check or trust
  // lookup treats the app user (or nobody) as the requester. It is emitted as a provisional
  // delegation that routing settles with the live delegate (`resolveUnattributedLinearSession`).
  // The app user as creator is never the requester either, whatever the trigger.
  const actor = trigger === 'unknown' || creator === appUserId ? '' : creator
  const context = text(payload.promptContext, 30000)
  const created = fact(
    'agent_session.created',
    key(['agent_session.created', sessionId]),
    {
      action: 'created',
      actor,
      session: {
        id: sessionId,
        ...(sessionUrl ? { url: sessionUrl } : {}),
        trigger,
        creator,
        appUserId,
      },
      ...(commentId ? { comment: { id: commentId } } : {}),
    },
    context
  )
  const routed = mention
    ? fact(
        'issue.mentioned',
        key(['issue.mentioned', sessionId]),
        { action: 'mentioned', actor, comment: { id: commentId }, session: { id: sessionId } },
        context
      )
    : fact(
        'issue.delegated',
        key(['issue.delegated', 'session', sessionId]),
        // The live probe confirms the issue's delegate is this app before any squad receives it.
        { action: 'delegated', actor, delegate: appUserId, session: { id: sessionId } },
        context
      )
  return [created, routed]
}

/** The adapter describes Linear facts. It knows nothing about Ficus agents or flow routing. */
export const linearOutputAdapter: IntegrationOutputAdapter = {
  integration: 'linear',
  catalog: linearOutputCatalog,
  workStreamBindings() {
    return { 'linear.issueId': { event: 'issue.id' }, 'linear.teamId': { event: 'teamId' } }
  },
  trackedResource(fact) {
    const issue = record(fact.data.issue)
    const externalId = text(issue?.id, 200)
    const repository = text(fact.data.teamKey, 100).trim().toLowerCase()
    const number = positive(issue?.number)
    // Comments carry only the issue UUID; those match through `trackedIdentity` instead.
    if (!externalId || !repository || number === undefined) return null
    return {
      integration: 'linear',
      repository,
      kind: 'issue',
      number,
      externalId,
      ...(fact.url ? { url: fact.url } : {}),
    }
  },
  trackedIdentity(fact) {
    const externalId = text(record(fact.data.issue)?.id, 200)
    return externalId ? { integration: 'linear', externalId } : null
  },
  normalize(event: VerifiedIngressEvent) {
    const payload = record(event.payload)
    if (!payload) return []
    // The signature covers the body only, so a replay with a mutated `Linear-Event` header cannot re-type it.
    if (text(payload.type, 100) && payload.type !== event.type) return []
    if (event.type === 'AgentSessionEvent') return normalizeSessionEvent(payload)
    const data = record(payload.data)
    if (!data) return []
    const action = text(payload.action, 100)
    const comment = event.type === 'Comment'
    if (event.type === 'Issue' && action === 'create') return normalizeIssueCreate(payload, data)
    if (comment ? action !== 'create' && action !== 'update' : event.type !== 'Issue' || action !== 'update') return []
    // Issue details live on the payload for issue events, and on the nested issue for comments.
    const source = comment ? (record(data.issue) ?? {}) : data
    const id = comment ? text(data.issueId, 200) || text(source.id, 200) : text(data.id, 200)
    if (!id) return []
    const updatedFrom = record(payload.updatedFrom) ?? {}
    const assigned = text(data.assigneeId, 200)
    const delegate = comment ? text(source.delegateId, 200) : text(data.delegateId, 200)
    const delegateChanged = !comment && 'delegateId' in updatedFrom
    let output = 'issue.comment'
    let verb = action
    let assignee: string
    let primary = true
    if (!comment) {
      if ('assigneeId' in updatedFrom) {
        output = assigned ? 'issue.assigned' : 'issue.unassigned'
        verb = assigned ? 'assigned' : 'unassigned'
        assignee = assigned || text(updatedFrom.assigneeId, 200)
        // An update that neither had nor gained an assignee identifies nobody to route on.
        if (!assignee) primary = false
      } else {
        output = 'issue.updated'
        verb =
          'stateId' in updatedFrom
            ? 'state'
            : 'title' in updatedFrom
              ? 'title'
              : 'labelIds' in updatedFrom
                ? 'labels'
                : 'updated'
        // A delegation change is also reported as its own fact; `issue.updated` keeps firing for it as before.
        assignee = assigned
      }
    } else assignee = text(source.assigneeId, 200)
    const at = comment
      ? action === 'update'
        ? when(data.updatedAt, data.createdAt, webhookTime(payload))
        : when(data.createdAt, data.updatedAt, webhookTime(payload))
      : when(data.updatedAt, webhookTime(payload))
    if (!at) return []
    const fields = issueFields(source, id)
    // Who acted on this delivery (the editor of an edited comment), not necessarily its author.
    const actor = text(record(payload.actor)?.id, 200) || text(data.userId, 200)
    const url = text(data.url, 2000)
    const details = comment ? text(data.body, 30000) : text(data.description, 30000) || fields.title
    const shared = {
      issue: fields.issue,
      teamId: fields.teamId,
      ...(fields.teamKey ? { teamKey: fields.teamKey } : {}),
      actor,
      state: fields.state,
      labels: fields.labels,
    }
    const make = (output: string, eventKey: string, data: Record<string, unknown>) => ({
      output,
      version: 1,
      resourceKey: id,
      occurredAt: at,
      eventKey,
      data: { ...shared, ...data },
      subject: subject(output, fields.identifier, id, fields.title),
      body: [url, details].filter(Boolean).join('\n\n').slice(0, 30000),
      ...(url ? { url } : {}),
    })
    const facts: IntegrationOutputFact[] = []
    if (primary)
      facts.push(
        make(
          output,
          // The comment id separates two comments on one issue that share a timestamp.
          // Comment keys never included the issue's assignee; keep them stable.
          key([
            output,
            id,
            verb,
            actor,
            at,
            fields.state,
            comment ? '' : assignee,
            ...(comment ? [text(data.id, 200)] : []),
          ]),
          {
            assignee,
            delegate,
            action: verb,
            ...(comment
              ? {
                  comment: {
                    id: text(data.id, 200),
                    ...(text(data.parentId, 200) ? { parentId: text(data.parentId, 200) } : {}),
                    ...(text(data.userId, 200) ? { author: text(data.userId, 200) } : {}),
                    // Set from the app's live probe when the comment is in one of its session threads.
                    inSession: false,
                  },
                }
              : {}),
          }
        )
      )
    if (delegateChanged) {
      const previous = text(updatedFrom.delegateId, 200)
      if (previous)
        facts.push(
          make('issue.undelegated', key(['issue.undelegated', id, previous, at]), {
            assignee: assigned,
            delegate: previous,
            action: 'undelegated',
          })
        )
      // A delegation to this connection's own app arrives as an agent session event instead.
      const ownApp = text(event.metadata?.[LINEAR_APP_USER_METADATA_KEY], 200)
      if (delegate && delegate !== ownApp)
        facts.push(
          make('issue.delegated', key(['issue.delegated', id, delegate, at]), {
            assignee: assigned,
            delegate,
            ...(previous ? { previousDelegate: previous } : {}),
            action: 'delegated',
          })
        )
    }
    return facts
  },
}

/**
 * The polling fallback's undelegation (5.7): an `issueUnassignedFromYou` notification for the app
 * user, as the poller builds it from Linear's `notifications` query, becomes one `issue.undelegated`
 * fact naming the app as the removed delegate. Webhook notifications never come through here; they
 * produce no outputs (the `Issue` webhook reports the same change).
 */
export function normalizeLinearUndelegationNotification(
  payload: Record<string, unknown>,
  appUserId: string
): IntegrationOutputFact[] {
  const notification = record(payload.notification)
  if (!notification || text(notification.type, 100) !== 'issueUnassignedFromYou' || !appUserId) return []
  const notificationId = text(notification.id, 200)
  const issue = record(notification.issue) ?? {}
  const id = text(notification.issueId, 200) || text(issue.id, 200)
  const at = when(notification.createdAt)
  if (!notificationId || !id || !at) return []
  const fields = issueFields(issue, id)
  const url = text(issue.url, 2000)
  return [
    {
      output: 'issue.undelegated',
      version: 1,
      resourceKey: id,
      occurredAt: at,
      eventKey: key(['issue.undelegated', id, appUserId, at]),
      data: {
        issue: fields.issue,
        teamId: fields.teamId,
        ...(fields.teamKey ? { teamKey: fields.teamKey } : {}),
        actor: text(notification.actorId, 200) || text(record(notification.actor)?.id, 200),
        state: fields.state,
        labels: fields.labels,
        assignee: text(issue.assigneeId, 200) || text(record(issue.assignee)?.id, 200),
        delegate: appUserId,
        action: 'undelegated',
      },
      subject: subject('issue.undelegated', fields.identifier, id, fields.title),
      body: [url, fields.title].filter(Boolean).join('\n\n').slice(0, 30000),
      ...(url ? { url } : {}),
    },
  ]
}

function normalizeIssueCreate(payload: Record<string, any>, data: Record<string, any>): IntegrationOutputFact[] {
  const id = text(data.id, 200)
  const at = when(data.createdAt, webhookTime(payload))
  if (!id || !at) return []
  const fields = issueFields(data, id)
  const url = text(data.url, 2000)
  return [
    {
      output: 'issue.created',
      version: 1,
      resourceKey: id,
      occurredAt: at,
      eventKey: key(['issue.created', id]),
      data: {
        issue: fields.issue,
        teamId: fields.teamId,
        ...(fields.teamKey ? { teamKey: fields.teamKey } : {}),
        assignee: text(data.assigneeId, 200),
        delegate: text(data.delegateId, 200),
        action: 'created',
        actor: text(record(payload.actor)?.id, 200) || text(data.creatorId, 200),
        state: fields.state,
        labels: fields.labels,
      },
      subject: subject('issue.created', fields.identifier, id, fields.title),
      body: [url, text(data.description, 30000) || fields.title].filter(Boolean).join('\n\n').slice(0, 30000),
      ...(url ? { url } : {}),
    },
  ]
}
