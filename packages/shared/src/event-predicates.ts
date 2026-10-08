import { z } from 'zod'
import { integrationDataPathSchema, integrationValueAt, type IntegrationOutputFact } from './integration-outputs'
import { eventDecisionDefaultFields, eventPredicateField, type EventPredicateField } from './event-predicate-catalog'
import { decisionQuestionSchema, type DecisionAnswer } from './decisions'
import {
  answerMatches,
  DECISION_YESNO_DEFAULT_THRESHOLD,
  decisionConditionIssue,
  decisionConditionSchema,
  type DecisionCondition,
} from './decision-conditions'

/** Caps on what one decision condition sends about an event. */
export const EVENT_DECISION_INPUT_MAX_FIELDS = 8
const DECISION_TEXT_MAX = 6000
const DECISION_STRING_MAX = 500
const DECISION_LIST_MAX = 50

const scalar = z.union([z.string().max(2000), z.number().finite(), z.boolean()])
export const eventPredicateSchema = z
  .object({
    field: integrationDataPathSchema,
    op: z.enum(['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists']),
    value: z.union([scalar, z.array(scalar).min(1).max(100)]),
  })
  .strict()
export type EventPredicate = z.infer<typeof eventPredicateSchema>

/**
 * Asks a decision model a question about the event and matches on its answer. Evaluated only after every
 * other check of its rule passes, at most once per event, and never with event content in the question:
 * the event goes in the decision's state, as data.
 */
export const eventDecisionPredicateSchema = z
  .object({
    kind: z.literal('decision'),
    question: decisionQuestionSchema,
    /**
     * The answer that matches, a decision condition without `question` (the predicate asks one). Defaults to
     * `{ type: 'yesno', op: 'at-least', probability: 0.5 }` for a yes/no question; required otherwise.
     */
    when: decisionConditionSchema.optional(),
    /** What of the event to send. Default: its subject, title, author, labels and text. */
    input: z
      .object({
        /** Allowlisted event fields to send instead of the default title, author and labels. */
        fields: z.array(integrationDataPathSchema).max(EVENT_DECISION_INPUT_MAX_FIELDS).optional(),
        /** Send the event's text (body or comment). Default true. */
        body: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /** When no decision model answers (none configured, or none in time). */
    onUnavailable: z.enum(['no-match', 'match']).default('no-match'),
  })
  .strict()
export type EventDecisionPredicate = z.infer<typeof eventDecisionPredicateSchema>

/** A rule condition: a typed field comparison, or a decision-model question (`kind: 'decision'`). */
export const eventRulePredicateSchema = z.discriminatedUnion('kind', [
  eventPredicateSchema.extend({ kind: z.literal('field').optional() }),
  eventDecisionPredicateSchema,
])
export type EventRulePredicate = z.infer<typeof eventRulePredicateSchema>
export const isEventDecisionPredicate = (predicate: EventRulePredicate): predicate is EventDecisionPredicate =>
  predicate.kind === 'decision'

/** Decision conditions cost a model call each; a rule asks at most this many. */
export const EVENT_DECISION_PREDICATES_MAX = 4

export function eventPredicateOperators(field: EventPredicateField): EventPredicate['op'][] {
  if (field.type === 'string[]') return ['contains', 'exists']
  return ['eq', 'neq', 'in', ...(field.type === 'number' ? (['gt', 'gte', 'lt', 'lte'] as const) : []), 'exists']
}
export function validateEventPredicates(
  source: { integration: string; output: string; version: number },
  predicates: EventRulePredicate[],
  ctx: z.RefinementCtx
) {
  if (predicates.filter(isEventDecisionPredicate).length > EVENT_DECISION_PREDICATES_MAX)
    ctx.addIssue({
      code: 'custom',
      path: ['predicates'],
      message: `Use at most ${EVENT_DECISION_PREDICATES_MAX} decision conditions per rule`,
    })
  predicates.forEach((predicate, index) => {
    if (isEventDecisionPredicate(predicate)) {
      const message = eventDecisionPredicateIssue(source, predicate)
      if (message) ctx.addIssue({ code: 'custom', path: ['predicates', index], message })
      return
    }
    const field = eventPredicateField(source, predicate.field)
    let message: string | undefined
    if (!field) message = 'Unsupported predicate field for this event version'
    else if (!eventPredicateOperators(field).includes(predicate.op)) message = 'Unsupported operator for this field'
    else {
      const type = predicate.op === 'exists' ? 'boolean' : field.type === 'string[]' ? 'string' : field.type
      const values = predicate.op === 'in' ? predicate.value : [predicate.value]
      if (!Array.isArray(values) || !values.every((value) => typeof value === type))
        message = `Predicate requires ${predicate.op === 'in' ? 'an array of ' : ''}${type} operands`
    }
    if (message) ctx.addIssue({ code: 'custom', path: ['predicates', index], message })
  })
}

/** No coercion. Missing/null never satisfy comparisons, including neq. Empty collections are present. */
export function eventPredicateMatches(predicate: EventPredicate, field: EventPredicateField, data: unknown): boolean {
  const actual = integrationValueAt(data, predicate.field)
  if (predicate.op === 'exists') return (actual !== undefined && actual !== null) === predicate.value
  if (actual === undefined || actual === null) return false
  const normalize = (value: unknown) =>
    field.normalize === 'lowercase' && typeof value === 'string' ? value.toLowerCase() : value
  if (field.type === 'string[]')
    return (
      predicate.op === 'contains' &&
      Array.isArray(actual) &&
      actual.every((item) => typeof item === 'string') &&
      actual.some((item) => normalize(item) === normalize(predicate.value))
    )
  if (typeof actual !== field.type || (typeof actual === 'number' && !Number.isFinite(actual))) return false
  const expected = normalize(predicate.value)
  const value = normalize(actual)
  switch (predicate.op) {
    case 'eq':
      return value === expected
    case 'neq':
      return value !== expected
    case 'in':
      return Array.isArray(predicate.value) && predicate.value.some((item) => value === normalize(item))
    case 'gt':
      return typeof value === 'number' && typeof expected === 'number' && value > expected
    case 'gte':
      return typeof value === 'number' && typeof expected === 'number' && value >= expected
    case 'lt':
      return typeof value === 'number' && typeof expected === 'number' && value < expected
    case 'lte':
      return typeof value === 'number' && typeof expected === 'number' && value <= expected
    default:
      return false
  }
}

function eventDecisionPredicateIssue(
  source: { integration: string; output: string; version: number },
  predicate: EventDecisionPredicate
): string | undefined {
  if (!predicate.when && predicate.question.type !== 'yesno')
    return `Decision condition needs a "when" for its ${predicate.question.type} question: which answer matches`
  if (predicate.when?.question !== undefined)
    return 'Decision condition: omit "question" in "when"; it reads the condition\'s only question'
  if (predicate.when) {
    const issue = decisionConditionIssue(predicate.when, { question: predicate.question })
    if (issue) return `Decision condition: ${issue}`
  }
  const unknown = predicate.input?.fields?.find((path) => !eventPredicateField(source, path))
  if (unknown !== undefined) return `Decision input field ${unknown} is not available for this event version`
  return
}

/** The condition a decision predicate applies: its `when`, or yes with at least 0.5. */
export function eventDecisionCondition(predicate: EventDecisionPredicate): DecisionCondition {
  return predicate.when ?? { type: 'yesno', op: 'at-least', probability: DECISION_YESNO_DEFAULT_THRESHOLD }
}

/**
 * What a decision predicate got. `answer`: the model answered. `unavailable`: no model answered, so
 * `onUnavailable` applies. `assumed`: no model was asked (the match preview's stated assumption).
 */
export type EventDecisionOutcome =
  | { answer: DecisionAnswer }
  | { unavailable: 'unconfigured' | 'unavailable' }
  | { assumed: boolean }

export function eventDecisionPredicateMatches(predicate: EventDecisionPredicate, outcome: EventDecisionOutcome) {
  if ('assumed' in outcome) return outcome.assumed
  if ('unavailable' in outcome) return predicate.onUnavailable === 'match'
  return answerMatches(outcome.answer, eventDecisionCondition(predicate), predicate.question)
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… [truncated]` : text)
function decisionValue(value: unknown): unknown {
  if (typeof value === 'string') return clip(value, DECISION_STRING_MAX)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value))
    return value
      .filter((item) => ['string', 'number', 'boolean'].includes(typeof item))
      .slice(0, DECISION_LIST_MAX)
      .map((item) => (typeof item === 'string' ? clip(item, 100) : item))
  return undefined
}

/**
 * The decision state for one event: untrusted event content, sent only as data, never in a question.
 * Fields are limited to the event's predicate allowlist; strings, lists and text are capped.
 */
export function eventDecisionState(
  integration: string,
  fact: IntegrationOutputFact,
  input: EventDecisionPredicate['input']
): Record<string, unknown> {
  const source = { integration, output: fact.output, version: fact.version }
  const paths = (input?.fields ?? eventDecisionDefaultFields(source)).filter((path) =>
    eventPredicateField(source, path)
  )
  const fields: Record<string, unknown> = {}
  for (const path of paths.slice(0, EVENT_DECISION_INPUT_MAX_FIELDS)) {
    const value = decisionValue(integrationValueAt(fact.data, path))
    if (value !== undefined && value !== '') fields[path] = value
  }
  return {
    event: `${integration} ${fact.output}`,
    subject: clip(String(fact.subject ?? ''), DECISION_STRING_MAX),
    ...(Object.keys(fields).length ? { fields } : {}),
    ...(input?.body !== false && fact.body ? { text: clip(String(fact.body), DECISION_TEXT_MAX) } : {}),
  }
}
