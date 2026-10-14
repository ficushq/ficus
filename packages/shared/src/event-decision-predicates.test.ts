import { expect, test } from 'bun:test'
import {
  assumeEventRuleDecisions,
  evaluateSquadEventRules,
  previewSquadEventRules,
  selectSquadEventRule,
  squadEventRuleSchema,
  type EventRuleDecisions,
} from './squad-event-rules'
import { eventDecisionState, eventRulePredicateSchema, type EventDecisionOutcome } from './event-predicates'
import { eventDecisionDefaultFields } from './event-predicate-catalog'
import type { IntegrationOutputFact } from './integration-outputs'

const fact: IntegrationOutputFact = {
  output: 'issue.comment',
  version: 1,
  subject: 'Issue comment: acme/repo#7',
  body: 'Issue comment by alice.\nhttps://github.com/acme/repo/issues/7\n\nProduction is down, please help!',
  eventKey: 'comment',
  resourceKey: 'acme/repo#7',
  occurredAt: '2026-10-01T00:00:00Z',
  data: {
    repository: 'acme/repo',
    issue: { number: 7, title: 'Checkout fails' },
    actor: 'alice',
    actorType: 'User',
    labels: ['bug'],
  },
}
const urgent = {
  kind: 'decision',
  question: { type: 'yesno', instructions: 'The comment reports something urgent.' },
} as const
const rule = (id: string, predicates: unknown[], type = 'notify-manager') =>
  squadEventRuleSchema.parse({
    id,
    source: { integration: 'github', output: fact.output, version: 1 },
    filters: { audience: 'any' },
    predicates,
    action: { type },
  })
const metadata = (...rules: unknown[]) => ({ integrationRules: { github: rules } })
const answering =
  (...outcomes: EventDecisionOutcome[]): EventRuleDecisions =>
  (_rule, predicates) =>
    predicates.map((_, index) => outcomes[index] ?? outcomes[0]!)

test('decision predicates validate their question, answer condition and input with clear messages', () => {
  const issues = (predicate: unknown) => {
    const result = squadEventRuleSchema.safeParse({ ...rule('r', []), predicates: [predicate] })
    return result.success ? [] : result.error.issues.map((issue) => issue.message)
  }
  expect(issues(urgent)).toEqual([])
  expect(rule('r', [urgent]).predicates as unknown).toEqual([{ ...urgent, onUnavailable: 'no-match' }])
  expect(
    issues({ ...urgent, when: { type: 'yesno', op: 'at-most', probability: 0.2 }, onUnavailable: 'match' })
  ).toEqual([])
  const kind = {
    kind: 'decision',
    question: { type: 'choice', instructions: 'What is it?', options: { bug: '', feature: '' } },
  }
  expect(issues(kind)).toEqual(['Decision condition needs a "when" for its choice question: which answer matches'])
  expect(issues({ ...kind, when: { type: 'choice', equals: 'docs' } })).toEqual([
    "Decision condition: The question has no option 'docs'",
  ])
  expect(issues({ ...kind, when: { type: 'yesno', op: 'at-least', probability: 0.5 } })).toEqual([
    'Decision condition: The question is a choice question, not yesno',
  ])
  expect(issues({ ...kind, when: { type: 'choice', equals: 'bug', minConfidence: 0.6 } })).toEqual([])
  // The predicate asks one question: its condition reads that one and does not name it.
  expect(issues({ ...kind, when: { type: 'choice', question: 'kind', equals: 'bug' } })).toEqual([
    'Decision condition: omit "question" in "when"; it reads the condition\'s only question',
  ])
  // The retired event-rule format is rejected, not translated.
  expect(issues({ ...kind, when: { answer: 'choice', is: 'bug' } }).length).toBeGreaterThan(0)
  const severity = {
    kind: 'decision',
    question: { type: 'score', instructions: 'How bad?', levels: [{ label: 'low' }, { label: 'high' }] },
  }
  expect(issues({ ...severity, when: { type: 'score', op: 'at-least', level: 'high' } })).toEqual([])
  expect(issues({ ...severity, when: { type: 'score', op: 'at-least', level: 'critical' } })).toEqual([
    "Decision condition: The question has no level 'critical'",
  ])
  expect(issues({ ...urgent, input: { fields: ['issue.title', 'labels'], body: false } })).toEqual([])
  expect(issues({ ...urgent, input: { fields: ['pullRequest.number'] } })).toEqual([
    'Decision input field pullRequest.number is not available for this event version',
  ])
  expect(issues({ ...urgent, input: { raw: true } }).length).toBeGreaterThan(0)
  expect(issues({ ...urgent, onUnavailable: 'retry' }).length).toBeGreaterThan(0)
  expect(issues({ ...urgent, extra: 1 }).length).toBeGreaterThan(0)
  const many = squadEventRuleSchema.safeParse({ ...rule('r', []), predicates: Array(5).fill(urgent) })
  expect(many.success ? [] : many.error.issues.map((issue) => issue.message)).toEqual([
    'Use at most 4 decision conditions per rule',
  ])
})

test('field and decision predicates share one list; field predicates keep their shape', () => {
  expect(eventRulePredicateSchema.parse({ field: 'actor', op: 'eq', value: 'alice' })).toEqual({
    field: 'actor',
    op: 'eq',
    value: 'alice',
  })
  expect(eventRulePredicateSchema.safeParse({ kind: 'decision' }).success).toBe(false)
  expect(eventRulePredicateSchema.safeParse({ kind: 'regex', field: 'actor' }).success).toBe(false)
})

test('deterministic checks run first: a rule that fails them never asks its decision', () => {
  let asked = 0
  const decisions: EventRuleDecisions = (_rule, predicates) => {
    asked++
    return predicates.map(() => ({ answer: { type: 'yesno', probability: 1 } }))
  }
  const gated = rule('gated', [{ field: 'actor', op: 'eq', value: 'bob' }, urgent])
  expect(selectSquadEventRule(metadata(gated), 'github', fact, '', undefined, decisions)).toBeUndefined()
  const filtered = { ...rule('filtered', [urgent]), filters: { audience: 'any' as const, labels: ['docs'] } }
  expect(selectSquadEventRule(metadata(filtered), 'github', fact, '', undefined, decisions)).toBeUndefined()
  expect(asked).toBe(0)
  // A rule after the first match is never asked either.
  const first = rule('first', [], 'ignore')
  expect(
    selectSquadEventRule(metadata(first, rule('later', [urgent])), 'github', fact, '', undefined, decisions)?.id
  ).toBe('first')
  expect(asked).toBe(0)
})

test('without an answer selection stops at the rule and reports it as pending', () => {
  const asking = rule('asking', [{ field: 'actor', op: 'eq', value: 'alice' }, urgent])
  const fallback = rule('fallback', [])
  const result = evaluateSquadEventRules(metadata(asking, fallback), 'github', fact, '')
  expect(result.selected).toBeUndefined()
  expect(result.pending?.rule.id).toBe('asking')
  expect(result.pending?.predicates).toEqual([{ ...urgent, onUnavailable: 'no-match' }])
  expect(result.preview.awaitingDecisionRuleId).toBe('asking')
  expect(result.preview.rules.map((item) => item.status)).toEqual(['awaiting-decision', 'not-evaluated'])
  expect(selectSquadEventRule(metadata(asking, fallback), 'github', fact, '')).toBeUndefined()
})

test('answers select or skip the rule; no answer follows onUnavailable', () => {
  const asking = rule('asking', [urgent])
  const strict = rule('strict', [{ ...urgent, when: { type: 'yesno', op: 'at-least', probability: 0.9 } }])
  const unlikely = rule('unlikely', [{ ...urgent, when: { type: 'yesno', op: 'at-most', probability: 0.3 } }])
  const lenient = rule('lenient', [{ ...urgent, onUnavailable: 'match' }])
  const fallback = rule('fallback', [], 'ignore')
  const select = (decisions: EventRuleDecisions, ...rules: unknown[]) =>
    selectSquadEventRule(metadata(...rules, fallback), 'github', fact, '', undefined, decisions)?.id
  expect(select(answering({ answer: { type: 'yesno', probability: 0.8 } }), asking)).toBe('asking')
  expect(select(answering({ answer: { type: 'yesno', probability: 0.2 } }), asking)).toBe('fallback')
  expect(select(answering({ answer: { type: 'yesno', probability: 0.8 } }), strict)).toBe('fallback')
  expect(select(answering({ answer: { type: 'yesno', probability: 0.5 } }), asking)).toBe('asking')
  expect(select(answering({ answer: { type: 'yesno', probability: 0.3 } }), unlikely)).toBe('unlikely')
  expect(select(answering({ answer: { type: 'yesno', probability: 0.31 } }), unlikely)).toBe('fallback')
  expect(select(answering({ answer: { type: 'refusal' } }), asking)).toBe('fallback')
  for (const reason of ['unconfigured', 'unavailable'] as const) {
    expect(select(answering({ unavailable: reason }), asking)).toBe('fallback')
    expect(select(answering({ unavailable: reason }), lenient)).toBe('lenient')
  }
  // Every decision condition of a rule must match.
  const both = rule('both', [urgent, { ...urgent, question: { type: 'yesno', instructions: 'It is a bug.' } }])
  expect(
    select(
      answering({ answer: { type: 'yesno', probability: 0.9 } }, { answer: { type: 'yesno', probability: 0.1 } }),
      both
    )
  ).toBe('fallback')
  const choice = rule('choice', [
    {
      kind: 'decision',
      question: { type: 'choice', instructions: 'Kind?', options: { bug: '', feature: '' } },
      when: { type: 'choice', equals: 'bug' },
    },
  ])
  const picked = (pick: string) =>
    answering({ answer: { type: 'choice', choice: pick, probabilities: { bug: 0.5, feature: 0.5 } } })
  expect(select(picked('bug'), choice)).toBe('choice')
  expect(select(picked('feature'), choice)).toBe('fallback')
  // Score conditions compare level positions through the predicate's own question.
  const severity = rule('severity', [
    {
      kind: 'decision',
      question: {
        type: 'score',
        instructions: 'How severe?',
        levels: [{ label: 'low' }, { label: 'medium' }, { label: 'high' }],
      },
      when: { type: 'score', op: 'at-least', level: 'medium' },
    },
  ])
  const scored = (level: string) => answering({ answer: { type: 'score', score: 0, level, probabilities: {} } })
  expect(select(scored('high'), severity)).toBe('severity')
  expect(select(scored('medium'), severity)).toBe('severity')
  expect(select(scored('low'), severity)).toBe('fallback')
})

test('preview traces decision outcomes without event values or answer numbers', () => {
  const asking = rule('asking', [urgent])
  const preview = previewSquadEventRules(
    metadata(asking),
    'github',
    fact,
    '',
    undefined,
    answering({ answer: { type: 'yesno', probability: 0.8125 } })
  )
  expect(preview.selectedRuleId).toBe('asking')
  expect(preview.rules[0]!.checks.at(-1)).toEqual({
    kind: 'decision',
    passed: true,
    description: 'Decision model (yesno): answer must satisfy the condition.',
  })
  expect(JSON.stringify(preview)).not.toContain('0.8125')
  expect(JSON.stringify(preview)).not.toContain('Production')
  const unavailable = previewSquadEventRules(
    metadata(asking),
    'github',
    fact,
    '',
    undefined,
    answering({ unavailable: 'unconfigured' })
  )
  expect(unavailable.rules[0]!.checks.at(-1)?.description).toBe(
    'Decision model (yesno): no provider configured; on unavailable, no-match.'
  )
  for (const matches of [true, false]) {
    const assumed = previewSquadEventRules(
      metadata(asking),
      'github',
      fact,
      '',
      undefined,
      assumeEventRuleDecisions(matches)
    )
    expect(assumed.selectedRuleId).toBe(matches ? 'asking' : null)
    expect(assumed.rules[0]!.checks.at(-1)?.description).toBe(
      `Decision model (yesno): assumed ${matches ? 'to match' : 'not to match'} in this preview.`
    )
  }
})

test('decision state carries the event as capped data from allowlisted fields only', () => {
  expect(eventDecisionDefaultFields({ integration: 'github', output: 'issue.comment', version: 1 })).toEqual([
    'issue.title',
    'actor',
    'actorType',
    'labels',
  ])
  expect(eventDecisionDefaultFields({ integration: 'github', output: 'pull_request.comment', version: 1 })).toEqual([
    'actor',
    'actorType',
    'labels',
  ])
  expect(eventDecisionState('github', fact, undefined)).toEqual({
    event: 'github issue.comment',
    subject: 'Issue comment: acme/repo#7',
    fields: { 'issue.title': 'Checkout fails', actor: 'alice', actorType: 'User', labels: ['bug'] },
    text: fact.body,
  })
  expect(eventDecisionState('github', fact, { fields: ['repository'], body: false })).toEqual({
    event: 'github issue.comment',
    subject: 'Issue comment: acme/repo#7',
    fields: { repository: 'acme/repo' },
  })
  const huge = {
    ...fact,
    body: 'x'.repeat(20000),
    data: {
      ...fact.data,
      issue: { number: 7, title: 't'.repeat(5000) },
      labels: Array(500).fill('l'.repeat(300)),
      secret: 'token',
    },
  }
  const state = eventDecisionState('github', huge, undefined) as { text: string; fields: Record<string, unknown> }
  expect(state.text.length).toBeLessThan(6100)
  expect(state.text.endsWith('… [truncated]')).toBe(true)
  expect((state.fields['issue.title'] as string).length).toBeLessThan(520)
  expect((state.fields.labels as string[]).length).toBe(50)
  expect(JSON.stringify(state)).not.toContain('token')
  expect(JSON.stringify(state).length).toBeLessThan(16000)
})
