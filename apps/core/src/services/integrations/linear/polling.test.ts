import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createEventPollingBudget } from '../event-polling-budget'
import { EventPollingRetryError, type RuntimeConnection } from '../types'
import { linearOutputAdapter, LINEAR_APP_USER_METADATA_KEY } from './outputs'
import {
  advanceLinearWatermark,
  createLinearAgentSessionPolling,
  LINEAR_POLL_FAST_MS,
  LINEAR_POLL_MAX_LOOKBACK_MS,
  LINEAR_POLL_PAGE_SIZE,
  LINEAR_POLL_REQUESTS_PER_TICK,
  LINEAR_POLL_SLOW_MS,
  LINEAR_SESSION_RETRY_REQUESTS,
  LINEAR_POLL_WEBHOOK_RECENCY_MS,
  linearSessionNeedsHandling,
  parseLinearPollingCursor,
  type KnownLinearSession,
  type LinearPollingDependencies,
  type UnfinishedLinearSession,
} from './polling'
import {
  agentSessionCreatedPayload,
  agentSessionPromptedPayload,
  createFakeLinear,
  type FakeLinear,
} from './testing/fake-linear'

const originalFetch = globalThis.fetch
const NOW = Date.parse('2026-11-20T12:00:00.000Z')
const organizationId = 'org-uuid'
const appUserId = 'app-user'
const appConfiguration = {
  version: 2,
  mode: 'app',
  organizationId,
  organizationName: 'Acme',
  organizationUrlKey: 'acme',
  appUserId,
  appUserName: 'Ficus',
  scopes: ['read', 'issues:create', 'comments:create', 'app:assignable', 'app:mentionable'],
}
const appConnection: RuntimeConnection = {
  id: 'connection-1',
  squadId: '',
  providerKey: 'linear',
  adapterVersion: 1,
  configuration: appConfiguration,
}
const issue = {
  id: 'issue-1',
  number: 7,
  identifier: 'ENG-7',
  title: 'Fix the importer',
  url: 'https://linear.app/acme/issue/ENG-7',
  team: { id: 'team-1', key: 'ENG' },
  delegateId: appUserId,
}
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

let linear: FakeLinear
let known: Map<string, KnownLinearSession>
let recentWebhook: boolean
let authorization: string | null
let installedAt: Date | null
let unfinished: UnfinishedLinearSession[]
let retried: Array<[string, string]>

function polling(overrides: Partial<LinearPollingDependencies> = {}) {
  return createLinearAgentSessionPolling({
    resolveAuthorization: async () => authorization,
    installedAt: async () => installedAt,
    receivedRecentWebhook: async (_organization, withinMs) => {
      expect(withinMs).toBe(LINEAR_POLL_WEBHOOK_RECENCY_MS)
      return recentWebhook
    },
    knownSessions: async (ids) => new Map([...known].filter(([id]) => ids.includes(id))),
    unfinishedSessions: async () => unfinished,
    retrySession: async (session, auth) => {
      retried.push([session.id, auth])
      return true
    },
    now: () => new Date(NOW),
    ...overrides,
  })
}
function pollOperations() {
  return linear.calls.map((call) => call.operation)
}

beforeEach(() => {
  linear = createFakeLinear({ clock: () => NOW, app: { id: appUserId, name: 'Ficus', app: true, active: true } })
  linear.addIssue(issue)
  globalThis.fetch = linear.fetch
  known = new Map()
  recentWebhook = false
  authorization = 'Bearer linear-app-access-token'
  installedAt = new Date(NOW - 3_600_000)
  unfinished = []
  retried = []
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('parseLinearPollingCursor', () => {
  test('starts at the install time when there is no cursor', () => {
    const cursor = parseLinearPollingCursor(null, new Date(NOW - 60_000), new Date(NOW))
    expect(cursor).toEqual({
      version: 1,
      sessions: { updatedAfter: iso(-60_000), boundaryIds: [] },
      prompts: { createdAfter: iso(-60_000), boundaryIds: [] },
      notifications: { createdAfter: iso(-60_000), boundaryIds: [] },
    })
  })

  test('caps the lookback at 72 hours, dropping the stale boundary', () => {
    const floor = iso(-LINEAR_POLL_MAX_LOOKBACK_MS)
    expect(parseLinearPollingCursor(null, new Date(0), new Date(NOW)).sessions.updatedAfter).toBe(floor)
    const cursor = parseLinearPollingCursor(
      {
        version: 1,
        sessions: { updatedAfter: iso(-100 * 3_600_000), boundaryIds: ['old'] },
        prompts: { createdAfter: iso(-60_000), boundaryIds: ['p1'] },
        notifications: { createdAfter: 'not a time', boundaryIds: ['n1'] },
      },
      new Date(NOW - 3_600_000),
      new Date(NOW)
    )
    expect(cursor.sessions).toEqual({ updatedAfter: floor, boundaryIds: [] })
    expect(cursor.prompts).toEqual({ createdAfter: iso(-60_000), boundaryIds: ['p1'] })
    // An unreadable watermark restarts at the install time.
    expect(cursor.notifications).toEqual({ createdAfter: iso(-3_600_000), boundaryIds: [] })
  })

  test('an unknown version restarts at the install time', () => {
    const cursor = parseLinearPollingCursor(
      { version: 9, sessions: { updatedAfter: iso(-1_000), boundaryIds: ['x'] } },
      new Date(NOW - 5_000),
      new Date(NOW)
    )
    expect(cursor.sessions).toEqual({ updatedAfter: iso(-5_000), boundaryIds: [] })
  })
})

describe('advanceLinearWatermark', () => {
  const at = Date.parse(iso(0))

  test('equal timestamps are neither skipped nor repeated', () => {
    const first = advanceLinearWatermark({ at: iso(-1_000), boundaryIds: [] }, [
      { id: 'a', at },
      { id: 'b', at: at - 500 },
    ])
    expect(first.fresh.map((item) => item.id)).toEqual(['a', 'b'])
    expect(first.next).toEqual({ at: iso(0), boundaryIds: ['a'] })
    // A second item at exactly the watermark arrives later: it is new, `a` is not.
    const second = advanceLinearWatermark(first.next, [
      { id: 'a', at },
      { id: 'c', at },
    ])
    expect(second.fresh.map((item) => item.id)).toEqual(['c'])
    expect(second.next).toEqual({ at: iso(0), boundaryIds: ['a', 'c'] })
    // Nothing new keeps the watermark as it was.
    expect(advanceLinearWatermark(second.next, [{ id: 'c', at }]).next).toBe(second.next)
  })

  test('items older than the watermark are skipped', () => {
    const result = advanceLinearWatermark({ at: iso(0), boundaryIds: [] }, [{ id: 'old', at: at - 1 }])
    expect(result.fresh).toEqual([])
  })

  test('keeps at most 50 boundary IDs', () => {
    const items = Array.from({ length: 60 }, (_, index) => ({ id: `id-${index}`, at }))
    const result = advanceLinearWatermark({ at: iso(-1), boundaryIds: [] }, items)
    expect(result.next.boundaryIds).toHaveLength(50)
    expect(result.next.boundaryIds.at(-1)).toBe('id-59')
  })
})

describe('linearSessionNeedsHandling', () => {
  test('pending unknown sessions and recorded ones not yet disposed are reprocessed; the rest are left alone', () => {
    expect(linearSessionNeedsHandling('pending', undefined, 'c')).toBe(true)
    expect(linearSessionNeedsHandling('active', undefined, 'c')).toBe(false)
    const handled = { connectionId: 'c', ackState: 'sent', dispositionState: 'sent' }
    expect(linearSessionNeedsHandling('pending', handled, 'c')).toBe(false)
    expect(linearSessionNeedsHandling('active', { ...handled, dispositionState: 'pending' }, 'c')).toBe(true)
    // A failed post after routing is the retry sweep's, not a second routing.
    expect(linearSessionNeedsHandling('pending', { ...handled, ackState: 'failed' }, 'c')).toBe(false)
    expect(linearSessionNeedsHandling('pending', { ...handled, dispositionState: 'failed' }, 'c')).toBe(false)
    expect(
      linearSessionNeedsHandling('pending', { ...handled, dispositionState: 'pending', connectionId: 'other' }, 'c')
    ).toBe(false)
  })
})

describe('Linear agent session polling', () => {
  test('API-key connections return no events and make no request', async () => {
    const result = await polling().poll({ ...appConnection, configuration: { version: 1 } }, null)
    expect(result.events).toEqual([])
    expect(linear.calls).toEqual([])
  })

  test('makes the three specified queries, at most once each, reserving budget before every request', async () => {
    const budget = createEventPollingBudget(10)
    await polling().poll(appConnection, null, budget.signal)
    expect(pollOperations()).toEqual([
      'FicusLinearPollSessions',
      'FicusLinearPollPrompts',
      'FicusLinearPollNotifications',
    ])
    expect(budget.consumed).toBe(LINEAR_POLL_REQUESTS_PER_TICK)
    const [sessions, prompts, notifications] = linear.calls
    expect(sessions!.variables).toEqual({ first: LINEAR_POLL_PAGE_SIZE })
    // `last` pages oldest first, from the install time on the first poll.
    expect(prompts!.variables).toEqual({ last: LINEAR_POLL_PAGE_SIZE, after: iso(-3_600_000) })
    expect(notifications!.variables).toEqual({ last: LINEAR_POLL_PAGE_SIZE, after: iso(-3_600_000) })
    expect(linear.calls.every((call) => call.authorization === 'Bearer linear-app-access-token')).toBe(true)
  })

  test('the queries filter prompts and undelegation notifications', async () => {
    const { LINEAR_POLL_SESSIONS_QUERY, LINEAR_POLL_PROMPTS_QUERY, LINEAR_POLL_NOTIFICATIONS_QUERY } =
      await import('./polling')
    expect(LINEAR_POLL_SESSIONS_QUERY).toContain('agentSessions(first: $first, orderBy: updatedAt)')
    expect(LINEAR_POLL_PROMPTS_QUERY).toContain(
      'agentActivities(last: $last, orderBy: createdAt, filter: { type: { eq: "prompt" }, createdAt: { gte: $after } })'
    )
    expect(LINEAR_POLL_NOTIFICATIONS_QUERY).toContain(
      'filter: { createdAt: { gte: $after }, type: { in: ["issueUnassignedFromYou"] } }'
    )
  })

  test('a budget too small for the poll stops before Linear is called again', async () => {
    const budget = createEventPollingBudget(1)
    await expect(polling().poll(appConnection, null, budget.signal)).rejects.toThrow()
    expect(pollOperations()).toEqual(['FicusLinearPollSessions'])
  })

  test('cadence: 60 seconds without recent app webhooks, 5 minutes with them', async () => {
    expect((await polling().poll(appConnection, null)).suggestedIntervalMs).toBe(LINEAR_POLL_FAST_MS)
    recentWebhook = true
    expect((await polling().poll(appConnection, null)).suggestedIntervalMs).toBe(LINEAR_POLL_SLOW_MS)
    // Three requests per poll at the fastest cadence stay within 180 requests an hour.
    expect((3_600_000 / LINEAR_POLL_FAST_MS) * LINEAR_POLL_REQUESTS_PER_TICK).toBeLessThanOrEqual(180)
  })

  test('an unusable connection reads nothing and keeps its position', async () => {
    authorization = null
    const stored = parseLinearPollingCursor(null, new Date(NOW - 1_000), new Date(NOW))
    const result = await polling().poll(appConnection, { ...stored })
    expect(linear.calls).toEqual([])
    expect(result.events).toEqual([])
    expect(result.nextCursor).toEqual({ ...stored })
  })

  test('unfinished sessions are retried with the app token, each reserving its full call count from the budget', async () => {
    expect(LINEAR_SESSION_RETRY_REQUESTS).toBe(3)
    unfinished = [{ id: 's1' }, { id: 's2' }, { id: 's3' }] as UnfinishedLinearSession[]
    const budget = createEventPollingBudget(LINEAR_POLL_REQUESTS_PER_TICK + 2 * LINEAR_SESSION_RETRY_REQUESTS + 1)
    await polling().poll(appConnection, null, budget.signal)
    // Three queries, then only two of the three retries fit the remaining budget.
    expect(retried).toEqual([
      ['s1', 'Bearer linear-app-access-token'],
      ['s2', 'Bearer linear-app-access-token'],
    ])
    expect(budget.remaining).toBe(1)
  })

  test('a retry that throws does not fail the poll', async () => {
    unfinished = [{ id: 's1' }] as UnfinishedLinearSession[]
    const result = await polling({
      retrySession: async () => {
        throw new Error('provider_unavailable')
      },
    }).poll(appConnection, null)
    expect(result.nextCursor).toMatchObject({ version: 1 })
  })

  test('API-key and unusable connections retry nothing', async () => {
    unfinished = [{ id: 's1' }] as UnfinishedLinearSession[]
    await polling().poll({ ...appConnection, configuration: { version: 1 } }, null)
    authorization = null
    await polling().poll(appConnection, null)
    expect(retried).toEqual([])
  })

  test('a rate-limited poll backs off for Linear’s Retry-After', async () => {
    linear.failNext(429)
    const error = await polling()
      .poll(appConnection, null)
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(EventPollingRetryError)
    expect((error as EventPollingRetryError).retryAfterMs).toBe(30_000)
  })

  test('pending sessions become created events; handled, foreign and older ones do not', async () => {
    linear.addSession({ id: 'pending-new', issueId: issue.id, creatorId: 'member', at: NOW - 30_000 })
    linear.addSession({
      id: 'mention',
      issueId: issue.id,
      creatorId: 'member',
      commentId: 'comment-1',
      at: NOW - 20_000,
    })
    linear.addSession({ id: 'handled', issueId: issue.id, at: NOW - 10_000 })
    linear.addSession({ id: 'active-unknown', issueId: issue.id, status: 'active', at: NOW - 5_000 })
    linear.addSession({ id: 'other-app', issueId: issue.id, appUserId: 'another-app', at: NOW - 4_000 })
    linear.addSession({ id: 'before-install', issueId: issue.id, at: NOW - 7_200_000 })
    known.set('handled', { connectionId: appConnection.id, ackState: 'sent', dispositionState: 'sent' })
    const result = await polling().poll(appConnection, null)
    expect(result.events.map((event) => event.logicalEventKey)).toEqual([
      'linear:session:pending-new:created',
      'linear:session:mention:created',
    ])
    const [delegation, mention] = result.events
    expect(delegation!.type).toBe('AgentSessionEvent')
    expect(delegation!.payload).toMatchObject({
      type: 'AgentSessionEvent',
      action: 'created',
      organizationId,
      appUserId,
      agentSession: { id: 'pending-new', issueId: issue.id, creatorId: 'member', status: 'pending' },
    })
    expect((mention!.payload as any).agentSession.commentId).toBe('comment-1')
    expect(result.nextCursor.sessions).toEqual({ updatedAfter: iso(-4_000), boundaryIds: ['other-app'] })
  })

  test('the next poll starts after what the last one saw', async () => {
    linear.addSession({ id: 'first', issueId: issue.id, at: NOW - 30_000 })
    const first = await polling().poll(appConnection, null)
    expect(first.events).toHaveLength(1)
    const second = await polling().poll(appConnection, first.nextCursor)
    expect(second.events).toEqual([])
    linear.addSession({ id: 'same-time', issueId: issue.id, at: NOW - 30_000 })
    const third = await polling().poll(appConnection, second.nextCursor)
    expect(third.events.map((event) => event.logicalEventKey)).toEqual(['linear:session:same-time:created'])
  })

  test('prompts on the app’s sessions become prompted events, oldest first', async () => {
    linear.addSession({ id: 'session-1', issueId: issue.id, status: 'active', at: NOW - 60_000 })
    linear.addSession({ id: 'foreign', issueId: issue.id, appUserId: 'another-app', at: NOW - 60_000 })
    linear.addPrompt({
      id: 'prompt-2',
      sessionId: 'session-1',
      userId: 'member',
      body: 'And the tests',
      at: NOW - 5_000,
    })
    linear.addPrompt({
      id: 'prompt-1',
      sessionId: 'session-1',
      userId: 'member',
      body: 'Please hurry',
      at: NOW - 9_000,
    })
    linear.addPrompt({
      id: 'stop',
      sessionId: 'session-1',
      userId: 'member',
      body: 'Stop',
      signal: 'stop',
      at: NOW - 1_000,
    })
    linear.addPrompt({ id: 'foreign-prompt', sessionId: 'foreign', userId: 'member', body: 'Hi', at: NOW - 1_000 })
    linear.addPrompt({ id: 'too-old', sessionId: 'session-1', userId: 'member', body: 'Old', at: NOW - 7_200_000 })
    const result = await polling().poll(appConnection, null)
    expect(result.events.map((event) => event.logicalEventKey)).toEqual([
      'linear:activity:prompt-1',
      'linear:activity:prompt-2',
      'linear:activity:stop',
    ])
    expect(result.events[0]!.payload).toMatchObject({
      action: 'prompted',
      agentSession: { id: 'session-1', issueId: issue.id },
      agentActivity: { id: 'prompt-1', userId: 'member', body: 'Please hurry' },
    })
    expect((result.events[2]!.payload as any).agentActivity.signal).toBe('stop')
    const prompts = result.nextCursor.prompts as { createdAfter: string; boundaryIds: string[] }
    expect(prompts.createdAfter).toBe(iso(-1_000))
    expect([...prompts.boundaryIds].sort()).toEqual(['foreign-prompt', 'stop'])
  })

  test('undelegation notifications become notification events', async () => {
    linear.addNotification({
      id: 'note-1',
      type: 'issueUnassignedFromYou',
      issueId: issue.id,
      actorId: 'member',
      at: NOW - 2_000,
    })
    linear.addNotification({ id: 'note-2', type: 'issueMention', issueId: issue.id, at: NOW - 1_000 })
    const result = await polling().poll(appConnection, null)
    expect(result.events.map((event) => event.logicalEventKey)).toEqual(['linear:notification:note-1'])
    expect(result.events[0]!.payload).toMatchObject({
      type: 'AppUserNotification',
      action: 'issueUnassignedFromYou',
      appUserId,
      notification: { id: 'note-1', issueId: issue.id, actorId: 'member', createdAt: iso(-2_000) },
    })
  })

  test('polled events normalize to the same fact event keys as their webhooks', async () => {
    const context = { organizationId, oauthClientId: 'client', appUserId }
    linear.addSession({ id: 'session-x', issueId: issue.id, creatorId: 'member', at: NOW - 30_000 })
    linear.addPrompt({ id: 'activity-x', sessionId: 'session-x', userId: 'member', body: 'More', at: NOW - 10_000 })
    const result = await polling().poll(appConnection, null)
    const keys = (event: { type: string; payload: unknown }) =>
      linearOutputAdapter
        .normalize({ ...event, metadata: { [LINEAR_APP_USER_METADATA_KEY]: appUserId } })
        .map((fact) => [fact.output, fact.eventKey])
    const webhookCreated = agentSessionCreatedPayload(context, {
      sessionId: 'session-x',
      issue,
      creatorId: 'member',
      timestamp: NOW - 29_000,
    })
    const webhookPrompted = agentSessionPromptedPayload(context, {
      sessionId: 'session-x',
      issue,
      userId: 'member',
      activityId: 'activity-x',
      body: 'More',
    })
    expect(keys(result.events[0]!)).toEqual(keys({ type: 'AgentSessionEvent', payload: webhookCreated }))
    expect(keys(result.events[0]!).map(([output]) => output)).toEqual(['agent_session.created', 'issue.delegated'])
    expect(keys(result.events[1]!)).toEqual(keys({ type: 'AgentSessionEvent', payload: webhookPrompted }))
  })
})
