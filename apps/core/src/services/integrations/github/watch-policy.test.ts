import { describe, expect, test } from 'bun:test'
import { GitHubPrWatchPolicy, findGitHubPrUrl } from './watch-policy'

describe('GitHubPrWatchPolicy', () => {
  test('finds canonical GitHub PR URLs anywhere in work-stream metadata', () => {
    expect(findGitHubPrUrl({ github: { repo: 'acme/widgets', pr: { number: 42 } } })).toEqual({
      owner: 'acme',
      repo: 'widgets',
      number: 42,
    })
    expect(findGitHubPrUrl({ url: 'https://example.com/acme/widgets/pull/42' })).toBeNull()
    expect(findGitHubPrUrl({ historical: { nested: { prUrl: 'https://github.com/acme/widgets/pull/42' } } })).toEqual({
      owner: 'acme',
      repo: 'widgets',
      number: 42,
    })
  })

  test('watches non-terminal PR streams and isolates deduplicated squad cursors', async () => {
    let deliveryCalls = 0
    const policy = new GitHubPrWatchPolicy({
      resolveConnection: async (squadId, connectionId) => (connectionId ? undefined : { id: `account-${squadId}` }),
      listWorkStreams: async () => [
        { squadId: 's1', status: 'active', metadata: { github: { repo: 'acme/widgets', pr: { number: 42 } } } },
        { squadId: 's1', status: 'queued', metadata: { github: { repo: 'Acme/Widgets', pr: { number: 42 } } } },
        { squadId: 's1', status: 'done', metadata: { github: { repo: 'acme/widgets', pr: { number: 43 } } } },
        { squadId: 's1', status: 'canceled', metadata: { github: { repo: 'acme/widgets', pr: { number: 44 } } } },
        { squadId: 's2', status: 'active', metadata: { github: { repo: 'acme/widgets', pr: { number: 42 } } } },
        { squadId: 's2', status: 'active', metadata: { github: { repo: 'Beta/Tools', pr: { number: 1 } } } },
      ],
      lastRealDeliveries: async (_provider, repos) => {
        deliveryCalls++
        expect(repos).toEqual(['acme/widgets', 'beta/tools'])
        return new Map()
      },
    })

    const watches = await policy.listWatches()

    expect(deliveryCalls).toBe(1)
    expect(watches).toHaveLength(3)
    expect(watches[0]).toMatchObject({
      providerKey: 'github',
      resourceKey: 's1:account-s1:acme/widgets#42',
      active: true,
    })
    expect(watches[1]).toMatchObject({
      providerKey: 'github',
      resourceKey: 's2:account-s2:acme/widgets#42',
      active: true,
    })
    expect(watches[2]).toMatchObject({ providerKey: 'github', resourceKey: 's2:account-s2:beta/tools#1', active: true })
    expect(watches.some((watch) => watch.resourceKey.endsWith('#44'))).toBe(false)
    expect(watches[0].connection).toMatchObject({
      id: 'account-s1',
      squadId: 's1',
      configuration: { owner: 'acme', repo: 'widgets', number: 42 },
    })
  })

  test('flips polling off as soon as a recent real webhook delivery is recorded', async () => {
    let delivery: Date | null = null
    const policy = new GitHubPrWatchPolicy({
      resolveConnection: async (squadId, connectionId) => (connectionId ? undefined : { id: `account-${squadId}` }),
      listWorkStreams: async () => [
        { squadId: 's1', status: 'active', metadata: { github: { repo: 'acme/widgets', pr: { number: 42 } } } },
      ],
      lastRealDeliveries: async () => new Map(delivery ? [['acme/widgets', delivery]] : []),
      now: () => new Date('2026-08-26T00:00:00Z'),
      realDeliveryLookbackDays: 7,
    })

    expect(await policy.listWatches()).toHaveLength(1)
    delivery = new Date('2026-08-01T00:00:00Z')
    expect((await policy.listWatches())[0].connection.configuration).toMatchObject({
      lastVerifiedWebhookDeliveryAt: '2026-08-01T00:00:00.000Z',
    })
    delivery = new Date('2026-08-25T23:00:00Z')
    expect(await policy.listWatches()).toEqual([])
  })
})

test('flow subscriptions discover PRs through custom metadata and drop watches when their binding disappears', async () => {
  let metadata: unknown = { delivery: { repository: 'Acme/Widgets', number: 9 } }
  const policy = new GitHubPrWatchPolicy({
    resolveConnection: async (squadId, connectionId) => (connectionId ? undefined : { id: `account-${squadId}` }),
    listWorkStreams: async () => [
      {
        squadId: 's1',
        status: 'active',
        metadata,
        subscriptions: [
          {
            id: 'review',
            source: { integration: 'github', output: 'pull_request.reviewed', version: 1 },
            match: {
              repository: { streamMetadata: 'delivery.repository' },
              'pullRequest.number': { streamMetadata: 'delivery.number' },
            },
            deliver: { to: 'active', whenInactive: 'retain' },
          },
        ],
      },
    ],
    lastRealDeliveries: async () => new Map(),
  })
  expect((await policy.listWatches())[0]).toMatchObject({ resourceKey: 's1:account-s1:acme/widgets#9' })
  metadata = {}
  expect(await policy.listWatches()).toEqual([])
})

test('issue triggers establish exact repository watches before a stream exists and remove them with the trigger', async () => {
  let enabled = true
  const trigger = (repo: string, connectionId?: string) => ({
    id: 'assigned',
    create: { workflow: { kind: 'preset', id: 'solo' }, metadata: {} },
    source: { integration: 'github', output: 'issue.assigned', version: 1, connectionId },
    match: { repository: { value: repo }, assignee: { value: 'tau-bot' } },
  })
  const policy = new GitHubPrWatchPolicy({
    resolveConnection: async (squadId, connectionId) => (connectionId ? undefined : { id: `account-${squadId}` }),
    listWorkStreams: async () => [],
    listSquads: async () =>
      enabled
        ? [
            {
              id: 's1',
              metadata: {
                integrationTriggers: [
                  trigger('Acme/Widgets'),
                  trigger('acme/widgets'),
                  trigger('acme/*'),
                  trigger('acme/secret', '9c1b5827-8613-4288-8de9-a9cb33d9958f'),
                ],
              },
            },
          ]
        : [],
    lastRealDeliveries: async () => new Map([['acme/widgets', new Date()]]),
  })
  expect(await policy.listWatches()).toEqual([
    expect.objectContaining({
      resourceKey: 's1:account-s1:acme/widgets:issue-events',
      connection: expect.objectContaining({ configuration: { kind: 'issue-events', owner: 'acme', repo: 'widgets' } }),
    }),
  ])
  enabled = false
  expect(await policy.listWatches()).toEqual([])
})

test('an assignee trigger discovers exact repositories already connected in squad metadata', async () => {
  const policy = new GitHubPrWatchPolicy({
    resolveConnection: async (squadId, connectionId) => (connectionId ? undefined : { id: `account-${squadId}` }),
    listWorkStreams: async () => [],
    listSquads: async () => [
      {
        id: 's1',
        metadata: {
          github: [{ repo: 'acme/widgets' }, { repo: 'acme/*' }],
          integrationTriggers: [
            {
              id: 'assigned',
              create: { workflow: { kind: 'preset', id: 'solo' }, metadata: {} },
              source: { integration: 'github', output: 'issue.assigned', version: 1 },
              match: { assignee: { value: 'tau-bot' } },
            },
          ],
        },
      },
    ],
    lastRealDeliveries: async () => new Map(),
  })
  expect((await policy.listWatches()).map((watch) => watch.resourceKey)).toEqual([
    's1:account-s1:acme/widgets:issue-events',
  ])
})

test('canonical code hosting references honor the selected account and never poll another provider', async () => {
  const connectionId = crypto.randomUUID()
  const requested: unknown[] = []
  const policy = new GitHubPrWatchPolicy({
    listWorkStreams: async () =>
      ['github', 'gitlab'].map((integration) => ({
        squadId: 'squad',
        status: 'active',
        metadata: {
          codeHost: { integration, repository: 'acme/widgets', changeRequest: { number: 42 }, connectionId },
          github: { repo: 'wrong/repo', pr: { number: 99 } },
        },
      })),
    resolveConnection: async (squad, id) => {
      requested.push([squad, id])
      return id === connectionId ? { id } : undefined
    },
    lastRealDeliveries: async () => new Map(),
  })
  expect((await policy.listWatches()).map((watch) => watch.connection.configuration)).toEqual([
    { owner: 'acme', repo: 'widgets', number: 42 },
  ])
  expect(requested).toEqual([['squad', connectionId]])
})

test('polls tracked-resource PR and issue watches, respecting connection pins and terminal status', async () => {
  const pinned = crypto.randomUUID()
  const policy = new GitHubPrWatchPolicy({
    resolveConnection: async (squadId, connectionId) =>
      connectionId ? { id: connectionId } : { id: `account-${squadId}` },
    listWorkStreams: async () => [
      {
        squadId: 's1',
        status: 'active',
        metadata: {
          tracked: [
            { integration: 'github', repository: 'acme/widgets', kind: 'pull_request', number: 42 },
            { integration: 'github', repository: 'beta/tools', kind: 'pull_request', number: 7, connectionId: pinned },
            { integration: 'github', repository: 'acme/widgets', kind: 'issue', number: 5 },
          ],
        },
      },
      {
        squadId: 's1',
        status: 'done',
        metadata: {
          tracked: [{ integration: 'github', repository: 'acme/widgets', kind: 'pull_request', number: 99 }],
        },
      },
    ],
    lastRealDeliveries: async () => new Map(),
  })
  const watches = await policy.listWatches()
  expect(watches.map((watch) => watch.resourceKey).sort()).toEqual(
    [`s1:${pinned}:beta/tools#7`, 's1:account-s1:acme/widgets#42', 's1:account-s1:acme/widgets:issue-events'].sort()
  )
  expect(watches.some((watch) => watch.resourceKey.endsWith('#99'))).toBe(false)
})

test('dedupes a PR present in both the delivery changeRequest and tracked resources into a single watch', async () => {
  const policy = new GitHubPrWatchPolicy({
    resolveConnection: async (squadId, connectionId) =>
      connectionId ? { id: connectionId } : { id: `account-${squadId}` },
    listWorkStreams: async () => [
      {
        squadId: 's1',
        status: 'active',
        metadata: {
          codeHost: { integration: 'github', repository: 'acme/widgets', changeRequest: { number: 42 } },
          tracked: [{ integration: 'github', repository: 'acme/widgets', kind: 'pull_request', number: 42 }],
        },
      },
    ],
    lastRealDeliveries: async () => new Map(),
  })
  const watches = await policy.listWatches()
  expect(watches).toHaveLength(1)
  expect(watches[0]).toMatchObject({ resourceKey: 's1:account-s1:acme/widgets#42' })
})

test('wildcard issue rules establish one watch per expanded repository and none without an expander', async () => {
  const { squadEventRuleSchema } = await import('@ficus/shared')
  const rule = squadEventRuleSchema.parse({
    id: 'glob',
    source: { integration: 'github', output: 'issue.assigned', version: 1 },
    filters: { repository: 'acme/svc-*', audience: 'any' },
    action: { type: 'notify-manager' },
  })
  const options = {
    resolveConnection: async (squadId: string) => ({ id: `account-${squadId}` }),
    listWorkStreams: async () => [],
    listSquads: async () => [{ id: 's1', metadata: { integrationRules: { github: [rule] } } }],
    lastRealDeliveries: async () => new Map<string, Date>(),
  }
  expect(await new GitHubPrWatchPolicy(options).listWatches()).toEqual([])

  const expanded: [string, readonly string[]][] = []
  const watches = await new GitHubPrWatchPolicy({
    ...options,
    expandRepositories: async (connectionId, selectors) => {
      expanded.push([connectionId, selectors])
      return ['acme/svc-api', 'acme/svc-web']
    },
  }).listWatches()
  expect(expanded).toEqual([['account-s1', ['acme/svc-*']]])
  expect(watches.map((watch) => watch.resourceKey)).toEqual([
    's1:account-s1:acme/svc-api:issue-events',
    's1:account-s1:acme/svc-web:issue-events',
  ])
  expect(watches[0]!.connection).toMatchObject({
    id: 'account-s1',
    configuration: { kind: 'issue-events', owner: 'acme', repo: 'svc-api' },
  })
})

test('completion-ready delivery watches refresh presentation even while webhooks suppress activity polling', async () => {
  const policy = new GitHubPrWatchPolicy({
    resolveConnection: async () => ({ id: 'account' }),
    listWorkStreams: async () => [
      {
        squadId: 's1',
        status: 'active',
        deliveryPresentation: true,
        metadata: { codeHost: { integration: 'github', repository: 'acme/widgets', changeRequest: { number: 7 } } },
      },
    ],
    lastRealDeliveries: async () => new Map([['acme/widgets', new Date()]]),
  })
  const watches = await policy.listWatches()
  expect(watches).toHaveLength(1)
  expect(watches[0]?.connection.configuration).toMatchObject({ deliveryPresentation: true })
})
