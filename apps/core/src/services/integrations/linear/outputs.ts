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
  const trigger = commentId ? 'mention' : 'delegation'
  const creator = text(session.creatorId, 200) || text(record(session.creator)?.id, 200)
  const context = text(payload.promptContext, 30000)
  const created = fact(
    'agent_session.created',
    key(['agent_session.created', sessionId]),
    {
      action: 'created',
      actor: creator,
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
  const routed = commentId
    ? fact(
        'issue.mentioned',
        key(['issue.mentioned', sessionId]),
        { action: 'mentioned', actor: creator, comment: { id: commentId }, session: { id: sessionId } },
        context
      )
    : fact(
        'issue.delegated',
        key(['issue.delegated', 'session', sessionId]),
        // The live probe confirms the issue's delegate is this app before any squad receives it.
        { action: 'delegated', actor: creator, delegate: appUserId, session: { id: sessionId } },
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
    let assignee = ''
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
        assignee = assigned
        // A delegation change is reported as its own fact; it is an update only when something else moved too.
        if (delegateChanged && !Object.keys(updatedFrom).some((field) => !['delegateId', 'updatedAt'].includes(field)))
          primary = false
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
          key([output, id, verb, actor, at, fields.state, comment ? '' : assignee, ...(comment ? [text(data.id, 200)] : [])]),
          {
            assignee,
            delegate,
            action: verb,
            ...(comment
              ? {
                  comment: {
                    id: text(data.id, 200),
                    ...(text(data.parentId, 200) ? { parentId: text(data.parentId, 200) } : {}),
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
