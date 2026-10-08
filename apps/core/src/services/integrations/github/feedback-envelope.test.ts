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

test('assignment actions bind the verified webhook actor and never carry parent title/body', () => {
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
  expect(JSON.stringify(content)).not.toContain('PARENT')
  // A redelivery is the same action; a different assignee is a different reviewable action.
  expect(
    projection({ ...event, githubObservation: { kind: 'webhook', deliveryId: 'again' } }).content!.contentHash
  ).toBe(content.contentHash)
  const other = structuredClone(event)
  other.payload.assignee = { id: 5, login: 'someone-else', type: 'User' }
  expect(projection(other).content!.nativeId).not.toBe(content.nativeId)
  // Polls have no signed actor: fail closed.
  expect(projection({ ...event, githubObservation: { kind: 'poll' } }).content!.attribution).toBe('unknown')
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
  expect(JSON.stringify(request)).not.toContain('PARENT')
  event.payload.action = 'labeled'
  event.payload.label = { name: 'bug' }
  expect(projection(event).content!.delivery!.data).toMatchObject({ action: 'labeled' })
  event.payload.action = 'edited'
  const edit = projection(event).content!
  expect(edit).toMatchObject({ objectKind: 'pull_request', attribution: 'unknown' })
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
