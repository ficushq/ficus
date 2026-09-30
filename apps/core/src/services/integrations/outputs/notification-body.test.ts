import { expect, test } from 'bun:test'
import { githubOutputAdapter } from './github'
import { integrationOutputRegistry } from './registry'

const repository = { full_name: 'acme/project' }
const date = '2026-09-07T10:00:00Z'
const description = 'Unchanged parent description.\n'.repeat(100)
const pr = {
  id: 10,
  number: 3,
  title: 'Fix race condition',
  body: description,
  state: 'open',
  updated_at: date,
  html_url: 'https://github.com/acme/project/pull/3',
  head: { sha: 'abc' },
  base: { repo: repository },
}

function resource(type: 'pull_request' | 'issues', action: string, extra = {}) {
  return githubOutputAdapter.normalize({
    type,
    payload: { repository, action, [type === 'issues' ? 'issue' : 'pull_request']: pr, ...extra },
  })[0]!
}

for (const action of ['synchronize', 'labeled', 'unlabeled', 'reopened', 'ready_for_review', 'closed']) {
  test(`PR ${action} notifications omit unchanged descriptions without changing canonical evidence`, () => {
    const fact = resource('pull_request', action)
    const before = structuredClone(fact)
    const body = integrationOutputRegistry.notificationBody('github', fact)
    expect(body).not.toContain(description)
    expect(body).toContain(pr.html_url)
    expect(body).toContain(action)
    expect(body).toContain('abc')
    expect(body).toContain('open')
    expect(fact).toEqual(before)
    expect(fact.body).toContain(description)
    expect(body.length).toBeLessThan(fact.body.length / 5)
    // No recipient-memory or previous-delivery dependency.
    expect(integrationOutputRegistry.notificationBody('github', structuredClone(fact))).toBe(body)
  })
}

for (const type of ['pull_request', 'issues'] as const) {
  test(`${type} edits remain discoverable including cleared descriptions`, () => {
    for (const body of ['Replacement description', '']) {
      const fact = resource(type, 'edited', {
        [type === 'issues' ? 'issue' : 'pull_request']: { ...pr, body },
        changes: { body: { from: description } },
      })
      const notice = integrationOutputRegistry.notificationBody('github', fact)
      expect(notice).toContain('edited')
      expect(notice).toContain('description')
      expect(notice).toContain(`https://github.com/acme/project/${type === 'issues' ? 'issues' : 'pull'}/3`)
      expect(notice).not.toContain(description)
    }
  })
}

test('issue status/unassignment updates omit the current description', () => {
  for (const action of ['closed', 'reopened', 'labeled', 'unassigned']) {
    const body = integrationOutputRegistry.notificationBody('github', resource('issues', action))
    expect(body).not.toContain(description)
    expect(body).toContain('https://github.com/acme/project/issues/3')
    expect(body).toContain(action)
  }
})

test('initial opening, assignment and review requests retain full context and a retrieval link', () => {
  for (const fact of [
    resource('issues', 'assigned'),
    resource('pull_request', 'opened'),
    resource('pull_request', 'review_requested'),
  ]) {
    const body = integrationOutputRegistry.notificationBody('github', fact)
    expect(body).toContain(description)
    expect(body).toContain('https://github.com/')
  }
})

for (const [type, actions] of [
  ['issue_comment', ['created', 'edited']],
  ['pull_request_review_comment', ['created', 'edited']],
  ['pull_request_review', ['submitted']],
] as const) {
  for (const action of actions) {
    test(`${type} ${action} preserves feedback and webhook/polling parity without parent context`, () => {
      const feedback = {
        id: 23,
        body: 'First point\nSecond point',
        created_at: date,
        updated_at: date,
        submitted_at: date,
        state: 'changes_requested',
        commit_id: 'abc',
        path: 'src/main.ts',
        line: 12,
        html_url: 'https://github.com/acme/project/pull/3#discussion_r23',
      }
      const event = {
        type,
        payload: {
          repository,
          action,
          ...(type === 'issue_comment' ? { issue: { ...pr, pull_request: {} } } : { pull_request: pr }),
          [type === 'pull_request_review' ? 'review' : 'comment']: feedback,
        },
      }
      const [webhook] = githubOutputAdapter.normalize(event)
      const [poll] = githubOutputAdapter.normalize({
        ...event,
        metadata: { synthetic: true },
        logicalEventKey: 'poll-id',
      })
      const body = integrationOutputRegistry.notificationBody('github', webhook!)
      expect(body).toBe(integrationOutputRegistry.notificationBody('github', poll!))
      expect(body).toContain(feedback.body)
      expect(body).toContain(feedback.html_url)
      expect(body).not.toContain(description)
      if (type === 'pull_request_review_comment') expect(body).toContain('src/main.ts:12')
      if (type === 'pull_request_review') expect(body).toContain('changes_requested')
      expect(webhook).toEqual(poll)
    })
  }
}

test('compact lifecycle messages preserve merged/conflict state and work for retained facts without a URL', () => {
  const merged = resource('pull_request', 'closed', {
    pull_request: { ...pr, state: 'closed', merged: true, merged_at: date },
  })
  expect(integrationOutputRegistry.notificationBody('github', merged)).toContain('merged')
  const conflict = resource('pull_request', 'synchronize', { pull_request: { ...pr, mergeable_state: 'dirty' } })
  delete conflict.url
  expect(integrationOutputRegistry.notificationBody('github', conflict)).toContain('Merge conflicts need resolution')
  expect(integrationOutputRegistry.notificationBody('github', conflict)).toContain(pr.html_url)
})

test('CI and other integrations retain their existing actionable body', () => {
  const [ci] = githubOutputAdapter.normalize({
    type: 'workflow_run',
    payload: {
      repository,
      action: 'completed',
      workflow_run: {
        id: 50,
        workflow_id: 1,
        run_number: 10,
        run_attempt: 2,
        name: 'Core',
        conclusion: 'failure',
        updated_at: date,
        head_sha: 'abc',
        html_url: 'https://github.com/acme/project/actions/runs/50',
        pull_requests: [{ number: 3 }],
      },
    },
  })
  expect(integrationOutputRegistry.notificationBody('github', ci!)).toBe(ci!.body)
  expect(integrationOutputRegistry.notificationBody('linear', resource('issues', 'closed'))).toBe(
    resource('issues', 'closed').body
  )
})

test('initial contexts without a provider HTML URL still offer full-detail retrieval', () => {
  const fact = resource('pull_request', 'review_requested', { pull_request: { ...pr, html_url: undefined } })
  expect(integrationOutputRegistry.notificationBody('github', fact)).toContain(pr.html_url)
  expect(integrationOutputRegistry.notificationBody('github', fact)).toContain(description)
})

test('older or custom facts without a valid resource identity retain their original content', () => {
  const fact = resource('pull_request', 'synchronize')
  fact.data = {}
  expect(integrationOutputRegistry.notificationBody('github', fact)).toBe(fact.body)
})
