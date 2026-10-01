import { describe, expect, test } from 'bun:test'
import { classifyDeliveryPresentation, deliverySnapshotEvent, type DeliveryEvent } from './delivery-state'
import type { WorkStreamDeliveryGateFacts, WorkflowRun } from '@ficus/shared'
import { workBucket, workStreamNeedsHumanAttention } from '@ficus/shared'

const metadata = { codeHost: { integration: 'github', repository: 'acme/repo', changeRequest: { number: 42 } } }
const run = (mode = 'pr-merge', followChanges = true) =>
  ({ status: 'completion-ready', definition: { completion: { mode, followChanges } } }) as WorkflowRun
const event = (
  output: string,
  data: Record<string, unknown> = {},
  headSha = 'a'.repeat(40),
  occurredAt = '2026-09-21T10:00:00Z'
): DeliveryEvent => ({
  integration: 'github',
  output,
  version: 1,
  eventKey: `${output}:${headSha}:${occurredAt}`,
  resourceKey: 'acme/repo#42',
  subject: '',
  body: '',
  occurredAt,
  data: { repository: 'acme/repo', pullRequest: { number: 42, headSha }, ...data },
})

test('policy, binding and tracking determine setup versus external, not PR existence alone', () => {
  expect(classifyDeliveryPresentation(run(), metadata, [])).toEqual({
    kind: 'external',
    explanation: { pullRequests: [{ number: 42, state: 'open' }] },
  })
  expect(classifyDeliveryPresentation(run(), {}, [])).toEqual({
    kind: 'setup',
    explanation: { setupReason: 'unbound' },
  })
  expect(classifyDeliveryPresentation(run('pr-merge', false), metadata, [])).toEqual({
    kind: 'setup',
    explanation: { setupReason: 'not-following-changes', pullRequests: [{ number: 42, state: 'open' }] },
  })
  expect(classifyDeliveryPresentation(run('review-approval'), {}, [])).toEqual({ kind: 'approval' })
  expect(classifyDeliveryPresentation({ ...run(), status: 'running' }, metadata, [])).toBeUndefined()
})
test('only positive current-head provider facts identify a human gate', () => {
  expect(
    classifyDeliveryPresentation(run(), metadata, [event('pull_request.updated', { mergeState: 'clean' })])
  ).toEqual({ kind: 'merge' })
  expect(
    classifyDeliveryPresentation(run('pr-auto-merge'), metadata, [
      event('pull_request.updated', { mergeState: 'clean' }),
    ])
  ).toEqual({
    kind: 'external',
    explanation: {
      pullRequests: [{ number: 42, state: 'open' }],
      gates: { mergeState: 'clean' },
      codeHostReason: 'awaiting-merge',
    },
  })
  expect(
    classifyDeliveryPresentation(run(), metadata, [
      event('pull_request.review_requested', { requestedReviewer: 'human', requestedReviewerType: 'User' }),
    ])
  ).toEqual({
    kind: 'review',
  })
  expect(
    classifyDeliveryPresentation(run(), metadata, [event('pull_request.ci_completed', { state: 'success' })])
  ).toEqual({
    kind: 'external',
    explanation: { pullRequests: [{ number: 42, state: 'open' }] },
  })
  expect(
    classifyDeliveryPresentation(run(), metadata, [
      event('pull_request.updated', { mergeState: 'clean' }, 'a'.repeat(40)),
      event('pull_request.updated', {}, 'b'.repeat(40), '2026-09-21T11:00:00Z'),
    ])
  ).toEqual({
    kind: 'external',
    explanation: { pullRequests: [{ number: 42, state: 'open' }] },
  })
})
test('negative current-head facts never look ready for review or merge', () => {
  for (const [fact, codeHostReason] of [
    [event('pull_request.ci_completed', { state: 'failure' }), undefined],
    [event('pull_request.reviewed', { state: 'changes_requested' }), 'changes-requested'],
    [event('pull_request.updated', { mergeConflict: true }), 'merge-conflict'],
  ] as const) {
    expect(classifyDeliveryPresentation(run(), metadata, [fact])).toEqual({
      kind: 'failure',
      ...(codeHostReason ? { explanation: { codeHostReason } } : {}),
    })
  }
})

test('branch identity, draft state, bot requests, and old review commits cannot advertise readiness', () => {
  const configured = { ...metadata, git: { branch: 'work/branch', baseBranch: 'main' } }
  expect(
    classifyDeliveryPresentation(run(), configured, [
      event('pull_request.updated', { mergeState: 'clean', headBranch: 'other', baseBranch: 'main' }),
    ])
  ).toEqual({
    kind: 'setup',
    explanation: {
      setupReason: 'branch-mismatch',
      branchMismatch: { streamBranch: 'work/branch', pullRequestBranch: 'other' },
      pullRequests: [{ number: 42, state: 'open' }],
      gates: { mergeState: 'clean' },
    },
  })
  expect(
    classifyDeliveryPresentation(run(), metadata, [event('pull_request.updated', { mergeState: 'clean', draft: true })])
  ).toEqual({
    kind: 'external',
    explanation: {
      pullRequests: [{ number: 42, state: 'open' }],
      gates: { mergeState: 'clean', draft: true },
      codeHostReason: 'draft',
    },
  })
  expect(
    classifyDeliveryPresentation(run(), metadata, [
      event('pull_request.review_requested', { requestedReviewerType: 'Bot' }),
    ])
  ).toEqual({
    kind: 'external',
    explanation: { pullRequests: [{ number: 42, state: 'open' }] },
  })
  expect(
    classifyDeliveryPresentation(run(), metadata, [
      event('pull_request.reviewed', { state: 'changes_requested', reviewedHeadSha: 'b'.repeat(40) }),
    ])
  ).toEqual({
    kind: 'external',
    explanation: { pullRequests: [{ number: 42, state: 'open' }] },
  })
})
test('auto-merge policy fallback requires a human only with positive merge readiness', () => {
  const clean = [event('pull_request.updated', { mergeState: 'clean' })]
  expect(classifyDeliveryPresentation(run('pr-auto-merge'), metadata, clean, { allowAutoMerge: false })).toEqual({
    kind: 'merge',
  })
  expect(classifyDeliveryPresentation(run('pr-auto-merge'), metadata, [], { allowAutoMerge: false })).toEqual({
    kind: 'external',
    explanation: { pullRequests: [{ number: 42, state: 'open' }] },
  })
})
test('valid direct-merge setup waits for verification, never displays delivered green', () => {
  expect(
    classifyDeliveryPresentation(
      run('direct-merge'),
      { ...metadata, git: { commit: 'a'.repeat(40), baseBranch: 'main' } },
      []
    )
  ).toEqual({
    kind: 'external',
    explanation: { pullRequests: [{ number: 42, state: 'open' }] },
  })
})
test('a late old-head CI failure cannot replace the observed PR head', () => {
  expect(
    classifyDeliveryPresentation(run(), metadata, [
      event('pull_request.updated', {}, 'b'.repeat(40)),
      event('pull_request.ci_completed', { state: 'failure' }, 'a'.repeat(40), '2026-09-21T11:00:00Z'),
    ])
  ).toEqual({
    kind: 'external',
    explanation: { pullRequests: [{ number: 42, state: 'open' }] },
  })
})

test('unknown or failing additional delivery PRs prevent claiming a ready primary merge', () => {
  const multiple = {
    ...metadata,
    tracked: [{ integration: 'github', repository: 'acme/other', kind: 'pull_request', number: 8, delivery: true }],
  }
  const primary = event('pull_request.updated', { mergeState: 'clean' })
  expect(classifyDeliveryPresentation(run(), multiple, [primary])).toEqual({
    kind: 'external',
    explanation: {
      pullRequests: [
        { number: 42, state: 'open' },
        { number: 8, state: 'open' },
      ],
    },
  })
  const failed = event('pull_request.updated', {
    repository: 'acme/other',
    pullRequest: { number: 8, headSha: 'b'.repeat(40) },
    mergeConflict: true,
  })
  expect(classifyDeliveryPresentation(run(), multiple, [primary, failed])).toEqual({
    kind: 'failure',
    explanation: { codeHostReason: 'merge-conflict' },
  })
})

test('already merged additional PRs do not hide the remaining human merge', () => {
  const multiple = {
    ...metadata,
    tracked: [{ integration: 'github', repository: 'acme/other', kind: 'pull_request', number: 8, delivery: true }],
  }
  const primary = event('pull_request.updated', { mergeState: 'clean' })
  const merged = event('pull_request.merged', {
    repository: 'acme/other',
    pullRequest: { number: 8, headSha: 'b'.repeat(40) },
  })
  expect(classifyDeliveryPresentation(run(), multiple, [primary, merged])).toEqual({ kind: 'merge' })
  expect(classifyDeliveryPresentation(run(), metadata, [event('pull_request.merged')])).toEqual({
    kind: 'external',
    explanation: { pullRequests: [{ number: 42, state: 'merged' }], codeHostReason: 'merged' },
  })
})

test('unknown reviewer identity and unknown PR head never imply a human action', () => {
  expect(classifyDeliveryPresentation(run(), metadata, [event('pull_request.review_requested')])).toEqual({
    kind: 'external',
    explanation: { pullRequests: [{ number: 42, state: 'open' }] },
  })
  expect(
    classifyDeliveryPresentation(run(), metadata, [event('pull_request.updated', { mergeState: 'clean' }, '')])
  ).toEqual({
    kind: 'external',
    explanation: { pullRequests: [{ number: 42, state: 'open' }] },
  })
})

test('malformed direct delivery metadata is setup required, never a serializer exception', () => {
  expect(
    classifyDeliveryPresentation(
      run('direct-merge'),
      { ...metadata, git: { commit: 'a'.repeat(40), baseBranch: 7 } },
      []
    )
  ).toEqual({
    kind: 'setup',
    explanation: { setupReason: 'direct-merge-facts', pullRequests: [{ number: 42, state: 'open' }] },
  })
})

test('a current human review request survives later CI success and unrelated PR comments', () => {
  const request = event('pull_request.review_requested', { requestedReviewer: 'human', requestedReviewerType: 'User' })
  const ci = event('pull_request.ci_completed', { state: 'success' }, 'a'.repeat(40), '2026-09-21T11:00:00Z')
  expect(classifyDeliveryPresentation(run(), metadata, [request, ci])).toEqual({ kind: 'review' })
  const comment = event('pull_request.comment', { pendingHumanReview: true }, 'a'.repeat(40), '2026-09-21T12:00:00Z')
  expect(classifyDeliveryPresentation(run(), metadata, [request, ci, comment])).toEqual({ kind: 'review' })
})

test('current clean review snapshots clear older changes requests and survive successful CI', () => {
  const rejected = event('pull_request.reviewed', { state: 'changes_requested' })
  const approved = event(
    'pull_request.reviewed',
    { state: 'approved', mergeState: 'clean', pendingHumanReview: false },
    'a'.repeat(40),
    '2026-09-21T11:00:00Z'
  )
  expect(classifyDeliveryPresentation(run(), metadata, [rejected, approved])).toEqual({ kind: 'merge' })
  const ci = event('pull_request.ci_completed', { state: 'success' }, 'a'.repeat(40), '2026-09-21T12:00:00Z')
  expect(classifyDeliveryPresentation(run(), metadata, [rejected, approved, ci])).toEqual({ kind: 'merge' })
})
test('draft does not hide current-head failures or conflicts', () => {
  const draft = event('pull_request.updated', { draft: true })
  const failure = event('pull_request.ci_completed', { state: 'failure' }, 'a'.repeat(40), '2026-09-21T11:00:00Z')
  expect(classifyDeliveryPresentation(run(), metadata, [draft, failure])).toEqual({
    kind: 'failure',
    explanation: { codeHostReason: 'ci-failed' },
  })
  expect(
    classifyDeliveryPresentation(run(), metadata, [event('pull_request.updated', { draft: true, mergeConflict: true })])
  ).toEqual({ kind: 'failure', explanation: { codeHostReason: 'merge-conflict' } })
})

test('stale aggregate observations cannot claim human readiness', () => {
  const clean = {
    ...event('pull_request.updated', { mergeState: 'clean' }),
    observedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  }
  // A stale snapshot's gate facts are not republished as current explanation either.
  expect(classifyDeliveryPresentation(run(), metadata, [clean])).toEqual({
    kind: 'external',
    explanation: { pullRequests: [{ number: 42, state: 'open' }] },
  })
})

test('explanations key pull requests by repository, prefer live pending checks, and drop merged gates', () => {
  // Same PR number in two repositories: only the one actually merged is reported merged.
  const twoRepos = {
    ...metadata,
    tracked: [{ integration: 'github', repository: 'acme/other', kind: 'pull_request', number: 42, delivery: true }],
  }
  const otherMerged = event('pull_request.merged', {
    repository: 'acme/other',
    pullRequest: { number: 42, headSha: 'b'.repeat(40) },
  })
  expect(
    classifyDeliveryPresentation(run('pr-auto-merge'), twoRepos, [
      event('pull_request.updated', { mergeState: 'clean' }),
      otherMerged,
    ])?.explanation?.pullRequests
  ).toEqual([
    { number: 42, state: 'open' },
    { number: 42, state: 'merged' },
  ])
  // A still-running check outranks an older snapshot rollup that claimed success.
  expect(
    classifyDeliveryPresentation(run('pr-auto-merge'), metadata, [
      event('pull_request.updated', { mergeState: 'clean', checksState: 'success' }),
      event('pull_request.ci_completed', { state: 'in_progress' }, 'a'.repeat(40), '2026-09-21T11:00:00Z'),
    ])?.explanation?.gates?.checksState
  ).toBe('pending')
  // Merged: nothing left to wait on, so no gate facts ride along.
  expect(
    classifyDeliveryPresentation(run(), metadata, [
      event('pull_request.updated', { mergeState: 'blocked', checksState: 'pending' }),
      event('pull_request.merged', {}, 'a'.repeat(40), '2026-09-21T11:00:00Z'),
    ])
  ).toEqual({
    kind: 'external',
    explanation: { pullRequests: [{ number: 42, state: 'merged' }], codeHostReason: 'merged' },
  })
})

test('normalized approvals, newer native snapshots and per-workflow CI recovery clear superseded failure without losing the gate', async () => {
  const { githubOutputAdapter } = await import('../integrations/outputs/github')
  const { workStreamNeedsHumanAttention, workBucket } = await import('@ficus/shared')
  const pr = { id: 42, number: 42, state: 'open', head: { sha: 'a'.repeat(40) }, mergeable_state: 'blocked' }
  const normalize = (type: string, payload: unknown) =>
    githubOutputAdapter.normalize({ type, payload }).map((fact) => ({ ...fact, integration: 'github' }))
  const rejected = normalize('pull_request_review', {
    action: 'submitted',
    repository: { full_name: 'acme/repo' },
    pull_request: pr,
    review: { id: 1, state: 'changes_requested', submitted_at: '2026-09-21T10:00:00Z' },
  })
  for (const submittedAt of ['2026-09-21T10:00:00Z', '2026-09-21T11:00:00Z']) {
    const recovered = normalize('pull_request_review', {
      action: 'submitted',
      repository: { full_name: 'acme/repo' },
      pull_request: { ...pr, mergeable_state: 'clean', updated_at: '2026-09-21T11:00:00Z' },
      review: { id: 2, state: 'approved', submitted_at: submittedAt },
    })
    expect(recovered).toHaveLength(1)
    const ci = (state: string, hour: number, workflowId = 7) =>
      normalize('workflow_run', {
        action: 'completed',
        repository: { full_name: 'acme/repo' },
        workflow_run: {
          id: hour,
          workflow_id: workflowId,
          run_number: hour,
          run_attempt: 1,
          conclusion: state,
          head_sha: 'a'.repeat(40),
          pull_requests: [{ number: 42 }],
          completed_at: `2026-09-21T${hour}:00:00Z`,
        },
      })
    expect(
      classifyDeliveryPresentation(run(), metadata, [
        ...rejected,
        ...recovered,
        ...ci('failure', 12),
        ...ci('success', 13, 8),
      ])
    ).toEqual({ kind: 'failure', explanation: { codeHostReason: 'ci-failed' } })
    const facts = [...rejected, ...recovered, ...ci('failure', 12), ...ci('success', 13)]
    const delivery = classifyDeliveryPresentation(run(), metadata, facts)
    expect(delivery).toEqual({ kind: 'merge' })
    const presentation = { status: 'active' as const, openWaits: [], delivery }
    expect(workStreamNeedsHumanAttention(presentation)).toBe(true)
    expect(workBucket(presentation)).toBe('needsYou')
  }
})

test('explicit unknown aggregates supersede clean readiness while sparse facts do not', () => {
  const clean = event('pull_request.updated', { mergeState: 'clean' })
  const newer = (data: Record<string, unknown>) =>
    event('pull_request.snapshot', data, 'a'.repeat(40), '2026-09-21T11:00:00Z')
  const unknowns: Record<string, unknown>[] = [
    { mergeState: 'unknown', checksState: 'pending', reviewDecision: 'approved' },
    { mergeState: 'unknown', checksState: 'unknown', reviewDecision: 'unknown' },
    { checksState: 'pending' },
  ]
  for (const data of unknowns)
    expect(classifyDeliveryPresentation(run(), metadata, [clean, newer(data)])).toEqual({
      kind: 'external',
      explanation: {
        pullRequests: [{ number: 42, state: 'open' }],
        gates: data as WorkStreamDeliveryGateFacts,
        ...(data.checksState === 'pending' ? { codeHostReason: 'ci-pending' } : {}),
      },
    })
  expect(classifyDeliveryPresentation(run(), metadata, [clean, newer({})])).toEqual({ kind: 'merge' })
  expect(
    classifyDeliveryPresentation(run(), metadata, [
      event('pull_request.snapshot', { reviewDecision: 'required' }),
      newer({ mergeState: 'unknown', checksState: 'unknown', reviewDecision: 'unknown' }),
    ])
  ).toEqual({
    kind: 'external',
    explanation: {
      pullRequests: [{ number: 42, state: 'open' }],
      gates: { mergeState: 'unknown', checksState: 'unknown', reviewDecision: 'unknown' },
    },
  })
  expect(
    classifyDeliveryPresentation(run(), metadata, [
      event('pull_request.snapshot', { checksState: 'pending' }),
      newer({ mergeState: 'clean' }),
    ])
  ).toEqual({ kind: 'merge' })
  expect(
    classifyDeliveryPresentation(run(), metadata, [
      clean,
      newer({ mergeState: 'unknown', checksState: 'pending', reviewDecision: 'required' }),
    ])
  ).toEqual({ kind: 'review' })
  expect(
    classifyDeliveryPresentation(run(), metadata, [
      event('pull_request.updated', { mergeState: 'dirty' }),
      newer({ mergeState: 'unknown', checksState: 'unknown' }),
    ])
  ).toEqual({ kind: 'failure', explanation: { codeHostReason: 'merge-conflict' } })
})

test('setup explanations distinguish unbound, not-following and direct-merge facts', () => {
  expect(classifyDeliveryPresentation(run(), { github: { repo: 'acme/repo' } }, [])).toEqual({
    kind: 'setup',
    explanation: { setupReason: 'unbound' },
  })
  expect(classifyDeliveryPresentation(run('direct-merge'), { codeHost: metadata.codeHost }, [])).toEqual({
    kind: 'setup',
    explanation: { setupReason: 'direct-merge-facts', pullRequests: [{ number: 42, state: 'open' }] },
  })
  expect(classifyDeliveryPresentation(run('direct-merge'), {}, [])).toEqual({
    kind: 'setup',
    explanation: { setupReason: 'direct-merge-facts' },
  })
})

test('branch mismatch explains both differing branch pairs with the observed gates', () => {
  const configured = { ...metadata, git: { branch: 'work/branch', baseBranch: 'main' } }
  expect(
    classifyDeliveryPresentation(run(), configured, [
      event('pull_request.updated', {
        mergeState: 'blocked',
        checksState: 'success',
        reviewDecision: 'approved',
        headBranch: 'other',
        baseBranch: 'develop',
      }),
    ])
  ).toEqual({
    kind: 'setup',
    explanation: {
      setupReason: 'branch-mismatch',
      branchMismatch: {
        streamBranch: 'work/branch',
        pullRequestBranch: 'other',
        streamBaseBranch: 'main',
        pullRequestBaseBranch: 'develop',
      },
      pullRequests: [{ number: 42, state: 'open' }],
      gates: { mergeState: 'blocked', checksState: 'success', reviewDecision: 'approved' },
    },
  })
})

test('external explanations carry the deciding gates including event-derived pending checks', () => {
  expect(
    classifyDeliveryPresentation(run(), metadata, [
      event('pull_request.updated', { mergeState: 'blocked', reviewDecision: 'approved' }),
      event('pull_request.ci_completed', { state: 'pending' }, 'a'.repeat(40), '2026-09-21T11:00:00Z'),
    ])
  ).toEqual({
    kind: 'external',
    explanation: {
      pullRequests: [{ number: 42, state: 'open' }],
      gates: { mergeState: 'blocked', reviewDecision: 'approved', checksState: 'pending' },
      codeHostReason: 'ci-pending',
    },
  })
})

test('observed pull request states override the metadata delivery view primary-first', () => {
  const multiple = {
    ...metadata,
    delivery: { pullRequests: { 'github:acme/other:pull_request:8': { state: 'closed', at: '2026-09-21T09:00:00Z' } } },
    tracked: [{ integration: 'github', repository: 'acme/other', kind: 'pull_request', number: 8, delivery: true }],
  }
  expect(classifyDeliveryPresentation(run(), multiple, [event('pull_request.merged', {}, 'a'.repeat(40))])).toEqual({
    kind: 'external',
    explanation: {
      pullRequests: [
        { number: 42, state: 'merged' },
        { number: 8, state: 'closed' },
      ],
    },
  })
})

test('human gates and failures without an authoritative head stay lean', () => {
  expect(
    classifyDeliveryPresentation(run(), metadata, [event('pull_request.updated', { mergeState: 'clean' })])
  ).toEqual({ kind: 'merge' })
  expect(classifyDeliveryPresentation(run('review-approval'), {}, [])).toEqual({ kind: 'approval' })
  expect(
    classifyDeliveryPresentation(run(), metadata, [event('pull_request.ci_completed', { state: 'failure' })])
  ).toEqual({ kind: 'failure' })
})

describe('a known required human review survives stale or superseding non-review evidence', () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const observed = (fact: DeliveryEvent, minutes: number): DeliveryEvent => ({
    ...fact,
    occurredAt: minutesAgo(minutes),
    observedAt: minutesAgo(minutes),
  })
  // Ficus #362 / tau-mobile#42: auto-merge enabled, ruleset requires one approval,
  // no explicit reviewer request, required CI pending and then green.
  const autoMergeEnabled = observed(
    event('pull_request.updated', { action: 'auto_merge_enabled', mergeState: 'blocked', pendingHumanReview: false }),
    30
  )
  const aggregate = (data: Record<string, unknown>, minutes: number, head = 'a'.repeat(40)) =>
    observed(
      event(
        'pull_request.snapshot',
        { pullRequestState: 'open', draft: false, pendingHumanReview: false, ...data },
        head
      ),
      minutes
    )
  const requiredWhilePending = aggregate(
    { mergeState: 'blocked', reviewDecision: 'required', checksState: 'pending' },
    20
  )
  const ciGreen = observed(event('pull_request.ci_completed', { state: 'success', ci: { workflowId: '7' } }), 10)
  const classify = (events: DeliveryEvent[]) =>
    classifyDeliveryPresentation(run('pr-auto-merge'), metadata, events, { allowAutoMerge: true })

  test('the #362 facts classify as a human PR review while CI is pending and after it settles', () => {
    expect(
      classify([
        autoMergeEnabled,
        aggregate({ mergeState: 'blocked', reviewDecision: 'required', checksState: 'pending' }, 1),
      ])
    ).toEqual({
      kind: 'review',
    })
    // The aggregate observation expired (polling fell behind) and only CI evidence is newer.
    expect(classify([autoMergeEnabled, requiredWhilePending, ciGreen])).toEqual({ kind: 'review' })
    const presentation = {
      status: 'active' as const,
      openWaits: [],
      delivery: classify([requiredWhilePending, ciGreen]),
    }
    expect(workStreamNeedsHumanAttention(presentation)).toBe(true)
    expect(workBucket(presentation)).toBe('needsYou')
  })

  test('approval, merge, close, a new head, or a newer aggregate without the requirement clear it', () => {
    const approval = observed(event('pull_request.reviewed', { state: 'approved', reviewedHeadSha: 'a'.repeat(40) }), 5)
    // Approved: back to the code host (the fixture's rollup still reports its pending checks).
    expect(classify([requiredWhilePending, ciGreen, approval])).toEqual({
      kind: 'external',
      explanation: { pullRequests: [{ number: 42, state: 'open' }], gates: { checksState: 'pending' } },
    })
    // An approval of an older commit does not satisfy the current head.
    const oldApproval = observed(
      event('pull_request.reviewed', { state: 'approved', reviewedHeadSha: 'b'.repeat(40) }),
      5
    )
    expect(classify([requiredWhilePending, oldApproval])).toEqual({ kind: 'review' })
    expect(classify([requiredWhilePending, observed(event('pull_request.merged'), 5)])).toEqual({
      kind: 'external',
      explanation: { pullRequests: [{ number: 42, state: 'merged' }], codeHostReason: 'merged' },
    })
    expect(classify([requiredWhilePending, observed(event('pull_request.closed'), 5)])).toEqual({
      kind: 'failure',
      explanation: { codeHostReason: 'closed' },
    })
    expect(
      classify([
        requiredWhilePending,
        observed(event('pull_request.updated', { action: 'synchronize' }, 'b'.repeat(40)), 5),
      ])
    ).toEqual({ kind: 'external', explanation: { pullRequests: [{ number: 42, state: 'open' }] } })
    expect(
      classify([
        requiredWhilePending,
        aggregate({ mergeState: 'blocked', reviewDecision: 'approved', checksState: 'success' }, 1),
      ])
    ).toEqual({
      kind: 'external',
      explanation: {
        pullRequests: [{ number: 42, state: 'open' }],
        gates: { mergeState: 'blocked', checksState: 'success', reviewDecision: 'approved' },
      },
    })
  })

  test('only CI, merge queue or auto-merge with review satisfied stays external; no evidence invents nothing', () => {
    expect(classify([autoMergeEnabled, ciGreen])).toEqual({
      kind: 'external',
      explanation: { pullRequests: [{ number: 42, state: 'open' }] },
    })
    expect(
      classify([aggregate({ mergeState: 'blocked', reviewDecision: 'approved', checksState: 'pending' }, 1)])
    ).toEqual({
      kind: 'external',
      explanation: {
        pullRequests: [{ number: 42, state: 'open' }],
        gates: { mergeState: 'blocked', checksState: 'pending', reviewDecision: 'approved' },
        codeHostReason: 'ci-pending',
      },
    })
    expect(classify([aggregate({ mergeState: 'blocked', reviewDecision: 'required', draft: true }, 1)])).toMatchObject({
      kind: 'external',
    })
    expect(
      classify([requiredWhilePending, observed(event('pull_request.ci_completed', { state: 'failure' }), 5)])
    ).toEqual({
      kind: 'failure',
      explanation: { codeHostReason: 'ci-failed' },
    })
  })

  test('a requested human reviewer stays a review after the observation ages and unrelated comments arrive', () => {
    const request = observed(
      event('pull_request.review_requested', {
        requestedReviewer: 'human',
        requestedReviewerType: 'User',
        pendingHumanReview: true,
      }),
      30
    )
    const comment = observed(event('pull_request.comment', {}), 10)
    expect(classify([request, comment, ciGreen])).toEqual({ kind: 'review' })
    const removed = observed(
      event('pull_request.updated', { action: 'review_request_removed', pendingHumanReview: false }),
      5
    )
    expect(classify([request, comment, removed])).toEqual({
      kind: 'external',
      explanation: { pullRequests: [{ number: 42, state: 'open' }] },
    })
  })
})

test('an expired cached snapshot keeps its review requirement but not its merge or check readiness', () => {
  const now = Date.parse('2026-01-01T08:00:00Z')
  const snapshot = {
    version: 1 as const,
    squadId: 'squad',
    connectionId: 'connection',
    repository: 'acme/repo',
    number: 42,
    observedAt: '2026-01-01T07:40:00Z',
    source: 'graphql' as const,
    headSha: 'a'.repeat(40),
    state: 'open' as const,
    draft: false,
    mergeState: 'clean',
    reviewDecision: 'required' as const,
    checksState: 'failure' as const,
    pendingHumanReview: false,
  }
  const stale = deliverySnapshotEvent(snapshot, now)
  expect(stale.data).not.toHaveProperty('mergeState')
  expect(stale.data).not.toHaveProperty('checksState')
  expect(stale.data).toMatchObject({ reviewDecision: 'required', pullRequestState: 'open', draft: false })
  // No alarm from an expired failure rollup; the standing requirement still decides.
  expect(classifyDeliveryPresentation(run(), metadata, [stale])).toEqual({ kind: 'review' })
  const approved = deliverySnapshotEvent({ ...snapshot, reviewDecision: 'approved' }, now)
  expect(classifyDeliveryPresentation(run(), metadata, [approved])).toEqual({
    kind: 'external',
    explanation: { pullRequests: [{ number: 42, state: 'open' }] },
  })
  const current = deliverySnapshotEvent(snapshot, Date.parse('2026-01-01T07:41:00Z'))
  expect(current.data).toMatchObject({ mergeState: 'clean', checksState: 'failure' })
})

describe('authoritative code-host label reasons', () => {
  const cases = [
    { data: { checksState: 'pending' }, kind: 'external', reason: 'ci-pending' },
    { data: { checksState: 'failure' }, kind: 'failure', reason: 'ci-failed' },
    { data: { mergeState: 'dirty' }, kind: 'failure', reason: 'merge-conflict' },
    { data: { mergeConflict: true }, kind: 'failure', reason: 'merge-conflict' },
    { data: { reviewDecision: 'changes_requested' }, kind: 'failure', reason: 'changes-requested' },
    { data: { draft: true }, kind: 'external', reason: 'draft' },
    { data: { mergeState: 'clean' }, kind: 'external', reason: 'awaiting-merge' },
    { data: { mergeState: 'blocked' }, kind: 'external', reason: undefined },
    { data: { mergeState: 'unknown' }, kind: 'external', reason: undefined },
    { data: {}, kind: 'external', reason: undefined },
  ]
  for (const row of cases)
    test(JSON.stringify(row.data), () => {
      const result = classifyDeliveryPresentation(
        run('pr-auto-merge'),
        metadata,
        [event('pull_request.updated', row.data)],
        { allowAutoMerge: true }
      )
      expect(result?.kind).toBe(row.kind)
      expect(result?.explanation?.codeHostReason).toBe(row.reason)
    })
  test('review wins pending CI and CI failure wins review without changing attention', () => {
    const required = event('pull_request.updated', { reviewDecision: 'required', checksState: 'pending' })
    expect(classifyDeliveryPresentation(run(), metadata, [required])?.kind).toBe('review')
    const failure = event('pull_request.ci_completed', { state: 'failure' }, 'a'.repeat(40), '2026-09-21T11:00:00Z')
    expect(classifyDeliveryPresentation(run(), metadata, [required, failure])?.explanation?.codeHostReason).toBe(
      'ci-failed'
    )
  })
  test('a secondary designated PR supplies the reason, never the primary', () => {
    const multiple = {
      ...metadata,
      tracked: [{ integration: 'github', repository: 'acme/other', kind: 'pull_request', number: 8, delivery: true }],
    }
    const secondary = event('pull_request.updated', {
      repository: 'acme/other',
      pullRequest: { number: 8, headSha: 'b'.repeat(40) },
      mergeConflict: true,
    })
    const result = classifyDeliveryPresentation(run(), multiple, [
      event('pull_request.updated', { checksState: 'pending' }),
      secondary,
    ])
    expect(result?.kind).toBe('failure')
    expect(result?.explanation?.codeHostReason).toBe('merge-conflict')
  })
  test('stale pending and clean snapshots cannot claim a current CI or merge reason', () => {
    for (const data of [{ checksState: 'pending' }, { mergeState: 'clean' }]) {
      const stale = {
        ...event('pull_request.updated', data),
        observedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      }
      expect(
        classifyDeliveryPresentation(run('pr-auto-merge'), metadata, [stale])?.explanation?.codeHostReason
      ).toBeUndefined()
    }
  })
  test('all designated PRs merged finalizes; one unknown PR does not', () => {
    expect(
      classifyDeliveryPresentation(run(), metadata, [event('pull_request.merged')])?.explanation?.codeHostReason
    ).toBe('merged')
    const multiple = {
      ...metadata,
      tracked: [{ integration: 'github', repository: 'acme/other', kind: 'pull_request', number: 8, delivery: true }],
    }
    expect(
      classifyDeliveryPresentation(run(), multiple, [event('pull_request.merged')])?.explanation?.codeHostReason
    ).toBeUndefined()
  })
})

test('a newer explicit unknown check rollup cannot resurrect an older pending CI label', () => {
  const result = classifyDeliveryPresentation(run('pr-auto-merge'), metadata, [
    event('pull_request.updated', { mergeState: 'blocked' }),
    event('pull_request.ci_completed', { state: 'in_progress' }, 'a'.repeat(40), '2026-09-21T11:00:00Z'),
    event(
      'pull_request.snapshot',
      { checksState: 'unknown', mergeState: 'unknown' },
      'a'.repeat(40),
      '2026-09-21T12:00:00Z'
    ),
  ])
  expect(result?.kind).toBe('external')
  expect(result?.explanation?.codeHostReason).toBeUndefined()
})

test('awaiting automatic merge requires readiness of every designated PR, not only the winning primary', () => {
  const multiple = {
    ...metadata,
    tracked: [{ integration: 'github', repository: 'acme/other', kind: 'pull_request', number: 8, delivery: true }],
  }
  const primary = event('pull_request.updated', { mergeState: 'clean' })
  for (const data of [{}, { checksState: 'pending' }, { draft: true }]) {
    const secondary = event('pull_request.updated', {
      repository: 'acme/other',
      pullRequest: { number: 8, headSha: 'b'.repeat(40) },
      ...data,
    })
    const result = classifyDeliveryPresentation(run('pr-auto-merge'), multiple, [primary, secondary], {
      allowAutoMerge: true,
    })
    expect(result?.kind).toBe('external')
    expect(result?.explanation?.codeHostReason).toBeUndefined()
  }
  const secondary = event('pull_request.merged', {
    repository: 'acme/other',
    pullRequest: { number: 8, headSha: 'b'.repeat(40) },
  })
  expect(
    classifyDeliveryPresentation(run('pr-auto-merge'), multiple, [primary, secondary], { allowAutoMerge: true })
      ?.explanation?.codeHostReason
  ).toBe('awaiting-merge')
})
