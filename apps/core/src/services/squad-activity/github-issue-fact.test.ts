import { describe, expect, it } from 'bun:test'
import { describeGitHubIssueFact, extractGitHubIssueDispatchFact, isGitHubIssueDispatchFact } from './github-issue-fact'
import { GitHubIssueEventPoller } from '../integrations/github/issue-event-poller'

const event = (
  type: string,
  action: string,
  payload: Record<string, unknown>,
  metadata: Record<string, unknown> = {}
) =>
  ({
    type,
    payload: { action, repository: { full_name: 'Acme/Widgets' }, ...payload },
    metadata: { synthetic: true, ...metadata },
  }) as any

const issue = (overrides: Record<string, unknown> = {}) => ({
  id: 900,
  number: 9,
  title: 'Fix the widget',
  updated_at: '2026-08-26T13:00:00Z',
  html_url: 'https://github.com/acme/widgets/issues/9',
  repository_url: 'https://api.github.com/repos/Acme/Widgets',
  ...overrides,
})

describe('GitHub issue dispatch fact', () => {
  it('extracts authoritative issue transition fields with the trigger sender as actor', () => {
    expect(
      extractGitHubIssueDispatchFact(
        'github',
        event(
          'issues',
          'closed',
          { issue: issue({ closed_at: '2026-08-26T12:00:00Z' }), sender: { login: 'ada' } },
          { providerDeliveryId: 'delivery-1' }
        )
      )
    ).toEqual({
      eventType: 'issues',
      action: 'closed',
      occurredAt: '2026-08-26T12:00:00.000Z',
      actorLogin: 'ada',
      repository: 'acme/widgets',
      issueNumber: 9,
      issueTitle: 'Fix the widget',
      detail: null,
      nativeId: '900',
      providerDeliveryId: 'delivery-1',
      logicalRowId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/),
      url: 'https://github.com/acme/widgets/issues/9',
    })
  })

  it('collapses the poll-synthesized close onto the webhook close, and retries onto themselves', () => {
    const webhook = extractGitHubIssueDispatchFact(
      'github',
      event(
        'issues',
        'closed',
        { issue: issue({ closed_at: '2026-08-26T12:00:00Z' }), sender: { login: 'ada' } },
        { providerDeliveryId: 'delivery-1' }
      )
    )
    // The issue-event poller synthesizes `issues` payloads whose embedded issue carries the
    // *event* time in `updated_at`; only `closed_at` is authoritative for a close.
    const polled = extractGitHubIssueDispatchFact(
      'github',
      event('issues', 'closed', {
        issue: issue({ closed_at: '2026-08-26T12:00:00Z', updated_at: '2026-08-27T09:00:00Z' }),
        assignee: null,
        sender: { login: 'poll-actor' },
        label: null,
      })
    )
    const retry = extractGitHubIssueDispatchFact(
      'github',
      event(
        'issues',
        'closed',
        { issue: issue({ closed_at: '2026-08-26T12:00:00Z' }), sender: { login: 'ada' } },
        { providerDeliveryId: 'delivery-2' }
      )
    )
    expect(polled?.logicalRowId).toBe(webhook!.logicalRowId)
    expect(retry?.logicalRowId).toBe(webhook!.logicalRowId)
    expect(retry?.providerDeliveryId).toBe('delivery-2')
    expect(polled?.actorLogin).toBe('poll-actor')
  })

  it('collapses a late-polled close onto its webhook row across a reopen and a second close', async () => {
    const firstClose = '2026-08-26T12:00:00Z'
    const reopen = '2026-08-26T14:00:00Z'
    const secondClose = '2026-08-26T16:00:00Z'
    const webhookClose = (closedAt: string) =>
      extractGitHubIssueDispatchFact(
        'github',
        event('issues', 'closed', {
          issue: issue({ closed_at: closedAt, updated_at: closedAt, state: 'closed' }),
          sender: { login: 'ada' },
        })
      )!
    // GitHub's issue-event page embeds the issue's CURRENT state in every entry,
    // so a poll that only reaches the first close still sees the second close's time.
    const current = issue({ closed_at: secondClose, updated_at: secondClose, state: 'closed' })
    const entry = (id: number, eventName: string, createdAt: string) => ({
      id,
      event: eventName,
      created_at: createdAt,
      issue: current,
      actor: { login: 'ada' },
    })
    const poller = new GitHubIssueEventPoller(
      async () => 'token',
      async (url) =>
        url.includes('/issues/events?')
          ? Response.json(
              [entry(3, 'closed', secondClose), entry(2, 'reopened', reopen), entry(1, 'closed', firstClose)],
              {
                headers: { etag: 'head' },
              }
            )
          : Response.json({ id: 10, full_name: 'acme/widgets' })
    )
    const { events } = await poller.poll(
      {
        id: 'github:squad',
        squadId: 'squad',
        providerKey: 'github',
        adapterVersion: 1,
        configuration: { kind: 'issue-events', owner: 'Acme', repo: 'Widgets' },
      } as never,
      { watermark: 0 }
    )
    const facts = events.map((polled) => extractGitHubIssueDispatchFact('github', polled)!)
    expect(facts.map((fact) => [fact.action, fact.occurredAt])).toEqual([
      ['closed', '2026-08-26T12:00:00.000Z'],
      ['reopened', '2026-08-26T14:00:00.000Z'],
      ['closed', '2026-08-26T16:00:00.000Z'],
    ])
    expect(facts[0].logicalRowId).toBe(webhookClose(firstClose).logicalRowId)
    expect(facts[2].logicalRowId).toBe(webhookClose(secondClose).logicalRowId)
    expect(facts[0].logicalRowId).not.toBe(facts[2].logicalRowId)
  })

  it('keeps distinct edits and the close/reopen transition apart', () => {
    const edit = (updatedAt: string) =>
      extractGitHubIssueDispatchFact(
        'github',
        event('issues', 'renamed', { issue: issue({ updated_at: updatedAt }), sender: { login: 'ada' } })
      )?.logicalRowId
    expect(edit('2026-08-26T13:00:00Z')).not.toBe(edit('2026-08-26T14:00:00Z'))
    const closed = extractGitHubIssueDispatchFact(
      'github',
      event('issues', 'closed', { issue: issue({ closed_at: '2026-08-26T12:00:00Z' }) })
    )
    const reopened = extractGitHubIssueDispatchFact(
      'github',
      event('issues', 'reopened', { issue: issue({ updated_at: '2026-08-26T12:00:00Z' }) })
    )
    expect(closed?.logicalRowId).not.toBe(reopened?.logicalRowId)
    expect(closed?.actorLogin).toBeNull()
  })

  it('maps the poller rename onto edited and gates webhook edits on a title change', () => {
    expect(extractGitHubIssueDispatchFact('github', event('issues', 'renamed', { issue: issue() }))).toMatchObject({
      action: 'edited',
      occurredAt: '2026-08-26T13:00:00.000Z',
    })
    expect(
      extractGitHubIssueDispatchFact(
        'github',
        event('issues', 'edited', { issue: issue(), changes: { title: { from: 'Fix the widgit' } } })
      )
    ).toMatchObject({ action: 'edited' })
    expect(extractGitHubIssueDispatchFact('github', event('issues', 'edited', { issue: issue() }))).toBeNull()
    expect(
      extractGitHubIssueDispatchFact(
        'github',
        event('issues', 'edited', { issue: issue(), changes: { body: { from: 'old body' } } })
      )
    ).toBeNull()
  })

  it('carries the assignee and label as the dedupe-significant detail', () => {
    const assigned = extractGitHubIssueDispatchFact(
      'github',
      event('issues', 'assigned', { issue: issue(), assignee: { login: 'ada' }, sender: { login: 'grace' } })
    )
    expect(assigned).toMatchObject({ action: 'assigned', detail: 'ada', actorLogin: 'grace' })
    expect(
      extractGitHubIssueDispatchFact(
        'github',
        event('issues', 'unassigned', { issue: issue(), assignee: { login: 'ada' } })
      )
    ).toMatchObject({ action: 'unassigned', detail: 'ada' })
    const labeled = extractGitHubIssueDispatchFact(
      'github',
      event('issues', 'labeled', { issue: issue(), label: { name: 'bug' } })
    )
    expect(labeled).toMatchObject({ action: 'labeled', detail: 'bug' })
    expect(
      extractGitHubIssueDispatchFact('github', event('issues', 'unlabeled', { issue: issue(), label: { name: 'bug' } }))
    ).toMatchObject({ action: 'unlabeled', detail: 'bug' })
    // A different label on the same issue is a different fact, not a duplicate.
    expect(labeled?.logicalRowId).not.toBe(
      extractGitHubIssueDispatchFact(
        'github',
        event('issues', 'labeled', { issue: issue(), label: { name: 'wontfix' } })
      )?.logicalRowId
    )
    // A detail-bearing action with no subject is not a fact we can describe or dedupe.
    expect(extractGitHubIssueDispatchFact('github', event('issues', 'assigned', { issue: issue() }))).toBeNull()
    expect(extractGitHubIssueDispatchFact('github', event('issues', 'labeled', { issue: issue() }))).toBeNull()
  })

  it('extracts issue comments from their author and canonical issue url', () => {
    expect(
      extractGitHubIssueDispatchFact(
        'github',
        event('issue_comment', 'created', {
          issue: issue({ html_url: 'https://evil.test/acme/widgets/issues/9' }),
          comment: {
            id: 9001,
            created_at: '2026-08-26T12:00:00Z',
            updated_at: '2026-08-26T14:00:00Z',
            user: { login: 'ada' },
          },
          sender: { login: 'different-trigger' },
        })
      )
    ).toMatchObject({
      eventType: 'issue_comment',
      action: 'created',
      occurredAt: '2026-08-26T12:00:00.000Z',
      actorLogin: 'ada',
      nativeId: '9001',
      detail: null,
      url: 'https://github.com/acme/widgets/issues/9',
    })
    expect(
      extractGitHubIssueDispatchFact(
        'github',
        event('issue_comment', 'edited', {
          issue: issue(),
          comment: { id: 9001, created_at: '2026-08-26T12:00:00Z', updated_at: '2026-08-26T14:00:00Z' },
        })
      )
    ).toMatchObject({ action: 'edited', occurredAt: '2026-08-26T14:00:00.000Z', actorLogin: null })
  })

  it('rejects pull requests, other providers, and cross-repository payloads', () => {
    expect(
      extractGitHubIssueDispatchFact(
        'github',
        event('issue_comment', 'created', {
          issue: issue({ pull_request: { html_url: 'https://github.com/acme/widgets/pull/9' } }),
          comment: { id: 9001, created_at: '2026-08-26T12:00:00Z', user: { login: 'ada' } },
        })
      )
    ).toBeNull()
    expect(
      extractGitHubIssueDispatchFact(
        'github',
        event('issues', 'closed', { issue: issue({ pull_request: {}, closed_at: '2026-08-26T12:00:00Z' }) })
      )
    ).toBeNull()
    expect(
      extractGitHubIssueDispatchFact(
        'github',
        event('pull_request', 'closed', {
          number: 9,
          pull_request: { id: 900, number: 9, closed_at: '2026-08-26T12:00:00Z' },
        })
      )
    ).toBeNull()
    expect(
      extractGitHubIssueDispatchFact(
        'gitlab',
        event('issues', 'closed', { issue: issue({ closed_at: '2026-08-26T12:00:00Z' }) })
      )
    ).toBeNull()
    expect(
      extractGitHubIssueDispatchFact(
        'github',
        event('issues', 'closed', {
          issue: issue({
            closed_at: '2026-08-26T12:00:00Z',
            repository_url: 'https://api.github.com/repos/other/private',
          }),
        })
      )
    ).toBeNull()
    expect(
      extractGitHubIssueDispatchFact(
        'github',
        event('issues', 'closed', {
          issue: issue({ closed_at: '2026-08-26T12:00:00Z', repository: { full_name: 'other/private' } }),
        })
      )
    ).toBeNull()
    expect(extractGitHubIssueDispatchFact('github', event('issues', 'deleted', { issue: issue() }))).toBeNull()
  })

  it('revalidates a stored fact and rejects tampering', () => {
    const fact = extractGitHubIssueDispatchFact(
      'github',
      event('issues', 'labeled', { issue: issue(), label: { name: 'bug' }, sender: { login: 'ada' } })
    )!
    expect(isGitHubIssueDispatchFact(fact)).toBe(true)
    expect(isGitHubIssueDispatchFact(JSON.parse(JSON.stringify(fact)))).toBe(true)
    expect(isGitHubIssueDispatchFact({ ...fact, logicalRowId: '00000000-0000-4000-8000-000000000001' })).toBe(false)
    expect(isGitHubIssueDispatchFact({ ...fact, detail: 'wontfix' })).toBe(false)
    expect(isGitHubIssueDispatchFact({ ...fact, issueNumber: 10 })).toBe(false)
    expect(isGitHubIssueDispatchFact({ ...fact, repository: 'Acme/Widgets' })).toBe(false)
    expect(isGitHubIssueDispatchFact({ ...fact, action: 'deleted' })).toBe(false)
    expect(isGitHubIssueDispatchFact(null)).toBe(false)
    expect(isGitHubIssueDispatchFact('not a fact')).toBe(false)
  })

  it('describes every supported fact in past tense without inventing a subject', () => {
    const describe_ = (eventType: 'issues' | 'issue_comment', action: string, detail: string | null) =>
      describeGitHubIssueFact({ eventType, action, detail } as never)
    expect(describe_('issues', 'closed', null)).toBe('closed')
    expect(describe_('issues', 'reopened', null)).toBe('reopened')
    expect(describe_('issues', 'assigned', 'ada')).toBe('assigned to ada')
    expect(describe_('issues', 'unassigned', 'ada')).toBe('unassigned from ada')
    expect(describe_('issues', 'labeled', 'bug')).toBe('labeled bug')
    expect(describe_('issues', 'unlabeled', 'bug')).toBe('unlabeled bug')
    expect(describe_('issues', 'edited', null)).toBe('title edited')
    expect(describe_('issue_comment', 'created', null)).toBe('comment')
    expect(describe_('issue_comment', 'edited', null)).toBe('comment edited')
  })

  it('treats inherited Object.prototype names as unsupported event types instead of throwing', () => {
    for (const type of ['constructor', 'toString', 'valueOf']) {
      expect(extractGitHubIssueDispatchFact('github', event(type, 'closed', { issue: issue() }))).toBeNull()
      expect(isGitHubIssueDispatchFact({ eventType: type, action: 'closed' })).toBe(false)
    }
  })
})
