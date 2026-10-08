import { describe, expect, test } from 'bun:test'
import {
  answerMatches,
  DECISION_YESNO_DEFAULT_THRESHOLD,
  decisionConditionIssue,
  decisionConditionQuestion,
  decisionConditionSchema,
  describeDecisionCondition,
  type DecisionCondition,
} from './decision-conditions'
import type { DecisionQuestions } from './decisions'

const questions: DecisionQuestions = {
  ready: { type: 'yesno', instructions: 'The work is ready to ship.' },
  kind: { type: 'choice', instructions: 'What kind of change is this?', options: { bug: 'A fix', feature: 'New' } },
  risk: {
    type: 'score',
    instructions: 'How risky is the change?',
    levels: [{ label: 'Low' }, { label: 'Medium' }, { label: 'High' }],
  },
}

describe('decisionConditionSchema', () => {
  test('accepts one condition per question type', () => {
    for (const condition of [
      { type: 'yesno', question: 'ready', op: 'at-least', probability: 0.8 },
      { type: 'choice', question: 'kind', equals: 'bug' },
      { type: 'choice', question: 'kind', equals: 'bug', minConfidence: 0.6 },
      { type: 'score', question: 'risk', op: 'at-most', level: 'Medium' },
    ])
      expect(decisionConditionSchema.parse(condition)).toEqual(condition as DecisionCondition)
  })

  test('rejects thresholds outside 0 to 1, unknown comparisons and extra fields', () => {
    const invalid = [
      { type: 'yesno', question: 'ready', op: 'at-least', probability: 1.2 },
      { type: 'yesno', question: 'ready', op: 'at-least', probability: -0.1 },
      { type: 'yesno', question: 'ready', op: 'above', probability: 0.5 },
      { type: 'choice', question: 'kind', equals: 'bug', minConfidence: 2 },
      { type: 'score', question: 'risk', op: 'at-least' },
      { type: 'yesno', question: 'Ready!', op: 'at-least', probability: 0.5 },
      { type: 'yesno', question: 'ready', op: 'at-least', probability: 0.5, extra: true },
    ]
    for (const condition of invalid) expect(decisionConditionSchema.safeParse(condition).success).toBe(false)
    const issue = decisionConditionSchema.safeParse(invalid[0]).error!.issues[0]!
    expect(issue.message).toBe('Use a probability from 0 to 1.')
  })
})

describe('answerMatches', () => {
  test('yes/no compares the probability with the threshold, inclusively', () => {
    const atLeast: DecisionCondition = { type: 'yesno', question: 'ready', op: 'at-least', probability: 0.8 }
    const atMost: DecisionCondition = { type: 'yesno', question: 'ready', op: 'at-most', probability: 0.2 }
    expect(answerMatches({ type: 'yesno', probability: 0.8 }, atLeast)).toBe(true)
    expect(answerMatches({ type: 'yesno', probability: 0.79 }, atLeast)).toBe(false)
    expect(answerMatches({ type: 'yesno', probability: 0.2 }, atMost)).toBe(true)
    expect(answerMatches({ type: 'yesno', probability: 0.21 }, atMost)).toBe(false)
  })

  test('choice matches the chosen option, and its probability when a confidence is required', () => {
    const answer = { type: 'choice' as const, choice: 'bug', probabilities: { bug: 0.7, feature: 0.3 } }
    expect(answerMatches(answer, { type: 'choice', question: 'kind', equals: 'bug' })).toBe(true)
    expect(answerMatches(answer, { type: 'choice', question: 'kind', equals: 'feature' })).toBe(false)
    expect(answerMatches(answer, { type: 'choice', question: 'kind', equals: 'bug', minConfidence: 0.7 })).toBe(true)
    expect(answerMatches(answer, { type: 'choice', question: 'kind', equals: 'bug', minConfidence: 0.71 })).toBe(false)
  })

  test('score compares level positions, lowest first', () => {
    const answer = { type: 'score' as const, score: 1.2, level: 'Medium', probabilities: {} }
    const atLeast = (level: string): DecisionCondition => ({ type: 'score', question: 'risk', op: 'at-least', level })
    const atMost = (level: string): DecisionCondition => ({ type: 'score', question: 'risk', op: 'at-most', level })
    expect(answerMatches(answer, atLeast('Medium'), questions.risk)).toBe(true)
    expect(answerMatches(answer, atLeast('High'), questions.risk)).toBe(false)
    expect(answerMatches(answer, atMost('Low'), questions.risk)).toBe(false)
    expect(answerMatches(answer, atMost('Medium'), questions.risk)).toBe(true)
    // Without the question there are no levels to compare.
    expect(answerMatches(answer, atLeast('Low'))).toBe(false)
    expect(answerMatches(answer, atLeast('Unknown'), questions.risk)).toBe(false)
  })

  test('refusals, missing answers and answers of another type never match', () => {
    const condition: DecisionCondition = { type: 'yesno', question: 'ready', op: 'at-most', probability: 1 }
    expect(answerMatches({ type: 'refusal' }, condition)).toBe(false)
    expect(answerMatches(undefined, condition)).toBe(false)
    expect(answerMatches({ type: 'choice', choice: 'bug', probabilities: {} }, condition)).toBe(false)
  })
})

describe('decisionConditionIssue', () => {
  test('explains a condition its questions cannot satisfy', () => {
    expect(
      decisionConditionIssue({ type: 'yesno', question: 'ready', op: 'at-least', probability: 0.5 }, questions)
    ).toBeUndefined()
    expect(
      decisionConditionIssue({ type: 'yesno', question: 'done', op: 'at-least', probability: 0.5 }, questions)
    ).toBe("Unknown question 'done'")
    expect(decisionConditionIssue({ type: 'choice', question: 'ready', equals: 'bug' }, questions)).toBe(
      "Question 'ready' is a yesno question, not choice"
    )
    expect(decisionConditionIssue({ type: 'choice', question: 'kind', equals: 'chore' }, questions)).toBe(
      "Question 'kind' has no option 'chore'"
    )
    expect(
      decisionConditionIssue({ type: 'score', question: 'risk', op: 'at-least', level: 'Severe' }, questions)
    ).toBe("Question 'risk' has no level 'Severe'")
  })
})

test('describeDecisionCondition reads like the editor shows it', () => {
  expect(describeDecisionCondition({ type: 'yesno', question: 'ready', op: 'at-least', probability: 0.8 })).toBe(
    'ready ≥ 80%'
  )
  expect(describeDecisionCondition({ type: 'choice', question: 'kind', equals: 'bug', minConfidence: 0.6 })).toBe(
    'kind = bug (≥ 60%)'
  )
  expect(describeDecisionCondition({ type: 'score', question: 'risk', op: 'at-most', level: 'Low' })).toBe('risk ≤ Low')
})

describe('an omitted question', () => {
  const only: DecisionQuestions = { urgent: { type: 'yesno', instructions: 'It is urgent.' } }
  const unnamed: DecisionCondition = { type: 'yesno', op: 'at-least', probability: DECISION_YESNO_DEFAULT_THRESHOLD }

  test('is valid in the schema and reads the only question', () => {
    expect(decisionConditionSchema.parse(unnamed)).toEqual(unnamed)
    expect(decisionConditionSchema.parse({ type: 'choice', equals: 'bug' })).toEqual({ type: 'choice', equals: 'bug' })
    expect(decisionConditionQuestion(unnamed, only)).toBe('urgent')
    expect(decisionConditionIssue(unnamed, only)).toBeUndefined()
    expect(answerMatches({ type: 'yesno', probability: 0.5 }, unnamed)).toBe(true)
  })

  test('is an issue when there are several questions, or none', () => {
    expect(decisionConditionQuestion(unnamed, questions)).toBeUndefined()
    expect(decisionConditionIssue(unnamed, questions)).toBe(
      'Name the question this condition reads: there are 3 (ready, kind, risk)'
    )
    expect(decisionConditionIssue(unnamed, {})).toBe('There is no question for this condition to read')
  })

  test('issues about the lone question do not invent a name for it', () => {
    expect(decisionConditionIssue({ type: 'choice', equals: 'bug' }, only)).toBe(
      'The question is a yesno question, not choice'
    )
    expect(decisionConditionIssue({ type: 'choice', equals: 'chore' }, { kind: questions.kind! })).toBe(
      "The question has no option 'chore'"
    )
    expect(decisionConditionIssue({ type: 'score', op: 'at-least', level: 'Severe' }, { risk: questions.risk! })).toBe(
      "The question has no level 'Severe'"
    )
  })

  test('describes as the answer itself', () => {
    expect(describeDecisionCondition(unnamed)).toBe('yes ≥ 50%')
    expect(describeDecisionCondition({ type: 'choice', equals: 'bug' })).toBe('answer = bug')
    expect(describeDecisionCondition({ type: 'score', op: 'at-most', level: 'Low' })).toBe('level ≤ Low')
  })
})
