import { expect, test } from 'bun:test'
import {
  effectiveSquadEventRules,
  selectSquadEventRule,
  resolveTrackedResources,
  trackedResourceUrl,
} from '@ficus/shared'
import { GitHubPollingProvider } from './provider'
import { githubOutputAdapter } from '../outputs/github'
import { integrationOutputRegistry } from '../outputs/registry'
import { githubTrackedResourceAdapter } from './code-hosting'
import { GitHubPrWatchPolicy } from './watch-policy'

const repository = { id: 101, full_name: 'acme/widgets' }
const alert = {
  number: 7,
  state: 'open',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  html_url: 'https://github.com/acme/widgets/security/dependabot/7',
  dependency: { package: { ecosystem: 'npm', name: 'widget' }, manifest_path: 'apps/web/bun.lock' },
  security_advisory: { ghsa_id: 'GHSA-abcd-efgh-ijkl', severity: 'high', summary: 'Unsafe widgets' },
  security_vulnerability: {
    severity: 'high',
    vulnerable_version_range: '< 2.0.0',
    first_patched_version: { identifier: '2.0.0' },
  },
}
const event = (action = 'created', item = alert, repo = repository) => ({
  type: 'dependabot_alert',
  payload: { action, alert: item, repository: repo },
})
const connection = {
  id: 'account',
  squadId: 'squad',
  providerKey: 'github',
  adapterVersion: 1,
  configuration: { kind: 'dependabot-alerts' as const, owner: 'acme', repo: 'widgets' },
}

test('Dependabot output carries typed security details and immutable repository identity', () => {
  const [fact] = githubOutputAdapter.normalize(event())
  expect(fact?.output).toBe('dependabot_alert.updated')
  expect(fact?.data).toMatchObject({
    repository: 'acme/widgets',
    repositoryId: 101,
    severity: 'high',
    state: 'open',
    action: 'created',
    alert: {
      number: 7,
      advisoryId: alert.security_advisory.ghsa_id,
      package: 'widget',
      ecosystem: 'npm',
      manifest: 'apps/web/bun.lock',
      affectedRange: '< 2.0.0',
      patchedVersion: '2.0.0',
    },
  })
  expect(fact?.body).toContain('Group:')
  integrationOutputRegistry.validateFact('github', fact!)
  const renamed = githubOutputAdapter.normalize(event('created', alert, { id: 101, full_name: 'other/renamed' }))[0]!
  expect(renamed.resourceKey).toBe(fact!.resourceKey)
  expect(renamed.eventKey).toBe(fact!.eventKey)
  const reopened = githubOutputAdapter.normalize(
    event('reopened', { ...alert, updated_at: '2026-09-02T00:00:00Z' })
  )[0]!
  expect(reopened.eventKey).not.toBe(fact!.eventKey)
  for (const action of ['reintroduced', 'auto_reopened', 'assignees_changed', 'fixed', 'dismissed', 'auto_dismissed']) {
    const state = ['fixed', 'dismissed', 'auto_dismissed'].includes(action) ? action : 'open'
    expect(githubOutputAdapter.normalize(event(action, { ...alert, state }))[0]?.data.action).toBe(action)
  }
  expect(githubOutputAdapter.normalize(event('unknown'))).toEqual([])
  expect(githubOutputAdapter.normalize(event('created', alert, { id: 0, full_name: 'acme/widgets' }))).toEqual([])
})

test('defaults notify the manager for high/critical open alerts only, with configurable lower severity', () => {
  const fact = githubOutputAdapter.normalize(event())[0]!
  const metadata = { github: [{ repo: 'acme/widgets' }] }
  expect(selectSquadEventRule(metadata, 'github', fact, '')?.action.type).toBe('notify-manager')
  expect(selectSquadEventRule({}, 'github', fact, '')).toBeUndefined()
  expect(
    selectSquadEventRule(metadata, 'github', { ...fact, data: { ...fact.data, severity: 'low' } }, '')
  ).toBeUndefined()
  expect(
    selectSquadEventRule(metadata, 'github', { ...fact, data: { ...fact.data, state: 'fixed' } }, '')
  ).toBeUndefined()
  const rules = effectiveSquadEventRules(metadata, 'github').filter((r) => r.source.output === fact.output)
  expect(rules).toHaveLength(1)
  rules[0]!.predicates = [{ field: 'severity', op: 'in', value: ['low', 'medium', 'high', 'critical'] }]
  expect(
    selectSquadEventRule(
      { ...metadata, integrationRules: { github: rules } },
      'github',
      { ...fact, data: { ...fact.data, severity: 'low' } },
      ''
    )?.action.type
  ).toBe('notify-manager')
  expect(selectSquadEventRule({ ...metadata, integrationRules: { github: [] } }, 'github', fact, '')).toBeUndefined()
})

test('backfill publishes open alerts immediately and overlaps webhook facts without duplicate identities', async () => {
  const urls: string[] = []
  const provider = new GitHubPollingProvider(
    async () => 'test-token',
    async (url) => {
      urls.push(String(url))
      return String(url).includes('/dependabot/alerts') ? Response.json([alert]) : Response.json(repository)
    }
  )
  expect(provider.parseConfig(connection.configuration)).toEqual(connection.configuration)
  const first = await provider.capabilities.event_polling!.poll(connection, null)
  expect(first.events).toHaveLength(1)
  expect(first.suggestedIntervalMs).toBe(86_400_000)
  expect(first.budgetUnitsConsumed).toBe(2)
  const fact = githubOutputAdapter.normalize(first.events[0]!)[0]!
  expect(fact.data.action).toBe('observed') // snapshots cannot claim a native reopen action
  expect(fact.eventKey).toBe(githubOutputAdapter.normalize(event())[0]!.eventKey)
  expect(urls.every((url) => url.startsWith('https://api.github.com/'))).toBe(true)
  const second = await provider.capabilities.event_polling!.poll(connection, first.nextCursor)
  expect(githubOutputAdapter.normalize(second.events[0]!)[0]!.eventKey).toBe(fact.eventKey)
})

test('permission failure is unavailable, not an empty alert page', async () => {
  const provider = new GitHubPollingProvider(
    async () => 'test-token',
    async (url) =>
      String(url).includes('/dependabot/alerts') ? new Response(null, { status: 403 }) : Response.json(repository)
  )
  await expect(provider.capabilities.event_polling!.poll(connection, null)).rejects.toThrow(
    'Dependabot discovery unavailable (403)'
  )
})

test('alert tracking uses the typed registry, immutable ID and never a delivery PR', () => {
  const target = githubOutputAdapter.trackedResource!(githubOutputAdapter.normalize(event())[0]!)!
  expect(target.kind).toBe('dependabot_alert')
  const [resource] = resolveTrackedResources({ tracked: [target] })
  expect(resource?.delivery).toBe(false)
  expect(trackedResourceUrl(target)).toBe(alert.html_url)
  const subscriptions = githubTrackedResourceAdapter.trackedSubscriptions(resource!)
  expect(subscriptions[0]?.source.output).toBe('dependabot_alert.updated')
  expect(subscriptions[0]?.match['alert.externalId']).toEqual({ value: '101:7' })
  expect(githubOutputAdapter.workStreamBindings!(githubOutputAdapter.normalize(event())[0]!)).toEqual({})
})

test('enabled repository-scoped discovery reconciles even when webhooks are healthy; disabling removes watches', async () => {
  let metadata: unknown = { github: [{ repo: 'acme/widgets' }] }
  const policy = new GitHubPrWatchPolicy({
    resolveConnection: async () => ({ id: 'account' }),
    listWorkStreams: async () => [],
    listSquads: async () => [{ id: 'squad', metadata }],
    lastRealDeliveries: async () => new Map([['acme/widgets', new Date()]]),
  })
  expect(
    (await policy.listWatches()).filter((w) => (w.connection.configuration as any).kind === 'dependabot-alerts')
  ).toHaveLength(1)
  metadata = { github: [{ repo: 'acme/widgets' }], integrationRules: { github: [] } }
  expect(
    (await policy.listWatches()).filter((w) => (w.connection.configuration as any).kind === 'dependabot-alerts')
  ).toHaveLength(0)
})

test('bounded pagination resumes from durable cursor and rejects off-origin links', async () => {
  let next = true
  const provider = new GitHubPollingProvider(
    async () => 'test-token',
    async (url) => {
      if (!String(url).includes('/dependabot/alerts')) return Response.json(repository)
      return Response.json([alert], {
        headers: next
          ? { link: '<https://api.github.com/repos/acme/widgets/dependabot/alerts?after=abc>; rel="next"' }
          : {},
      })
    }
  )
  const first = await provider.capabilities.event_polling!.poll(connection, null)
  expect(first.nextCursor.after).toBe('abc')
  expect(first.suggestedIntervalMs).toBe(60_000)
  next = false
  expect(
    (await provider.capabilities.event_polling!.poll(connection, first.nextCursor)).nextCursor.after
  ).toBeUndefined()
  const bad = new GitHubPollingProvider(
    async () => 'test-token',
    async (url) =>
      String(url).includes('/dependabot/alerts')
        ? Response.json([alert], {
            headers: { link: '<https://evil.example/repos/acme/widgets/dependabot/alerts?after=abc>; rel="next"' },
          })
        : Response.json(repository)
  )
  await expect(bad.capabilities.event_polling!.poll(connection, null)).rejects.toThrow('Invalid Dependabot pagination')
})

test('initial stale-name redirects are followed safely and cancellation reaches every request', async () => {
  const urls: string[] = []
  const signal = new AbortController().signal as any
  signal.reserveRequest = () => {}
  const provider = new GitHubPollingProvider(
    async () => 'test-token',
    async (url, init) => {
      urls.push(String(url))
      expect(init?.signal).toBe(signal)
      if (urls.length === 1)
        return new Response(null, { status: 301, headers: { location: 'https://api.github.com/repositories/101' } })
      return String(url).includes('/dependabot/alerts') ? Response.json([alert]) : Response.json(repository)
    }
  )
  expect((await provider.capabilities.event_polling!.poll(connection, null, signal)).events).toHaveLength(1)
  expect(urls).toHaveLength(3)
})
