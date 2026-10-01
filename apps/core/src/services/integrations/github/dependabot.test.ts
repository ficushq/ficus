import { expect, test } from 'bun:test'
import {
  effectiveSquadEventRules,
  selectSquadEventRule,
  resolveTrackedResources,
  trackedResourceUrl,
} from '@ficus/shared'
import { GitHubPollingProvider } from './provider'
import type { EventPollingCapability } from '../types'
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
  expect(rules[0]!.enabled).toBe(true)
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

test('Dependabot interests never create polling watches or fall through to issue/PR polling', async () => {
  let resolves = 0
  let expands = 0
  const target = githubOutputAdapter.trackedResource!(githubOutputAdapter.normalize(event())[0]!)!
  const subscriptions = githubTrackedResourceAdapter.trackedSubscriptions(
    resolveTrackedResources({ tracked: [target] })[0]!
  )
  // Even PR-shaped bindings on a security subscription must not create a PR watch.
  subscriptions[0]!.match['pullRequest.number'] = { value: 7 }
  for (const metadata of [
    { github: [{ repo: 'acme/widgets' }] },
    {
      integrationRules: {
        github: effectiveSquadEventRules({}, 'github')
          .filter((r) => r.source.output === 'dependabot_alert.updated')
          .map((r) => ({ ...r, filters: { ...r.filters, repository: 'acme/*' } })),
      },
    },
  ]) {
    const policy = new GitHubPrWatchPolicy({
      resolveConnection: async () => {
        resolves++
        return { id: 'account' }
      },
      expandRepositories: async () => {
        expands++
        return ['acme/widgets']
      },
      listWorkStreams: async () => [
        { squadId: 'squad', status: 'active', metadata: { tracked: [target] }, subscriptions },
      ],
      listSquads: async () => [{ id: 'squad', metadata }],
      lastRealDeliveries: async () => new Map(),
    })
    const watches = await policy.listWatches()
    // Shared repo bindings intentionally retain unrelated issue polling.
    expect(watches.map((w) => w.connection.configuration)).toEqual(
      'github' in metadata ? [{ kind: 'issue-events', owner: 'acme', repo: 'widgets' }] : []
    )
  }
  expect(expands).toBe(0)
  expect(resolves).toBe(1)
})

test('retired Dependabot configurations are rejected before credential or API access through the plugin', async () => {
  const { createGitHubPlugin } = await import('./plugin')
  let credentials = 0
  const plugin = createGitHubPlugin(
    { currentUser: async () => ({ version: 1, userId: 1, login: 'test' }) },
    async () => {
      credentials++
      return 'token'
    }
  )
  // Runner watches carry resource configs, not account configs; keep the real
  // plugin's runtime parser under test at the provider-neutral polling boundary.
  const poller = plugin.runtime.provider.capabilities.event_polling! as EventPollingCapability
  const provider = new GitHubPollingProvider(async () => undefined)
  for (const configuration of [
    connection.configuration,
    { ...connection.configuration, number: 7, deliveryPresentation: true },
  ]) {
    expect(() => provider.parseConfig(configuration)).toThrow('Invalid GitHub polling configuration')
    expect(() => poller.poll({ ...connection, configuration }, { after: 'old-page', repository }, undefined)).toThrow(
      'Invalid GitHub polling configuration'
    )
  }
  expect(credentials).toBe(0)
})

test('synthetic Dependabot events are no longer normalized, and historical observations cannot notify', () => {
  expect(githubOutputAdapter.normalize({ ...event('observed'), metadata: { synthetic: true } })).toEqual([])
  expect(githubOutputAdapter.normalize({ ...event(), metadata: { synthetic: true } })).toEqual([])
  const native = githubOutputAdapter.normalize(event())[0]!
  expect(githubOutputAdapter.shouldNotify!({ ...native, data: { ...native.data, action: 'observed' } }, {})).toBe(false)
  expect(githubOutputAdapter.shouldNotify!(native, {})).toBe(true)
})
