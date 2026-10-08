import { z } from 'zod'
import { DECISION_NAME_PATTERN, type DecisionAnswer, type DecisionQuestion, type DecisionQuestions } from './decisions'

/*
 * A condition on one decision answer: the building block for routing on a decision model's
 * output (workflow decision steps, event rule conditions). Conditions name a question and
 * compare its answer; they never see free text.
 */

const questionName = z.string().regex(DECISION_NAME_PATTERN, 'Use the name of a question.')
const probability = z.number().min(0, 'Use a probability from 0 to 1.').max(1, 'Use a probability from 0 to 1.')
const comparison = z.enum(['at-least', 'at-most'])

export const decisionConditionSchema = z.discriminatedUnion('type', [
  /** The probability that a yes/no question is true, compared with a threshold. */
  z.object({ type: z.literal('yesno'), question: questionName, op: comparison, probability }).strict(),
  /** A choice question picked this option, optionally with at least this probability. */
  z
    .object({
      type: z.literal('choice'),
      question: questionName,
      equals: z.string().regex(DECISION_NAME_PATTERN, 'Use the name of an option.'),
      minConfidence: probability.optional(),
    })
    .strict(),
  /** A score question's nearest level, compared with a level of that question. */
  z
    .object({
      type: z.literal('score'),
      question: questionName,
      op: comparison,
      level: z.string().trim().min(1).max(200),
    })
    .strict(),
])
export type DecisionCondition = z.infer<typeof decisionConditionSchema>

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
  const question = Object.hasOwn(questions, condition.question) ? questions[condition.question] : undefined
  if (!question) return `Unknown question '${condition.question}'`
  if (question.type !== condition.type)
    return `Question '${condition.question}' is a ${question.type} question, not ${condition.type}`
  if (condition.type === 'choice' && question.type === 'choice' && !Object.hasOwn(question.options, condition.equals))
    return `Question '${condition.question}' has no option '${condition.equals}'`
  if (
    condition.type === 'score' &&
    question.type === 'score' &&
    !question.levels.some((level) => level.label === condition.level)
  )
    return `Question '${condition.question}' has no level '${condition.level}'`
  return undefined
}

/** A short human-readable form, e.g. `ready ≥ 80%` or `kind = bug (≥ 60%)`. */
export function describeDecisionCondition(condition: DecisionCondition): string {
  const sign = 'op' in condition ? (condition.op === 'at-least' ? '≥' : '≤') : '='
  switch (condition.type) {
    case 'yesno':
      return `${condition.question} ${sign} ${Math.round(condition.probability * 100)}%`
    case 'choice':
      return `${condition.question} = ${condition.equals}${condition.minConfidence !== undefined ? ` (≥ ${Math.round(condition.minConfidence * 100)}%)` : ''}`
    case 'score':
      return `${condition.question} ${sign} ${condition.level}`
  }
}
