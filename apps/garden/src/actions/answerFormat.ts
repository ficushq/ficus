import type { QuestionData, QuestionItem } from '@ficus/shared'

/**
 * Pure answer building for ask_human questions. Mirrors apps/web's
 * QuestionInput (initial state, validity and the submit formatting) so an
 * answer from the garden reaches the agent byte-for-byte the same as one from
 * the web app.
 */

/** Placeholder value of the "Other" choice on select / multi-select questions. */
export const OTHER_OPTION = '__other__'
/** Sent when every (optional) question was skipped. */
export const EMPTY_ANSWER = '(empty)'

export type AnswerValue = string | string[]
export type Answers = Record<string, AnswerValue>
/** Free text typed into each question's "Other" box, by question id. */
export type OtherTexts = Record<string, string>

/** Starting values: the question's default, else [] for multi-select and '' otherwise. */
export function initialAnswers(questionData: QuestionData): Answers {
  const initial: Answers = {}
  for (const q of questionData.questions) {
    if (q.default !== undefined) initial[q.id] = q.default
    else if (q.type === 'multi-select') initial[q.id] = []
    else initial[q.id] = ''
  }
  return initial
}

/** Whether one required question has a usable answer (optional questions always pass). */
export function isQuestionAnswered(question: QuestionItem, answer: AnswerValue | undefined, otherText = ''): boolean {
  if (question.optional) return true
  const other = otherText.trim()
  if (question.type === 'multi-select') {
    if (!Array.isArray(answer) || answer.length === 0) return false
    return !(answer.includes(OTHER_OPTION) && !other)
  }
  if (!answer || (typeof answer === 'string' && !answer.trim())) return false
  if (question.type === 'select') return !(answer === OTHER_OPTION && !other)
  return true
}

/** The web's submit gate: every required question answered, "Other" text present when picked. */
export function isAnswerComplete(questionData: QuestionData, answers: Answers, otherTexts: OtherTexts = {}): boolean {
  return questionData.questions.every((q) => isQuestionAnswered(q, answers[q.id], otherTexts[q.id]))
}

/** One question's formatted value, or undefined when it has nothing to send. */
export function formatQuestionValue(
  question: QuestionItem,
  answer: AnswerValue | undefined,
  otherText = ''
): string | undefined {
  const other = otherText.trim()
  if (question.type === 'multi-select' && Array.isArray(answer)) {
    const selected = answer.filter((value) => value !== OTHER_OPTION)
    if (answer.includes(OTHER_OPTION) && other) selected.push(other)
    return selected.length > 0 ? selected.join(', ') : undefined
  }
  if (question.type === 'select' && typeof answer === 'string') {
    if (answer === OTHER_OPTION) return other || undefined
    return answer ? answer.trim() : undefined
  }
  if (typeof answer === 'string' && answer.trim()) return answer.trim()
  return undefined
}

/**
 * The answer string the agent receives: a lone question sends its raw value;
 * several send pretty-printed JSON keyed by question id. Nothing to send
 * becomes "(empty)".
 */
export function formatAnswer(questionData: QuestionData, answers: Answers, otherTexts: OtherTexts = {}): string {
  const formatted: Record<string, string> = {}
  for (const q of questionData.questions) {
    const value = formatQuestionValue(q, answers[q.id], otherTexts[q.id])
    if (value !== undefined) formatted[q.id] = value
  }
  if (questionData.questions.length === 1) return Object.values(formatted)[0] || EMPTY_ANSWER
  const json = JSON.stringify(formatted, null, 2)
  return json === '{}' ? EMPTY_ANSWER : json
}

/** Toggle one choice in a multi-select answer, keeping the pick order. */
export function toggleChoice(current: AnswerValue | undefined, value: string): string[] {
  const list = Array.isArray(current) ? current : []
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]
}
