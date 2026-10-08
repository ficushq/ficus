import { answerMatches, describeDecisionCondition } from './decision-conditions'
import type { DecisionAnswer } from './decisions'
import type { WorkflowDecisionStep } from './workflows'

/** What a decision step's model said and which outcome it chose, kept on the attempt. */
export interface WorkflowDecisionRecord {
  /**
   * `answered`: the model answered every question. `refused`: it refused or gave no usable answer
   * to a question. `unconfigured`: no decision provider is set up. `unavailable`: none answered in time.
   */
  status: 'answered' | 'refused' | 'unconfigured' | 'unavailable'
  /** The route (its index) that matched, or the fallback that applied. */
  matched: number | 'otherwise' | 'unavailable'
  /** The outcome followed; absent while the step waits for a person to choose. */
  outcome?: string
  awaitingPerson?: boolean
  answers?: Record<string, DecisionAnswer>
  providerId?: string
  model?: string
  latencyMs?: number
  errors?: Array<{ providerId: string; error: string }>
  decidedAt: string
}

export type WorkflowDecisionReply =
  | {
      ok: true
      result: { answers: Record<string, DecisionAnswer>; providerId: string; model: string; latencyMs: number }
    }
  | { ok: false; reason: 'unconfigured' | 'unavailable'; errors: Array<{ providerId: string; error: string }> }

/**
 * Route a decision step on a decision model's reply: the first matching route wins, then
 * `otherwise`. No usable answer to any question (a refusal, a missing or mistyped answer) or no
 * reply at all follows `unavailable`. A fallback the step omits waits for a person instead of guessing.
 */
export function routeWorkflowDecision(
  step: Pick<WorkflowDecisionStep, 'questions' | 'routes' | 'otherwise' | 'unavailable'>,
  reply: WorkflowDecisionReply,
  decidedAt = new Date().toISOString()
): WorkflowDecisionRecord {
  const settle = (
    record: Omit<WorkflowDecisionRecord, 'outcome' | 'awaitingPerson' | 'decidedAt'>,
    outcome: string | undefined
  ): WorkflowDecisionRecord => ({ ...record, ...(outcome ? { outcome } : { awaitingPerson: true }), decidedAt })
  if (!reply.ok)
    return settle(
      { status: reply.reason, matched: 'unavailable', ...(reply.errors.length ? { errors: reply.errors } : {}) },
      step.unavailable
    )
  const { answers, providerId, model, latencyMs } = reply.result
  const provenance = { answers, providerId, model, latencyMs }
  const unusable = Object.entries(step.questions).some(([name, question]) => answers[name]?.type !== question.type)
  if (unusable) return settle({ status: 'refused', matched: 'unavailable', ...provenance }, step.unavailable)
  const index = step.routes.findIndex((route) =>
    answerMatches(answers[route.when.question], route.when, step.questions[route.when.question])
  )
  if (index !== -1) return settle({ status: 'answered', matched: index, ...provenance }, step.routes[index]!.outcome)
  return settle({ status: 'answered', matched: 'otherwise', ...provenance }, step.otherwise)
}

function describeAnswer(answer: DecisionAnswer): string {
  const percent = (value: number) => `${Math.round(value * 100)}%`
  switch (answer.type) {
    case 'yesno':
      return `yes ${percent(answer.probability)}`
    case 'choice': {
      const confidence = answer.probabilities[answer.choice] ?? answer.confidence
      return confidence === undefined ? answer.choice : `${answer.choice} (${percent(confidence)})`
    }
    case 'score':
      return `${answer.level} (score ${answer.score.toFixed(1)})`
    case 'refusal':
      return 'refused'
  }
}

/** Why the step went where it did, in a sentence or two: the attempt's recorded result. */
export function describeWorkflowDecision(
  step: Pick<WorkflowDecisionStep, 'routes'>,
  record: WorkflowDecisionRecord
): string {
  const reason =
    typeof record.matched === 'number'
      ? `route ${record.matched + 1}: ${step.routes[record.matched] ? describeDecisionCondition(step.routes[record.matched]!.when) : 'matched'}`
      : record.matched === 'otherwise'
        ? 'no route matched'
        : record.status === 'refused'
          ? 'the model refused or gave no usable answer'
          : record.status === 'unconfigured'
            ? 'no decision provider is configured for workflow decisions'
            : 'no decision provider answered in time'
  const lines = [
    record.outcome
      ? `Decision: '${record.outcome}' (${reason}).`
      : `No automatic decision (${reason}); waiting for a person to choose the outcome.`,
  ]
  if (record.providerId)
    lines.push(
      `Decided by ${record.providerId}${record.model ? ` · ${record.model}` : ''} in ${record.latencyMs ?? 0} ms.`
    )
  if (record.answers && Object.keys(record.answers).length)
    lines.push(
      `Answers: ${Object.entries(record.answers)
        .map(([name, answer]) => `${name}: ${describeAnswer(answer)}`)
        .join('; ')}.`
    )
  return lines.join('\n')
}

/** A decision step's routing in a few lines: what it asks and where each answer goes. */
export function describeWorkflowDecisionRouting(
  step: Pick<WorkflowDecisionStep, 'questions' | 'routes' | 'otherwise' | 'unavailable'>
): string {
  const person = 'ask a person'
  return [
    `Asks: ${Object.entries(step.questions)
      .map(([name, question]) => `${name} (${question.type === 'yesno' ? 'yes/no' : question.type})`)
      .join(', ')}`,
    ...step.routes.map((route, index) => `${index + 1}. ${describeDecisionCondition(route.when)} → ${route.outcome}`),
    `Otherwise → ${step.otherwise ?? person}`,
    `No answer → ${step.unavailable ?? person}`,
  ].join('\n')
}
