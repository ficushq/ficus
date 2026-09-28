import { expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { integrationSubscriptionSchema, trackedResourceKey, type TrackedResource } from '@ficus/shared'
import { TrackedResourceRegistry, type TrackedResourceAdapter } from './registry'
import { subscriptionTargetsResource, trackedResourceRegistry } from './index'
import { linearTrackedResourceAdapter } from './linear'
import { githubTrackedResourceAdapter } from '../github/code-hosting'

const connectionId = randomUUID()
const linearIssue: TrackedResource = {
  integration: 'linear',
  repository: 'ENG',
  kind: 'issue',
  number: 12,
  externalId: 'aaaaaaaa-issue-uuid',
  connectionId,
}
const trackedId = (resource: TrackedResource, event: string) =>
  `tracked-${createHash('sha256').update(trackedResourceKey(resource)).digest('hex').slice(0, 12)}-${event}`

test('a tracked Linear issue fans out to its four issue events, keyed by the provider issue id', () => {
  const subscriptions = trackedResourceRegistry.subscriptions({ tracked: [linearIssue] })
  expect(subscriptions.map((sub) => sub.source.output)).toEqual([
    'issue.assigned',
    'issue.unassigned',
    'issue.updated',
    'issue.comment',
  ])
  expect(subscriptions.map((sub) => sub.id)).toEqual(
    ['assigned', 'unassigned', 'updated', 'comment'].map((event) => trackedId(linearIssue, event))
  )
  for (const sub of subscriptions) {
    expect(integrationSubscriptionSchema.parse(sub).source.connectionId).toBe(connectionId)
    expect(sub.match).toEqual({ 'issue.id': { value: linearIssue.externalId! } })
    expect(sub.deliver).toEqual({ to: 'delivery-owner', whenInactive: 'retain' })
  }
  // Without a provider id the link still follows the issue by team key and number.
  const { externalId: _id, connectionId: _pinned, ...byNumber } = linearIssue
  const fallback = trackedResourceRegistry.subscriptions({ tracked: [byNumber] })
  expect(fallback).toHaveLength(4)
  for (const sub of fallback) {
    expect(integrationSubscriptionSchema.parse(sub).source.connectionId).toBeUndefined()
    expect(sub.match).toEqual({ teamKey: { value: 'eng' }, 'issue.number': { value: 12 } })
  }
  // Identity-hashed ids ignore the provider id, so learning one never renumbers the subscriptions.
  expect(fallback.map((sub) => sub.id)).toEqual(subscriptions.map((sub) => sub.id))
})

test('tracked fan-out covers only tracked links whose identity the provider accepts', () => {
  // A Linear team key is a short alphanumeric code, never an `owner/repo` path.
  for (const repository of ['acme/widgets', '', 'toolongteamkey', '9eng', 'e ng'])
    expect(trackedResourceRegistry.subscriptions({ tracked: [{ ...linearIssue, repository }] })).toEqual([])
  // A pull request has no Linear representation.
  expect(trackedResourceRegistry.subscriptions({ tracked: [{ ...linearIssue, kind: 'pull_request' }] })).toEqual([])
  // The delivery change request owns its reserved code-host ids; it never fans out here.
  expect(
    trackedResourceRegistry.subscriptions({
      codeHost: { integration: 'github', repository: 'acme/widgets', changeRequest: { number: 34 } },
    })
  ).toEqual([])
  // An integration with no tracked-resource adapter contributes nothing.
  expect(trackedResourceRegistry.subscriptions({ tracked: [{ ...linearIssue, integration: 'gitlab' }] })).toEqual([])
  expect(trackedResourceRegistry.subscriptions({ tracked: 'nope' })).toEqual([])
})

test('GitHub tracked links keep their repository/number identity through the shared registry', () => {
  const issue: TrackedResource = { integration: 'github', repository: 'Acme/Widgets', kind: 'issue', number: 42 }
  const subscriptions = trackedResourceRegistry.subscriptions({ tracked: [issue] })
  expect(subscriptions.map((sub) => sub.source.output)).toEqual([
    'issue.assigned',
    'issue.unassigned',
    'issue.updated',
    'issue.comment',
  ])
  for (const sub of subscriptions) {
    expect(sub.source.integration).toBe('github')
    expect(sub.match).toEqual({ repository: { value: 'acme/widgets' }, 'issue.number': { value: 42 } })
  }
  const pullRequest = trackedResourceRegistry.subscriptions({
    tracked: [{ ...issue, kind: 'pull_request', number: 7 }],
  })
  expect(pullRequest).toHaveLength(8)
  expect(pullRequest[0]!.match).toEqual({
    repository: { value: 'acme/widgets' },
    'pullRequest.number': { value: 7 },
  })
})

test('the registry composes one adapter per integration', () => {
  expect(trackedResourceRegistry.adapterFor('linear')).toBe(linearTrackedResourceAdapter)
  expect(trackedResourceRegistry.adapterFor('github')).toBe(githubTrackedResourceAdapter)
  expect(trackedResourceRegistry.adapterFor('gitlab')).toBeUndefined()
  expect(() => new TrackedResourceRegistry([linearTrackedResourceAdapter, linearTrackedResourceAdapter])).toThrow(
    'Duplicate tracked resource adapter'
  )
  const custom: TrackedResourceAdapter = {
    integration: 'gitlab',
    validateRepository: () => true,
    matchFields: () => ({ repository: 'project', number: 'mergeRequest.number' }),
    trackedSubscriptions: () => [],
    authorizeSquad: async () => true,
  }
  expect(new TrackedResourceRegistry([custom]).adapterFor('gitlab')).toBe(custom)
})

test('subscriptionTargetsResource identifies Linear links by provider id or by team key and number', () => {
  const [byId] = trackedResourceRegistry.subscriptions({ tracked: [linearIssue] })
  const { externalId: _id, ...withoutId } = linearIssue
  const [byNumber] = trackedResourceRegistry.subscriptions({ tracked: [withoutId] })
  expect(subscriptionTargetsResource(byId!, linearIssue)).toBe(true)
  expect(subscriptionTargetsResource(byId!, { ...linearIssue, externalId: 'another-issue' })).toBe(false)
  // The id-matched subscription names one issue; team key and number alone cannot confirm it.
  expect(subscriptionTargetsResource(byId!, withoutId)).toBe(false)
  expect(subscriptionTargetsResource(byNumber!, { ...withoutId, repository: '  eng  ' })).toBe(true)
  // A link that learned its provider id still matches the subscription it already had.
  expect(subscriptionTargetsResource(byNumber!, linearIssue)).toBe(true)
  expect(subscriptionTargetsResource(byNumber!, { ...withoutId, number: 13 })).toBe(false)
  expect(subscriptionTargetsResource(byNumber!, { ...withoutId, repository: 'ops' })).toBe(false)
  // Integration identity is never crossed, and an unknown integration has no match fields at all.
  expect(subscriptionTargetsResource(byNumber!, { ...withoutId, integration: 'github' })).toBe(false)
  expect(
    subscriptionTargetsResource(byId!, { ...linearIssue, integration: 'gitlab' }, new TrackedResourceRegistry([]))
  ).toBe(false)
})

test('Linear match fields are kind-aware, so an issue subscription never identifies a "pull request" link', () => {
  const [byId] = trackedResourceRegistry.subscriptions({ tracked: [linearIssue] })
  const { externalId: _id, ...withoutId } = linearIssue
  const [byNumber] = trackedResourceRegistry.subscriptions({ tracked: [withoutId] })
  // Linear has no pull requests, but metadata could still claim one with the issue's identity.
  const claimed = { ...linearIssue, kind: 'pull_request' as const }
  expect(subscriptionTargetsResource(byId!, claimed)).toBe(false)
  expect(subscriptionTargetsResource(byNumber!, claimed)).toBe(false)
  expect(subscriptionTargetsResource(byNumber!, { ...withoutId, kind: 'pull_request' })).toBe(false)
  expect(linearTrackedResourceAdapter.matchFields('pull_request').externalId).toBeUndefined()
  expect(linearTrackedResourceAdapter.matchFields('issue')).toEqual({
    repository: 'teamKey',
    number: 'issue.number',
    externalId: 'issue.id',
  })
})
