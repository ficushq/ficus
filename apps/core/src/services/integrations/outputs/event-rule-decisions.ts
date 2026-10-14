import { createHash } from 'node:crypto'
import {
  effectiveSquadEventRules,
  evaluateSquadEventRules,
  eventDecisionState,
  type DecisionQuestion,
  type EventDecisionOutcome,
  type EventDecisionPredicate,
  type EventRuleDecisions,
  type IntegrationOutputFact,
  type SquadEventRule,
} from '@ficus/shared'
import { createLogger } from '../../../lib/infra/logger'
import { decide as defaultDecide } from '../../decisions/service'

const log = createLogger('event-rule-decisions')

export type EventRuleDecide = typeof defaultDecide

/*
 * Decision conditions in squad event rules. Rule selection itself stays synchronous and shared (the web
 * preview runs it too); this asks the decision model for the one rule selection is waiting on, then
 * evaluates again, so a decision is asked only for a rule whose every other check passed, and never for
 * a rule after the first match.
 *
 * Outcomes are kept per event (and question and state) for a while, so the stages that each select a
 * rule for one event (trigger, identity lookup, native notification) and retries in this process ask once.
 * Callers resolve before opening a transaction: a model call must never hold a squad row lock.
 */

const CACHE_TTL_MS = 15 * 60 * 1000
const CACHE_MAX = 1000
const cache = new Map<string, { expiresAt: number; outcome: Promise<EventDecisionOutcome> }>()

let injectedDecide: EventRuleDecide | undefined

/** Tests: answer event-rule decisions without a provider. Returns a restore function. */
export function setEventRuleDecideForTests(decide: EventRuleDecide | undefined) {
  const previous = injectedDecide
  injectedDecide = decide
  cache.clear()
  return () => {
    injectedDecide = previous
    cache.clear()
  }
}

export function clearEventRuleDecisionCacheForTests() {
  cache.clear()
}

export interface EventRuleContext {
  metadata: unknown
  integration: string
  fact: IntegrationOutputFact
  login: string
  connectionId?: string
  /** The integration output event: decisions are asked at most once per event. */
  eventId: string
  squadId: string
}

/** Same decision predicates under the same rule ID, so a rule edited mid-event is never given stale answers. */
const ruleKey = (rule: SquadEventRule, predicates: EventDecisionPredicate[]) => JSON.stringify([rule.id, predicates])

/**
 * Select the squad's event rule, asking decision conditions as selection reaches them. Returns the rule
 * and the decisions it used, for synchronous re-selection (inside a transaction) with the same answers.
 */
export async function resolveSquadEventRule(
  context: EventRuleContext,
  options: {
    decide?: EventRuleDecide
    /**
     * Only these actions matter to the caller: a decision is not asked when no enabled rule from the waiting
     * one on has one of them (the outcome could not change what the caller does). The rule is then undefined.
     */
    actions?: SquadEventRule['action']['type'][]
  } = {}
): Promise<{ rule: SquadEventRule | undefined; decisions: EventRuleDecisions }> {
  const outcomes = new Map<string, EventDecisionOutcome[]>()
  const decisions: EventRuleDecisions = (rule, predicates) => outcomes.get(ruleKey(rule, predicates))
  // Each round answers one more rule; there are at most 32 rules per provider.
  for (let round = 0; round <= 32; round++) {
    const { selected, pending } = evaluateSquadEventRules(
      context.metadata,
      context.integration,
      context.fact,
      context.login,
      context.connectionId,
      decisions
    )
    if (!pending) return { rule: selected, decisions }
    if (options.actions) {
      const rules = effectiveSquadEventRules(context.metadata, context.integration)
      const reachable = rules.slice(rules.findIndex((rule) => rule.id === pending.rule.id))
      if (!reachable.some((rule) => rule.enabled && options.actions!.includes(rule.action.type)))
        return { rule: undefined, decisions }
    }
    outcomes.set(
      ruleKey(pending.rule, pending.predicates),
      await askRule(context, pending.rule, pending.predicates, options.decide ?? injectedDecide ?? defaultDecide)
    )
  }
  return { rule: undefined, decisions }
}

async function askRule(
  context: EventRuleContext,
  rule: SquadEventRule,
  predicates: EventDecisionPredicate[],
  decide: EventRuleDecide
): Promise<EventDecisionOutcome[]> {
  const now = Date.now()
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key)
  const entries = predicates.map((predicate) => {
    const state = eventDecisionState(context.integration, context.fact, predicate.input)
    const key = createHash('sha256')
      .update(JSON.stringify([context.eventId, state, predicate.question]))
      .digest('hex')
    return { predicate, state, key }
  })
  const known = new Map<string, Promise<EventDecisionOutcome>>()
  for (const { key } of entries) {
    const cached = cache.get(key)?.outcome
    if (cached) known.set(key, cached)
  }
  // One model call per distinct state: a rule's questions about the same input are asked together.
  const groups = new Map<string, Array<(typeof entries)[number]>>()
  const grouped = new Set<string>()
  for (const entry of entries) {
    if (known.has(entry.key) || grouped.has(entry.key)) continue
    grouped.add(entry.key)
    const stateKey = JSON.stringify(entry.state)
    groups.set(stateKey, [...(groups.get(stateKey) ?? []), entry])
  }
  for (const group of groups.values()) {
    const questions: Record<string, DecisionQuestion> = {}
    group.forEach((entry, index) => (questions[`q${index}`] = entry.predicate.question))
    const call = (async () => {
      try {
        // Untrusted event content goes only in `state`; the questions are the squad's own configuration.
        return await decide(
          'event-rules',
          { state: group[0]!.state, questions },
          { source: { kind: 'event-rule', squadId: context.squadId, ruleId: rule.id, eventId: context.eventId } }
        )
      } catch (error) {
        log.warn('Event rule decision failed', { squadId: context.squadId, ruleId: rule.id, error: String(error) })
        return { ok: false as const, reason: 'unavailable' as const, errors: [] }
      }
    })()
    group.forEach((entry, index) => {
      const outcome = call.then((result): EventDecisionOutcome => {
        if (!result.ok) return { unavailable: result.reason }
        const answer = result.result.answers[`q${index}`]
        return answer ? { answer } : { unavailable: 'unavailable' }
      })
      known.set(entry.key, outcome)
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
      cache.set(entry.key, { expiresAt: now + CACHE_TTL_MS, outcome })
    })
  }
  const outcomes = await Promise.all(entries.map((entry) => known.get(entry.key)!))
  log.info('Event rule decision', {
    squadId: context.squadId,
    ruleId: rule.id,
    eventId: context.eventId,
    outcomes: outcomes.map((outcome) =>
      'answer' in outcome ? outcome.answer : 'unavailable' in outcome ? outcome.unavailable : 'assumed'
    ),
  })
  return outcomes
}
