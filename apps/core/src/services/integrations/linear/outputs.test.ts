import { expect, test } from 'bun:test'
import type { IntegrationOutputFact } from '@ficus/shared'
import { linearOutputAdapter } from './outputs'

const issueUrl = 'https://linear.app/acme/issue/ENG-123'
function issueData(changes: Record<string, unknown> = {}) {
  return {
    id: 'issue-uuid',
    number: 123,
    identifier: 'ENG-123',
    title: 'Fix bug',
    url: issueUrl,
    teamId: 'team-uuid',
    team: { id: 'team-uuid', key: 'ENG', name: 'Engineering' },
    state: { id: 'state-uuid', name: 'In Progress', type: 'started' },
    assigneeId: 'user-1',
    labelIds: ['label-uuid'],
    labels: [{ id: 'label-uuid', name: 'bug' }],
    priority: 2,
    description: 'Steps to reproduce',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-07T10:00:00.000Z',
    ...changes,
  }
}
function issueEvent(updatedFrom: Record<string, unknown>, changes: Record<string, unknown> = {}, action = 'update') {
  return {
    type: 'Issue',
    payload: {
      action,
      type: 'Issue',
      updatedFrom,
      data: issueData(changes),
      webhookTimestamp: Date.parse('2026-09-07T11:00:00.000Z'),
    },
  }
}
function commentEvent(data: Record<string, unknown> = {}, action = 'create') {
  return {
    type: 'Comment',
    payload: {
      action,
      type: 'Comment',
      data: {
        id: 'comment-uuid',
        body: 'Looks good to me',
        issueId: 'issue-uuid',
        issue: { id: 'issue-uuid', title: 'Fix bug' },
        userId: 'user-2',
        url: `${issueUrl}#comment-comment-uuid`,
        createdAt: '2026-09-07T12:00:00.000Z',
        updatedAt: '2026-09-07T12:30:00.000Z',
        ...data,
      },
      webhookTimestamp: Date.parse('2026-09-07T13:00:00.000Z'),
    },
  }
}
function only(event: { type: string; payload: unknown }) {
  const facts = linearOutputAdapter.normalize(event)
  expect(facts).toHaveLength(1)
  return facts[0]!
}

test('assignment carries the full Linear issue identity', () => {
  const fact = only(issueEvent({ assigneeId: null }))
  expect(fact.output).toBe('issue.assigned')
  expect(fact.version).toBe(1)
  expect(fact.resourceKey).toBe('issue-uuid')
  expect(fact.occurredAt).toBe('2026-09-07T10:00:00.000Z')
  expect(fact.eventKey).toMatch(/^[0-9a-f]{64}$/)
  expect(fact.data).toEqual({
    issue: { id: 'issue-uuid', number: 123, identifier: 'ENG-123', title: 'Fix bug' },
    teamId: 'team-uuid',
    teamKey: 'eng',
    assignee: 'user-1',
    delegate: '',
    action: 'assigned',
    actor: '',
    state: 'started',
    labels: ['bug'],
  })
  expect(fact.subject).toBe('Linear issue assigned: ENG-123 Fix bug')
  expect(fact.body).toBe(`${issueUrl}\n\nSteps to reproduce`)
  expect(fact.url).toBe(issueUrl)
})

test('unassignment reports the previous assignee', () => {
  const fact = only(issueEvent({ assigneeId: 'user-1' }, { assigneeId: null }))
  expect(fact.output).toBe('issue.unassigned')
  expect(fact.data.assignee).toBe('user-1')
  expect(fact.data.action).toBe('unassigned')
  expect(fact.subject).toBe('Linear issue unassigned: ENG-123 Fix bug')
  // An update that neither had nor gained an assignee identifies nobody to route on.
  expect(linearOutputAdapter.normalize(issueEvent({ assigneeId: null }, { assigneeId: null }))).toEqual([])
})

test('other updates report which field changed', () => {
  expect(only(issueEvent({ stateId: 'other-state-uuid' })).output).toBe('issue.updated')
  expect(only(issueEvent({ stateId: 'other-state-uuid' })).data.action).toBe('state')
  expect(only(issueEvent({ title: 'Old title' })).data.action).toBe('title')
  expect(only(issueEvent({ labelIds: [] })).data.action).toBe('labels')
  expect(only(issueEvent({ priority: 1 })).data.action).toBe('updated')
  expect(only(issueEvent({})).data.action).toBe('updated')
  const fact = only(
    issueEvent({ stateId: 'other-state-uuid' }, { state: { id: 's', name: 'Done', type: 'completed' } })
  )
  expect(fact.data.state).toBe('completed')
  expect(fact.data.assignee).toBe('user-1')
  expect(fact.subject).toBe('Linear issue updated: ENG-123 Fix bug')
})

test('Linear label conditions match regardless of the casing on the issue or in the saved rule', async () => {
  const { previewSquadEventRules, selectSquadEventRule, squadEventRuleSchema } = await import('@ficus/shared')
  const fact = only(issueEvent({ labelIds: [] }, { labels: [{ id: 'label-uuid', name: 'Blocked' }] }))
  expect(fact.output).toBe('issue.updated')
  // The stored fact keeps Linear's casing; only the comparison ignores it.
  expect(fact.data.labels).toEqual(['Blocked'])
  for (const [op, value, selected] of [
    ['not-contains', 'blocked', undefined],
    ['not-contains', 'BLOCKED', undefined],
    ['contains', 'blocked', 'labels'],
    ['contains', 'Blocked', 'labels'],
    ['not-contains', 'bug', 'labels'],
  ] as const) {
    const metadata = {
      integrationRules: {
        linear: [
          squadEventRuleSchema.parse({
            id: 'labels',
            source: { integration: 'linear', output: 'issue.updated', version: 1 },
            filters: { audience: 'any' },
            predicates: [{ field: 'labels', op, value }],
            action: { type: 'notify-manager' },
          }),
        ],
      },
    }
    expect(selectSquadEventRule(metadata, 'linear', fact, '')?.id).toBe(selected)
    expect(previewSquadEventRules(metadata, 'linear', fact, '').selectedRuleId).toBe(selected ?? null)
  }
})

test('comments become issue facts keyed by the issue', () => {
  const fact = only(commentEvent())
  expect(fact.output).toBe('issue.comment')
  expect(fact.resourceKey).toBe('issue-uuid')
  expect(fact.occurredAt).toBe('2026-09-07T12:00:00.000Z')
  expect(fact.data).toEqual({
    issue: { id: 'issue-uuid', title: 'Fix bug' },
    teamId: '',
    assignee: '',
    delegate: '',
    action: 'create',
    actor: 'user-2',
    state: '',
    labels: [],
    comment: { id: 'comment-uuid', inSession: false },
  })
  expect(fact.subject).toBe('Linear issue comment: issue-uuid Fix bug')
  expect(fact.body).toBe(`${issueUrl}#comment-comment-uuid\n\nLooks good to me`)
  expect(fact.url).toBe(`${issueUrl}#comment-comment-uuid`)
  expect(only(commentEvent({}, 'update')).data.action).toBe('update')
  // The nested issue alone still identifies the resource.
  expect(only(commentEvent({ issueId: undefined })).resourceKey).toBe('issue-uuid')
})

test('each comment edit is its own fact, timed by the edit', () => {
  const first = only(commentEvent({ updatedAt: '2026-09-07T12:30:00.000Z' }, 'update'))
  const second = only(commentEvent({ updatedAt: '2026-09-07T12:45:00.000Z' }, 'update'))
  expect(first.occurredAt).toBe('2026-09-07T12:30:00.000Z')
  expect(second.occurredAt).toBe('2026-09-07T12:45:00.000Z')
  expect(first.eventKey).not.toBe(second.eventKey)
  // A redelivery of the very same webhook stays one fact.
  expect(only(commentEvent({ updatedAt: '2026-09-07T12:45:00.000Z' }, 'update')).eventKey).toBe(second.eventKey)
  // Creation still reports the creation time, and is distinct from an edit at the same instant.
  expect(only(commentEvent({ createdAt: '2026-09-07T12:30:00.000Z' })).occurredAt).toBe('2026-09-07T12:30:00.000Z')
  expect(only(commentEvent({ updatedAt: undefined }, 'update')).occurredAt).toBe('2026-09-07T12:00:00.000Z')
  // Two different comments posted at the same instant are two facts.
  expect(only(commentEvent({ id: 'other-comment-uuid' })).eventKey).not.toBe(only(commentEvent()).eventKey)
})

test('a mutated Linear-Event header cannot re-type a signed body', () => {
  // Each body below normalizes fine under its own header; only the disagreement rejects it.
  const comment = commentEvent()
  expect(only(comment).output).toBe('issue.comment')
  expect(linearOutputAdapter.normalize({ ...comment, payload: { ...comment.payload, type: 'Issue' } })).toEqual([])
  const issue = issueEvent({ assigneeId: null })
  expect(only(issue).output).toBe('issue.assigned')
  expect(linearOutputAdapter.normalize({ ...issue, payload: { ...issue.payload, type: 'Comment' } })).toEqual([])
  // Payloads that carry no type at all are still normalized on the header alone.
  expect(only({ type: 'Comment', payload: { ...comment.payload, type: undefined } }).output).toBe('issue.comment')
})

test('unusable Linear events are ignored rather than thrown on', () => {
  expect(linearOutputAdapter.normalize(issueEvent({ assigneeId: null }, {}, 'remove'))).toEqual([])
  expect(linearOutputAdapter.normalize(commentEvent({}, 'remove'))).toEqual([])
  expect(linearOutputAdapter.normalize({ type: 'Project', payload: { action: 'update', data: { id: 'p' } } })).toEqual(
    []
  )
  expect(linearOutputAdapter.normalize({ type: 'Issue', payload: null })).toEqual([])
  expect(linearOutputAdapter.normalize({ type: 'Issue', payload: 'nonsense' })).toEqual([])
  expect(linearOutputAdapter.normalize({ type: 'Issue', payload: { action: 'update', data: null } })).toEqual([])
  expect(linearOutputAdapter.normalize({ type: 'Issue', payload: { action: 'update', data: { id: 42 } } })).toEqual([])
  expect(
    linearOutputAdapter.normalize({ type: 'Comment', payload: { action: 'create', data: { body: 'hi' } } })
  ).toEqual([])
  // No usable timestamp anywhere.
  expect(
    linearOutputAdapter.normalize({
      type: 'Issue',
      payload: { action: 'update', updatedFrom: {}, data: { id: 'issue-uuid', updatedAt: 'not-a-date' } },
    })
  ).toEqual([])
  expect(
    linearOutputAdapter.normalize({
      type: 'Issue',
      payload: { action: 'update', updatedFrom: {}, data: { id: 'issue-uuid' }, webhookTimestamp: Number.NaN },
    })
  ).toEqual([])
})

test('older payloads without identifier, number, or team key still normalize', () => {
  const fact = only(
    issueEvent({ assigneeId: null }, { identifier: undefined, number: undefined, team: undefined, labels: undefined })
  )
  expect(fact.data).toEqual({
    issue: { id: 'issue-uuid', title: 'Fix bug' },
    teamId: 'team-uuid',
    assignee: 'user-1',
    delegate: '',
    action: 'assigned',
    actor: '',
    state: 'started',
    labels: [],
  })
  expect(fact.subject).toBe('Linear issue assigned: issue-uuid Fix bug')
  // The webhook timestamp is the fallback when the issue carries no updatedAt.
  expect(only(issueEvent({ assigneeId: null }, { updatedAt: undefined })).occurredAt).toBe('2026-09-07T11:00:00.000Z')
})

test('event keys are stable per event and separate distinct facts', () => {
  const key = (event: { type: string; payload: unknown }) => only(event).eventKey
  const assigned = key(issueEvent({ assigneeId: null }))
  expect(key(issueEvent({ assigneeId: null }))).toBe(assigned)
  // Two deliveries that assign the same user at the same instant are one fact, whatever they replaced.
  expect(key(issueEvent({ assigneeId: 'user-0' }))).toBe(assigned)
  expect(key(issueEvent({ assigneeId: 'user-1' }, { assigneeId: null }))).not.toBe(assigned)
  expect(key(issueEvent({ assigneeId: null }, { assigneeId: 'user-9' }))).not.toBe(assigned)
  expect(key(issueEvent({ assigneeId: null }, { updatedAt: '2026-09-07T10:00:01.000Z' }))).not.toBe(assigned)
  expect(key(issueEvent({ title: 'Old title' }))).not.toBe(key(issueEvent({ stateId: 'other' })))
  expect(key(commentEvent())).not.toBe(assigned)
  expect(key(commentEvent({ userId: 'user-3' }))).not.toBe(key(commentEvent()))
})

test('tracked identity uses the team key and number, falling back to the issue id', () => {
  const assigned = only(issueEvent({ assigneeId: null }))
  expect(linearOutputAdapter.trackedResource?.(assigned)).toEqual({
    integration: 'linear',
    repository: 'eng',
    kind: 'issue',
    number: 123,
    externalId: 'issue-uuid',
    url: issueUrl,
  })
  expect(linearOutputAdapter.trackedIdentity?.(assigned)).toEqual({ integration: 'linear', externalId: 'issue-uuid' })
  const comment = only(commentEvent())
  expect(linearOutputAdapter.trackedResource?.(comment)).toBeNull()
  expect(linearOutputAdapter.trackedIdentity?.(comment)).toEqual({ integration: 'linear', externalId: 'issue-uuid' })
  const noTeamKey = only(issueEvent({ assigneeId: null }, { team: undefined }))
  expect(linearOutputAdapter.trackedResource?.(noTeamKey)).toBeNull()
  const noNumber = only(issueEvent({ assigneeId: null }, { number: undefined }))
  expect(linearOutputAdapter.trackedResource?.(noNumber)).toBeNull()
  const bare = { data: {} } as unknown as IntegrationOutputFact
  expect(linearOutputAdapter.trackedResource?.(bare)).toBeNull()
  expect(linearOutputAdapter.trackedIdentity?.(bare)).toBeNull()
})

test('work stream bindings still expose the Linear issue and team', () => {
  expect(linearOutputAdapter.workStreamBindings?.(only(issueEvent({ assigneeId: null })))).toEqual({
    'linear.issueId': { event: 'issue.id' },
    'linear.teamId': { event: 'teamId' },
  })
})

const app = 'app-user'
function sessionEvent(action: 'created' | 'prompted', session: Record<string, unknown> = {}, extra = {}) {
  return {
    type: 'AgentSessionEvent',
    payload: {
      type: 'AgentSessionEvent',
      action,
      createdAt: '2026-11-19T10:00:00.000Z',
      organizationId: 'org-uuid',
      oauthClientId: 'client-id',
      appUserId: app,
      agentSession: {
        id: 'session-uuid',
        issueId: 'issue-uuid',
        issue: {
          id: 'issue-uuid',
          identifier: 'ENG-123',
          number: 123,
          title: 'Fix bug',
          url: issueUrl,
          team: { id: 'team-uuid', key: 'ENG' },
        },
        creatorId: 'person',
        url: 'https://linear.app/acme/issue/ENG-123#agent-session',
        status: 'pending',
        ...session,
      },
      promptContext: '<issue identifier="ENG-123"><title>Fix bug</title></issue>',
      webhookTimestamp: Date.parse('2026-11-19T10:00:01.000Z'),
      ...extra,
    },
  }
}

test('a delegation session yields the session fact and exactly one delegated fact', () => {
  const facts = linearOutputAdapter.normalize(sessionEvent('created'))
  expect(facts.map((fact) => fact.output)).toEqual(['agent_session.created', 'issue.delegated'])
  const [created, delegated] = facts
  expect(created!.data).toMatchObject({
    issue: { id: 'issue-uuid', number: 123, identifier: 'ENG-123' },
    teamId: 'team-uuid',
    teamKey: 'eng',
    actor: 'person',
    session: { id: 'session-uuid', trigger: 'delegation', creator: 'person', appUserId: app },
  })
  expect(delegated!.data).toMatchObject({ delegate: app, session: { id: 'session-uuid' }, action: 'delegated' })
  expect(delegated!.body).toContain('<issue identifier="ENG-123">')
  expect(created!.resourceKey).toBe('issue-uuid')
})

test('a mention session yields the session fact and exactly one mentioned fact', () => {
  const facts = linearOutputAdapter.normalize(sessionEvent('created', { commentId: 'comment-uuid' }))
  expect(facts.map((fact) => fact.output)).toEqual(['agent_session.created', 'issue.mentioned'])
  expect(facts[0]!.data).toMatchObject({ session: { trigger: 'mention' }, comment: { id: 'comment-uuid' } })
  expect(facts[1]!.data).toMatchObject({ comment: { id: 'comment-uuid' }, session: { id: 'session-uuid' } })
})

test('a prompt yields one prompted fact keyed by its activity', () => {
  const prompted = (activity: Record<string, unknown>) =>
    linearOutputAdapter.normalize(sessionEvent('prompted', {}, { agentActivity: activity }))
  const [fact] = prompted({ id: 'activity-uuid', body: 'Please also fix the footer', userId: 'person' })
  expect(fact!.output).toBe('agent_session.prompted')
  expect(fact!.data).toMatchObject({
    actor: 'person',
    session: { id: 'session-uuid', appUserId: app },
    activity: { id: 'activity-uuid' },
    prompt: { signal: '' },
  })
  expect(fact!.body).toBe(`${issueUrl}\n\nPlease also fix the footer`)
  expect(
    prompted({ id: 'activity-uuid', content: { type: 'prompt', body: 'Stop' }, signal: 'stop' })[0]!.data
  ).toMatchObject({ prompt: { signal: 'stop' } })
  expect(prompted({ id: 'activity-uuid', body: 'x' })[0]!.eventKey).toBe(fact!.eventKey)
  expect(prompted({ id: 'other-activity', body: 'x' })[0]!.eventKey).not.toBe(fact!.eventKey)
  expect(prompted({ body: 'no id' })).toEqual([])
})

test('session event keys depend only on stable Linear IDs, so webhook and polling agree', () => {
  const keys = (event: ReturnType<typeof sessionEvent>) =>
    linearOutputAdapter.normalize(event).map((fact) => fact.eventKey)
  const first = keys(sessionEvent('created'))
  const redelivered = keys(
    sessionEvent('created', { status: 'active' }, { webhookTimestamp: Date.now(), createdAt: '2026-11-19T10:05:00Z' })
  )
  expect(redelivered).toEqual(first)
  expect(keys(sessionEvent('created', { id: 'other-session' }))).not.toEqual(first)
})

test('sessions without an issue, or without a session or app user, produce no outputs', () => {
  expect(linearOutputAdapter.normalize(sessionEvent('created', { issueId: undefined, issue: undefined }))).toEqual([])
  expect(linearOutputAdapter.normalize(sessionEvent('created', { id: undefined }))).toEqual([])
  expect(linearOutputAdapter.normalize(sessionEvent('created', {}, { appUserId: undefined }))).toEqual([])
  expect(linearOutputAdapter.normalize({ ...sessionEvent('created'), type: 'AppUserNotification' } as never)).toEqual(
    []
  )
})

test('issue creation is its own fact with the delegate and assignee at creation', () => {
  const fact = only(issueEvent({}, { delegateId: 'other-agent', creatorId: 'person' }, 'create'))
  expect(fact.output).toBe('issue.created')
  expect(fact.data).toMatchObject({ delegate: 'other-agent', assignee: 'user-1', actor: 'person', action: 'created' })
  expect(fact.occurredAt).toBe('2026-09-01T10:00:00.000Z')
  expect(fact.eventKey).toBe(only(issueEvent({}, { title: 'Renamed' }, 'create')).eventKey)
})

test('delegate changes become delegated and undelegated facts; a self-delegation comes from the session', () => {
  const outputs = (event: ReturnType<typeof issueEvent>, metadata?: Record<string, unknown>) =>
    linearOutputAdapter.normalize({ ...event, metadata }).map((fact) => [fact.output, fact.data.delegate])
  // Existing issue.updated rules and subscriptions still see a delegate change as an update.
  expect(outputs(issueEvent({ delegateId: null }, { delegateId: 'other-agent' }))).toEqual([
    ['issue.updated', 'other-agent'],
    ['issue.delegated', 'other-agent'],
  ])
  expect(outputs(issueEvent({ delegateId: 'other-agent' }, { delegateId: null }))).toEqual([
    ['issue.updated', ''],
    ['issue.undelegated', 'other-agent'],
  ])
  expect(outputs(issueEvent({ delegateId: 'other-agent' }, { delegateId: app }), { linearAppUserId: app })).toEqual([
    ['issue.updated', app],
    ['issue.undelegated', 'other-agent'],
  ])
  // Delegations to the app on an API-key connection (no app context) still report the delegation.
  expect(outputs(issueEvent({ delegateId: null }, { delegateId: app }))).toEqual([
    ['issue.updated', app],
    ['issue.delegated', app],
  ])
  // A state change with a delegation reports both.
  expect(outputs(issueEvent({ delegateId: null, stateId: 'old' }, { delegateId: 'other-agent' }))).toEqual([
    ['issue.updated', 'other-agent'],
    ['issue.delegated', 'other-agent'],
  ])
  const delegated = linearOutputAdapter
    .normalize(issueEvent({ delegateId: 'a' }, { delegateId: 'b' }))
    .find((fact) => fact.output === 'issue.delegated')
  expect(delegated!.data.previousDelegate).toBe('a')
})

test('comments carry their own ID and parent', () => {
  expect(only(commentEvent({ parentId: 'parent-uuid' })).data.comment).toEqual({
    id: 'comment-uuid',
    parentId: 'parent-uuid',
    inSession: false,
  })
})
