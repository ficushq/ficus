import { expect, test } from 'bun:test'
import { githubOutputAdapter } from './github'
import { integrationOutputRegistry } from './registry'
import { createHash } from 'node:crypto'

const repository = { full_name: 'Acme/Project' }
const date = '2026-09-07T10:00:00Z'
const pr = { id: 10, number: 3, updated_at: date, head: { sha: 'abc' }, base: { repo: repository } }

test('retiring scripts preserves existing event keys so upgrades do not replay merges', () => {
  const [fact] = githubOutputAdapter.normalize({
    type: 'pull_request',
    payload: {
      action: 'closed',
      repository,
      pull_request: { ...pr, merged: true, merged_at: date },
    },
  })
  const previousKey = createHash('sha256')
    .update(JSON.stringify(['pull_request.merged', 'acme/project', 3, 'closed', 10, date, '', '', '', undefined]))
    .digest('hex')
  expect(fact!.eventKey).toBe(previousKey)
})

test('native review line comments preserve file, line, multiline body and thread URL', () => {
  const [fact] = githubOutputAdapter.normalize({
    type: 'pull_request_review_comment',
    payload: {
      action: 'created',
      repository,
      pull_request: pr,
      comment: {
        id: 23,
        created_at: date,
        path: 'src/main.ts',
        line: 12,
        body: 'First point\nSecond point',
        html_url: 'https://github.com/Acme/Project/pull/3#discussion_r23',
      },
    },
  })
  expect(fact!.body).toContain('src/main.ts:12')
  expect(fact!.body).toContain('First point\nSecond point')
  expect(fact!.body).toContain('reply in this review thread')
  expect(fact!.url).toContain('#discussion_r23')
})

test('webhook and polling representations share the review output identity', () => {
  const payload = {
    action: 'submitted',
    repository,
    pull_request: pr,
    review: {
      id: 20,
      submitted_at: date,
      state: 'changes_requested',
      body: 'Check the edge case',
      html_url: 'https://github.com/Acme/Project/pull/3#review-20',
    },
  }
  const webhook = githubOutputAdapter.normalize({ type: 'pull_request_review', payload })
  const polling = githubOutputAdapter.normalize({
    type: 'pull_request_review',
    payload,
    logicalEventKey: 'poll-dispatch-id',
    metadata: { transport: 'poll' },
  })
  expect(webhook).toEqual(polling)
  expect(webhook[0]!.data).toMatchObject({
    repository: 'acme/project',
    pullRequest: { number: 3, headSha: 'abc' },
    state: 'changes_requested',
  })
  expect(() => integrationOutputRegistry.validateFact('github', webhook[0]!)).not.toThrow()
})

test('issue assignments expose a typed assignee and issue identity without a PR identity', () => {
  const [event] = githubOutputAdapter.normalize({
    type: 'issues',
    payload: {
      action: 'assigned',
      repository,
      assignee: { login: 'Noah' },
      issue: { id: 11, number: 4, title: 'Investigate latency', updated_at: date },
    },
  })
  expect(event!.output).toBe('issue.assigned')
  expect(event!.data).toMatchObject({ assignee: 'Noah', issue: { number: 4, title: 'Investigate latency' } })
  expect(event!.data.pullRequest).toBeUndefined()
  expect(() => integrationOutputRegistry.validateFact('github', event!)).not.toThrow()
  // Issue identity lives in `metadata.tracked`; an event-created stream binds only its repository.
  expect(githubOutputAdapter.workStreamBindings!(event!)).toEqual({ 'github.repo': { event: 'repository' } })
  expect(
    githubOutputAdapter.workStreamBindings!({ ...event!, data: { ...event!.data, pullRequest: { number: 4 } } })
  ).toEqual({ 'github.repo': { event: 'repository' }, 'github.pr.number': { event: 'pullRequest.number' } })
})

test('issue comments and PR comments are distinct outputs', () => {
  const payload = {
    action: 'created',
    repository,
    issue: { number: 3 },
    comment: { id: 9, body: 'New details', created_at: date },
  }
  expect(githubOutputAdapter.normalize({ type: 'issue_comment', payload })[0]!.output).toBe('issue.comment')
  expect(
    githubOutputAdapter.normalize({
      type: 'issue_comment',
      payload: { ...payload, issue: { ...payload.issue, pull_request: {} } },
    })[0]!.output
  ).toBe('pull_request.comment')
})

test('CI outputs retain monotonic workflow run/attempt identity for every linked PR', () => {
  const events = githubOutputAdapter.normalize({
    type: 'workflow_run',
    payload: {
      action: 'completed',
      repository,
      workflow_run: {
        id: 50,
        workflow_id: 1,
        run_number: 10,
        run_attempt: 2,
        name: 'CI / Core',
        conclusion: 'failure',
        updated_at: date,
        head_sha: 'abc',
        html_url: 'https://github.com/Acme/Project/actions/runs/50',
        pull_requests: [{ number: 3 }, { number: 4 }],
      },
    },
  })
  expect(events).toHaveLength(2)
  expect(events[0]!.ordering).toEqual({ key: '1', position: [10, 2] })
  expect(events[0]!.data).toMatchObject({ pullRequest: { headSha: 'abc' }, state: 'failure' })
  expect(events[0]!.eventKey).not.toBe(events[1]!.eventKey)
  expect(events[0]!.subject).toBe('CI failure: acme/project#3 · CI / Core')
  expect(events[0]!.body).toBe(
    'CI / Core: failure\nHead: abc · Run #10 · Attempt 2\nhttps://github.com/Acme/Project/actions/runs/50'
  )
})

test('CI notifications tolerate missing optional workflow details without empty placeholders', () => {
  const [event] = githubOutputAdapter.normalize({
    type: 'workflow_run',
    payload: {
      action: 'completed',
      repository,
      sender: { login: 'tauagent' },
      workflow_run: { id: 51, conclusion: 'success', updated_at: date, pull_requests: [{ number: 3 }] },
    },
  })
  expect(event!.subject).toBe('CI success: acme/project#3 · Workflow')
  expect(event!.body).toBe('Workflow: success')
})

test('invalid native identities cannot broaden correlation or cross a repository boundary', () => {
  expect(
    githubOutputAdapter.normalize({
      type: 'pull_request',
      payload: { action: 'closed', repository, pull_request: { ...pr, base: { repo: { full_name: 'Other/Repo' } } } },
    })
  ).toEqual([])
  expect(
    githubOutputAdapter.normalize({
      type: 'issues',
      payload: { action: 'assigned', repository, issue: { number: '4', updated_at: date } },
    })
  ).toEqual([])
  expect(
    githubOutputAdapter.normalize({ type: 'issues', payload: { action: 'assigned', repository, issue: { number: 4 } } })
  ).toEqual([])
})

test('event-specific predicates match normalized review, CI, collection, boolean and absent-line facts', async () => {
  const { previewSquadEventRules, selectSquadEventRule, squadEventRuleSchema } = await import('@ficus/shared')
  const cases = [
    {
      type: 'pull_request_review',
      payload: { action: 'submitted', review: { id: 20, submitted_at: date, state: 'changes_requested' } },
      predicate: { field: 'state', op: 'in', value: ['changes_requested'] },
    },
    {
      type: 'workflow_run',
      payload: {
        action: 'completed',
        workflow_run: { id: 21, updated_at: date, conclusion: 'failure', name: 'Core', pull_requests: [{ number: 3 }] },
      },
      predicate: { field: 'workflow', op: 'eq', value: 'Core' },
    },
    {
      type: 'pull_request',
      payload: { action: 'synchronize', pull_request: { ...pr, mergeable_state: 'dirty' } },
      predicate: { field: 'mergeConflict', op: 'eq', value: true },
    },
    {
      type: 'pull_request',
      payload: { action: 'synchronize', pull_request: { ...pr, labels: [{ name: 'bug' }] } },
      predicate: { field: 'labels', op: 'contains', value: 'bug' },
    },
    {
      type: 'pull_request_review_comment',
      payload: { action: 'created', comment: { id: 22, created_at: date, path: 'src/main.ts', line: null } },
      predicate: { field: 'line', op: 'exists', value: false },
    },
  ]
  for (const input of cases) {
    const [fact] = githubOutputAdapter.normalize({
      type: input.type,
      payload: { repository, pull_request: pr, ...input.payload },
    })
    expect(fact).toBeDefined()
    integrationOutputRegistry.validateFact('github', fact!)
    const rule = squadEventRuleSchema.parse({
      id: 'native',
      source: { integration: 'github', output: fact!.output, version: 1 },
      filters: { audience: 'any' },
      predicates: [input.predicate],
      action: { type: 'ignore' },
    })
    const metadata = { integrationRules: { github: [rule] } }
    expect(previewSquadEventRules(metadata, 'github', fact!, 'bot').selectedRuleId).toBe('native')
    expect(selectSquadEventRule(metadata, 'github', fact!, 'bot')?.id).toBe('native')
    const missing = { ...fact!, data: {} }
    expect(previewSquadEventRules(metadata, 'github', missing, 'bot').selectedRuleId).toBe(
      input.predicate.op === 'exists' ? 'native' : null
    )
  }
})

test('PR snapshots preserve provider aggregate merge state, not individual CI success', () => {
  const [fact] = githubOutputAdapter.normalize({
    type: 'pull_request',
    payload: {
      action: 'synchronize',
      repository,
      pull_request: { ...pr, mergeable_state: 'clean' },
    },
  })
  expect(fact!.data.mergeState).toBe('clean')
})

test('PR snapshots distinguish pending human review from bot-only requests', () => {
  for (const [type, pendingHumanReview] of [
    ['User', true],
    ['Bot', false],
  ] as const) {
    const [fact] = githubOutputAdapter.normalize({
      type: 'pull_request',
      payload: {
        action: 'synchronize',
        repository,
        pull_request: { ...pr, requested_reviewers: [{ login: 'reviewer', type }], requested_teams: [] },
      },
    })
    expect(fact!.data.pendingHumanReview).toBe(pendingHumanReview)
  }
})
