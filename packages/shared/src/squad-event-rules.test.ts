import { describe, expect, test } from 'bun:test'
import { squadMetadataSchema } from './schemas'
import {
  effectiveSquadEventRules,
  isLinearSelfComment,
  LINEAR_DEFAULT_RULE_IDS,
  previewSquadEventRules,
  selectSquadEventRule,
  squadEventRulesSchema,
  squadEventRuleSchema,
} from './squad-event-rules'
import type { WorkflowEventTrigger } from './workflows'
import type { IntegrationOutputFact } from './integration-outputs'

const fact: IntegrationOutputFact = {
  output: 'issue.assigned',
  version: 1,
  subject: 'Assigned issue',
  body: '',
  eventKey: 'one',
  resourceKey: 'acme/repo#1',
  occurredAt: '2026-09-10T00:00:00Z',
  data: { repository: 'acme/repo', assignee: 'bot', labels: ['bug'], issue: { number: 1 } },
}
const rule = (id: string, type = 'notify-manager') =>
  squadEventRuleSchema.parse({
    id,
    source: { integration: 'github', output: fact.output, version: 1 },
    filters: { audience: 'any' },
    action: { type },
  })
test('first enabled matching rule wins, including ignore; empty config disables defaults', () => {
  const first = rule('ignored', 'ignore')
  const second = rule('manager')
  const meta = { github: [{ repo: 'acme/repo' }], integrationRules: { github: [first, second] } }
  expect(selectSquadEventRule(meta, 'github', fact, 'bot')?.action.type).toBe('ignore')
  first.enabled = false
  expect(selectSquadEventRule(meta, 'github', fact, 'bot')?.id).toBe('manager')
  expect(selectSquadEventRule({ ...meta, integrationRules: { github: [] } }, 'github', fact, 'bot')).toBeUndefined()
})
test('provider, account, repo, labels, and team filters stay scoped', () => {
  const scoped = rule('scoped')
  scoped.source.connectionId = 'a16c2a73-a1b8-4d64-bff1-87ad0905b099'
  scoped.filters = { audience: 'connected-account', squadRouting: true, repository: 'acme/*', labels: ['bug'] }
  const metadata = { github: [{ repo: 'acme/repo' }], integrationRules: { github: [scoped] } }
  const select = (input = fact, login = 'bot', account = scoped.source.connectionId) =>
    selectSquadEventRule(metadata, 'github', input, login, account)
  expect(select()?.id).toBe(scoped.id)
  expect(select(fact, 'other')).toBeUndefined()
  expect(select(fact, 'bot', 'other')).toBeUndefined()
  expect(select({ ...fact, data: { ...fact.data, repository: 'acme/other' } })).toBeUndefined()
  expect(select({ ...fact, data: { ...fact.data, labels: ['docs'] } })).toBeUndefined()
  expect(selectSquadEventRule(metadata, 'linear', fact, 'bot')).toBeUndefined()
})
test('legacy triggers are adopted with their selected workflow and metadata intact', () => {
  const trigger: WorkflowEventTrigger = {
    id: 'assigned',
    source: rule('x').source,
    match: { repository: { value: 'acme/repo' } },
    create: {
      workflow: { kind: 'preset', id: 'reviewed-coding', customizations: [] },
      titlePrefix: 'Fix: ',
      metadata: { 'github.repo': { event: 'repository' } },
    },
  }
  const rules = effectiveSquadEventRules({ integrationTriggers: [trigger] }, 'github')
  expect(rules[0]?.action).toEqual({ type: 'start-workstream', ...trigger.create })
  expect(rules[0]?.match).toEqual(trigger.match)
  expect(rules.some((rule) => rule.source.output === 'pull_request.review_requested')).toBe(true)
})
test('all four actions are shared across providers and metadata rejects invalid configurations', () => {
  for (const type of ['notify-manager', 'notify-consultant', 'start-workstream', 'ignore'] as const) {
    const item = rule('action', type)
    item.source.integration = 'linear'
    item.filters.teamId = 'team'
    const metadata = { integrationRules: { linear: [item] } }
    expect(squadMetadataSchema.safeParse(metadata).success).toBe(true)
    expect(selectSquadEventRule(metadata, 'linear', { ...fact, data: { teamId: 'team' } }, '')?.action.type).toBe(type)
    expect(selectSquadEventRule(metadata, 'linear', { ...fact, data: { teamId: 'other' } }, '')).toBeUndefined()
  }
  expect(squadEventRulesSchema.safeParse({ linear: [rule('wrong-provider')] }).success).toBe(false)
  expect(squadEventRulesSchema.safeParse({ github: [rule('duplicate'), rule('duplicate')] }).success).toBe(false)
  expect(
    squadMetadataSchema.safeParse({
      integrationRules: { github: [{ ...rule('bad'), action: { type: 'execute-shell' } }] },
    }).success
  ).toBe(false)
})

test.each(['start-workstream', 'notify-manager', 'notify-consultant'] as const)(
  'instructions for %s are optional, bounded, and retained',
  (type) => {
    const item = rule('context', type)
    const action = { type, additionalContext: '  Check accessibility.\nInclude evidence.  ' }
    expect(squadEventRuleSchema.parse({ ...item, action }).action).toMatchObject({
      additionalContext: 'Check accessibility.\nInclude evidence.',
    })
    expect(
      squadEventRuleSchema.safeParse({ ...item, action: { ...action, additionalContext: 'a'.repeat(10001) } }).success
    ).toBe(false)
  }
)

test('own comments and reviews never select squad actions, even with any-account involvement', () => {
  for (const output of [
    'issue.comment',
    'pull_request.comment',
    'pull_request.reviewed',
    'pull_request.review_comment',
  ]) {
    for (const audience of ['any', 'connected-account', 'assigned-or-mentioned'] as const) {
      const item = rule('comment')
      item.source.output = output
      item.filters.audience = audience
      const metadata = { integrationRules: { github: [item] } }
      const comment = {
        ...fact,
        output,
        body: '@bot please review',
        data: { ...fact.data, actor: 'BoT', assignees: ['bot'] },
      }
      expect(selectSquadEventRule(metadata, 'github', comment, 'bot')).toBeUndefined()
      expect(
        selectSquadEventRule(metadata, 'github', { ...comment, data: { ...comment.data, actor: 'reviewer' } }, 'bot')
          ?.id
      ).toBe(item.id)
    }
  }
  // Self-assignment still starts work; lifecycle events are not comment echoes.
  expect(
    selectSquadEventRule(
      { integrationRules: { github: [rule('assignment')] } },
      'github',
      { ...fact, data: { ...fact.data, actor: 'bot' } },
      'bot'
    )?.id
  ).toBe('assignment')
})

test('event-aware predicates accept only typed operators and allowlisted fields at metadata boundaries', () => {
  const withPredicates = (predicates: unknown, output = fact.output, integration = 'github', version = 1) => ({
    ...rule('typed'),
    source: { integration, output, version },
    predicates,
  })
  const valid = [
    { field: 'repository', op: 'eq', value: 'ACME/REPO' },
    { field: 'issue.number', op: 'gte', value: 1 },
    { field: 'labels', op: 'contains', value: 'bug' },
    { field: 'labels', op: 'not-contains', value: 'blocked' },
    { field: 'assignee', op: 'in', value: ['BOT', 'reviewer'] },
    { field: 'actor', op: 'exists', value: false },
  ]
  expect(squadMetadataSchema.safeParse({ integrationRules: { github: [withPredicates(valid)] } }).success).toBe(true)
  for (const predicates of [
    [{ field: 'repository', op: 'regex', value: '.*' }],
    [{ field: 'repository', op: 'gt', value: 'repo' }],
    [{ field: 'issue.number', op: 'eq', value: '1' }],
    [{ field: 'issue.number', op: 'in', value: [1, '2'] }],
    [{ field: 'labels', op: 'eq', value: ['bug'] }],
    [{ field: 'labels', op: 'contains', value: 1 }],
    [{ field: 'labels', op: 'not-contains', value: 1 }],
    [{ field: 'labels', op: 'not-contains', value: ['blocked'] }],
    [{ field: 'labels', op: 'not-contains', value: true }],
    [{ field: 'actor', op: 'not-contains', value: 'bot' }],
    [{ field: 'issue.number', op: 'not-contains', value: 1 }],
    [{ field: 'actor', op: 'exists', value: 'false' }],
    [{ field: 'actor', op: 'eq', value: null }],
    [{ field: 'actor', op: 'in', value: [] }],
    [{ field: 'actor', op: 'eq', value: 'bot', secret: true }],
    [{ field: 'pullRequest.number', op: 'eq', value: 1 }],
    [{ field: 'body', op: 'eq', value: 'private' }],
    [{ field: 'credentials.token', op: 'exists', value: true }],
    [{ field: 'constructor.name', op: 'eq', value: 'Object' }],
    Array.from({ length: 17 }, () => valid[0]),
  ])
    expect(squadEventRuleSchema.safeParse(withPredicates(predicates)).success).toBe(false)
  expect(squadEventRuleSchema.safeParse(withPredicates(valid, fact.output, 'github', 2)).success).toBe(false)
  expect(squadEventRuleSchema.safeParse(withPredicates(valid, 'unknown')).success).toBe(false)
  expect(squadEventRuleSchema.safeParse(withPredicates(valid, fact.output, 'linear')).success).toBe(false)
  expect(
    squadEventRuleSchema.safeParse(
      withPredicates([{ field: 'mergeConflict', op: 'eq', value: true }], 'pull_request.updated')
    ).success
  ).toBe(true)
})

test('typed predicates AND with fixed and legacy filters, normalizing only declared identity fields', () => {
  const item = {
    ...rule('typed'),
    predicates: [
      { field: 'repository', op: 'eq', value: 'ACME/REPO' },
      { field: 'issue.number', op: 'gte', value: 1 },
      { field: 'labels', op: 'contains', value: 'bug' },
    ],
  }
  const select = (data = fact.data, predicates: unknown = item.predicates) =>
    selectSquadEventRule(
      { integrationRules: { github: [{ ...item, predicates }] } },
      'github',
      { ...fact, data },
      'bot'
    )
  expect(select()?.id).toBe('typed')
  expect(select({ ...fact.data, labels: ['BUG'] })?.id).toBe('typed')
  expect(
    select({ ...fact.data, issue: { number: 1, title: 'Bug' } }, [{ field: 'issue.title', op: 'eq', value: 'bug' }])
  ).toBeUndefined()
  expect(select({ ...fact.data, issue: { number: 0 } })).toBeUndefined()
  for (const actual of [undefined, null, '1']) {
    for (const op of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'])
      expect(
        select({ ...fact.data, issue: { number: actual } }, [{ field: 'issue.number', op, value: 1 }])
      ).toBeUndefined()
  }
  for (const [data, expected] of [
    [{}, false],
    [{ labels: null }, false],
    [{ labels: [] }, true],
    [{ labels: ['bug'] }, true],
  ] as const)
    expect(!!select(data, [{ field: 'labels', op: 'exists', value: true }])).toBe(expected)
  expect(select({ labels: [] }, [{ field: 'labels', op: 'contains', value: 'bug' }])).toBeUndefined()
  expect(select({ assignees: ['BoT'] }, [{ field: 'assignees', op: 'contains', value: 'bot' }])?.id).toBe('typed')
})

test('GitHub and Linear label conditions ignore case on both the event and the saved rule', () => {
  const linearFact: IntegrationOutputFact = {
    ...fact,
    output: 'issue.updated',
    resourceKey: 'linear-issue',
    data: { teamId: 'team-1', labels: ['Blocked', 'bug'] },
  }
  const githubFact: IntegrationOutputFact = { ...fact, data: { ...fact.data, labels: ['Blocked', 'bug'] } }
  for (const [integration, event] of [
    ['github', githubFact],
    ['linear', linearFact],
  ] as const) {
    const select = (predicates: unknown, labels: string[]) =>
      selectSquadEventRule(
        {
          integrationRules: {
            [integration]: [
              {
                ...rule('labelled'),
                source: { integration, output: event.output, version: 1 },
                predicates,
              },
            ],
          },
        },
        integration,
        { ...event, data: { ...event.data, labels } },
        'bot'
      )?.id
    for (const value of ['blocked', 'BLOCKED', 'Blocked']) {
      expect(select([{ field: 'labels', op: 'contains', value }], ['Blocked'])).toBe('labelled')
      expect(select([{ field: 'labels', op: 'contains', value }], ['blocked'])).toBe('labelled')
      expect(select([{ field: 'labels', op: 'not-contains', value }], ['Blocked', 'bug'])).toBeUndefined()
      expect(select([{ field: 'labels', op: 'not-contains', value }], ['bug'])).toBe('labelled')
      expect(select([{ field: 'labels', op: 'contains', value }], ['blocked-by-design'])).toBeUndefined()
    }
  }
})

test('per-rule and shared-scope label filters ignore case', () => {
  const filtered = { ...rule('filtered'), filters: { audience: 'any' as const, squadRouting: true, labels: ['BUG'] } }
  const select = (labels: string[], sharedLabels = ['Ui']) =>
    selectSquadEventRule(
      { github: [{ repo: 'acme/repo', labels: sharedLabels }], integrationRules: { github: [filtered] } },
      'github',
      { ...fact, data: { ...fact.data, labels } },
      'bot'
    )?.id
  expect(select(['bug', 'ui'])).toBe('filtered')
  expect(select(['Bug', 'UI'])).toBe('filtered')
  expect(select(['bug'])).toBeUndefined()
  expect(select(['ui'])).toBeUndefined()
})

test('preview traces array order, failed checks, suppression and first-match shadowing without disclosing data', async () => {
  const { previewSquadEventRules } = await import('./squad-event-rules')
  expect(typeof previewSquadEventRules).toBe('function')
  const disabled = { ...rule('disabled'), enabled: false }
  const scoped = { ...rule('scoped'), filters: { squadRouting: true, audience: 'any' as const } }
  const ignored = rule('ignored', 'ignore')
  const last = rule('last')
  const metadata = { github: [], integrationRules: { github: [disabled, scoped, ignored, last] } }
  const preview = previewSquadEventRules(metadata, 'github', fact, 'bot')
  expect(preview.selectedRuleId).toBe('ignored')
  expect(preview.action).toBe('ignore')
  expect(preview.rules.map(({ id, status }) => [id, status])).toEqual([
    ['disabled', 'disabled'],
    ['scoped', 'not-matched'],
    ['ignored', 'selected'],
    ['last', 'shadowed'],
  ])
  expect(preview.rules[1]?.checks).toContainEqual(expect.objectContaining({ kind: 'shared-scope', passed: false }))
  expect(preview.rules[2]?.checks).toContainEqual(
    expect.objectContaining({ kind: 'shared-scope', passed: true, description: 'Shared scope ignored for this rule.' })
  )
  expect(JSON.stringify(preview)).not.toContain('acme/repo')
  metadata.integrationRules.github.reverse()
  expect(previewSquadEventRules(metadata, 'github', fact, 'bot').selectedRuleId).toBe('last')
  const comment = { ...fact, output: 'issue.comment', data: { actor: 'BoT' } }
  expect(previewSquadEventRules(metadata, 'github', comment, 'bot').suppression).toBe('self-comment')
  expect(previewSquadEventRules(metadata, 'github', comment, 'bot').selectedRuleId).toBeNull()
})

test('preview and selection agree for fixed/shared/predicate/legacy combinations and no-match', async () => {
  const { previewSquadEventRules } = await import('./squad-event-rules')
  expect(typeof previewSquadEventRules).toBe('function')
  for (const integration of ['github', 'linear']) {
    for (const squadRouting of [false, true]) {
      for (const labels of [[], ['bug'], ['docs']]) {
        const item = squadEventRuleSchema.parse({
          ...rule('candidate'),
          source: { integration, output: fact.output, version: 1 },
          filters: { squadRouting, labels, audience: 'any' },
          predicates: [{ field: 'assignee', op: 'neq', value: 'other' }],
          match: { assignee: { value: 'bot' } },
        })
        const metadata = {
          github: [{ repo: 'acme/repo', labels: ['bug'] }],
          linear: [{ teamId: 'team' }],
          integrationRules: { [integration]: [item] },
        }
        for (const data of [
          fact.data,
          { ...fact.data, labels: ['docs'] },
          { ...fact.data, teamId: 'team' },
          { assignee: null },
          {},
        ]) {
          const input = { ...fact, data }
          const selected = selectSquadEventRule(metadata, integration, input, 'bot')
          const preview = previewSquadEventRules(metadata, integration, input, 'bot')
          expect(preview.selectedRuleId).toBe(selected?.id ?? null)
          expect(preview.action).toBe(selected?.action.type ?? null)
        }
      }
    }
  }
})

test('synthetic samples validate event-specific flat fields and never accept bodies, credentials or arbitrary objects', async () => {
  const { syntheticEventSampleSchema, syntheticEventFact } = await import('./event-rule-sample')
  expect(typeof syntheticEventSampleSchema?.safeParse).toBe('function')
  const sample = {
    source: rule('sample').source,
    fields: { 'issue.number': 1, repository: 'acme/repo', labels: ['bug'], actor: null },
    login: 'bot',
    mentioned: true,
  }
  expect(syntheticEventSampleSchema.safeParse(sample).success).toBe(true)
  const input = syntheticEventFact(syntheticEventSampleSchema.parse(sample))
  expect(input.data).toEqual({ issue: { number: 1 }, repository: 'acme/repo', labels: ['bug'], actor: null })
  expect(input.body).toBe('@bot')
  for (const fields of [
    { body: 'private' },
    { 'issue.number': '1' },
    { 'issue.number': Infinity },
    { labels: [1] },
    { 'issue.number': { token: 'secret' } },
    { 'pullRequest.number': 1 },
    { '__proto__.token': 'secret' },
  ])
    expect(syntheticEventSampleSchema.safeParse({ ...sample, fields }).success).toBe(false)
  expect(syntheticEventSampleSchema.safeParse({ ...sample, body: 'private' }).success).toBe(false)
  expect(syntheticEventSampleSchema.safeParse({ ...sample, source: { ...sample.source, version: 2 } }).success).toBe(
    false
  )
})

test('scalar operators discriminate boundaries without coercion and collections use exact any-member semantics', () => {
  const matches = (field: string, op: string, value: unknown, data: Record<string, unknown>) =>
    !!selectSquadEventRule(
      { integrationRules: { github: [{ ...rule('operators'), predicates: [{ field, op, value }] }] } },
      'github',
      { ...fact, data },
      ''
    )
  for (const [op, expected] of [
    ['eq', [false, true, false]],
    ['neq', [true, false, true]],
    ['gt', [false, false, true]],
    ['gte', [false, true, true]],
    ['lt', [true, false, false]],
    ['lte', [true, true, false]],
  ] as const)
    expect([0, 1, 2].map((number) => matches('issue.number', op, 1, { issue: { number } }))).toEqual([...expected])
  expect(matches('issue.number', 'in', [1, 2], { issue: { number: 2 } })).toBe(true)
  expect(matches('issue.number', 'in', [1, 2], { issue: { number: 3 } })).toBe(false)
  expect(matches('assignee', 'in', ['BOT'], { assignee: 'bot' })).toBe(true)
  expect(matches('assignee', 'neq', 'BOT', { assignee: 'bot' })).toBe(false)
  expect(matches('labels', 'contains', 'bug', { labels: ['debug'] })).toBe(false)
  expect(matches('labels', 'contains', 'bug', { labels: ['docs', 'bug'] })).toBe(true)
  expect(matches('labels', 'not-contains', 'blocked', { labels: ['docs', 'blocked'] })).toBe(false)
  expect(matches('labels', 'not-contains', 'blocked', { labels: ['docs', 'unblocked'] })).toBe(true)
  expect(matches('labels', 'not-contains', 'blocked', { labels: [] })).toBe(true)
  // Labels and assignees normalize to lowercase on both sides.
  expect(matches('labels', 'not-contains', 'blocked', { labels: ['Blocked'] })).toBe(false)
  expect(matches('assignees', 'not-contains', 'bot', { assignees: ['BoT'] })).toBe(false)
  expect(matches('assignees', 'not-contains', 'BOT', { assignees: ['human'] })).toBe(true)
  for (const data of [{}, { labels: null }, { labels: 'blocked' }, { labels: ['docs', 1] }])
    expect(matches('labels', 'not-contains', 'blocked', data)).toBe(false)
  expect(matches('actor', 'exists', true, { actor: '' })).toBe(true)
  expect(matches('actor', 'exists', false, { actor: null })).toBe(true)
  expect(matches('actor', 'exists', false, {})).toBe(true)
  expect(matches('actor', 'exists', false, { actor: 'x' })).toBe(false)
})

test('shared GitHub labels preserve lifecycle-only semantics while per-rule labels always constrain', async () => {
  const { previewSquadEventRules } = await import('./squad-event-rules')
  for (const output of ['issue.assigned', 'issue.comment', 'pull_request.updated']) {
    const item = {
      ...rule('shared'),
      source: { ...rule('shared').source, output },
      filters: { squadRouting: true, audience: 'any' as const },
    }
    const metadata = { github: [{ repo: 'acme/*', labels: ['security'] }], integrationRules: { github: [item] } }
    const input = { ...fact, output, data: { ...fact.data, actor: 'human' } }
    expect(previewSquadEventRules(metadata, 'github', input, 'bot').selectedRuleId).toBe(
      output === 'issue.assigned' ? null : 'shared'
    )
    const narrowed = {
      ...metadata,
      integrationRules: { github: [{ ...item, filters: { ...item.filters, labels: ['security'] } }] },
    }
    expect(previewSquadEventRules(narrowed, 'github', input, 'bot').selectedRuleId).toBeNull()
  }
})

test('inherited object names cannot bypass the predicate or sample allowlist', async () => {
  const { syntheticEventSampleSchema } = await import('./event-rule-sample')
  for (const field of ['toString', 'valueOf', 'hasOwnProperty']) {
    expect(
      squadEventRuleSchema.safeParse({ ...rule('inherited'), predicates: [{ field, op: 'exists', value: false }] })
        .success
    ).toBe(false)
    expect(
      syntheticEventSampleSchema.safeParse({ source: rule('inherited').source, fields: { [field]: null } }).success
    ).toBe(false)
  }
})

test('Dependabot PR author routing survives save/reload and agrees with preview without changing actor gates', async () => {
  const { previewSquadEventRules, syntheticEventSampleSchema, syntheticEventFact } = await import('./index')
  const source = { integration: 'github', output: 'pull_request.review_requested', version: 1 }
  const metadata = squadMetadataSchema.parse({
    github: [{ repo: 'acme/repo' }],
    integrationRules: {
      github: [
        {
          id: 'dependabot-review',
          source,
          filters: { audience: 'connected-account', squadRouting: true },
          predicates: [
            { field: 'pullRequest.author', op: 'eq', value: 'DEPENDABOT[bot]' },
            { field: 'pullRequest.authorType', op: 'eq', value: 'Bot' },
          ],
          action: { type: 'notify-manager' },
        },
      ],
    },
  })
  const reloaded = squadMetadataSchema.parse(JSON.parse(JSON.stringify(metadata)))
  for (const [author, actor, matches] of [
    ['dependabot[bot]', 'human', true],
    ['Dependabot[bot]', 'human', true],
    ['human', 'dependabot[bot]', false],
    [undefined, 'dependabot[bot]', false],
  ] as const) {
    const sample = syntheticEventSampleSchema.parse({
      source,
      fields: {
        repository: 'acme/repo',
        'pullRequest.number': 3,
        ...(author ? { 'pullRequest.author': author, 'pullRequest.authorType': 'Bot' } : {}),
        actor,
        requestedReviewer: 'connected',
        labels: ['dependabot[bot]'],
      },
    })
    const event = syntheticEventFact(sample)
    expect(selectSquadEventRule(reloaded, 'github', event, 'connected')?.id ?? null).toBe(
      matches ? 'dependabot-review' : null
    )
    expect(previewSquadEventRules(reloaded, 'github', event, 'connected').selectedRuleId).toBe(
      matches ? 'dependabot-review' : null
    )
    expect(selectSquadEventRule(reloaded, 'github', event, 'someone-else')).toBeUndefined()
  }
})

test('collection fields offer contains, not-contains and exists; scalar fields never offer not-contains', async () => {
  const { eventPredicateOperators } = await import('./event-predicates')
  const { eventPredicateField } = await import('./event-predicate-catalog')
  for (const integration of ['github', 'linear']) {
    const labels = eventPredicateField({ integration, output: 'issue.updated', version: 1 }, 'labels')!
    expect(eventPredicateOperators(labels)).toEqual(['contains', 'not-contains', 'exists'])
  }
  expect(eventPredicateOperators({ type: 'string', description: '' })).not.toContain('not-contains')
  expect(eventPredicateOperators({ type: 'number', description: '' })).not.toContain('not-contains')
})

test('a labels not-contains rule skips blocked issues and explains itself in the preview trace', async () => {
  const { previewSquadEventRules } = await import('./squad-event-rules')
  const item = squadEventRuleSchema.parse({
    ...rule('triage'),
    predicates: [{ field: 'labels', op: 'not-contains', value: 'blocked' }],
  })
  const metadata = { integrationRules: { github: [item] } }
  const withLabels = (labels: unknown) => ({ ...fact, data: { ...fact.data, labels } })
  expect(selectSquadEventRule(metadata, 'github', withLabels(['bug', 'blocked']), 'bot')).toBeUndefined()
  expect(selectSquadEventRule(metadata, 'github', withLabels(['bug']), 'bot')?.id).toBe('triage')
  expect(selectSquadEventRule(metadata, 'github', withLabels([]), 'bot')?.id).toBe('triage')
  expect(selectSquadEventRule(metadata, 'github', withLabels(null), 'bot')).toBeUndefined()
  const preview = previewSquadEventRules(metadata, 'github', withLabels(['blocked']), 'bot')
  expect(preview.selectedRuleId).toBeNull()
  expect(preview.rules[0]?.checks).toContainEqual({
    kind: 'predicate',
    passed: false,
    description:
      'labels not-contains: requires a present collection without that member; empty collections match, missing and null do not.',
  })
  expect(JSON.stringify(preview)).not.toContain('blocked')
})

describe('Linear rules', () => {
  const app = 'app-user'
  const linear = (output: string, data: Record<string, unknown>): IntegrationOutputFact => ({
    output,
    version: 1,
    subject: 'Linear event',
    body: '',
    eventKey: output,
    resourceKey: 'issue-uuid',
    occurredAt: '2026-11-19T00:00:00Z',
    data: { teamId: 'team', actor: 'person', actorType: 'user', ...data },
  })
  const routed = { linear: [{ teamId: 'team' }] }

  test('defaults mirror GitHub: account-bound changes and mentions notify the manager', () => {
    const rules = effectiveSquadEventRules({}, 'linear')
    expect(rules.map((rule) => [rule.id, rule.source.output, rule.action.type, rule.filters.audience])).toEqual([
      ['linear-issue-assigned', 'issue.assigned', 'notify-manager', 'connected-account'],
      ['linear-issue-unassigned', 'issue.unassigned', 'notify-manager', 'connected-account'],
      ['linear-issue-delegated', 'issue.delegated', 'notify-manager', 'connected-account'],
      ['linear-issue-undelegated', 'issue.undelegated', 'notify-manager', 'connected-account'],
      ['linear-issue-mentioned', 'issue.mentioned', 'notify-manager', 'assigned-or-mentioned'],
      ['linear-issue-comment', 'issue.comment', 'notify-manager', 'assigned-or-mentioned'],
      ['linear-agent-session-prompted', 'agent_session.prompted', 'notify-manager', 'connected-account'],
    ])
    expect(rules.every((rule) => rule.filters.squadRouting)).toBe(true)
    expect(LINEAR_DEFAULT_RULE_IDS).toEqual(rules.map((rule) => rule.id))
    // Stored rules stay authoritative: new defaults never appear in a squad that saved its own list.
    expect(effectiveSquadEventRules({ integrationRules: { linear: [] } }, 'linear')).toEqual([])
  })

  test('connected-account binds the assignee, the delegate or the session app user', () => {
    const select = (fact: IntegrationOutputFact) => selectSquadEventRule(routed, 'linear', fact, app)?.id
    expect(select(linear('issue.assigned', { assignee: app }))).toBe('linear-issue-assigned')
    expect(select(linear('issue.assigned', { assignee: 'someone' }))).toBeUndefined()
    expect(select(linear('issue.delegated', { delegate: app }))).toBe('linear-issue-delegated')
    expect(select(linear('issue.delegated', { delegate: 'other-agent' }))).toBeUndefined()
    expect(select(linear('issue.undelegated', { delegate: app }))).toBe('linear-issue-undelegated')
    expect(select(linear('agent_session.prompted', { session: { id: 's', appUserId: app } }))).toBe(
      'linear-agent-session-prompted'
    )
    expect(select(linear('agent_session.prompted', { session: { id: 's', appUserId: 'other' } }))).toBeUndefined()
    // Team routing still applies: an empty route list matches nothing.
    expect(selectSquadEventRule({}, 'linear', linear('issue.delegated', { delegate: app }), app)).toBeUndefined()
  })

  test('assigned-or-mentioned matches mentions and the account’s issues, never its own or app authors', () => {
    const select = (fact: IntegrationOutputFact) => selectSquadEventRule(routed, 'linear', fact, app)?.id
    expect(select(linear('issue.mentioned', { session: { id: 's' } }))).toBe('linear-issue-mentioned')
    expect(select(linear('issue.mentioned', { actorType: 'app' }))).toBeUndefined()
    expect(select(linear('issue.comment', { assignee: app }))).toBe('linear-issue-comment')
    expect(select(linear('issue.comment', { delegate: app }))).toBe('linear-issue-comment')
    expect(select(linear('issue.comment', { assignee: 'someone' }))).toBeUndefined()
    // A comment in the account's own session thread already arrives as a mention or a prompt.
    expect(select(linear('issue.comment', { delegate: app, session: { id: 's' } }))).toBeUndefined()
  })

  test('comments authored by the connected account are suppressed as self-comments', () => {
    const comment = linear('issue.comment', { actor: app, delegate: app })
    expect(isLinearSelfComment(comment, app)).toBe(true)
    expect(isLinearSelfComment(comment, '')).toBe(false)
    const preview = previewSquadEventRules(routed, 'linear', comment, app)
    expect(preview.suppression).toBe('self-comment')
    expect(preview.selectedRuleId).toBeNull()
  })

  test('an event without a recorded account keeps the old unrestricted Linear audience', () => {
    expect(selectSquadEventRule(routed, 'linear', linear('issue.assigned', { assignee: 'someone' }), '')?.id).toBe(
      'linear-issue-assigned'
    )
    const preview = previewSquadEventRules(routed, 'linear', linear('issue.delegated', { delegate: app }), app)
    expect(preview.rules.find((rule) => rule.id === 'linear-issue-delegated')?.checks).toContainEqual({
      kind: 'audience',
      passed: true,
      description: 'Delegated or undelegated agent must be the connected account.',
    })
  })
})
