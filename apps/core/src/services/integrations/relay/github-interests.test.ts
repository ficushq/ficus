import { expect, test } from 'bun:test'
import type { IntegrationSubscription } from '@ficus/shared'
import { discoverGitHubRelayInterests, type GitHubInterestSource } from './github-interests'
const subscription = (
  output: string,
  match: IntegrationSubscription['match'],
  connectionId?: string
): IntegrationSubscription => ({
  id: 'watch',
  source: { integration: 'github', version: 1, output, connectionId },
  match,
  deliver: { to: 'active', whenInactive: 'retain' },
})

test('relay discovers every GitHub flow output and exact metadata without enumerating an account', async () => {
  const source: GitHubInterestSource = {
    listWorkStreams: async () => [
      {
        squadId: 's1',
        status: 'active',
        metadata: { github: { repo: 'Org/Repo', connectionId: '4d506704-161f-4df9-92df-67a5f46614fb' } },
      },
      {
        squadId: 's1',
        status: 'paused',
        metadata: { delivery: { repo: 'org/checks' } },
        subscriptions: [subscription('pull_request.ci_completed', { repository: { streamMetadata: 'delivery.repo' } })],
      },
      { squadId: 's2', status: 'queued', metadata: { historical: 'https://github.com/org/legacy/pull/3' } },
      { squadId: 's1', status: 'done', metadata: { github: { repo: 'org/done' } } },
      { squadId: 's1', status: 'canceled', metadata: { github: { repo: 'org/canceled' } } },
      {
        squadId: 's1',
        status: 'active',
        metadata: {},
        subscriptions: [subscription('issue.comment', { repository: { value: 'org/*' } })],
      },
    ],
    listSquads: async () => [
      {
        id: 's1',
        metadata: {
          github: [{ repo: 'org/squad' }],
          integrationTriggers: [
            {
              id: 'review',
              create: { workflow: { kind: 'preset', id: 'solo' }, metadata: {} },
              source: {
                integration: 'github',
                output: 'pull_request.review_requested',
                version: 1,
                connectionId: '4d506704-161f-4df9-92df-67a5f46614fb',
              },
              match: { repository: { value: 'org/reviews' } },
            },
            {
              id: 'assigned',
              create: { workflow: { kind: 'preset', id: 'solo' }, metadata: {} },
              source: { integration: 'github', output: 'issue.assigned', version: 1 },
              match: { 'assignee.login': { value: 'me' } },
            },
          ],
        },
      },
    ],
    resolveConnection: async (squadId, connectionId) => ({ id: connectionId ?? `default-${squadId}` }),
  }
  expect(await discoverGitHubRelayInterests(source)).toEqual([
    { squadId: 's1', connectionId: '4d506704-161f-4df9-92df-67a5f46614fb', repository: 'org/repo' },
    { squadId: 's1', connectionId: 'default-s1', repository: 'org/checks' },
    { squadId: 's2', connectionId: 'default-s2', repository: 'org/legacy' },
    { squadId: 's1', connectionId: 'default-s1', repository: 'org/squad' },
    { squadId: 's1', connectionId: '4d506704-161f-4df9-92df-67a5f46614fb', repository: 'org/reviews' },
  ])
  source.resolveConnection = async () => undefined
  expect(await discoverGitHubRelayInterests(source)).toEqual([])
})

test('editable rules discover selected account repositories and drop disabled or ignored interests', async () => {
  const { squadEventRuleSchema } = await import('@ficus/shared')
  const account = 'bcbe4f3a-d2d1-4b91-b1ea-4c6c14485893'
  const rule = (id: string, repository: string) =>
    squadEventRuleSchema.parse({
      id,
      source: { integration: 'github', output: 'pull_request.review_requested', version: 1, connectionId: account },
      filters: { repository, audience: 'any' },
      action: { type: 'notify-consultant' },
    })
  const disabled = { ...rule('disabled', 'org/disabled'), enabled: false }
  const ignored = { ...rule('ignored', 'org/ignored'), action: { type: 'ignore' as const } }
  const source: GitHubInterestSource = {
    listWorkStreams: async () => [],
    listSquads: async () => [
      {
        id: 'squad',
        metadata: {
          integrationRules: { github: [rule('enabled', 'Org/Repo'), disabled, ignored, rule('glob', 'org/*')] },
        },
      },
    ],
    resolveConnection: async (_squad, id) => (id === account ? { id } : undefined),
  }
  expect(await discoverGitHubRelayInterests(source)).toEqual([
    { squadId: 'squad', connectionId: account, repository: 'org/repo' },
  ])
})

test('tracked resources declare relay interest for their repositories, deduplicated with codeHost metadata', async () => {
  const pinned = 'bcbe4f3a-d2d1-4b91-b1ea-4c6c14485893'
  const source: GitHubInterestSource = {
    listWorkStreams: async () => [
      {
        squadId: 's1',
        status: 'active',
        metadata: {
          codeHost: { integration: 'github', repository: 'acme/widgets', changeRequest: { number: 42 } },
          tracked: [
            { integration: 'github', repository: 'acme/widgets', kind: 'pull_request', number: 42 },
            { integration: 'github', repository: 'beta/tools', kind: 'pull_request', number: 7, connectionId: pinned },
          ],
        },
      },
      {
        squadId: 's1',
        status: 'done',
        metadata: { tracked: [{ integration: 'github', repository: 'org/skipped', kind: 'issue', number: 1 }] },
      },
    ],
    listSquads: async () => [],
    resolveConnection: async (squadId, connectionId) => ({ id: connectionId ?? `default-${squadId}` }),
  }
  expect(await discoverGitHubRelayInterests(source)).toEqual([
    { squadId: 's1', connectionId: 'default-s1', repository: 'acme/widgets' },
    { squadId: 's1', connectionId: pinned, repository: 'beta/tools' },
  ])
})

test('wildcard rule repositories expand through the injected expander into exact interests', async () => {
  const { squadEventRuleSchema } = await import('@ficus/shared')
  const account = 'bcbe4f3a-d2d1-4b91-b1ea-4c6c14485893'
  const rule = (id: string, repository: string) =>
    squadEventRuleSchema.parse({
      id,
      source: { integration: 'github', output: 'issue.assigned', version: 1, connectionId: account },
      filters: { repository, audience: 'any' },
      action: { type: 'notify-manager' },
    })
  const expanded: [string, readonly string[]][] = []
  const source: GitHubInterestSource = {
    listWorkStreams: async () => [],
    listSquads: async () => [
      { id: 'squad', metadata: { integrationRules: { github: [rule('glob', 'org/*'), rule('exact', 'Org/Repo')] } } },
    ],
    resolveConnection: async (_squad, id) => (id === account ? { id } : undefined),
    expandRepositories: async (connectionId, selectors) => {
      expanded.push([connectionId, selectors])
      return selectors.flatMap((selector) => (selector === 'org/*' ? ['org/a', 'org/repo'] : [selector.toLowerCase()]))
    },
  }
  expect(await discoverGitHubRelayInterests(source)).toEqual([
    { squadId: 'squad', connectionId: account, repository: 'org/a' },
    { squadId: 'squad', connectionId: account, repository: 'org/repo' },
  ])
  // Only the pattern went through expansion, keyed by the resolved connection.
  expect(expanded).toEqual([[account, ['org/*']]])
})
