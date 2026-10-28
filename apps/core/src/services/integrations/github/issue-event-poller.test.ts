import { expect, test } from 'bun:test'
import type { GitHubPollingFetch } from './event-poller'
import { GitHubIssueEventPoller } from './issue-event-poller'
import { GitHubPollingProvider } from './provider'
import { createEventPollingBudget } from '../event-polling-budget'
import { githubOutputAdapter } from '../outputs/github'

const connection = {
  id: 'github:squad',
  squadId: 'squad',
  providerKey: 'github',
  adapterVersion: 1,
  configuration: { kind: 'issue-events' as const, owner: 'acme', repo: 'widgets' },
}
const occurredAt = '2026-09-07T10:00:00Z'
const item = (id: number, action = 'assigned') => ({
  id,
  event: action,
  created_at: occurredAt,
  issue: { id: 42, number: 7, title: 'Fix latency', updated_at: '2026-09-07T12:00:00Z', state: 'open' },
  assignee: { login: 'ficus-bot' },
  actor: { login: 'noah' },
})
function response(items: unknown[], next = false, etag = 'head') {
  return Response.json(items, {
    headers: { etag, ...(next ? { link: '<https://api.github.com/next>; rel="next"' } : {}) },
  })
}

function withRepository(page: GitHubPollingFetch): GitHubPollingFetch {
  return (url, init) =>
    url.includes('/issues/events?')
      ? page(url, init)
      : Promise.resolve(Response.json({ id: 10, full_name: 'acme/widgets' }))
}

test('provider exposes repository polling and baselines historical assignments without emitting them', async () => {
  const provider = new GitHubPollingProvider(
    async () => 'token',
    async (_url, init) => {
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer token')
      return response([item(12), item(11)])
    }
  )
  expect(provider.parseConfig(connection.configuration)).toEqual(connection.configuration)
  const result = await provider.capabilities.event_polling!.poll(connection, null)
  expect(result.events).toEqual([])
  expect(result.nextCursor).toEqual({ watermark: 12, etag: 'head' })
})

test('new assignments and removals produce the same typed flow outputs as webhook events', async () => {
  const poller = new GitHubIssueEventPoller(
    async () => 'token',
    withRepository(async () => response([item(12, 'unassigned'), item(11), item(10)]))
  )
  const result = await poller.poll(connection, { watermark: 10 })
  expect(result.events).toHaveLength(2)
  const outputs = result.events.flatMap((event) => githubOutputAdapter.normalize(event))
  expect(outputs.map((output) => output.output)).toEqual(['issue.assigned', 'issue.unassigned'])
  expect(outputs[0]!.data).toMatchObject({ repository: 'acme/widgets', assignee: 'ficus-bot', issue: { number: 7 } })
  expect(outputs[0]!.occurredAt).toBe('2026-09-07T10:00:00.000Z')
  const webhook = githubOutputAdapter.normalize({
    type: 'issues',
    payload: {
      action: 'assigned',
      issue: { ...item(11).issue, updated_at: occurredAt },
      repository: { id: 10, full_name: 'acme/widgets' },
      assignee: item(11).assignee,
      sender: item(11).actor,
    },
  })
  expect(outputs[0]!.eventKey).toBe(webhook[0]!.eventKey)
  expect(result.events[0]!.logicalEventKey).toBeTruthy()
  expect(Object.keys(result.events[0]!)).not.toContain('logicalEventKey')
})

test('synthesized close and reopen events carry the event time as the close time', async () => {
  // GitHub embeds the issue's CURRENT state in every event, so a page read after a
  // later transition reports the later close time. Each synthesized event must
  // describe its own moment instead.
  const current = { ...item(11).issue, state: 'closed', closed_at: '2026-09-07T20:00:00Z' }
  const poller = new GitHubIssueEventPoller(
    async () => 'token',
    withRepository(async () =>
      response([
        { ...item(13, 'assigned'), issue: current },
        { ...item(12, 'reopened'), issue: current, assignee: null },
        { ...item(11, 'closed'), issue: current, assignee: null },
      ])
    )
  )
  const result = await poller.poll(connection, { watermark: 10 })
  const issues = result.events.map((event) => (event.payload as Record<string, any>).issue)
  expect(result.events.map((event) => (event.payload as Record<string, any>).action)).toEqual([
    'closed',
    'reopened',
    'assigned',
  ])
  expect(issues[0]).toMatchObject({ updated_at: occurredAt, closed_at: occurredAt })
  expect(issues[1]).toMatchObject({ updated_at: occurredAt, closed_at: null })
  // Only close transitions restate the close time; anything else keeps the issue as read.
  expect(issues[2]).toMatchObject({ updated_at: occurredAt, closed_at: '2026-09-07T20:00:00Z' })

  // The webhook for that same close still collapses onto the polled event.
  const webhook = githubOutputAdapter.normalize({
    type: 'issues',
    payload: {
      action: 'closed',
      issue: { ...item(11).issue, state: 'closed', updated_at: occurredAt, closed_at: occurredAt },
      repository: { id: 10, full_name: 'acme/widgets' },
      sender: item(11).actor,
    },
  })
  const polled = githubOutputAdapter.normalize(result.events[0]!)
  expect(polled[0]!.output).toBe('issue.updated')
  expect(polled[0]!.eventKey).toBe(webhook[0]!.eventKey)
  expect(polled[0]!.occurredAt).toBe('2026-09-07T10:00:00.000Z')
})

test('page scans retain the previous watermark until a burst is drained within the request budget', async () => {
  const urls: string[] = []
  const poller = new GitHubIssueEventPoller(
    async () => 'token',
    async (url) => {
      urls.push(url)
      if (!url.includes('/issues/events?')) return Response.json({ id: 10, full_name: 'acme/widgets' })
      return url.endsWith('page=1')
        ? response([item(15), item(14)], true)
        : response([item(14), item(13), item(12)], true)
    }
  )
  const budget = createEventPollingBudget(2)
  const first = await poller.poll(connection, { watermark: 12 }, budget.signal)
  expect(budget.consumed).toBe(2)
  expect(first.nextCursor).toMatchObject({ watermark: 12, scan: { page: 2, ceiling: 15 } })
  const second = await poller.poll(connection, first.nextCursor, createEventPollingBudget(1).signal)
  expect(second.nextCursor).toEqual({ watermark: 15, etag: 'head' })
  expect(urls).toHaveLength(3)
  expect(first.events[0]!.logicalEventKey).toBe(second.events[1]!.logicalEventKey)
  expect(second.events).toHaveLength(2)
})

test('conditional unchanged reads preserve cursor and emit nothing', async () => {
  const poller = new GitHubIssueEventPoller(
    async () => 'token',
    async (_url, init) => {
      expect((init?.headers as Record<string, string>)['if-none-match']).toBe('old')
      return new Response(null, { status: 304 })
    }
  )
  const result = await poller.poll(connection, { watermark: 12, etag: 'old' })
  expect(result.events).toEqual([])
  expect(result.nextCursor).toEqual({ watermark: 12, etag: 'old' })
})

test('PR assignments and unrelated issue events are not treated as issue assignments', async () => {
  const poller = new GitHubIssueEventPoller(
    async () => 'token',
    withRepository(async () =>
      response([
        {
          ...item(13),
          issue: { ...item(13).issue, pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/7' } },
        },
        item(12, 'subscribed'),
        item(11, 'closed'),
      ])
    )
  )
  const result = await poller.poll(connection, { watermark: 10 })
  expect(result.events).toHaveLength(1)
  expect(githubOutputAdapter.normalize(result.events[0]!)[0]!.output).toBe('issue.updated')
})

test('credential failures, denied reads, malformed pages, and exhausted budgets never advance a cursor', async () => {
  const noCredential = new GitHubIssueEventPoller(
    async () => undefined,
    async () => {
      throw new Error('must not request')
    }
  )
  await expect(noCredential.poll(connection, { watermark: 10 })).rejects.toThrow('credential unavailable')
  const denied = new GitHubIssueEventPoller(
    async () => 'token',
    async () => new Response(null, { status: 403 })
  )
  await expect(denied.poll(connection, { watermark: 10 })).rejects.toThrow('(403)')
  const malformed = new GitHubIssueEventPoller(
    async () => 'token',
    async () => Response.json({ message: 'bad' })
  )
  await expect(malformed.poll(connection, { watermark: 10 })).rejects.toThrow('Invalid GitHub')
  const noBudget = new GitHubIssueEventPoller(
    async () => 'token',
    async () => {
      throw new Error('must not request')
    }
  )
  await expect(noBudget.poll(connection, { watermark: 10 }, createEventPollingBudget(0).signal)).rejects.toThrow(
    'budget exhausted'
  )
})

test('new issue assignments obtain verified native repository identity with one cached budgeted lookup', async () => {
  const urls: string[] = []
  let eventId = 12
  const poller = new GitHubIssueEventPoller(
    async () => 'assigned-token',
    async (url, init) => {
      urls.push(url)
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer assigned-token')
      if (!url.includes('/issues/events?')) {
        expect((init?.headers as Record<string, string>)['if-none-match']).toBeUndefined()
        expect(init?.redirect).toBe('error')
        return Response.json({ id: 10, full_name: 'ACME/Widgets' })
      }
      return response([item(eventId), item(eventId - 1)])
    }
  )
  const budget = createEventPollingBudget(2)
  const first = await poller.poll(connection, { watermark: 10, etag: 'events-only' }, budget.signal)
  expect(first.events).toHaveLength(2)
  expect(first.events.every((event) => event.payload.repository.id === 10)).toBe(true)
  expect(budget.consumed).toBe(2)
  expect(first.budgetUnitsConsumed).toBe(2)
  const { hasGitHubFreshnessBinding } = await import('./feedback-freshness-binding')
  const [fact] = githubOutputAdapter.normalize(first.events[0]!)
  expect(hasGitHubFreshnessBinding({ integration: 'github', sourceKey: 'native-poll-fixture', fact: fact! })).toBe(true)
  eventId = 14
  const cachedBudget = createEventPollingBudget(1)
  const second = await poller.poll(connection, first.nextCursor, cachedBudget.signal)
  expect(second.events).toHaveLength(2)
  expect(second.events.every((event) => event.payload.repository.id === 10)).toBe(true)
  expect(cachedBudget.consumed).toBe(1)
  expect(second.budgetUnitsConsumed).toBe(1)
  expect(urls.filter((url) => !url.includes('/issues/events?'))).toHaveLength(1)
})

for (const [label, repository] of [
  ['full_name mismatch', { id: 10, full_name: 'other/project' }],
  ['invalid id', { id: 0, full_name: 'acme/widgets' }],
  ['non-integer id', { id: 1.5, full_name: 'acme/widgets' }],
  ['string id', { id: '10', full_name: 'acme/widgets' }],
] as const)
  test(`repository identity ${label} withholds without advancing the issue cursor`, async () => {
    const cursor = Object.freeze({ watermark: 10, etag: 'old' })
    const poller = new GitHubIssueEventPoller(
      async () => 'token',
      async (url) => (url.includes('/issues/events?') ? response([item(11)]) : Response.json(repository))
    )
    await expect(poller.poll(connection, cursor)).rejects.toThrow('repository identity')
    expect(cursor).toEqual({ watermark: 10, etag: 'old' })
  })

test('a failed identity lookup leaves the cursor unchanged and does not poison the cache on retry', async () => {
  let fail = true
  let lookups = 0
  const cursor = Object.freeze({ watermark: 10 })
  const poller = new GitHubIssueEventPoller(
    async () => 'token',
    async (url) => {
      if (url.includes('/issues/events?')) return response([item(11)])
      lookups++
      return fail ? new Response(null, { status: 403 }) : Response.json({ id: 10, full_name: 'acme/widgets' })
    }
  )
  await expect(poller.poll(connection, cursor)).rejects.toThrow('403')
  expect(cursor).toEqual({ watermark: 10 })
  fail = false
  const retry = await poller.poll(connection, cursor)
  expect(retry.events).toHaveLength(1)
  expect(retry.events[0]!.payload.repository.id).toBe(10)
  expect(lookups).toBe(2)
})

test('insufficient identity lookup budget emits nothing, preserves the cursor and retries with a sufficient budget', async () => {
  let lookups = 0
  const cursor = Object.freeze({ watermark: 10 })
  const poller = new GitHubIssueEventPoller(
    async () => 'token',
    async (url) => {
      if (url.includes('/issues/events?')) return response([item(11)])
      lookups++
      return Response.json({ id: 10, full_name: 'acme/widgets' })
    }
  )
  await expect(poller.poll(connection, cursor, createEventPollingBudget(1).signal)).rejects.toThrow('budget exhausted')
  expect(cursor).toEqual({ watermark: 10 })
  expect(lookups).toBe(0)
  expect((await poller.poll(connection, cursor, createEventPollingBudget(2).signal)).events).toHaveLength(1)
})

test('concurrent polls share a single repository lookup, not an authority or request-budget exemption', async () => {
  let lookups = 0
  let feeds = 0
  const poller = new GitHubIssueEventPoller(
    async () => 'token',
    async (url) => {
      if (url.includes('/issues/events?')) {
        feeds++
        return response([item(11)])
      }
      lookups++
      await Promise.resolve()
      return Response.json({ id: 10, full_name: 'acme/widgets' })
    }
  )
  const budgets = [createEventPollingBudget(2), createEventPollingBudget(2)]
  const results = await Promise.all(budgets.map((budget) => poller.poll(connection, { watermark: 10 }, budget.signal)))
  expect(results.every((result) => result.events[0]!.payload.repository.id === 10)).toBe(true)
  expect(lookups).toBe(1)
  expect(feeds).toBe(2)
  expect(budgets.reduce((total, budget) => total + budget.consumed, 0)).toBe(3)
  expect(results.reduce((total, result) => total + result.budgetUnitsConsumed!, 0)).toBe(3)
})

test('no repository lookup occurs for baselines, empty pages, historical or unsupported events', async () => {
  for (const [items, cursor] of [
    [[item(11)], null],
    [[], { watermark: 10 }],
    [[item(9)], { watermark: 10 }],
    [[item(11, 'subscribed')], { watermark: 10 }],
  ] as const) {
    let calls = 0
    const poller = new GitHubIssueEventPoller(
      async () => 'token',
      async (url) => {
        calls++
        expect(url).toContain('/issues/events?')
        return response([...items])
      }
    )
    const result = await poller.poll(connection, cursor)
    expect(result.events).toHaveLength(0)
    expect(result.budgetUnitsConsumed).toBe(1)
    expect(calls).toBe(1)
  }
})
