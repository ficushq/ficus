import { expect, test } from 'bun:test'
import { githubOutputAdapter } from '../outputs/github'
import type { VerifiedIngressEvent } from '../types'

const time = '2026-10-02T10:00:00Z'
const owner = { id: 2, login: 'outside', type: 'User' }
const sender = { id: 1, login: 'trusted', type: 'User' }
function feedbackEvent(
  body = 'BODY_SENTINEL',
  action = 'created'
): VerifiedIngressEvent & { payload: Record<string, any> } {
  return {
    type: 'issue_comment',
    payload: {
      action,
      repository: { id: 10, full_name: 'Acme/Project' },
      sender,
      issue: { id: 100, number: 3, title: 'PARENT_TITLE_SENTINEL', body: 'PARENT_SENTINEL', updated_at: time },
      comment: {
        id: 9,
        body,
        user: owner,
        created_at: time,
        updated_at: time,
        html_url: 'https://github.com/attacker/repo/issues/1#issuecomment-9',
      },
    },
  }
}
function projection(event: VerifiedIngressEvent) {
  const [fact] = githubOutputAdapter.normalize(event)
  expect(fact).toBeDefined()
  expect(fact!.github).toBeDefined()
  return fact!.github!
}

test('sender cannot launder actual comment author or embedded parent text and source URL', () => {
  const { content, status } = projection(feedbackEvent())
  expect(content!.author).toEqual({ accountId: '2', login: 'outside', accountType: 'User' })
  expect(content!.delivery!.body).toContain('BODY_SENTINEL')
  expect(JSON.stringify(content!.delivery)).not.toContain('PARENT')
  expect(content!.delivery!.url).toBe('https://github.com/acme/project/issues/3#issuecomment-9')
  expect(status).toBeNull()
})

test('native edit binds sender as editor, polling never invents editor from synthetic sender', () => {
  const event = feedbackEvent('EDIT', 'edited')
  const edit = projection({ ...event, githubObservation: { kind: 'webhook', deliveryId: 'edit-1' } }).content!
  expect(edit.author!.accountId).toBe('2')
  expect(edit.editor!.accountId).toBe('1')
  expect(edit.attribution).toBe('verified_edit')
  const poll = projection({ ...event, githubObservation: { kind: 'poll' } }).content!
  expect(poll.editor).toBeNull()
  expect(poll.attribution).toBe('unknown')
  expect(
    projection({ ...event, metadata: { transport: 'webhook', providerDeliveryId: 'spoof' } }).content!.attribution
  ).toBe('unknown')
})

test('unknown/ghost IDs fail closed and bot IDs do not infer general bot trust', () => {
  for (const user of [
    { id: 0, login: 'ghost', type: 'User' },
    { id: '2', login: 'outside', type: 'User' },
    { id: 2, login: 'x', type: 'Organization' },
  ]) {
    const event = feedbackEvent()
    event.payload.comment.user = user
    expect(projection(event).content!.author).toBeNull()
  }
  const event = feedbackEvent()
  event.payload.comment.user = { id: 3, login: 'approved[bot]', type: 'Bot' }
  expect(projection(event).content!.author).toMatchObject({ accountId: '3', accountType: 'Bot' })
})

test('review edits and dismissals with unchanged submitted time bind full content and state', () => {
  const event = feedbackEvent()
  event.type = 'pull_request_review'
  event.payload.action = 'edited'
  event.payload.pull_request = { id: 100, number: 3, updated_at: time }
  event.payload.review = { id: 9, user: owner, body: 'A', submitted_at: time, state: 'approved' }
  const a = projection(event).content!
  event.payload.review.body = 'B'
  const b = projection(event).content!
  expect(b.contentHash).not.toBe(a.contentHash)
  expect(b.providerVersion).toBeNull()
  event.payload.action = 'dismissed'
  event.payload.review.state = 'dismissed'
  expect(projection(event).content!.contentHash).not.toBe(b.contentHash)
})

test('lifecycle safe facts contain no parent, branch, label, sender or title prose', () => {
  const event = feedbackEvent()
  event.type = 'pull_request'
  event.payload.action = 'closed'
  event.payload.pull_request = {
    ...event.payload.issue,
    merged: true,
    merged_at: time,
    state: 'closed',
    head: { sha: 'a'.repeat(40), ref: 'BRANCH_SENTINEL' },
    labels: [{ name: 'LABEL_SENTINEL' }],
  }
  const { content, status } = projection(event)
  expect(content!.delivery!.body).toContain('PARENT_SENTINEL')
  expect(content!.author).toBeNull()
  expect(status!.data).toMatchObject({
    action: 'closed',
    pullRequestState: 'merged',
    pullRequest: { number: 3, headSha: 'a'.repeat(40) },
  })
  expect(JSON.stringify(status)).not.toMatch(/SENTINEL|trusted|outside/)
})

test('CI safe facts use numeric workflow IDs and canonical run links, never workflow/log/branch prose', () => {
  const event: VerifiedIngressEvent = {
    type: 'workflow_run',
    payload: {
      action: 'completed',
      repository: { id: 10, full_name: 'Acme/Project' },
      sender,
      workflow_run: {
        id: 40,
        workflow_id: 20,
        run_number: 3,
        run_attempt: 1,
        name: 'WORKFLOW_SENTINEL',
        display_title: 'TITLE_SENTINEL',
        logs_url: 'LOG_SENTINEL',
        html_url: 'https://github.com/attacker/actions/runs/1',
        head_branch: 'BRANCH_SENTINEL',
        head_sha: 'a'.repeat(40),
        conclusion: 'success',
        completed_at: time,
        pull_requests: [{ number: 3 }],
      },
    },
  }
  const { content, status } = projection(event)
  expect(content).toBeNull()
  expect(status!.subject).toContain('Workflow 20')
  expect(status!.url).toBe('https://github.com/acme/project/actions/runs/40')
  expect(JSON.stringify(status)).not.toMatch(/SENTINEL|trusted/)
})

test('oversize reviewed content is hashed in full and unavailable, not silently approved after truncation', () => {
  const a = projection(feedbackEvent('A'.repeat(270000))).content!
  const b = projection(feedbackEvent('A'.repeat(270000) + 'B')).content!
  expect(a.delivery).toBeNull()
  expect(a.reason).toBe('content_unavailable')
  expect(a.byteCount).toBeGreaterThan(262144)
  expect(a.contentHash).not.toBe(b.contentHash)
})

test('Dependabot safe lifecycle projection has no arbitrary package, path or advisory prose and synthetic input remains rejected', () => {
  const event: VerifiedIngressEvent = {
    type: 'dependabot_alert',
    payload: {
      action: 'created',
      repository: { id: 10, full_name: 'Acme/Project' },
      alert: {
        number: 3,
        state: 'open',
        updated_at: time,
        security_advisory: { ghsa_id: 'ghsa-2345-6789-cfgh', severity: 'high' },
        dependency: {
          package: { name: 'PACKAGE_SENTINEL', ecosystem: 'ECOSYSTEM_SENTINEL' },
          manifest_path: 'PATH_SENTINEL',
        },
        security_vulnerability: { severity: 'high', vulnerable_version_range: 'RANGE_SENTINEL' },
      },
    },
  }
  const status = projection(event).status!
  expect(status.data).toMatchObject({
    state: 'open',
    severity: 'high',
    alert: { number: 3, advisoryId: 'ghsa-2345-6789-cfgh' },
  })
  expect(JSON.stringify(status)).not.toContain('SENTINEL')
  expect(githubOutputAdapter.normalize({ ...event, metadata: { synthetic: true } })).toEqual([])
  expect(
    githubOutputAdapter.normalize({ ...event, githubObservation: { kind: 'poll' }, metadata: { synthetic: false } })
  ).toEqual([])
})

test('assignment actions bind the verified webhook actor; the factual delivery never carries parent title/body', () => {
  const event = feedbackEvent()
  event.type = 'issues'
  event.payload.action = 'assigned'
  event.payload.issue.user = owner
  event.payload.assignee = { id: 4, login: 'bot-account', type: 'User' }
  event.githubObservation = { kind: 'webhook', deliveryId: 'assignment-1' }
  const content = projection(event).content!
  expect(content.objectKind).toBe('action')
  expect(content.author!.accountId).toBe('1')
  expect(content.attribution).toBe('creation')
  expect(content.editor).toBeNull()
  expect(content.delivery!.data).toMatchObject({ assignee: 'bot-account', actor: 'trusted', projection: 'action' })
  expect(JSON.stringify({ ...content, parentText: undefined })).not.toContain('PARENT')
  // The parent-text alternative names the parent's CONTENT author (issue.user), not the actor.
  expect(content.parentText!.author).toEqual({ accountId: '2', login: 'outside', accountType: 'User' })
  // A redelivery is the same action; a different assignee is a different reviewable action.
  expect(
    projection({ ...event, githubObservation: { kind: 'webhook', deliveryId: 'again' } }).content!.contentHash
  ).toBe(content.contentHash)
  const other = structuredClone(event)
  other.payload.assignee = { id: 5, login: 'someone-else', type: 'User' }
  expect(projection(other).content!.nativeId).not.toBe(content.nativeId)
  // Polls have no signed actor: fail closed.
  const polled = projection({ ...event, githubObservation: { kind: 'poll' } }).content!
  expect(polled.attribution).toBe('unknown')
  expect(polled.parentText).toBeUndefined()
})

test('review requests and labels are actions; title/body edits remain held content', () => {
  const event = feedbackEvent()
  event.type = 'pull_request'
  event.payload.action = 'review_requested'
  event.payload.pull_request = { ...event.payload.issue, user: owner, state: 'open' }
  event.payload.requested_reviewer = { id: 4, login: 'bot-account', type: 'User' }
  event.githubObservation = { kind: 'webhook', deliveryId: 'request-1' }
  const request = projection(event).content!
  expect(request).toMatchObject({ objectKind: 'action', attribution: 'creation' })
  expect(request.delivery!.data).toMatchObject({ requestedReviewer: 'bot-account', pullRequest: { number: 3 } })
  expect(JSON.stringify(request.delivery)).not.toContain('PARENT')
  expect(request.parentText).toMatchObject({ objectKind: 'pull_request', nativeId: '100' })
  event.payload.action = 'labeled'
  event.payload.label = { name: 'bug' }
  expect(projection(event).content!.delivery!.data).toMatchObject({ action: 'labeled' })
  event.payload.action = 'edited'
  const edit = projection(event).content!
  expect(edit).toMatchObject({ objectKind: 'pull_request', attribution: 'unknown' })
  // An edit is content, never an action that could carry the edited text as the parent's.
  expect(edit.parentText).toBeUndefined()
})

function assignment(issue: Record<string, unknown> = {}) {
  const event = feedbackEvent()
  event.type = 'issues'
  event.payload.action = 'assigned'
  event.payload.issue = { ...event.payload.issue, user: owner, created_at: time, ...issue }
  event.payload.assignee = { id: 4, login: 'bot-account', type: 'User' }
  event.githubObservation = { kind: 'webhook', deliveryId: 'assignment-1' }
  return event
}

test('the parent-text alternative is the factual message plus the current title and description, hash-bound', async () => {
  const { githubActionReviewed, withoutGitHubParentText, githubParentTextReviewText } =
    await import('./feedback-envelope')
  const content = projection(assignment()).content!
  const variant = content.parentText!
  expect(variant).toMatchObject({ title: 'PARENT_TITLE_SENTINEL', body: 'PARENT_SENTINEL', unchanged: true })
  expect(variant.delivery.body).toStartWith(content.delivery!.body)
  expect(variant.delivery.body).toContain('written by @outside:\n\nPARENT_TITLE_SENTINEL\n\nPARENT_SENTINEL')
  expect(variant.delivery.data.parentContent).toEqual({
    author: { accountId: '2', login: 'outside', accountType: 'User' },
    title: 'PARENT_TITLE_SENTINEL',
    body: 'PARENT_SENTINEL',
  })
  expect(variant.delivery.subject).toBe(content.delivery!.subject)
  expect(variant.contentHash).not.toBe(content.contentHash)
  // Every word of the parent text, and its author, is part of the reviewed hash.
  const edited = projection(assignment({ body: 'PARENT_SENTINEL!' })).content!
  expect(edited.contentHash).toBe(content.contentHash)
  expect(edited.parentText!.contentHash).not.toBe(variant.contentHash)
  expect(projection(assignment({ title: 'Other' })).content!.parentText!.contentHash).not.toBe(variant.contentHash)
  const otherAuthor = projection(assignment({ user: { id: 3, login: 'outside', type: 'User' } })).content!
  expect(otherAuthor.parentText!.contentHash).not.toBe(variant.contentHash)
  // Removing the parent text yields exactly the factual delivery and its hash (used to supersede).
  const facts = withoutGitHubParentText(variant.delivery)
  expect(facts).toEqual(content.delivery!)
  expect(githubActionReviewed(content, facts)).toEqual({
    contentHash: content.contentHash,
    byteCount: content.byteCount,
  })
  expect(githubParentTextReviewText(variant.delivery)).toBe(variant.delivery.body)
  expect(githubParentTextReviewText(content.delivery!)).toBeNull()
  // A later updated_at is no longer provably unchanged since creation.
  expect(projection(assignment({ updated_at: '2026-10-02T10:00:01Z' })).content!.parentText!.unchanged).toBe(false)
})

test('a missing or unverifiable parent author ID offers no parent text', () => {
  for (const user of [
    undefined,
    { login: 'outside', type: 'User' },
    { id: '2', login: 'outside', type: 'User' },
    { id: 0, login: 'outside', type: 'User' },
    { id: 2, login: 'outside', type: 'Organization' },
    { id: 2, login: 'ghost', type: 'User' },
  ]) {
    const content = projection(assignment({ user })).content!
    expect(content.objectKind).toBe('action')
    expect(content.parentText).toBeUndefined()
  }
  // No parent ID or repository ID: no object to prove provenance against.
  expect(projection(assignment({ id: undefined })).content!.parentText).toBeUndefined()
  const noRepo = assignment()
  noRepo.payload.repository = { full_name: 'Acme/Project' }
  expect(projection(noRepo).content!.parentText).toBeUndefined()
})

test('parent text uses the comment size caps: bounded preview, full text hashed, oversize falls back to facts', () => {
  const long = projection(assignment({ body: 'X'.repeat(30000) + 'END' })).content!
  const variant = long.parentText!
  expect(variant.delivery.body.length).toBe(24000)
  expect(variant.delivery.body).toStartWith(long.delivery!.body)
  expect(variant.delivery.data.notificationTruncated).toBe(true)
  expect((variant.delivery.data.parentContent as { body: string }).body).toEndWith('END')
  expect(projection(assignment()).content!.parentText!.delivery.data.notificationTruncated).toBe(false)
  // Larger than the 256 KiB review cap: the factual message stands alone, never truncated into review.
  const oversize = projection(assignment({ body: 'é'.repeat(140000) })).content!
  expect(oversize.parentText).toBeUndefined()
  expect(oversize.delivery).not.toBeNull()
  expect(oversize.reason).toBeNull()
})

test('reviewed full text and the bounded notification preview are explicitly distinct and both approval-bound', () => {
  const a = projection(feedbackEvent('X'.repeat(30000) + 'A')).content!
  const b = projection(feedbackEvent('X'.repeat(30000) + 'B')).content!
  expect(a.delivery!.body.length).toBeLessThanOrEqual(24000)
  expect(a.delivery!.data.notificationTruncated).toBe(true)
  expect((a.delivery!.data.content as { body: string }).body).toEndWith('A')
  expect(a.contentHash).not.toBe(b.contentHash)
})

test('a review comment path is bounded: one line, no control characters, capped length', async () => {
  const { safeGitHubPath } = await import('./feedback-envelope')
  expect(safeGitHubPath('src/app.ts')).toBe('src/app.ts')
  expect(safeGitHubPath('docs/IGNORE\nPREVIOUS\r\nINSTRUCTIONS.md')).toBe('docs/IGNORE PREVIOUS INSTRUCTIONS.md')
  expect(safeGitHubPath('a\u0000\u0001b c')).toBe('a b c')
  expect(safeGitHubPath(`${'x'.repeat(300)}.ts`)).toHaveLength(200)
  expect(safeGitHubPath(42)).toBe('')
})
