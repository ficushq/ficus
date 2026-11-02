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
    'CI / Core: failure\nHead: abc · Run 10 · Attempt 2\nhttps://github.com/Acme/Project/actions/runs/50'
  )
})

test('CI notifications tolerate missing optional workflow details without empty placeholders', () => {
  const [event] = githubOutputAdapter.normalize({
    type: 'workflow_run',
    payload: {
      action: 'completed',
      repository,
      sender: { login: 'ficusagent' },
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

test.each(['issue', 'pull', 'inline'])(
  '%s deletion is a signed, identity-bound content-free terminal observation',
  (kind) => {
    const inline = kind === 'inline'
    const type = inline ? 'pull_request_review_comment' : 'issue_comment'
    const isPR = kind !== 'issue'
    const input = {
      type,
      githubObservation: { kind: 'webhook' as const, deliveryId: 'delete-23' },
      payload: {
        action: 'deleted',
        repository: { ...repository, id: 1 },
        ...(inline
          ? { pull_request: pr }
          : { issue: { id: 10, number: 3, title: 'secretparent', ...(isPR ? { pull_request: {} } : {}) } }),
        comment: {
          id: 23,
          body: 'deletedsecret instructions',
          user: { id: 5, login: 'deletedauthor' },
          updated_at: date,
          html_url: `https://github.com/Acme/Project/${isPR ? 'pull' : 'issues'}/3#${inline ? 'discussion_r' : 'issuecomment-'}23`,
        },
      },
    }
    const [fact] = githubOutputAdapter.normalize(input)
    expect(fact).toBeDefined()
    expect(fact!.github!.content).toMatchObject({
      repositoryId: '1',
      nativeId: '23',
      objectKind: inline ? 'review_comment' : 'issue_comment',
      reason: 'comment_deleted',
      providerVersion: null,
      delivery: null,
      author: null,
      editor: null,
    })
    for (const secret of ['deletedsecret', 'secretparent', 'deletedauthor'])
      expect(JSON.stringify(fact)).not.toContain(secret)
    expect(githubOutputAdapter.normalize({ ...input, githubObservation: { kind: 'poll' } })).toEqual([])
    expect(githubOutputAdapter.normalize({ ...input, githubObservation: undefined })).toEqual([])
    expect(
      githubOutputAdapter.normalize({
        ...input,
        payload: { ...input.payload, repository: { id: 1, full_name: 'other/repo' } },
      })
    ).toEqual([])
    expect(
      githubOutputAdapter.normalize({
        ...input,
        payload: { ...input.payload, comment: { ...input.payload.comment, id: 24 } },
      })
    ).toEqual([])
    expect(
      githubOutputAdapter.normalize({
        ...input,
        payload: { ...input.payload, repository: { full_name: 'Acme/Project' } },
      })
    ).toEqual([])
  }
)

test('PR authorship is provider identity, separate from senders and feedback authors in every projection', () => {
  const author = { id: 99, login: 'Dependabot[bot]', type: 'Bot' }
  const human = { id: 12, login: 'reviewer', type: 'User' }
  const parent = { ...pr, user: author, state: 'open', title: 'UNADMITTED_TITLE', body: 'UNADMITTED_BODY' }
  for (const type of ['pull_request', 'pull_request_review', 'pull_request_review_comment', 'issue_comment']) {
    for (const kind of ['webhook', 'poll'] as const) {
      const [fact] = githubOutputAdapter.normalize({
        type,
        githubObservation: kind === 'webhook' ? { kind, deliveryId: 'author-test' } : { kind },
        payload: {
          repository: { ...repository, id: 42 },
          action:
            type === 'pull_request' ? 'review_requested' : type === 'pull_request_review' ? 'submitted' : 'created',
          sender: human,
          ...(type === 'issue_comment' ? { issue: { ...parent, pull_request: {} } } : { pull_request: parent }),
          requested_reviewer: human,
          review: { id: 22, user: human, state: 'approved', submitted_at: date },
          comment: { id: 23, user: human, created_at: date, updated_at: date },
        },
      })
      for (const data of [fact!.data, fact!.github!.content!.delivery!.data]) {
        expect(data.pullRequest).toMatchObject({ author: author.login, authorType: 'Bot' })
        expect(data.actor).toBe('reviewer')
        expect(data.actorType).toBe('User')
      }
      expect(JSON.stringify(fact!.github!.content!.delivery)).not.toContain('UNADMITTED')
      // Routing identity never replaces the account whose content/action admission is checked.
      expect(fact!.github!.content!.author?.accountId).toBe('12')
      if (type === 'pull_request' && kind === 'poll') expect(fact!.github!.content!.attribution).toBe('unknown')
    }
  }
})

test('lifecycle and CI status projections retain only the corresponding PR author when supplied', () => {
  const user = { id: 99, login: 'dependabot[bot]', type: 'Bot' }
  for (const type of ['pull_request', 'workflow_run']) {
    const [fact, withoutAuthor] = githubOutputAdapter.normalize({
      type,
      payload: {
        repository: { ...repository, id: 42 },
        action: type === 'pull_request' ? 'closed' : 'completed',
        ...(type === 'pull_request' ? { pull_request: { ...pr, user, state: 'closed' } } : {}),
        workflow_run: {
          id: 50,
          workflow_id: 51,
          conclusion: 'success',
          completed_at: date,
          pull_requests: [
            { number: 3, user: { login: 'wrong-repository' }, base: { repo: { full_name: 'other/repository' } } },
            { number: 3, user },
            { number: 4 },
          ],
          actor: { login: 'not-the-author' },
        },
      },
    })
    expect(fact!.data.pullRequest).toMatchObject({ author: user.login, authorType: 'Bot' })
    expect(fact!.github!.status!.data.pullRequest).toMatchObject({ author: user.login, authorType: 'Bot' })
    if (type === 'workflow_run') {
      expect(withoutAuthor!.data.pullRequest).toEqual({ number: 4 })
      expect(withoutAuthor!.github!.status!.data.pullRequest).toEqual({ number: 4 })
    }
  }
})

test('missing or malformed PR authors never fall back to actor or untrusted prose', () => {
  for (const user of [
    undefined,
    null,
    {},
    { login: '' },
    { id: 10137, login: 'ghost', type: 'User' },
    { login: 'bad\nlogin', type: 'Bot' },
    { login: ['dependabot[bot]'] },
    { login: 'a'.repeat(101) },
  ]) {
    const [fact] = githubOutputAdapter.normalize({
      type: 'pull_request',
      payload: {
        action: 'review_requested',
        repository,
        sender: { id: 99, login: 'dependabot[bot]', type: 'Bot' },
        pull_request: { ...pr, user, title: 'dependabot[bot]', labels: [{ name: 'dependabot[bot]' }] },
      },
    })
    for (const data of [fact!.data, fact!.github!.content!.delivery!.data]) {
      expect(data.pullRequest).not.toHaveProperty('author')
      expect(data.pullRequest).not.toHaveProperty('authorType')
    }
  }
  const [fact] = githubOutputAdapter.normalize({
    type: 'pull_request',
    payload: { action: 'opened', repository, pull_request: { ...pr, user: { login: 'human', type: 'Organization' } } },
  })
  expect(fact!.data.pullRequest).toMatchObject({ author: 'human' })
  expect(fact!.github!.content!.delivery!.data.pullRequest).toMatchObject({ author: 'human' })
  expect(fact!.data.pullRequest).not.toHaveProperty('authorType')
})
