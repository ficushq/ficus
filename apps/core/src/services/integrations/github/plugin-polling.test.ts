import { expect, spyOn, test } from 'bun:test'
import { createGitHubPlugin } from './plugin'
import { GitHubPrWatchPolicy } from './watch-policy'
import { readGitHubDeliverySnapshot } from './delivery-presentation'
import { githubOutputAdapter } from '../outputs/github'
import { createEventPollingBudget } from '../event-polling-budget'
import type { EventPollingCapability } from '../types'

const head = 'a'.repeat(40)
const resource = { owner: 'acme', repo: 'widgets', number: 7 }
const connection = {
  id: '11111111-1111-4111-8111-111111111111',
  squadId: 's1',
  providerKey: 'github',
  adapterVersion: 1,
  configuration: resource,
}

// Runtime watches carry resource configuration, not the stored OAuth account configuration.
function runtimePoller(credential = 'fixture', expectedConfiguration?: unknown) {
  return createGitHubPlugin(
    { currentUser: async () => ({ version: 1, userId: 42, login: 'fixture' }) },
    async (parsed) => {
      if (expectedConfiguration) expect(parsed.configuration).toEqual(expectedConfiguration)
      return credential || undefined
    }
  ).runtime.provider.capabilities.event_polling! as EventPollingCapability
}

function responses(graphql = true) {
  const paths: string[] = []
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer fixture')
    if (path === '/graphql') {
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body)).variables).toEqual(resource)
      return graphql
        ? Response.json({
            data: {
              repository: {
                pullRequest: {
                  headRefOid: head,
                  state: 'OPEN',
                  isDraft: false,
                  mergeStateStatus: 'BLOCKED',
                  reviewDecision: 'REVIEW_REQUIRED',
                  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] },
                },
              },
            },
          })
        : new Response(null, { status: 403 })
    }
    expect(path.startsWith('/repos/acme/widgets/')).toBe(true)
    return Response.json(
      path.endsWith('/pulls/7')
        ? {
            id: 7,
            number: 7,
            state: 'open',
            merged: false,
            draft: false,
            head: { sha: head },
            base: { repo: { full_name: 'acme/widgets' } },
            mergeable_state: 'clean',
          }
        : path.endsWith('/issues/7')
          ? { number: 7 }
          : [],
      { headers: { date: new Date().toUTCString() } }
    )
  })
  return { paths, restore: () => fetchMock.mockRestore() }
}

test('delivery watch -> plugin parser -> aggregate snapshot survives initial and same-head polls within budget', async () => {
  const fixture = responses()
  try {
    const deliveredAt = new Date()
    const policy = new GitHubPrWatchPolicy({
      resolveConnection: async (_squad, id) => (id === connection.id ? { id } : undefined),
      listWorkStreams: async () => [
        {
          squadId: connection.squadId,
          status: 'active',
          deliveryPresentation: true,
          metadata: {
            codeHost: {
              integration: 'github',
              connectionId: connection.id,
              repository: 'acme/widgets',
              changeRequest: { number: 7 },
            },
            tracked: [
              {
                integration: 'github',
                kind: 'pull_request',
                repository: 'acme/widgets',
                number: 8,
                connectionId: connection.id,
              },
            ],
          },
        },
      ],
      lastRealDeliveries: async () => new Map([['acme/widgets', deliveredAt]]),
    })
    // A fresh webhook suppresses unrelated activity watches, but not designated delivery watches.
    const watches = await policy.listWatches()
    expect(watches).toHaveLength(1)
    const watch = watches[0]!
    expect(watch.connection.configuration).toEqual({
      ...resource,
      deliveryPresentation: true,
      lastVerifiedWebhookDeliveryAt: deliveredAt.toISOString(),
    })
    const poller = runtimePoller('fixture', watch.connection.configuration)
    const budget = createEventPollingBudget(12)
    let cursor: Record<string, unknown> | null = null
    for (let i = 0; i < 2; i++) {
      const result = await poller.poll(watch.connection, cursor, budget.signal)
      expect(result.events).toEqual([])
      expect(readGitHubDeliverySnapshot(result.nextCursor)).toMatchObject({
        squadId: connection.squadId,
        connectionId: connection.id,
        repository: 'acme/widgets',
        number: 7,
        headSha: head,
        source: 'graphql',
        reviewDecision: 'required',
        checksState: 'pending',
      })
      cursor = result.nextCursor
    }
    expect(fixture.paths.filter((path) => path === '/graphql')).toHaveLength(2)
    expect(fixture.paths).toHaveLength(12)
    expect(budget.consumed).toBe(12)
  } finally {
    fixture.restore()
  }
})

for (const deliveryPresentation of [false, undefined, 'true', 1]) {
  test(`plugin does not enable delivery polling for ${JSON.stringify(deliveryPresentation)}`, async () => {
    const fixture = responses()
    try {
      const result = await runtimePoller().poll(
        { ...connection, configuration: { ...resource, deliveryPresentation } },
        null
      )
      expect(result.nextCursor.deliveryPresentation).toBeUndefined()
      expect(fixture.paths).toHaveLength(5)
      expect(fixture.paths).not.toContain('/graphql')
    } finally {
      fixture.restore()
    }
  })
}

test('plugin falls back to REST without inventing required review when GraphQL is unavailable', async () => {
  const fixture = responses(false)
  try {
    const result = await runtimePoller().poll(
      { ...connection, configuration: { ...resource, deliveryPresentation: true } },
      null
    )
    expect(readGitHubDeliverySnapshot(result.nextCursor)).toMatchObject({
      source: 'rest',
      headSha: head,
      reviewDecision: 'unknown',
      checksState: 'unknown',
      mergeState: 'clean',
    })
    expect(fixture.paths).toContain('/graphql')
  } finally {
    fixture.restore()
  }
})

test('plugin cannot collect delivery facts without an assigned credential', async () => {
  const fixture = responses()
  try {
    await expect(
      runtimePoller('').poll({ ...connection, configuration: { ...resource, deliveryPresentation: true } }, null)
    ).rejects.toThrow('GitHub credential unavailable')
    expect(fixture.paths).toEqual([])
  } finally {
    fixture.restore()
  }
})

test('plugin still polls repository issue events and normalizes assignments without querying PR delivery', async () => {
  const paths: string[] = []
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    paths.push(new URL(String(input)).pathname)
    return Response.json([
      {
        id: 12,
        event: 'assigned',
        created_at: '2026-10-01T21:00:00Z',
        issue: { id: 7, number: 7, state: 'open', title: 'Fix polling' },
        assignee: { login: 'ficus-bot' },
        actor: { login: 'noah' },
      },
    ])
  })
  try {
    const result = await runtimePoller().poll(
      { ...connection, configuration: { kind: 'issue-events', owner: 'acme', repo: 'widgets' } },
      { watermark: 11 }
    )
    expect(paths).toEqual(['/repos/acme/widgets/issues/events'])
    expect(result.nextCursor.watermark).toBe(12)
    const outputs = result.events.flatMap((event) => githubOutputAdapter.normalize(event))
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({
      output: 'issue.assigned',
      data: { repository: 'acme/widgets', assignee: 'ficus-bot', issue: { number: 7 } },
    })
  } finally {
    fetchMock.mockRestore()
  }
})
