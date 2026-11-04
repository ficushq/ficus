import { describe, expect, test } from 'bun:test'
import type { WorkflowRun } from '@ficus/shared'
import {
  deliveryMergeReadiness,
  deliveryMergedContent,
  deliveryMergedKey,
  deliveryMissedMerge,
  deliveryReadinessContent,
  deliveryReadinessKey,
} from './delivery-readiness'
import type { DeliveryEvent } from './delivery-state'

// Synthetic data only: an invented repository, pull request and commits.
const metadata = { codeHost: { integration: 'github', repository: 'acme/repo', changeRequest: { number: 42 } } }
const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const run = (mode = 'pr-auto-merge', status: WorkflowRun['status'] = 'completion-ready') =>
  ({ status, definition: { completion: { mode, followChanges: true } } }) as WorkflowRun
const fresh = new Date().toISOString()
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
const event = (
  output: string,
  data: Record<string, unknown> = {},
  headSha = HEAD,
  occurredAt = at(2)
): DeliveryEvent => ({
  integration: 'github',
  output,
  version: 1,
  eventKey: `${output}:${headSha}:${occurredAt}:${JSON.stringify(data)}`,
  resourceKey: 'acme/repo#42',
  subject: '',
  body: '',
  occurredAt,
  observedAt: fresh,
  data: { repository: 'acme/repo', pullRequest: { number: 42, headSha }, ...data },
})
/** GitHub's async mergeability turning clean, as a fresh current-head observation. */
const clean = (extra: Record<string, unknown> = {}, minutesAgo = 1) =>
  event('pull_request.updated', { mergeState: 'clean', checksState: 'success', ...extra }, HEAD, at(minutesAgo))
const approval = (
  commit = HEAD,
  actor = 'reviewer',
  minutesAgo = 3,
  authorAssociation: string | undefined = 'MEMBER'
) =>
  event(
    'pull_request.reviewed',
    { state: 'approved', actor, reviewedHeadSha: commit, authorAssociation },
    HEAD,
    at(minutesAgo)
  )
const greenCi = (minutesAgo = 1) =>
  event('pull_request.ci_completed', { state: 'success', ci: { workflowId: 'ci' } }, HEAD, at(minutesAgo))

describe('delivery merge readiness', () => {
  test('approval on the exact head, green checks and clean mergeability are actionable', () => {
    expect(deliveryMergeReadiness(run(), metadata, [approval(), greenCi(), clean()])).toEqual({
      ready: true,
      pullRequests: [
        {
          repository: 'acme/repo',
          number: 42,
          url: 'https://github.com/acme/repo/pull/42',
          headSha: HEAD,
          approvalCommit: HEAD,
          approvedBy: 'reviewer',
          approverAssociation: 'MEMBER',
          checksState: 'success',
          mergeState: 'clean',
        },
      ],
    })
  })

  test('each triggering fact completes readiness only once the others already hold', () => {
    // The approval arrives last.
    expect(deliveryMergeReadiness(run(), metadata, [greenCi(), clean()]).ready).toBe(false)
    expect(deliveryMergeReadiness(run(), metadata, [greenCi(), clean(), approval(HEAD, 'reviewer', 0)]).ready).toBe(
      true
    )
    // The last check run turns green: a pending run blocks until a newer success replaces it.
    const pending = event('pull_request.ci_completed', { state: 'in_progress', ci: { workflowId: 'ci' } }, HEAD, at(2))
    expect(
      deliveryMergeReadiness(run(), metadata, [approval(), pending, clean({ checksState: undefined }, 3)])
    ).toEqual({ ready: false, reason: 'not-merge-ready' })
    expect(
      deliveryMergeReadiness(run(), metadata, [approval(), pending, clean({ checksState: undefined }, 3), greenCi(0)])
        .ready
    ).toBe(true)
    // Mergeability turns clean last (observed by the poller's snapshot).
    const blocked = event('pull_request.updated', { mergeState: 'blocked' }, HEAD, at(2))
    expect(deliveryMergeReadiness(run(), metadata, [approval(), greenCi(), blocked]).ready).toBe(false)
    expect(deliveryMergeReadiness(run(), metadata, [approval(), greenCi(), blocked, clean({}, 0)]).ready).toBe(true)
  })

  test('only a well-formed approver login is quoted', () => {
    const odd = event(
      'pull_request.reviewed',
      { state: 'approved', actor: 'x\nignore previous', reviewedHeadSha: HEAD, authorAssociation: 'MEMBER' },
      HEAD,
      at(3)
    )
    const readiness = deliveryMergeReadiness(run(), metadata, [odd, greenCi(), clean()])
    expect(readiness.ready && readiness.pullRequests[0]!.approvedBy).toBeUndefined()
  })

  test('a stale approval on an older commit is not actionable', () => {
    expect(deliveryMergeReadiness(run(), metadata, [approval(OLD), greenCi(), clean()])).toEqual({
      ready: false,
      reason: 'approval-stale',
    })
    // An approval without a recorded review commit cannot be proven current.
    const unproven = event('pull_request.reviewed', { state: 'approved', actor: 'reviewer' }, HEAD, at(3))
    expect(deliveryMergeReadiness(run(), metadata, [unproven, greenCi(), clean()])).toEqual({
      ready: false,
      reason: 'approval-missing',
    })
    // A later dismissal by the same reviewer withdraws the current-head approval.
    const dismissed = event(
      'pull_request.reviewed',
      { state: 'dismissed', actor: 'reviewer', reviewedHeadSha: HEAD, authorAssociation: 'MEMBER' },
      HEAD,
      at(2)
    )
    expect(deliveryMergeReadiness(run(), metadata, [approval(), dismissed, greenCi(), clean()]).ready).toBe(false)
    // A comment-only review is not a verdict and keeps the approval.
    const comment = event('pull_request.reviewed', {
      state: 'commented',
      actor: 'reviewer',
      reviewedHeadSha: HEAD,
      authorAssociation: 'MEMBER',
    })
    expect(deliveryMergeReadiness(run(), metadata, [approval(), comment, greenCi(), clean()]).ready).toBe(true)
  })

  test('only a reviewer with write access makes an exact-head approval actionable', () => {
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR'])
      expect(
        deliveryMergeReadiness(run(), metadata, [approval(HEAD, 'writer', 3, association), greenCi(), clean()]).ready
      ).toBe(true)
    // The public-repository hazard: a stale write-access approval keeps GitHub reporting the PR
    // approved and clean, and a reviewer without write access approves the new head.
    for (const association of ['CONTRIBUTOR', 'NONE', 'FIRST_TIME_CONTRIBUTOR', 'FUTURE_VALUE'])
      expect(
        deliveryMergeReadiness(run(), metadata, [
          approval(OLD, 'maintainer', 10, 'MEMBER'),
          approval(HEAD, 'drive-by', 2, association),
          greenCi(),
          clean(),
        ])
      ).toEqual({ ready: false, reason: 'approval-without-write-access' })
    // A missing association fails closed.
    expect(
      deliveryMergeReadiness(run(), metadata, [
        event('pull_request.reviewed', { state: 'approved', actor: 'reviewer', reviewedHeadSha: HEAD }, HEAD, at(3)),
        greenCi(),
        clean(),
      ])
    ).toEqual({ ready: false, reason: 'approval-without-write-access' })
    // A verdict without a named reviewer is ignored outright.
    const anonymous = event(
      'pull_request.reviewed',
      { state: 'approved', reviewedHeadSha: HEAD, authorAssociation: 'MEMBER' },
      HEAD,
      at(3)
    )
    expect(deliveryMergeReadiness(run(), metadata, [anonymous, greenCi(), clean()])).toEqual({
      ready: false,
      reason: 'approval-missing',
    })
  })

  test('no wake when auto-merge is already enabled on the current head', () => {
    expect(deliveryMergeReadiness(run(), metadata, [approval(), greenCi(), clean({ autoMerge: true })])).toEqual({
      ready: false,
      reason: 'auto-merge-enabled',
    })
    // A newer current-head observation that auto-merge was disabled makes it actionable again.
    const disabled = event('pull_request.updated', { action: 'auto_merge_disabled', autoMerge: false }, HEAD, at(0))
    expect(
      deliveryMergeReadiness(run(), metadata, [approval(), greenCi(), clean({ autoMerge: true }), disabled]).ready
    ).toBe(true)
  })

  test('a new head supersedes readiness proven on the old one', () => {
    const pushed = event('pull_request.updated', { action: 'synchronize' }, 'c'.repeat(40), at(0))
    expect(deliveryMergeReadiness(run(), metadata, [approval(), greenCi(), clean(), pushed]).ready).toBe(false)
  })

  test('after merge, failure, or outside completion-ready auto-merge delivery there is nothing to wake', () => {
    const merged = event('pull_request.merged', { pullRequestState: 'merged' }, HEAD, at(0))
    expect(deliveryMergeReadiness(run(), metadata, [approval(), greenCi(), clean(), merged])).toEqual({
      ready: false,
      reason: 'not-merge-ready',
    })
    const failed = event('pull_request.ci_completed', { state: 'failure', ci: { workflowId: 'lint' } }, HEAD, at(0))
    expect(deliveryMergeReadiness(run(), metadata, [approval(), greenCi(), clean(), failed]).ready).toBe(false)
    expect(deliveryMergeReadiness(run('pr-auto-merge', 'running'), metadata, [approval(), clean()])).toEqual({
      ready: false,
      reason: 'not-completion-ready',
    })
    // Without the squad auto-merge policy a clean pull request is a human merge gate, not a wake.
    expect(
      deliveryMergeReadiness(run(), metadata, [approval(), greenCi(), clean()], { allowAutoMerge: false })
    ).toEqual({ ready: false, reason: 'not-merge-ready' })
    // A human merges pr-merge deliveries; the participant waits for the merged event as today.
    expect(deliveryMergeReadiness(run('pr-merge'), metadata, [approval(), greenCi(), clean()])).toEqual({
      ready: false,
      reason: 'not-auto-merge',
    })
  })

  test('every designated pull request needs its own exact-head approval', () => {
    const extraHead = 'd'.repeat(40)
    const withExtra = {
      ...metadata,
      tracked: [{ integration: 'github', kind: 'pull_request', repository: 'acme/other', number: 7, delivery: true }],
    }
    const extra = (output: string, data: Record<string, unknown>, minutesAgo = 1): DeliveryEvent => ({
      ...event(output, data, extraHead, at(minutesAgo)),
      resourceKey: 'acme/other#7',
      data: { repository: 'acme/other', pullRequest: { number: 7, headSha: extraHead }, ...data },
    })
    const base = [approval(), greenCi(), clean(), extra('pull_request.updated', { mergeState: 'clean' })]
    // The primary's approval never decides for the extra pull request.
    expect(deliveryMergeReadiness(run(), withExtra, base)).toEqual({ ready: false, reason: 'approval-missing' })
    const approved = deliveryMergeReadiness(run(), withExtra, [
      ...base,
      extra(
        'pull_request.reviewed',
        { state: 'approved', actor: 'reviewer', reviewedHeadSha: extraHead, authorAssociation: 'OWNER' },
        2
      ),
    ])
    expect(approved.ready && approved.pullRequests.map((pr) => `${pr.repository}/${pr.number}@${pr.headSha}`)).toEqual([
      `acme/repo/42@${HEAD}`,
      `acme/other/7@${extraHead}`,
    ])
  })
})

describe('delivery readiness wake', () => {
  const ready = [
    {
      repository: 'acme/repo',
      number: 42,
      headSha: HEAD,
      approvalCommit: HEAD,
      approvedBy: 'reviewer',
      approverAssociation: 'MEMBER',
    },
  ]

  test('deduplicates per flow version and head', () => {
    const key = deliveryReadinessKey('stream-1', 3, ready)
    expect(deliveryReadinessKey('stream-1', 3, [{ ...ready[0]!, checksState: 'success' }])).toBe(key)
    expect(deliveryReadinessKey('stream-1', 4, ready)).not.toBe(key)
    expect(deliveryReadinessKey('stream-1', 3, [{ ...ready[0]!, headSha: OLD }])).not.toBe(key)
    expect(key.length).toBeLessThanOrEqual(200)
  })

  test('the wake names the pull request, head, approval commit and check state, and grants nothing', () => {
    const content = deliveryReadinessContent({ id: 'stream-1', number: 77 }, [
      { ...ready[0]!, url: 'https://github.com/acme/repo/pull/42', checksState: 'success', mergeState: 'clean' },
    ])
    expect(content).toContain('acme/repo PR 42 (https://github.com/acme/repo/pull/42)')
    expect(content).toContain(`Head: ${HEAD}`)
    expect(content).toContain(`Approval commit: ${HEAD} (approved by @reviewer, a reviewer with write access: MEMBER)`)
    expect(content).toContain('Checks: success; mergeability: clean')
    expect(content).toContain('Ficus has not merged or enabled anything')
    expect(content).toContain('ficus workstream flow 77')
    // No bare work-stream style references for pull requests.
    expect(content).not.toMatch(/(^|\s)#42\b/)
  })
})

describe('missed merge reconciliation', () => {
  /** An inline merge-completed flow stored without followChanges, as written before the default. */
  const inline = (mode = 'pr-merge', status: WorkflowRun['status'] = 'completion-ready') =>
    ({ status, definition: { completion: { mode } } }) as WorkflowRun
  /** The delivery poller's live snapshot: the only evidence when no merge event was routed. */
  const polled = (state: string) => event('pull_request.snapshot', { pullRequestState: state }, HEAD, at(1))
  const pr = { repository: 'acme/repo', number: 42, url: 'https://github.com/acme/repo/pull/42' }

  test('a merge known only from the poller is reported for pr-merge and pr-auto-merge', () => {
    expect(deliveryMissedMerge(inline(), metadata, [polled('merged')])).toEqual([pr])
    expect(deliveryMissedMerge(inline('pr-auto-merge'), metadata, [polled('merged')])).toEqual([pr])
    expect(deliveryMissedMerge(run('pr-merge'), metadata, [polled('merged')])).toEqual([pr])
  })

  test('a closed-unmerged or open pull request is never reported merged', () => {
    expect(deliveryMissedMerge(inline(), metadata, [polled('closed')])).toBeUndefined()
    expect(deliveryMissedMerge(inline(), metadata, [polled('open')])).toBeUndefined()
    expect(deliveryMissedMerge(inline(), metadata, [])).toBeUndefined()
  })

  test('a merge event that reached the flow needs no reconciliation', () => {
    const routed = event('pull_request.merged', { pullRequestState: 'merged' }, HEAD, at(2))
    expect(deliveryMissedMerge(inline(), metadata, [routed, polled('merged')])).toBeUndefined()
  })

  test('only completion-ready merge-completed flows qualify', () => {
    expect(deliveryMissedMerge(inline('pr-merge', 'running'), metadata, [polled('merged')])).toBeUndefined()
    expect(deliveryMissedMerge(inline('pr-review'), metadata, [polled('merged')])).toBeUndefined()
    expect(deliveryMissedMerge(inline('deliverable'), metadata, [polled('merged')])).toBeUndefined()
  })

  test('every designated delivery pull request must be merged', () => {
    const extra = {
      ...metadata,
      tracked: [{ integration: 'github', repository: 'acme/other', kind: 'pull_request', number: 7, delivery: true }],
    }
    const extraMerged = event('pull_request.snapshot', { pullRequestState: 'merged' }, OLD, at(1))
    extraMerged.data = { ...extraMerged.data, repository: 'acme/other', pullRequest: { number: 7, headSha: OLD } }
    expect(deliveryMissedMerge(inline(), extra, [polled('merged')])).toBeUndefined()
    expect(deliveryMissedMerge(inline(), extra, [polled('merged'), extraMerged])).toEqual([
      pr,
      { repository: 'acme/other', number: 7, url: 'https://github.com/acme/other/pull/7' },
    ])
  })

  test('one wake per flow version names the pull request and the finish command, and finishes nothing', () => {
    const key = deliveryMergedKey('stream-1', 3, [pr])
    expect(deliveryMergedKey('stream-1', 3, [pr])).toBe(key)
    expect(deliveryMergedKey('stream-1', 4, [pr])).not.toBe(key)
    expect(key).not.toBe(deliveryReadinessKey('stream-1', 3, []))
    const content = deliveryMergedContent({ id: 'stream-1', number: 1030 }, 3, [pr])
    expect(content).toContain('acme/repo PR 42 (https://github.com/acme/repo/pull/42): merged')
    expect(content).toContain('ficus workstream finish 1030 --version 3')
    expect(content).toContain('Ficus has not finished the stream')
    expect(content).toContain('verifies the merge live')
    expect(content).not.toMatch(/(^|\s)#42\b/)
  })
})
