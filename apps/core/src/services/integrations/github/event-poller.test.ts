import { describe, expect, test } from 'bun:test'
import { createEventPollingBudget } from '../event-polling-budget'
import { GitHubPrEventPoller, type GitHubPollingCursor, type GitHubPrPollingConfig } from './event-poller'
import { GitHubPrWatchPolicy } from './watch-policy'
import type { RuntimeConnection, VerifiedIngressEvent } from '../types'

const repository = {
  id: 9,
  full_name: 'acme/widgets',
  html_url: 'https://github.com/acme/widgets',
  custom_properties: {},
}
const pullRequest = {
  id: 42,
  number: 7,
  state: 'open',
  merged: false,
  head: { sha: 'abc' },
  base: { repo: repository },
  user: { login: 'author' },
}
const issue = {
  id: 70,
  number: 7,
  pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/7' },
  repository_url: 'https://api.github.com/repos/acme/widgets',
}
const comment = {
  id: 101,
  body: 'please change this',
  user: { login: 'reviewer', type: 'User' },
  html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-101',
  created_at: '2026-08-26T00:00:00Z',
  updated_at: '2026-08-26T00:00:00Z',
}

function connection(): RuntimeConnection<{ owner: string; repo: string; number: number }> {
  return {
    id: 'github:acme/widgets#7',
    squadId: 'squad-1',
    providerKey: 'github',
    adapterVersion: 1,
    configuration: { owner: 'acme', repo: 'widgets', number: 7 },
  }
}

function response(body: unknown, etag: string, date?: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { etag, 'content-type': 'application/json', ...(date ? { date } : {}) },
  })
}

describe('GitHubPrEventPoller', () => {
  test('establishes a baseline without replaying existing GitHub activity', async () => {
    const bodies = [pullRequest, issue, [], [], []]
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async () => response(bodies.shift(), `"etag-${bodies.length}"`),
    })

    const result = await poller.poll(connection(), null)

    expect(result.events).toEqual([])
    expect(result.nextCursor.pr).toMatchObject({ headSha: 'abc', state: 'open', merged: false })
    expect(result.nextCursor.etags).toBeDefined()
  })

  test('advances and preserves an issue-comment watermark for empty cursors', async () => {
    const boundary = 'Wed, 26 Aug 2026 05:00:00 GMT'
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async (input) => {
        const url = new URL(input)
        if (url.pathname.endsWith('/pulls/7')) {
          return new Response(JSON.stringify(pullRequest), { headers: { date: boundary } })
        }
        if (url.pathname.endsWith('/issues/7')) return response(issue, '"issue"')
        return response([], '"empty"')
      },
    })

    const baseline = await poller.poll(connection(), null)
    expect((baseline.nextCursor as GitHubPollingCursor).lastIssueCommentUpdatedAt).toBe('2026-08-26T05:00:00.000Z')

    const invalidClockPoller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async (input) => {
        const url = new URL(input)
        if (url.pathname.endsWith('/pulls/7')) {
          return new Response(JSON.stringify(pullRequest), { headers: { date: 'invalid' } })
        }
        if (url.pathname.endsWith('/issues/7')) return response(issue, '"issue-2"')
        return response([], '"empty-2"')
      },
    })
    const unchanged = await invalidClockPoller.poll(connection(), baseline.nextCursor as GitHubPollingCursor)
    expect((unchanged.nextCursor as GitHubPollingCursor).lastIssueCommentUpdatedAt).toBe('2026-08-26T05:00:00.000Z')
  })

  test('uses the verified-delivery cutoff after suppression and emits later changes once', async () => {
    const deliveredAt = new Date('2026-08-02T00:00:00Z')
    let now = new Date('2026-08-03T00:00:00Z')
    const policy = new GitHubPrWatchPolicy({
      resolveConnection: async (squadId, connectionId) => (connectionId ? undefined : { id: `account-${squadId}` }),
      listWorkStreams: async () => [
        { squadId: 's1', status: 'active', metadata: { prUrl: 'https://github.com/acme/widgets/pull/7' } },
      ],
      lastRealDeliveries: async () => new Map([['acme/widgets', deliveredAt]]),
      now: () => now,
      realDeliveryLookbackDays: 7,
    })
    expect(await policy.listWatches()).toEqual([])

    now = new Date('2026-08-10T00:00:01Z')
    const [resumedWatch] = await policy.listWatches()
    expect(resumedWatch).toBeDefined()
    const resumedConnection = resumedWatch.connection as RuntimeConnection<{
      owner: string
      repo: string
      number: number
      lastVerifiedWebhookDeliveryAt?: string
    }>
    const webhookDeliveredComment = {
      ...comment,
      id: 102,
      body: 'delivered by webhook while polling was suppressed',
      created_at: '2026-08-02T00:00:00Z',
      updated_at: '2026-08-02T00:00:00Z',
    }
    const outageComment = {
      ...comment,
      id: 104,
      body: 'created after the last verified delivery during the outage',
      created_at: '2026-08-03T00:00:00Z',
      updated_at: '2026-08-03T00:00:00Z',
    }
    const nextComment = {
      ...comment,
      id: 103,
      body: 'new after polling resumed',
      updated_at: '2026-08-10T00:01:00Z',
    }
    let phase = 0
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async (input) => {
        const url = new URL(input)
        if (url.pathname.endsWith('/pulls/7')) {
          return new Response(JSON.stringify(pullRequest), { headers: { date: 'invalid-provider-date' } })
        }
        if (url.pathname.endsWith('/issues/7')) return response(issue, `"issue-${phase}"`)
        if (url.pathname.endsWith('/issues/7/comments')) {
          return response(
            phase === 0 ? [comment, webhookDeliveredComment, outageComment] : [nextComment],
            `"comments-${phase}"`
          )
        }
        return response([], `"empty-${phase}"`)
      },
    })
    const staleCursor: GitHubPollingCursor = {
      etags: {},
      pr: { headSha: 'abc', state: 'open', merged: false },
      issue,
      pullRequest,
      issueComments: { '101': comment },
      reviews: {},
      reviewComments: {},
      lastIssueCommentUpdatedAt: '2026-08-01T00:00:00Z',
      lastSuccessfulPollAt: '2026-08-01T00:00:00Z',
    }

    const resumed = await poller.poll(resumedConnection, staleCursor)
    expect(resumed.events).toHaveLength(1)
    expect(resumed.events[0].payload).toMatchObject({ action: 'created', comment: { id: 104 } })
    expect(Object.keys((resumed.nextCursor as GitHubPollingCursor).issueComments)).toEqual(
      expect.arrayContaining(['102', '104'])
    )
    expect((resumed.nextCursor as GitHubPollingCursor).lastSuccessfulPollAt).toBe('2026-08-01T00:00:00.000Z')
    expect((resumed.nextCursor as GitHubPollingCursor).lastConsumedWebhookDeliveryAt).toBe('2026-08-02T00:00:00.000Z')

    phase = 1
    const changed = await poller.poll(resumedConnection, resumed.nextCursor as GitHubPollingCursor)
    expect(changed.events).toHaveLength(1)
    expect(changed.events[0].payload).toMatchObject({ action: 'created', comment: { id: 103 } })

    phase = 2
    const stable = await poller.poll(resumedConnection, changed.nextCursor as GitHubPollingCursor)
    expect(stable.events).toEqual([])
  })

  test('recovers only action-specific post-delivery PR, comment, review, and review-comment activity', async () => {
    const cutoff = '2026-08-02T00:00:00Z'
    const closedPr = {
      ...pullRequest,
      state: 'closed',
      closed_at: '2026-08-03T00:00:00Z',
      updated_at: '2026-08-04T00:00:00Z',
    }
    const beforeComment = {
      ...comment,
      id: 201,
      created_at: cutoff,
      updated_at: cutoff,
    }
    const afterComment = {
      ...comment,
      id: 202,
      created_at: '2026-08-03T00:00:00Z',
      updated_at: '2026-08-03T00:00:00Z',
    }
    const oldEditedComment = {
      ...comment,
      id: 203,
      body: 'old issue comment',
      created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-01T00:00:00Z',
    }
    const editedComment = {
      ...oldEditedComment,
      body: 'edited during outage',
      updated_at: '2026-08-03T00:00:00Z',
    }
    const unseenEditedComment = {
      ...editedComment,
      id: 204,
      created_at: cutoff,
      body: 'created at cutoff and edited after it',
    }
    const beforeReview = { id: 301, state: 'APPROVED', body: '', user: { login: 'r1' }, submitted_at: cutoff }
    const afterReview = {
      id: 302,
      state: 'APPROVED',
      body: '',
      user: { login: 'r2' },
      submitted_at: '2026-08-03T00:00:00Z',
    }
    const beforeReviewComment = { ...beforeComment, id: 401 }
    const afterReviewComment = { ...afterComment, id: 402 }
    const oldEditedReviewComment = { ...oldEditedComment, id: 403 }
    const editedReviewComment = { ...editedComment, id: 403 }
    const unseenEditedReviewComment = { ...unseenEditedComment, id: 404 }
    const bodies = [
      closedPr,
      issue,
      [beforeComment, afterComment, editedComment, unseenEditedComment],
      [beforeReview, afterReview],
      [beforeReviewComment, afterReviewComment, editedReviewComment, unseenEditedReviewComment],
    ]
    const pollingConnection: RuntimeConnection<GitHubPrPollingConfig> = connection()
    pollingConnection.configuration.lastVerifiedWebhookDeliveryAt = cutoff
    const cursor: GitHubPollingCursor = {
      etags: {},
      pr: { headSha: 'abc', state: 'open', merged: false },
      issue,
      pullRequest,
      issueComments: { '203': oldEditedComment },
      reviews: {},
      reviewComments: { '403': oldEditedReviewComment },
      lastSuccessfulPollAt: '2026-08-01T00:00:00Z',
    }
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async () => response(bodies.shift(), '"recovery"'),
    })

    const result = await poller.poll(pollingConnection, cursor)

    expect(result.events.map((event) => event.type)).toEqual([
      'pull_request',
      'issue_comment',
      'issue_comment',
      'issue_comment',
      'pull_request_review',
      'pull_request_review_comment',
      'pull_request_review_comment',
      'pull_request_review_comment',
    ])
    expect(result.events.map((event) => event.logicalEventKey).every(Boolean)).toBe(true)
    expect(result.events[1].payload).toMatchObject({ comment: { id: 202 } })
    expect(result.events[2].payload).toMatchObject({ action: 'edited', comment: { id: 203 } })
    expect(result.events[3].payload).toMatchObject({ action: 'edited', comment: { id: 204 } })
    expect(result.events[4].payload).toMatchObject({ review: { id: 302 } })
    expect(result.events[5].payload).toMatchObject({ comment: { id: 402 } })
    expect(result.events[6].payload).toMatchObject({ action: 'edited', comment: { id: 403 } })
    expect(result.events[7].payload).toMatchObject({ action: 'edited', comment: { id: 404 } })

    const secondBodies = [
      closedPr,
      issue,
      [beforeComment, afterComment, editedComment, unseenEditedComment],
      [beforeReview, afterReview],
      [beforeReviewComment, afterReviewComment, editedReviewComment, unseenEditedReviewComment],
    ]
    const secondSquad = { ...pollingConnection, id: 'github:squad-2', squadId: 'squad-2' }
    const duplicate = await new GitHubPrEventPoller({
      resolveCredential: async () => 'other-token',
      fetch: async () => response(secondBodies.shift(), '"recovery-second-squad"'),
    }).poll(secondSquad, cursor)
    expect(duplicate.events.map((event) => event.logicalEventKey)).toEqual(
      result.events.map((event) => event.logicalEventKey)
    )
  })

  test('does not guess recovery times for synchronize, reopen, or review edits', async () => {
    const cutoff = '2026-08-02T00:00:00Z'
    const pollingConnection: RuntimeConnection<GitHubPrPollingConfig> = connection()
    pollingConnection.configuration.lastVerifiedWebhookDeliveryAt = cutoff
    const previousReview = { id: 301, state: 'approved', body: 'old', user: { login: 'r1' } }
    const previousComment = { ...comment, id: 501, body: 'old', updated_at: '2026-08-01T00:00:00Z' }
    const missingTimestampEdit = { ...previousComment, body: 'new', updated_at: undefined }
    const invalidTimestampComment = { ...comment, id: 502, created_at: 'not-a-time', updated_at: 'not-a-time' }
    const missingCreatedAt = { ...comment, id: 503, created_at: undefined, updated_at: '2026-08-03T00:00:00Z' }
    const invalidCreatedAt = { ...comment, id: 504, created_at: 'not-a-time', updated_at: '2026-08-03T00:00:00Z' }
    const missingReviewCommentCreatedAt = { ...missingCreatedAt, id: 603 }
    const invalidReviewCommentCreatedAt = { ...invalidCreatedAt, id: 604 }
    const cursor: GitHubPollingCursor = {
      etags: {},
      pr: { headSha: 'abc', state: 'closed', merged: false },
      issue,
      pullRequest: { ...pullRequest, state: 'closed' },
      issueComments: { '501': previousComment },
      reviews: { '301': previousReview },
      reviewComments: {},
      lastSuccessfulPollAt: '2026-08-01T00:00:00Z',
    }
    const currentPr = { ...pullRequest, head: { sha: 'def' }, updated_at: '2026-08-03T00:00:00Z' }
    const editedReview = {
      ...previousReview,
      body: 'new',
      submitted_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-03T00:00:00Z',
    }
    const dismissedReview = {
      id: 302,
      state: 'dismissed',
      body: '',
      user: { login: 'r2' },
      submitted_at: '2026-08-03T00:00:00Z',
      updated_at: '2026-08-03T00:00:00Z',
    }
    const bodies = [
      currentPr,
      issue,
      [missingTimestampEdit, invalidTimestampComment, missingCreatedAt, invalidCreatedAt],
      [editedReview, dismissedReview],
      [missingReviewCommentCreatedAt, invalidReviewCommentCreatedAt],
    ]
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async () => response(bodies.shift(), '"unsupported-recovery"'),
    })

    const result = await poller.poll(pollingConnection, cursor)

    expect(result.events).toEqual([])
    expect((result.nextCursor as GitHubPollingCursor).pr).toMatchObject({ state: 'open', headSha: 'def' })
    expect((result.nextCursor as GitHubPollingCursor).reviews).toHaveProperty('302')
    expect((result.nextCursor as GitHubPollingCursor).issueComments).toHaveProperty('503')
    expect((result.nextCursor as GitHubPollingCursor).issueComments).toHaveProperty('504')
    expect((result.nextCursor as GitHubPollingCursor).reviewComments).toHaveProperty('603')
    expect((result.nextCursor as GitHubPollingCursor).reviewComments).toHaveProperty('604')

    const synchronizeCursor = { ...cursor, pr: { headSha: 'abc', state: 'open', merged: false } }
    const synchronizeBodies = [currentPr, issue, [], [previousReview], []]
    const synchronize = await new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async () => response(synchronizeBodies.shift(), '"unsupported-synchronize"'),
    }).poll(pollingConnection, synchronizeCursor)
    expect(synchronize.events).toEqual([])
  })

  test('unconditionally restarts and durably resumes a capped pre-delivery scan', async () => {
    const staleCursor: GitHubPollingCursor = {
      etags: { issueComments: '"legacy-comments"' },
      pr: { headSha: 'abc', state: 'open', merged: false },
      issue,
      pullRequest,
      issueComments: { '101': comment },
      reviews: {},
      reviewComments: {},
      lastIssueCommentUpdatedAt: '2026-08-01T00:00:00Z',
      lastSuccessfulPollAt: '2026-08-01T00:00:00Z',
    }
    let phase: 'pending' | 'baseline' | 'baselineResume' | 'change' = 'pending'
    let prRequests = 0
    const restartValidators: Array<string | null> = []
    const resumedBaselinePages: number[] = []
    const webhookComment = {
      ...comment,
      id: 102,
      body: 'delivered by real webhook',
      created_at: '2026-08-02T00:00:00Z',
      updated_at: '2026-08-02T00:00:00Z',
    }
    const outageEdit = {
      ...webhookComment,
      id: 103,
      body: 'edited after delivery while polling was suppressed',
      updated_at: '2026-08-03T00:00:00Z',
    }
    const nextComment = { ...comment, id: 104, body: 'after resumed baseline' }
    const pendingPage = [
      ...Array.from({ length: 99 }, (_, index) => ({ ...webhookComment, id: 1_000 + index })),
      webhookComment,
    ]
    const recoveryPage = [
      ...Array.from({ length: 98 }, (_, index) => ({ ...webhookComment, id: 1_000 + index })),
      webhookComment,
      outageEdit,
    ]
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async (input, init) => {
        const url = new URL(input)
        const ifNoneMatch = new Headers(init?.headers).get('if-none-match')
        if (phase === 'baseline') restartValidators.push(ifNoneMatch)
        if (url.pathname.endsWith('/pulls/7')) {
          prRequests++
          return response(pullRequest, '"covered-pr"')
        }
        if (url.pathname.endsWith('/issues/7')) return response(issue, '"covered-issue"')
        if (url.pathname.endsWith('/issues/7/comments')) {
          if (phase === 'baselineResume') resumedBaselinePages.push(Number(url.searchParams.get('page')))
          if (phase === 'pending' || phase === 'baseline') {
            if (phase === 'baseline' && ifNoneMatch) {
              return new Response(null, { status: 304, headers: { etag: ifNoneMatch } })
            }
            return new Response(JSON.stringify(phase === 'pending' ? pendingPage : recoveryPage), {
              headers: {
                etag: phase === 'pending' ? '"pre-delivery-comments"' : '"covered-comments"',
                link: '<https://api.github.test/comments?page=2>; rel="next"',
              },
            })
          }
          if (phase === 'baselineResume') return response([], '"covered-comments-page-2"')
          return response([webhookComment, nextComment], '"changed-comments"')
        }
        return response([], `"empty-${phase}"`)
      },
    })

    const partial = await poller.poll(connection(), staleCursor, createEventPollingBudget(3).signal)
    const partialCursor = partial.nextCursor as GitHubPollingCursor
    expect(partialCursor.pendingScan).toMatchObject({ baseline: false })
    expect(partialCursor.etags.issueComments).toBe('"legacy-comments"')
    expect(partialCursor.etags['issueComments:1']).toBe('"pre-delivery-comments"')
    partialCursor.collectionPages = {
      ...(partialCursor.collectionPages ?? {}),
      issueComments: { count: 9, lastSize: 20 },
    }
    expect(prRequests).toBe(1)

    phase = 'baseline'
    const resumedConnection: RuntimeConnection<GitHubPrPollingConfig> = connection()
    resumedConnection.configuration.lastVerifiedWebhookDeliveryAt = '2026-08-02T00:00:00Z'
    const restarted = await poller.poll(resumedConnection, partialCursor, createEventPollingBudget(3).signal)
    const restartedCursor = restarted.nextCursor as GitHubPollingCursor
    expect(prRequests).toBe(2)
    expect(restartValidators).toEqual([null, null, null])
    expect(restartedCursor.pendingScan).toMatchObject({
      baseline: true,
      baselineDeliveryAt: '2026-08-02T00:00:00.000Z',
      collections: {
        issueComments: { objects: { '103': { id: 103 } }, actions: { '103': 'edited' } },
      },
    })
    expect(restartedCursor.pendingScan?.collections.issueComments).not.toHaveProperty('known')

    phase = 'baselineResume'
    const resumed = await poller.poll(resumedConnection, restartedCursor)
    expect(prRequests).toBe(2)
    expect(resumedBaselinePages).toEqual([2])
    expect(resumed.events).toHaveLength(1)
    expect(resumed.events[0].payload).toMatchObject({ action: 'edited', comment: { id: 103 } })
    expect((resumed.nextCursor as GitHubPollingCursor).lastConsumedWebhookDeliveryAt).toBe('2026-08-02T00:00:00.000Z')

    phase = 'change'
    const changed = await poller.poll(resumedConnection, resumed.nextCursor as GitHubPollingCursor)
    expect(changed.events).toHaveLength(1)
    expect(changed.events[0].payload).toMatchObject({ action: 'created', comment: { id: 104 } })
    const stable = await poller.poll(resumedConnection, changed.nextCursor as GitHubPollingCursor)
    expect(stable.events).toEqual([])
  })

  test('does not baseline arbitrary downtime without a durable successful-poll comparison', async () => {
    const baseline: GitHubPollingCursor = {
      etags: {},
      pr: { headSha: 'abc', state: 'open', merged: false },
      issue,
      pullRequest,
      issueComments: {},
      reviews: {},
      reviewComments: {},
    }
    const bodies = [pullRequest, issue, [comment], [], []]
    const pollingConnection: RuntimeConnection<GitHubPrPollingConfig> = connection()
    pollingConnection.configuration = {
      ...pollingConnection.configuration,
      lastVerifiedWebhookDeliveryAt: '2026-08-02T00:00:00Z',
    }
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async () => response(bodies.shift(), '"current"'),
    })

    const result = await poller.poll(pollingConnection, baseline)

    expect(result.events).toHaveLength(1)
    expect(result.events[0].payload).toMatchObject({ action: 'created', comment: { id: 101 } })
    expect((result.nextCursor as GitHubPollingCursor).lastSuccessfulPollAt).toBeUndefined()
    expect((result.nextCursor as GitHubPollingCursor).lastConsumedWebhookDeliveryAt).toBeUndefined()
  })

  test('follows every collection page without replaying the >100-item baseline', async () => {
    const oldComments = Array.from({ length: 150 }, (_, index) => ({
      ...comment,
      id: index + 1,
      updated_at: `2026-08-25T00:${String(index % 60).padStart(2, '0')}:00Z`,
    }))
    const oldReviews = Array.from({ length: 150 }, (_, index) => ({ id: index + 1, state: 'APPROVED', body: '' }))
    const oldReviewComments = Array.from({ length: 150 }, (_, index) => ({ ...comment, id: index + 1 }))
    let round = 0
    const requests: Array<{ url: string; ifNoneMatch: string | null }> = []
    const page = (items: unknown[], url: URL, ifNoneMatch: string | null) => {
      const pageNumber = Number(url.searchParams.get('page') ?? '1')
      const etag = `"${round}-${url.pathname}-${pageNumber}"`
      if (ifNoneMatch === etag) return new Response(null, { status: 304 })
      const slice = items.slice((pageNumber - 1) * 100, pageNumber * 100)
      const hasNext = pageNumber * 100 < items.length
      return new Response(JSON.stringify(slice), {
        status: 200,
        headers: {
          etag,
          ...(hasNext
            ? { link: `<${url.origin}${url.pathname}?page=${pageNumber + 1}&per_page=100>; rel="next"` }
            : {}),
        },
      })
    }
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async (input, init) => {
        const url = new URL(input)
        const ifNoneMatch = new Headers(init?.headers).get('if-none-match')
        requests.push({ url: `${url.pathname}?${url.searchParams}`, ifNoneMatch })
        if (url.pathname.endsWith('/pulls/7')) return response(pullRequest, `"pr-${round}"`)
        if (url.pathname.endsWith('/issues/7')) return response(issue, `"issue-${round}"`)
        const additions = round === 0 ? 0 : 101
        if (url.pathname.endsWith('/issues/7/comments')) {
          const items = additions
            ? [...oldComments, ...Array.from({ length: additions }, (_, index) => ({ ...comment, id: 1000 + index }))]
            : oldComments
          return page(items, url, ifNoneMatch)
        }
        if (url.pathname.endsWith('/pulls/7/reviews')) {
          const items = additions
            ? [
                ...oldReviews,
                ...Array.from({ length: additions }, (_, index) => ({ id: 2000 + index, state: 'APPROVED' })),
              ]
            : oldReviews
          return page(items, url, ifNoneMatch)
        }
        const items = additions
          ? [
              ...oldReviewComments,
              ...Array.from({ length: additions }, (_, index) => ({ ...comment, id: 3000 + index })),
            ]
          : oldReviewComments
        return page(items, url, ifNoneMatch)
      },
    })

    const baselineBudget = createEventPollingBudget(10)
    const baseline = await poller.poll(connection(), null, baselineBudget.signal)
    round = 1
    const changedBudget = createEventPollingBudget(14)
    const changed = await poller.poll(connection(), baseline.nextCursor, changedBudget.signal)

    expect(Object.keys((baseline.nextCursor as GitHubPollingCursor).issueComments)).toHaveLength(150)
    expect(changed.events.filter((event) => event.type === 'issue_comment')).toHaveLength(101)
    expect(changed.events.filter((event) => event.type === 'pull_request_review')).toHaveLength(101)
    expect(changed.events.filter((event) => event.type === 'pull_request_review_comment')).toHaveLength(101)
    expect(changed.budgetUnitsConsumed).toBe(14)
    expect(baselineBudget.consumed).toBe(10)
    expect(changedBudget.consumed).toBe(14)
    expect(requests.filter(({ url }) => url.includes('page=2')).length).toBeGreaterThanOrEqual(6)
    expect(
      requests.some(
        ({ url, ifNoneMatch }) => url.includes('/pulls/7/reviews') && url.includes('page=2') && ifNoneMatch !== null
      )
    ).toBe(true)
  })

  test('finishes multi-page stabilization without ETags using compact content fingerprints', async () => {
    const comments = Array.from({ length: 150 }, (_, index) => ({ ...comment, id: index + 1 }))
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async (input) => {
        const url = new URL(input)
        if (url.pathname.endsWith('/pulls/7')) return response(pullRequest, '"pr"')
        if (url.pathname.endsWith('/issues/7')) return response(issue, '"issue"')
        if (url.pathname.endsWith('/issues/7/comments')) {
          const page = Number(url.searchParams.get('page'))
          const items = comments.slice((page - 1) * 100, page * 100)
          const headers = page === 1 ? { link: '<https://api.github.test/comments?page=2>; rel="next"' } : undefined
          return new Response(JSON.stringify(items), { headers })
        }
        return new Response('[]')
      },
    })

    const result = await poller.poll(connection(), null, createEventPollingBudget(20).signal)
    const cursor = result.nextCursor as GitHubPollingCursor
    expect(cursor.pendingScan).toBeUndefined()
    expect(Object.keys(cursor.issueComments)).toHaveLength(150)
    expect(JSON.stringify(cursor).length).toBeLessThan(50_000)
    expect(result.events).toEqual([])
  })

  test('advances a quiet >40-page history so its follow-up scan is ordinary', async () => {
    const boundary = 'Wed, 26 Aug 2026 05:00:00 GMT'
    let requests = 0
    let issuePageRequests = 0
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async (input, init) => {
        requests++
        const url = new URL(input)
        if (url.pathname.endsWith('/pulls/7')) {
          return new Response(JSON.stringify(pullRequest), { headers: { date: boundary, etag: '"pr"' } })
        }
        if (url.pathname.endsWith('/issues/7')) return response(issue, '"issue"')
        if (url.pathname.endsWith('/issues/7/comments')) {
          issuePageRequests++
          if (url.searchParams.has('since')) return response([], '"quiet"')
          const page = Number(url.searchParams.get('page'))
          const etag = `"history-${page}"`
          if (new Headers(init?.headers).get('if-none-match') === etag) return new Response(null, { status: 304 })
          const size = page <= 41 ? 100 : page === 42 ? 1 : 0
          const items = Array.from({ length: size }, (_, index) => ({
            ...comment,
            id: (page - 1) * 100 + index + 1,
            updated_at: '2026-08-26T04:00:00Z',
          }))
          const headers: Record<string, string> = { etag }
          if (page < 42) headers.link = `<https://api.github.test/comments?page=${page + 1}>; rel="next"`
          return new Response(JSON.stringify(items), { headers })
        }
        return response([], '"empty"')
      },
    })

    let cursor: GitHubPollingCursor | null = null
    for (let attempts = 0; attempts < 5; attempts++) {
      const result = await poller.poll(connection(), cursor, createEventPollingBudget(40).signal)
      expect(result.events).toEqual([])
      cursor = result.nextCursor as GitHubPollingCursor
      if (!cursor.pendingScan) break
    }
    expect(cursor!.pendingScan).toBeUndefined()
    expect(cursor!.lastIssueCommentUpdatedAt).toBe('2026-08-26T05:00:00.000Z')

    const beforeRequests = requests
    const beforeIssuePages = issuePageRequests
    const quiet = await poller.poll(connection(), cursor, createEventPollingBudget(40).signal)
    expect(quiet.events).toEqual([])
    expect((quiet.nextCursor as GitHubPollingCursor).pendingScan).toBeUndefined()
    expect(requests - beforeRequests).toBe(5)
    expect(issuePageRequests - beforeIssuePages).toBe(1)
  })

  test('resumes capped scans and catches an edit inserted into an already-read page exactly once', async () => {
    let editVersion = 0
    let requests = 0
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async (input, init) => {
        requests++
        const url = new URL(input)
        if (url.pathname.endsWith('/pulls/7')) return response(pullRequest, '"pr"')
        if (url.pathname.endsWith('/issues/7')) return response(issue, '"issue"')
        if (url.pathname.endsWith('/issues/7/comments')) {
          const page = Number(url.searchParams.get('page'))
          const etag = `"issue-comments-${page}-v${page === 1 ? editVersion : 0}"`
          if (new Headers(init?.headers).get('if-none-match') === etag) return new Response(null, { status: 304 })
          const size = page <= 41 ? 100 : page === 42 ? 1 : 0
          const items = Array.from({ length: size }, (_, index) => {
            const id = (page - 1) * 100 + index + 1
            return { ...comment, id, ...(id === 1 && editVersion ? { body: 'edited between ticks' } : {}) }
          })
          const headers: Record<string, string> = { etag }
          if (page < 42) headers.link = `<https://api.github.test/page/${page + 1}>; rel="next"`
          return new Response(JSON.stringify(items), { headers })
        }
        return response([], '"empty"')
      },
    })

    const tick = async (cursor: GitHubPollingCursor | null) => {
      const before = requests
      const budget = createEventPollingBudget(40)
      const result = await poller.poll(connection(), cursor, budget.signal)
      expect(requests - before).toBeLessThanOrEqual(40)
      expect(budget.consumed).toBeLessThanOrEqual(40)
      expect(JSON.stringify(result.nextCursor).length).toBeLessThan(1_000_000)
      return result
    }

    let cursor: GitHubPollingCursor | null = null
    for (let attempts = 0; attempts < 10; attempts++) {
      const result = await tick(cursor)
      expect(result.events).toEqual([])
      cursor = result.nextCursor as GitHubPollingCursor
      if (!cursor.pendingScan) break
    }
    expect(cursor!.pendingScan).toBeUndefined()

    // Start a fresh >40-request scan, then edit ID 1 after its first page was read.
    let result = await tick(cursor)
    cursor = result.nextCursor as GitHubPollingCursor
    expect(cursor.pendingScan).toBeDefined()
    editVersion = 1

    const emitted: VerifiedIngressEvent[] = []
    for (let attempts = 0; attempts < 10 && cursor.pendingScan; attempts++) {
      result = await tick(cursor)
      emitted.push(...result.events)
      cursor = result.nextCursor as GitHubPollingCursor
    }
    expect(cursor.pendingScan).toBeUndefined()
    expect(emitted).toHaveLength(1)
    expect(emitted[0].payload).toMatchObject({
      action: 'edited',
      comment: { id: 1, body: 'edited between ticks' },
    })

    const replayed: VerifiedIngressEvent[] = []
    for (let attempts = 0; attempts < 10; attempts++) {
      result = await tick(cursor)
      replayed.push(...result.events)
      cursor = result.nextCursor as GitHubPollingCursor
      if (!cursor.pendingScan) break
    }
    expect(replayed).toEqual([])
  })

  test('normalizes an RFC server boundary and catches an edit after its page was validated', async () => {
    const boundary = 'Wed, 26 Aug 2026 05:00:00 GMT'
    const comments = Array.from({ length: 150 }, (_, index) => ({
      ...comment,
      id: index + 1,
      updated_at: index === 149 ? '2026-08-26T05:00:01Z' : '2026-08-26T04:59:00Z',
    }))
    let phase = 0
    let editedAfterValidation = false
    let eligibilitySince: string | null = null
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async (input, init) => {
        const url = new URL(input)
        if (url.pathname.endsWith('/pulls/7')) {
          return new Response(JSON.stringify(pullRequest), { headers: { date: boundary, etag: '"pr"' } })
        }
        if (url.pathname.endsWith('/issues/7')) return response(issue, '"issue"')
        if (url.pathname.endsWith('/issues/7/comments')) {
          if (phase === 1) {
            eligibilitySince = url.searchParams.get('since')
            const edited = { ...comments[0], body: 'edited after validation', updated_at: '2026-08-26T05:00:00Z' }
            const eligible = eligibilitySince && Date.parse(edited.updated_at) > Date.parse(eligibilitySince)
            return response(eligible ? [edited] : [], '"edited"')
          }
          const page = Number(url.searchParams.get('page'))
          const etag = `"comments-${page}"`
          if (new Headers(init?.headers).get('if-none-match') === etag) {
            if (page === 2) editedAfterValidation = true
            return new Response(null, { status: 304 })
          }
          const items = comments.slice((page - 1) * 100, page * 100)
          const headers: Record<string, string> = { etag }
          if (page === 1) headers.link = '<https://api.github.test/comments?page=2>; rel="next"'
          return new Response(JSON.stringify(items), { headers })
        }
        return response([], '"empty"')
      },
    })
    const baseline: GitHubPollingCursor = {
      etags: {},
      pr: { headSha: 'abc', state: 'open', merged: false },
      issue,
      pullRequest,
      issueComments: Object.fromEntries(comments.map((item) => [String(item.id), item])),
      reviews: {},
      reviewComments: {},
      lastIssueCommentUpdatedAt: '2026-08-26T04:59:00Z',
    }

    const stable = await poller.poll(connection(), baseline, createEventPollingBudget(20).signal)
    expect(editedAfterValidation).toBe(true)
    expect((stable.nextCursor as GitHubPollingCursor).lastIssueCommentUpdatedAt).toBe('2026-08-26T05:00:00.000Z')
    expect(stable.events).toEqual([])

    phase = 1
    const changed = await poller.poll(
      connection(),
      stable.nextCursor as GitHubPollingCursor,
      createEventPollingBudget(20).signal
    )
    expect(String(eligibilitySince)).toBe('2026-08-26T04:59:59.000Z')
    expect(changed.events).toHaveLength(1)
    expect(changed.events[0].payload).toMatchObject({
      action: 'edited',
      comment: { id: 1, body: 'edited after validation' },
    })
  })

  test('charges a late-page failure to the shared request cap', async () => {
    const budget = createEventPollingBudget(7)
    let requests = 0
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async (input) => {
        requests++
        if (requests === 7) throw new Error('late page failed')
        const url = new URL(input)
        if (url.pathname.endsWith('/pulls/7')) return response(pullRequest, '"pr"')
        if (url.pathname.endsWith('/issues/7')) return response(issue, '"issue"')
        return new Response(JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ ...comment, id }))), {
          headers: { link: `<${url.origin}${url.pathname}?page=next>; rel="next"`, etag: `"${requests}"` },
        })
      },
    })

    await expect(poller.poll(connection(), null, budget.signal)).rejects.toThrow('late page failed')
    expect(requests).toBe(7)
    expect(budget.consumed).toBe(7)
    expect(budget.remaining).toBe(0)
  })

  test('upgrades a legacy 100-item cursor by probing the next page', async () => {
    const existing = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [String(index + 1), { ...comment, id: index + 1 }])
    )
    const baseline: GitHubPollingCursor = {
      etags: { pr: '"legacy-pr"', issueComments: '"legacy"' },
      pr: { headSha: 'abc', state: 'open', merged: false },
      issue,
      issueComments: existing,
      reviews: {},
      reviewComments: {},
    }
    let prRequests = 0
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async (input) => {
        const url = new URL(input)
        if (url.pathname.endsWith('/pulls/7')) {
          prRequests++
          return prRequests === 1 ? new Response(null, { status: 304 }) : response(pullRequest, '"pr"')
        }
        if (url.pathname.endsWith('/issues/7')) return response(issue, '"issue"')
        if (url.pathname.endsWith('/issues/7/comments')) {
          return url.searchParams.get('page') === '1'
            ? new Response(null, { status: 304 })
            : response([{ ...comment, id: 101 }], '"page-2"')
        }
        return response([], '"empty"')
      },
    })

    const result = await poller.poll(connection(), baseline)

    expect(prRequests).toBe(2)
    expect(result.events.filter((event) => event.type === 'issue_comment')).toHaveLength(1)
    expect((result.events[0].payload as { comment: { id: number } }).comment.id).toBe(101)
  })

  test('synthesizes a byte-shape-identical native issue_comment webhook payload', async () => {
    const baseline: GitHubPollingCursor = {
      etags: {},
      pr: { headSha: 'abc', state: 'open', merged: false },
      issue,
      issueComments: {},
      reviews: {},
      reviewComments: {},
    }
    const bodies = [pullRequest, issue, [comment], [], []]
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async () => response(bodies.shift(), '"next"'),
    })

    const result = await poller.poll(connection(), baseline)

    expect(result.events).toEqual([
      {
        type: 'issue_comment',
        metadata: { synthetic: true },
        payload: { action: 'created', issue, comment, repository, sender: comment.user },
      },
    ])
  })

  test('normalizes recorded REST PR, issue, and comment shapes against the shared sanitized webhook', async () => {
    const rest = (await Bun.file(`${import.meta.dir}/fixtures/github-issue-comment-rest.json`).json()) as {
      _recording: { source: string[] }
      pull_request: Record<string, any>
      issue: Record<string, unknown>
      comment: Record<string, unknown>
    }
    const webhook = await Bun.file(
      `${import.meta.dir}/../../webhooks/processors/fixtures/github-issue-comment-webhook.json`
    ).json()
    const recordedConnection = {
      ...connection(),
      id: 'github:fixture-org-2/fixture-repo-3#42',
      configuration: { owner: 'fixture-org-2', repo: 'fixture-repo-3', number: 42 },
    }
    const baseline: GitHubPollingCursor = {
      etags: {},
      pr: {
        headSha: rest.pull_request.head.sha,
        state: rest.pull_request.state,
        merged: rest.pull_request.merged === true,
      },
      issue: rest.issue,
      pullRequest: rest.pull_request,
      issueComments: {},
      reviews: {},
      reviewComments: {},
    }
    const bodies = [rest.pull_request, rest.issue, [rest.comment], [], []]
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async () => response(bodies.shift(), '"fixture"'),
    })

    const result = await poller.poll(recordedConnection, baseline)

    const payload = result.events.find((event) => event.type === 'issue_comment')!.payload as Record<string, any>
    const without = (value: Record<string, any>, keys: string[]) =>
      Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
    expect(rest._recording.source).toContain('GET /repos/fixture-org-2/fixture-repo-3/issues/42')
    expect(payload.comment).toEqual(webhook.comment)
    expect(payload.issue.author_association).toBe(rest.issue.author_association)
    expect(without(payload.issue, ['state', 'closed_at', 'updated_at', 'pull_request', 'author_association'])).toEqual(
      without(webhook.issue, ['state', 'closed_at', 'updated_at', 'pull_request', 'author_association'])
    )
    expect(without(payload.repository, ['open_issues_count', 'open_issues', 'pushed_at', 'updated_at'])).toEqual(
      without(webhook.repository, ['open_issues_count', 'open_issues', 'pushed_at', 'updated_at'])
    )
    expect(payload.sender).toEqual(webhook.sender)
  })

  test('uses conditional requests and keeps prior snapshots on 304 responses', async () => {
    const seenHeaders: Headers[] = []
    const baseline: GitHubPollingCursor = {
      etags: { pr: '"p"', issue: '"i"', issueComments: '"c"', reviews: '"r"', reviewComments: '"rc"' },
      pr: { headSha: 'abc', state: 'open', merged: false },
      issue,
      pullRequest,
      issueComments: { '101': comment },
      reviews: {},
      reviewComments: {},
    }
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async (_url, init) => {
        seenHeaders.push(new Headers(init?.headers))
        return new Response(null, { status: 304 })
      },
    })

    const result = await poller.poll(connection(), baseline)

    expect(result.events).toEqual([])
    expect(result.nextCursor).toMatchObject({ issue, pullRequest })
    expect((result.nextCursor as GitHubPollingCursor).issueComments['101']).toEqual({
      fingerprint: expect.any(String),
      updatedAt: comment.updated_at,
    })
    expect(seenHeaders.map((headers) => headers.get('if-none-match'))).toEqual(['"p"', '"i"', '"c"', '"r"', '"rc"'])
  })

  test('versions successive synchronize and close cycles with distinct stable logical keys', async () => {
    const pollPr = async (current: Record<string, unknown>, cursor: GitHubPollingCursor, squadId = 'squad-1') => {
      const bodies = [current, issue, [], [], []]
      return new GitHubPrEventPoller({
        resolveCredential: async () => 'token',
        fetch: async () => response(bodies.shift(), '"pr-transition"'),
      }).poll({ ...connection(), squadId }, cursor)
    }
    const baseline: GitHubPollingCursor = {
      etags: {},
      pr: { headSha: 'abc', state: 'open', merged: false },
      issue,
      pullRequest,
      issueComments: {},
      reviews: {},
      reviewComments: {},
    }
    const synchronizeOnePr = { ...pullRequest, head: { sha: 'def' }, updated_at: '2026-08-26T01:00:00Z' }
    const synchronizeOne = await pollPr(synchronizeOnePr, baseline)
    const synchronizeTwoPr = { ...pullRequest, head: { sha: 'ghi' }, updated_at: '2026-08-26T02:00:00Z' }
    const synchronizeTwo = await pollPr(synchronizeTwoPr, synchronizeOne.nextCursor as GitHubPollingCursor)
    expect(synchronizeTwo.events[0].logicalEventKey).not.toBe(synchronizeOne.events[0].logicalEventKey)

    const closedOnePr = {
      ...synchronizeTwoPr,
      state: 'closed',
      closed_at: '2026-08-26T03:00:00Z',
      updated_at: '2026-08-26T03:00:00Z',
    }
    const closedOne = await pollPr(closedOnePr, synchronizeTwo.nextCursor as GitHubPollingCursor)
    const reopenedPr = {
      ...synchronizeTwoPr,
      updated_at: '2026-08-26T04:00:00Z',
    }
    const reopened = await pollPr(reopenedPr, closedOne.nextCursor as GitHubPollingCursor)
    const closedTwoPr = {
      ...closedOnePr,
      closed_at: '2026-08-26T05:00:00Z',
      updated_at: '2026-08-26T05:00:00Z',
    }
    const closedTwo = await pollPr(closedTwoPr, reopened.nextCursor as GitHubPollingCursor)
    expect(
      new Set([
        closedOne.events[0].logicalEventKey,
        reopened.events[0].logicalEventKey,
        closedTwo.events[0].logicalEventKey,
      ]).size
    ).toBe(3)

    const duplicate = await pollPr(closedTwoPr, reopened.nextCursor as GitHubPollingCursor, 'squad-2')
    expect(duplicate.events[0].logicalEventKey).toBe(closedTwo.events[0].logicalEventKey)
  })

  test('emits closed rather than synchronize when merge and head change together', async () => {
    const mergedPr = { ...pullRequest, state: 'closed', merged: true, head: { sha: 'merge-head' } }
    const baseline: GitHubPollingCursor = {
      etags: {},
      pr: { headSha: 'abc', state: 'open', merged: false },
      issue,
      issueComments: {},
      reviews: {},
      reviewComments: {},
    }
    const bodies = [mergedPr, issue, [], [], []]
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async () => response(bodies.shift(), '"e"'),
    })

    const { events } = await poller.poll(connection(), baseline)

    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({ action: 'closed', pull_request: { merged: true } })
    expect(events[0].payload).not.toHaveProperty('sender')
  })

  test('omits the unauthoritative PR author for reopened transitions', async () => {
    const baseline: GitHubPollingCursor = {
      etags: {},
      pr: { headSha: 'abc', state: 'closed', merged: false },
      issue,
      issueComments: {},
      reviews: {},
      reviewComments: {},
    }
    const bodies = [pullRequest, issue, [], [], []]
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async () => response(bodies.shift(), '"e"'),
    })

    const { events } = await poller.poll(connection(), baseline)

    expect(events[0].payload).toMatchObject({ action: 'reopened', pull_request: { user: { login: 'author' } } })
    expect(events[0].payload).not.toHaveProperty('sender')
  })

  test('keeps mutable collection keys stable across irrelevant credential-specific fields', async () => {
    const oldIssueComment = { ...comment, id: 701, body: 'old', updated_at: '2026-08-26T01:00:00Z' }
    const oldReview = {
      id: 702,
      state: 'APPROVED',
      body: 'old',
      user: { login: 'reviewer' },
      submitted_at: '2026-08-26T01:00:00Z',
      updated_at: '2026-08-26T01:00:00Z',
    }
    const oldReviewComment = { ...oldIssueComment, id: 703 }
    const relevant = { body: 'edited', updated_at: '2026-08-26T02:00:00Z' }
    const firstVersions = [
      { ...oldIssueComment, ...relevant, reactions: { total_count: 1 }, viewer: { reacted: true } },
      { ...oldReview, ...relevant, reactions: { total_count: 1 }, viewer: { can_edit: true } },
      { ...oldReviewComment, ...relevant, reactions: { total_count: 1 }, viewer: { reacted: true } },
    ]
    const secondVersions = firstVersions.map((item) => ({
      ...item,
      reactions: { total_count: 999 },
      viewer: { credential_specific: true },
    }))
    const baseline: GitHubPollingCursor = {
      etags: {},
      pr: { headSha: 'abc', state: 'open', merged: false },
      issue,
      pullRequest,
      issueComments: { '701': oldIssueComment },
      reviews: { '702': oldReview },
      reviewComments: { '703': oldReviewComment },
    }
    const pollVersions = async (versions: Array<Record<string, unknown>>, cursor: GitHubPollingCursor) => {
      const bodies = [pullRequest, issue, [versions[0]], [versions[1]], [versions[2]]]
      return new GitHubPrEventPoller({
        resolveCredential: async () => 'token',
        fetch: async () => response(bodies.shift(), '"mutable-key"'),
      }).poll(connection(), cursor)
    }

    const first = await pollVersions(firstVersions, baseline)
    const second = await pollVersions(secondVersions, baseline)
    expect(second.events.map((event) => event.logicalEventKey)).toEqual(
      first.events.map((event) => event.logicalEventKey)
    )

    const laterVersions = firstVersions.map((item) => ({
      ...item,
      body: 'edited again',
      updated_at: '2026-08-26T03:00:00Z',
    }))
    const laterCursor = {
      ...baseline,
      issueComments: { '701': firstVersions[0] },
      reviews: { '702': firstVersions[1] },
      reviewComments: { '703': firstVersions[2] },
    }
    const later = await pollVersions(laterVersions, laterCursor)
    expect(later.events).toHaveLength(3)
    expect(later.events.every((event, index) => event.logicalEventKey !== first.events[index].logicalEventKey)).toBe(
      true
    )
  })

  test('emits edited events when a previously seen native comment changes', async () => {
    const edited = { ...comment, body: 'updated', updated_at: '2026-08-26T02:00:00Z' }
    const baseline: GitHubPollingCursor = {
      etags: {},
      pr: { headSha: 'abc', state: 'open', merged: false },
      issue,
      issueComments: { '101': comment },
      reviews: {},
      reviewComments: {},
      pullRequest,
    }
    const bodies = [pullRequest, issue, [edited], [], []]
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async () => response(bodies.shift(), '"e"'),
    })

    const { events } = await poller.poll(connection(), baseline)

    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({ action: 'edited', comment: { id: 101, body: 'updated' } })

    const editedAgain = { ...edited, body: 'updated again', updated_at: '2026-08-26T03:00:00Z' }
    const nextBodies = [pullRequest, issue, [editedAgain], [], []]
    const next = await new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async () => response(nextBodies.shift(), '"edit-next"'),
    }).poll(connection(), { ...baseline, issueComments: { '101': edited } })
    expect(next.events[0].logicalEventKey).not.toBe(events[0].logicalEventKey)
  })

  test('normalizes legacy uppercase review snapshots without emitting false edits', async () => {
    const review = { id: 201, state: 'APPROVED', body: 'ok' }
    const baseline: GitHubPollingCursor = {
      etags: {},
      pr: { headSha: 'abc', state: 'open', merged: false },
      issue,
      pullRequest,
      issueComments: {},
      reviews: { '201': review },
      reviewComments: {},
    }
    const bodies = [pullRequest, issue, [], [review], []]
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async () => response(bodies.shift(), '"review"'),
    })

    const { events } = await poller.poll(connection(), baseline)

    expect(events).toEqual([])
  })

  test('normalizes submitted, edited, and dismissed REST reviews to webhook states', async () => {
    const recorded = await Bun.file(`${import.meta.dir}/fixtures/github-pull-request-review-rest.json`).json()
    const cases = [
      {
        action: 'submitted',
        previous: undefined,
        current: recorded.review,
        state: 'commented',
      },
      {
        action: 'edited',
        previous: { id: 201, state: 'approved', body: 'old' },
        current: { id: 201, state: 'APPROVED', body: 'new' },
        state: 'approved',
      },
      {
        action: 'dismissed',
        previous: { id: 201, state: 'approved', body: 'ok' },
        current: { id: 201, state: 'DISMISSED', body: 'ok' },
        state: 'dismissed',
      },
    ]

    for (const reviewCase of cases) {
      const baseline: GitHubPollingCursor = {
        etags: {},
        pr: { headSha: 'abc', state: 'open', merged: false },
        issue,
        pullRequest,
        issueComments: {},
        reviews: reviewCase.previous ? { '201': reviewCase.previous } : {},
        reviewComments: {},
      }
      const bodies = [pullRequest, issue, [], [reviewCase.current], []]
      const poller = new GitHubPrEventPoller({
        resolveCredential: async () => 'token',
        fetch: async () => response(bodies.shift(), '"review"', 'Wed, 26 Aug 2026 12:00:00 GMT'),
      })

      const { events } = await poller.poll(connection(), baseline)

      expect(events).toHaveLength(1)
      expect(events[0].payload).toMatchObject({
        action: reviewCase.action,
        review: { state: reviewCase.state },
      })
      expect(events[0].metadata).toEqual({ synthetic: true })
    }
  })

  test('emits native PR, review, and review-comment events only for new transitions', async () => {
    const review = { id: 201, state: 'APPROVED', user: { login: 'r1' }, submitted_at: '2026-08-26T01:00:00Z' }
    const reviewComment = { id: 301, body: 'nit', user: { login: 'r1' }, pull_request_review_id: 201 }
    const changedPr = { ...pullRequest, head: { sha: 'def' } }
    const baseline: GitHubPollingCursor = {
      etags: {},
      pr: { headSha: 'abc', state: 'open', merged: false },
      issue,
      issueComments: {},
      reviews: {},
      reviewComments: {},
    }
    const bodies = [changedPr, issue, [], [review], [reviewComment]]
    const poller = new GitHubPrEventPoller({
      resolveCredential: async () => 'token',
      fetch: async () => response(bodies.shift(), '"e"'),
    })

    const { events } = await poller.poll(connection(), baseline)

    expect(events.map((event) => event.type)).toEqual([
      'pull_request',
      'pull_request_review',
      'pull_request_review_comment',
    ])
    expect(events[0].payload).toEqual({
      action: 'synchronize',
      number: 7,
      pull_request: changedPr,
      repository,
    })
    expect(events[1].payload).toEqual({
      action: 'submitted',
      review: { ...review, state: 'approved' },
      pull_request: changedPr,
      repository,
      sender: review.user,
    })
    expect(events[2].payload).toEqual({
      action: 'created',
      comment: reviewComment,
      pull_request: changedPr,
      repository,
      sender: reviewComment.user,
    })
  })
})

test('delivery baseline and same-head polls cache aggregate checks/review policy without replaying activity', async () => {
  let required = true
  const head = 'a'.repeat(40)
  const poller = new GitHubPrEventPoller({
    resolveCredential: async () => 'token',
    fetch: async (input) => {
      const path = new URL(input).pathname
      if (path === '/graphql')
        return response(
          {
            data: {
              repository: {
                pullRequest: {
                  headRefOid: head,
                  headRefName: 'work',
                  baseRefName: 'main',
                  state: 'OPEN',
                  isDraft: false,
                  mergeStateStatus: required ? 'BLOCKED' : 'CLEAN',
                  reviewDecision: required ? 'REVIEW_REQUIRED' : 'APPROVED',
                  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
                },
              },
            },
          },
          'graphql',
          new Date().toUTCString()
        )
      if (path.endsWith('/pulls/7'))
        return response(
          { ...pullRequest, head: { sha: head }, mergeable_state: required ? 'blocked' : 'clean' },
          'pr',
          new Date().toUTCString()
        )
      if (path.endsWith('/issues/7')) return response(issue, 'issue')
      return response([], 'empty')
    },
  })
  const watch = { ...connection(), configuration: { ...connection().configuration, deliveryPresentation: true } }
  const baseline = await poller.poll(watch, null)
  expect(baseline.events).toEqual([])
  expect(baseline.budgetUnitsConsumed).toBe(6)
  expect(baseline.nextCursor.deliveryPresentation).toMatchObject({
    headSha: head,
    reviewDecision: 'required',
    checksState: 'success',
  })
  required = false
  const next = await poller.poll(watch, baseline.nextCursor)
  expect(next.events).toEqual([])
  expect(next.nextCursor.deliveryPresentation).toMatchObject({
    headSha: head,
    mergeState: 'clean',
    reviewDecision: 'approved',
  })
})

test('an unavailable aggregate cannot renew a dynamic merge state from an unchanged REST cache', async () => {
  let baseline = true
  const head = 'a'.repeat(40)
  const poller = new GitHubPrEventPoller({
    resolveCredential: async () => 'token',
    fetch: async (input) => {
      const path = new URL(input).pathname
      if (path === '/graphql')
        return baseline
          ? response(
              {
                data: {
                  repository: {
                    pullRequest: {
                      headRefOid: head,
                      state: 'OPEN',
                      isDraft: false,
                      mergeStateStatus: 'CLEAN',
                      reviewDecision: 'APPROVED',
                    },
                  },
                },
              },
              'graph'
            )
          : new Response('{}', { status: 403 })
      if (path.endsWith('/pulls/7'))
        return baseline
          ? response({ ...pullRequest, head: { sha: head }, mergeable_state: 'clean' }, 'pr')
          : new Response(null, { status: 304 })
      if (path.endsWith('/issues/7')) return baseline ? response(issue, 'issue') : new Response(null, { status: 304 })
      return response([], 'empty')
    },
  })
  const watch = { ...connection(), configuration: { ...connection().configuration, deliveryPresentation: true } }
  const initial = await poller.poll(watch, null)
  expect(initial.nextCursor.deliveryPresentation).toMatchObject({ mergeState: 'clean' })
  baseline = false
  const next = await poller.poll(watch, initial.nextCursor)
  expect(next.events).toEqual([])
  expect(next.nextCursor.deliveryPresentation).toBeUndefined()
})

test('emitted polling updates and feedback share compact webhook presentation without stripping snapshots', async () => {
  const { githubOutputAdapter } = await import('../outputs/github')
  const { integrationOutputRegistry } = await import('../outputs/registry')
  const description = 'Unchanged parent description.\n'.repeat(100)
  const pr = { ...pullRequest, body: description, updated_at: '2026-08-26T01:00:00Z' }
  const issueSnapshot = { ...issue, body: description }
  const review = { id: 201, state: 'APPROVED', body: 'Review feedback', submitted_at: '2026-08-26T01:00:00Z' }
  let phase = 0
  const poller = new GitHubPrEventPoller({
    resolveCredential: async () => 'token',
    fetch: async (input) => {
      const path = new URL(input).pathname
      if (path.endsWith('/pulls/7'))
        return response({ ...pr, head: { sha: ['abc', 'def', 'ghi'][phase] } }, `"pr-${phase}"`)
      if (path.endsWith('/issues/7')) return response(issueSnapshot, `"issue-${phase}"`)
      if (path.endsWith('/reviews')) return response(phase ? [review] : [], `"reviews-${phase}"`)
      const feedback = {
        ...comment,
        body: phase === 1 ? 'New feedback' : 'Edited feedback',
        updated_at: `2026-08-26T0${phase}:00:00Z`,
      }
      return response(
        phase
          ? [{ ...feedback, ...(path.endsWith('/pulls/7/comments') ? { path: 'src/main.ts', line: 12 } : {}) }]
          : [],
        `"comments-${phase}"`
      )
    },
  })
  let cursor = (await poller.poll(connection(), null)).nextCursor
  for (phase = 1; phase <= 2; phase++) {
    const polled = await poller.poll(connection(), cursor)
    cursor = polled.nextCursor
    expect(polled.events.map((event) => event.type)).toEqual(
      phase === 1
        ? ['pull_request', 'issue_comment', 'pull_request_review', 'pull_request_review_comment']
        : ['pull_request', 'issue_comment', 'pull_request_review_comment']
    )
    for (const event of polled.events) {
      const payload = event.payload as Record<string, any>
      expect((payload.pull_request ?? payload.issue).body).toBe(description)
      const [fact] = githubOutputAdapter.normalize(event)
      const [webhookFact] = githubOutputAdapter.normalize({ type: event.type, payload })
      expect(fact).toEqual(webhookFact)
      const body = integrationOutputRegistry.notificationBody('github', fact!)
      expect(body).toBe(integrationOutputRegistry.notificationBody('github', webhookFact!))
      expect(body).not.toContain(description)
      if (event.type === 'pull_request') {
        expect(body).toContain(`Head: ${phase === 1 ? 'def' : 'ghi'}`)
        expect(fact!.body).toContain(description)
      } else if (event.type === 'pull_request_review') {
        expect(body).toContain('Review feedback')
        expect(body).toContain('approved')
      } else {
        expect(payload.action).toBe(phase === 1 ? 'created' : 'edited')
        expect(body).toContain(phase === 1 ? 'New feedback' : 'Edited feedback')
        if (event.type === 'pull_request_review_comment') expect(body).toContain('src/main.ts:12')
      }
    }
  }
})
