import { expect, test } from 'bun:test'
import { createBlankWorkflow, integrationSubscriptionSchema } from '@ficus/shared'
import { CodeHostingRegistry, isDeliveryFeedbackSubscription, type CodeHostingAdapter } from './registry'
import { subscriptionTargetsResource } from '../tracked-resources'
import { githubCodeHostingAdapter } from '../github/code-hosting'

test('a new code hosting adapter supplies delivery evidence and events without changing the flow', async () => {
  const calls: unknown[] = []
  const adapter: CodeHostingAdapter = {
    integration: 'test-code-host',
    validateRepository: (repository) => repository === 'group/subgroup/repo',
    changeRequest: async (reference, squadId) => {
      calls.push([reference, squadId])
      return { merged: true, headBranch: 'feature', baseBranch: 'main' }
    },
    changeRequestsByHead: async () => [
      { number: 7, merged: true, state: 'closed', headBranch: 'feature', baseBranch: 'main' },
    ],
    containsCommit: async (_reference, _squadId, base, commit) => base === 'main' && commit === 'a'.repeat(40),
    subscriptions: (reference) => [
      {
        id: 'code-host-merged',
        source: { integration: 'test-code-host', output: 'merge_request.merged', version: 1 },
        match: { project: { value: reference.repository }, number: { value: reference.changeRequest!.number } },
        deliver: { to: 'delivery-owner', whenInactive: 'retain' },
      },
    ],
  }
  const registry = new CodeHostingRegistry([adapter, githubCodeHostingAdapter])
  const flow = createBlankWorkflow()
  flow.completion = { mode: 'pr-merge', followChanges: true }
  const metadata = {
    codeHost: { integration: adapter.integration, repository: 'group/subgroup/repo', changeRequest: { number: 7 } },
  }
  const before = structuredClone(flow)
  const { reference, adapter: resolved } = registry.resolve(metadata)!
  expect(await resolved.changeRequest(reference, 'squad')).toEqual({
    merged: true,
    headBranch: 'feature',
    baseBranch: 'main',
  })
  expect(calls).toEqual([[reference, 'squad']])
  expect(await resolved.containsCommit(reference, 'squad', 'main', 'a'.repeat(40))).toBe(true)
  expect(
    registry.subscriptions(flow, metadata).map((item) => integrationSubscriptionSchema.parse(item).source.integration)
  ).toEqual(['test-code-host'])
  expect(
    registry.subscriptions(flow, {
      codeHost: { ...metadata.codeHost, integration: 'github', repository: 'owner/repo' },
    })
  ).toHaveLength(8)
  expect(flow).toEqual(before)
  flow.completion.changeEventsTo = { step: flow.entry }
  for (const codeHost of [
    metadata.codeHost,
    { ...metadata.codeHost, integration: 'github', repository: 'owner/repo' },
  ]) {
    const events = registry.subscriptions(flow, { codeHost })
    expect(events.length).toBeGreaterThan(0)
    expect(
      events.every(
        (event) =>
          typeof event.deliver.to === 'object' && 'step' in event.deliver.to && event.deliver.to.step === flow.entry
      )
    ).toBe(true)
    expect(events.every((event) => event.deliver.whenInactive === 'retain')).toBe(true)
  }
})

test('explicit unsupported or invalid bindings never fall back to legacy GitHub; old definitions stay opt-in', () => {
  const registry = new CodeHostingRegistry([githubCodeHostingAdapter])
  const github = { repo: 'owner/repo', pr: { number: 7 } }
  const flow = createBlankWorkflow()
  expect(registry.subscriptions(flow, { github })).toEqual([])
  flow.completion.followChanges = true
  expect(registry.subscriptions(flow, { github })).toHaveLength(8)
  for (const codeHost of [
    null,
    {},
    { integration: 'gitlab', repository: 'owner/repo', changeRequest: { number: 7 } },
  ]) {
    expect(registry.resolve({ codeHost, github })).toBeNull()
    expect(registry.subscriptions(flow, { codeHost, github })).toEqual([])
  }
  expect(registry.subscriptions(flow, { codeHost: { integration: 'github', repository: 'owner/repo' } })).toEqual([])
})

test('tracked issues get their own connection-scoped subscriptions alongside PRs; a legacy github.issue gets none', () => {
  const registry = new CodeHostingRegistry([githubCodeHostingAdapter])
  const flow = createBlankWorkflow()
  flow.completion.followChanges = true
  flow.completion.changeEventsTo = { step: flow.entry }
  const connectionId = crypto.randomUUID()
  const github = { repo: 'Owner/Repo', issue: '42' }
  const tracked = [{ integration: 'github', repository: 'Owner/Repo', kind: 'issue', number: 42, connectionId }]
  // The legacy field is inert: only a `tracked` entry links an issue.
  expect(registry.subscriptions(flow, { github })).toEqual([])
  const issues = registry.subscriptions(flow, { github, tracked })
  expect(issues.map((sub) => sub.source.output)).toEqual([
    'issue.assigned',
    'issue.unassigned',
    'issue.updated',
    'issue.comment',
  ])
  for (const sub of issues) {
    expect(integrationSubscriptionSchema.parse(sub).source.connectionId).toBe(connectionId)
    expect(sub.match).toEqual({ repository: { value: 'owner/repo' }, 'issue.number': { value: 42 } })
    expect(sub.deliver).toEqual({ to: { step: flow.entry }, whenInactive: 'retain' })
  }
  const codeHost = { integration: 'github', repository: 'owner/repo', changeRequest: { number: 99 } }
  const both = registry.subscriptions(flow, { github, codeHost, tracked })
  expect(both).toHaveLength(12)
  expect(new Set(both.map((sub) => sub.id)).size).toBe(12)
  expect(both.filter((sub) => sub.source.output.startsWith('issue.'))).toEqual(issues)
  flow.completion.followChanges = false
  expect(registry.subscriptions(flow, { github, codeHost, tracked })).toEqual([])
})

test('tracked issue subscriptions reject malformed identities and do not cross repository or connection bindings', () => {
  const registry = new CodeHostingRegistry([githubCodeHostingAdapter])
  const flow = createBlankWorkflow()
  flow.completion.followChanges = true
  const issue = { integration: 'github', repository: 'owner/repo', kind: 'issue' }
  for (const number of [null, true, {}, [], -1, 0, 1.5, '1.5', '42', 'bad', Number.MAX_SAFE_INTEGER + 1])
    expect(registry.subscriptions(flow, { tracked: [{ ...issue, number }] })).toEqual([])
  for (const repository of ['', 'owner', 'owner/repo/extra', 'own er/repo'])
    expect(registry.subscriptions(flow, { tracked: [{ ...issue, repository, number: 42 }] })).toEqual([])
  expect(registry.subscriptions(flow, { tracked: [{ ...issue, integration: 'gitlab', number: 42 }] })).toEqual([])
  expect(registry.subscriptions(flow, { tracked: [{ ...issue, number: 42, connectionId: 'invalid' }] })).toEqual([])
  expect(registry.subscriptions(flow, { tracked: { ...issue, number: 42 } })).toEqual([])
  const connectionId = crypto.randomUUID()
  expect(
    registry
      .subscriptions(flow, {
        tracked: [{ ...issue, number: 42, connectionId }],
        integrationSource: { integration: 'github', resourceKey: 'owner/repo#42', connectionId: crypto.randomUUID() },
      })
      .every((sub) => sub.source.connectionId === connectionId)
  ).toBe(true)
  // One identity per subscription: the same number in another repository is a different link.
  expect(
    registry
      .subscriptions(flow, { tracked: [{ ...issue, repository: 'other/repo', number: 42 }] })
      .every((sub) => JSON.stringify(sub.match.repository) === JSON.stringify({ value: 'other/repo' }))
  ).toBe(true)
})

test('delivery feedback covers the code-host binding and flagged tracked pull requests only', () => {
  const registry = new CodeHostingRegistry([githubCodeHostingAdapter])
  const flow = createBlankWorkflow()
  flow.completion = { mode: 'pr-merge', followChanges: true }
  const flagged = { integration: 'github', repository: 'Acme/Other', kind: 'pull_request', number: 21, delivery: true }
  const plain = { integration: 'github', repository: 'acme/other', kind: 'pull_request', number: 22 }
  const issue = { integration: 'github', repository: 'acme/widgets', kind: 'issue', number: 23 }
  const metadata = {
    codeHost: { integration: 'github', repository: 'acme/widgets', changeRequest: { number: 34 } },
    tracked: [flagged, plain, issue],
  }
  const subscriptions = registry.subscriptions(flow, metadata)
  const byId = (id: string) => subscriptions.find((sub) => sub.id === id)!
  const trackedId = (resource: (typeof metadata.tracked)[number], event: string) =>
    subscriptions.find(
      (sub) =>
        sub.id.startsWith('tracked-') &&
        sub.id.endsWith(`-${event}`) &&
        JSON.stringify(sub.match[resource.kind === 'issue' ? 'issue.number' : 'pullRequest.number']) ===
          JSON.stringify({ value: resource.number })
    )!
  expect(isDeliveryFeedbackSubscription(byId('code-host-merged'), metadata)).toBe(true)
  expect(isDeliveryFeedbackSubscription(trackedId(flagged, 'merged'), metadata)).toBe(true)
  expect(isDeliveryFeedbackSubscription(trackedId(plain, 'merged'), metadata)).toBe(false)
  expect(isDeliveryFeedbackSubscription(trackedId(issue, 'comment'), metadata)).toBe(false)
  // The flag is metadata, not subscription identity: the same subscription is not feedback without it.
  expect(
    isDeliveryFeedbackSubscription(trackedId(flagged, 'merged'), {
      ...metadata,
      tracked: [{ ...flagged, delivery: undefined }, plain, issue],
    })
  ).toBe(false)
  // An author-written subscription is never delivery feedback, even when it names the primary
  // delivery PR literally: only the server's own reserved ids may pass the delivery-approval wait.
  const explicit = integrationSubscriptionSchema.parse({
    id: 'watch-the-delivery-pr',
    source: { integration: 'github', output: 'pull_request.merged', version: 1 },
    match: { repository: { value: 'acme/widgets' }, 'pullRequest.number': { value: 34 } },
    deliver: { to: 'delivery-owner', whenInactive: 'retain' },
  })
  expect(isDeliveryFeedbackSubscription(explicit, metadata)).toBe(false)
})

test('subscriptionTargetsResource compares literal matches case/whitespace-insensitively and by kind-specific number field', () => {
  const pr = integrationSubscriptionSchema.parse({
    id: 'watch-pr',
    source: { integration: 'github', output: 'pull_request.merged', version: 1 },
    match: { repository: { value: '  Acme/Widgets  ' }, 'pullRequest.number': { value: 34 } },
    deliver: { to: 'delivery-owner', whenInactive: 'retain' },
  })
  expect(
    subscriptionTargetsResource(pr, {
      integration: 'github',
      repository: 'acme/widgets',
      kind: 'pull_request',
      number: 34,
    })
  ).toBe(true)
  // Whitespace/casing on the resource side is normalized too.
  expect(
    subscriptionTargetsResource(pr, {
      integration: 'github',
      repository: '  ACME/WIDGETS  ',
      kind: 'pull_request',
      number: 34,
    })
  ).toBe(true)
  expect(
    subscriptionTargetsResource(pr, {
      integration: 'github',
      repository: 'acme/widgets',
      kind: 'pull_request',
      number: 35,
    })
  ).toBe(false)
  expect(
    subscriptionTargetsResource(pr, {
      integration: 'gitlab',
      repository: 'acme/widgets',
      kind: 'pull_request',
      number: 34,
    })
  ).toBe(false)
  // Same number, but the resource is an issue: the pull request match path never matches it.
  expect(
    subscriptionTargetsResource(pr, { integration: 'github', repository: 'acme/widgets', kind: 'issue', number: 34 })
  ).toBe(false)

  const issue = integrationSubscriptionSchema.parse({
    id: 'watch-issue',
    source: { integration: 'github', output: 'issue.updated', version: 1 },
    match: { repository: { value: 'acme/widgets' }, 'issue.number': { value: 12 } },
    deliver: { to: 'delivery-owner', whenInactive: 'retain' },
  })
  expect(
    subscriptionTargetsResource(issue, { integration: 'github', repository: 'acme/widgets', kind: 'issue', number: 12 })
  ).toBe(true)

  // A `streamMetadata`-bound match carries no fixed value of its own, so it never matches a resource.
  const bound = integrationSubscriptionSchema.parse({
    id: 'watch-bound',
    source: { integration: 'github', output: 'pull_request.merged', version: 1 },
    match: {
      repository: { streamMetadata: 'github.repo' },
      'pullRequest.number': { streamMetadata: 'github.pr.number' },
    },
    deliver: { to: 'delivery-owner', whenInactive: 'retain' },
  })
  expect(
    subscriptionTargetsResource(bound, {
      integration: 'github',
      repository: 'acme/widgets',
      kind: 'pull_request',
      number: 34,
    })
  ).toBe(false)
})

test('tracked resources fan out with stable identity-hashed ids and never duplicate delivery/legacy bindings', () => {
  const registry = new CodeHostingRegistry([githubCodeHostingAdapter])
  const flow = createBlankWorkflow()
  flow.completion = { mode: 'pr-merge', followChanges: true }
  const metadata = {
    codeHost: { integration: 'github', repository: 'acme/widgets', changeRequest: { number: 34 } },
    github: { repo: 'acme/widgets', issue: 12 },
    tracked: [
      { integration: 'github', repository: 'acme/widgets', kind: 'pull_request', number: 34 },
      { integration: 'github', repository: 'acme/widgets', kind: 'issue', number: 12 },
      { integration: 'github', repository: 'acme/other', kind: 'issue', number: 7 },
      {
        integration: 'github',
        repository: 'acme/other',
        kind: 'pull_request',
        number: 8,
        connectionId: '11111111-1111-4111-8111-111111111111',
      },
    ],
  }
  const subs = registry.subscriptions(flow, metadata)
  const ids = subs.map((s) => s.id)
  expect(ids.filter((id) => id.startsWith('code-host-'))).toHaveLength(8)
  // The delivery PR is also listed in `tracked`; it keeps its reserved ids instead of fanning out again.
  expect(ids.filter((id) => id.startsWith('tracked-'))).toHaveLength(16)
  expect(ids).toHaveLength(24)
  expect(new Set(ids).size).toBe(ids.length)
  for (const sub of subs) expect(integrationSubscriptionSchema.safeParse(sub).success).toBe(true)
  const isIssueSeven = (s: (typeof subs)[number]) => {
    const match = s.match['issue.number']
    return !!match && 'value' in match && match.value === 7
  }
  const other = subs.find(isIssueSeven)!
  expect(other.match.repository).toEqual({ value: 'acme/other' })
  const pinned = subs.find((s) => {
    const match = s.match['pullRequest.number']
    return !!match && 'value' in match && match.value === 8
  })!
  expect(pinned.source.connectionId).toBe('11111111-1111-4111-8111-111111111111')
  // Ids are independent of list position.
  const reordered = registry.subscriptions(flow, { ...metadata, tracked: [...metadata.tracked].reverse() })
  expect(new Set(reordered.map((s) => s.id))).toEqual(new Set(ids))
  // Removing one link leaves the others untouched.
  const without = registry.subscriptions(flow, { ...metadata, tracked: metadata.tracked.filter((t) => t.number !== 7) })
  const removed = new Set(subs.filter(isIssueSeven).map((s) => s.id))
  expect(without.map((s) => s.id).sort()).toEqual(ids.filter((id) => !removed.has(id)).sort())
})

test('tracked fan-out is delegated to the tracked-resource adapters, not the code-hosting ones', () => {
  // The code-hosting registry knows GitHub only; Linear has no code-hosting adapter at all.
  const registry = new CodeHostingRegistry([githubCodeHostingAdapter])
  const flow = createBlankWorkflow()
  flow.completion.followChanges = true
  const linear = { integration: 'linear', repository: 'eng', kind: 'issue', number: 12, externalId: 'issue-uuid' }
  const subscriptions = registry.subscriptions(flow, { tracked: [linear] })
  expect(subscriptions.map((sub) => sub.source.output)).toEqual([
    'issue.assigned',
    'issue.unassigned',
    'issue.updated',
    'issue.comment',
  ])
  for (const sub of subscriptions) {
    expect(integrationSubscriptionSchema.parse(sub).source.integration).toBe('linear')
    expect(sub.match).toEqual({ 'issue.id': { value: 'issue-uuid' } })
    // The flow's own delivery target still applies to every inferred subscription.
    expect(sub.deliver).toEqual({ to: 'delivery-owner', whenInactive: 'retain' })
  }
  flow.completion.changeEventsTo = { step: flow.entry }
  expect(
    registry
      .subscriptions(flow, { tracked: [linear] })
      .every((sub) => JSON.stringify(sub.deliver.to) === JSON.stringify({ step: flow.entry }))
  ).toBe(true)
  // A tracked Linear issue is still identified by the shared matcher.
  expect(subscriptionTargetsResource(subscriptions[0]!, { ...linear, kind: 'issue' as const })).toBe(true)
})

test('a Linear issue link is never delivery feedback, even beside a link claiming a Linear pull request', () => {
  const registry = new CodeHostingRegistry([githubCodeHostingAdapter])
  const flow = createBlankWorkflow()
  flow.completion = { mode: 'pr-merge', followChanges: true }
  const issue = { integration: 'linear', repository: 'eng', kind: 'issue', number: 12, externalId: 'issue-uuid' }
  // Linear has no pull requests, but stored metadata could still claim one and flag it for delivery.
  const flagged = { ...issue, kind: 'pull_request', delivery: true }
  for (const externalId of [issue.externalId, undefined]) {
    const metadata = {
      tracked: [
        { ...issue, externalId },
        { ...flagged, externalId },
      ],
    }
    const subscriptions = registry.subscriptions(flow, metadata)
    expect(subscriptions).toHaveLength(4)
    for (const subscription of subscriptions) {
      expect(subscription.source.output.startsWith('issue.')).toBe(true)
      expect(isDeliveryFeedbackSubscription(subscription, metadata)).toBe(false)
    }
  }
})
