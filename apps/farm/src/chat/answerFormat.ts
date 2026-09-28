import type { QuestionItem } from '@ficus/shared'
import {
  formatAnswer as formatQuestionData,
  initialAnswers as initialFor,
  isAnswerComplete,
  OTHER_OPTION,
  type Answers,
  type AnswerValue,
  type OtherTexts,
} from '../actions/answerFormat'

/**
 * The chat's question card speaks in question lists; the rules themselves
 * (the web's QuestionInput answer format) live once, in actions/answerFormat.
 */
export const OTHER = OTHER_OPTION
export type { Answers, AnswerValue, OtherTexts }

export function initialAnswers(questions: QuestionItem[]): Answers {
  return initialFor({ questions })
}

export function answersComplete(questions: QuestionItem[], answers: Answers, otherTexts: OtherTexts = {}): boolean {
  return isAnswerComplete({ questions }, answers, otherTexts)
}

export function formatAnswer(questions: QuestionItem[], answers: Answers, otherTexts: OtherTexts = {}): string {
  return formatQuestionData({ questions }, answers, otherTexts)
}
