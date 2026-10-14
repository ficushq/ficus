import { z } from 'zod'
import { DECISION_NAME_PATTERN, type DecisionAnswer, type DecisionQuestion, type DecisionQuestions } from './decisions'

/*
 * A condition on one decision answer: the building block for routing on a decision model's
 * output (workflow decision steps, event rule conditions). Conditions compare a question's
 * answer; they never see free text.
 *
 * - yesno:  `{ type: 'yesno', question?, op: 'at-least' | 'at-most', probability }` — the probability of yes.
 * - choice: `{ type: 'choice', question?, equals, minConfidence? }` — the option picked, optionally with at least
 *           this probability.
 * - score:  `{ type: 'score', question?, op: 'at-least' | 'at-most', level }` — the nearest level, by position.
 *
 * `question` names the question the condition reads. Omit it where there is only one question (an event rule
 * condition asks one); with several questions it is required. Editors of multi-question steps always write it.
 */

const questionName = z.string().regex(DECISION_NAME_PATTERN, 'Use the name of a question.')
const probability = z.number().min(0, 'Use a probability from 0 to 1.').max(1, 'Use a probability from 0 to 1.')
const comparison = z.enum(['at-least', 'at-most'])

export const decisionConditionSchema = z.discriminatedUnion('type', [
  /** The probability that a yes/no question is true, compared with a threshold. */
  z.object({ type: z.literal('yesno'), question: questionName.optional(), op: comparison, probability }).strict(),
  /** A choice question picked this option, optionally with at least this probability. */
  z
    .object({
      type: z.literal('choice'),
      question: questionName.optional(),
      equals: z.string().regex(DECISION_NAME_PATTERN, 'Use the name of an option.'),
      minConfidence: probability.optional(),
    })
    .strict(),
  /** A score question's nearest level, compared with a level of that question. */
  z
    .object({
      type: z.literal('score'),
      question: questionName.optional(),
      op: comparison,
      level: z.string().trim().min(1).max(200),
    })
    .strict(),
])
export type DecisionCondition = z.infer<typeof decisionConditionSchema>

/** The yes/no probability an event rule condition asks for when it gives no condition of its own. */
export const DECISION_YESNO_DEFAULT_THRESHOLD = 0.5

/** The name of the question a condition reads: its own, else the only question. Undefined when ambiguous. */
export function decisionConditionQuestion(
  condition: DecisionCondition,
  questions: DecisionQuestions
): string | undefined {
  if (condition.question !== undefined) return condition.question
  const names = Object.keys(questions)
  return names.length === 1 ? names[0] : undefined
}

const compare = (op: z.infer<typeof comparison>, value: number, threshold: number) =>
  op === 'at-least' ? value >= threshold : value <= threshold

/**
 * Whether an answer satisfies a condition. A refusal, or an answer of another type, never matches.
 * Score conditions compare level positions, so they need the question (its levels, lowest first).
 */
export function answerMatches(
  answer: DecisionAnswer | undefined,
  condition: DecisionCondition,
  question?: DecisionQuestion
): boolean {
  if (!answer || answer.type !== condition.type) return false
  switch (condition.type) {
    case 'yesno':
      return answer.type === 'yesno' && compare(condition.op, answer.probability, condition.probability)
    case 'choice': {
      if (answer.type !== 'choice' || answer.choice !== condition.equals) return false
      if (condition.minConfidence === undefined) return true
      const confidence = answer.probabilities[condition.equals] ?? answer.confidence
      return confidence !== undefined && confidence >= condition.minConfidence
    }
    case 'score': {
      if (answer.type !== 'score' || question?.type !== 'score') return false
      const labels = question.levels.map((level) => level.label)
      const actual = labels.indexOf(answer.level)
      const threshold = labels.indexOf(condition.level)
      return actual !== -1 && threshold !== -1 && compare(condition.op, actual, threshold)
    }
  }
}

/** Why a condition cannot apply to these questions, or undefined when it can. */
export function decisionConditionIssue(condition: DecisionCondition, questions: DecisionQuestions): string | undefined {
  const name = decisionConditionQuestion(condition, questions)
  if (name === undefined) {
    const names = Object.keys(questions)
    return names.length
      ? `Name the question this condition reads: there are ${names.length} (${names.join(', ')})`
      : 'There is no question for this condition to read'
  }
  const question = Object.hasOwn(questions, name) ? questions[name] : undefined
  if (!question) return `Unknown question '${name}'`
  // Named only when the condition names it: a lone, unnamed question is just "the question".
  const label = condition.question === undefined ? 'The question' : `Question '${name}'`
  if (question.type !== condition.type) return `${label} is a ${question.type} question, not ${condition.type}`
  if (condition.type === 'choice' && question.type === 'choice' && !Object.hasOwn(question.options, condition.equals))
    return `${label} has no option '${condition.equals}'`
  if (
    condition.type === 'score' &&
    question.type === 'score' &&
    !question.levels.some((level) => level.label === condition.level)
  )
    return `${label} has no level '${condition.level}'`
  return undefined
}

/** A short human-readable form, e.g. `ready ≥ 80%` or `kind = bug (≥ 60%)`; `yes ≥ 80%` without a question name. */
export function describeDecisionCondition(condition: DecisionCondition): string {
  const sign = 'op' in condition ? (condition.op === 'at-least' ? '≥' : '≤') : '='
  switch (condition.type) {
    case 'yesno':
      return `${condition.question ?? 'yes'} ${sign} ${Math.round(condition.probability * 100)}%`
    case 'choice':
      return `${condition.question ?? 'answer'} = ${condition.equals}${condition.minConfidence !== undefined ? ` (≥ ${Math.round(condition.minConfidence * 100)}%)` : ''}`
    case 'score':
      return `${condition.question ?? 'level'} ${sign} ${condition.level}`
  }
}
