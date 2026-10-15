import { describe, expect, test } from 'bun:test'
import {
  formatQuestionAnswerChoices,
  parseQuestionAnswerCardData,
  resolveQuestionAnswers,
  SKIPPED_QUESTION_ANSWER,
} from './question-answers'
import type { QuestionData } from './types'

const select: QuestionData = {
  questions: [
    {
      id: 'risk',
      type: 'select',
      question: 'Proceed?',
      options: [
        { value: 'accept', label: 'Accept the risk' },
        { value: 'reject', label: 'Reject' },
      ],
    },
  ],
}

const multi: QuestionData = {
  questions: [
    {
      id: 'envs',
      type: 'multi-select',
      question: 'Which environments?',
      options: [
        { value: 'staging', label: 'Staging' },
        { value: 'prod, eu', label: 'Production (EU)' },
        { value: 'dev' },
      ],
    },
  ],
}

describe('resolveQuestionAnswers', () => {
  test('maps a single-select value to its label', () => {
    expect(resolveQuestionAnswers(select, 'accept')).toEqual([
      { questionId: 'risk', question: 'Proceed?', choices: [{ label: 'Accept the risk', value: 'accept' }] },
    ])
  })

  test('keeps Other text and unknown values as free text', () => {
    expect(resolveQuestionAnswers(select, 'Only on Fridays')?.[0].choices).toEqual([{ label: 'Only on Fridays' }])
  })

  test('maps each multi-select value, including values containing ", ", and keeps Other text last', () => {
    expect(resolveQuestionAnswers(multi, 'staging, prod, eu, dev, my, own')?.[0].choices).toEqual([
      { label: 'Staging', value: 'staging' },
      { label: 'Production (EU)', value: 'prod, eu' },
      { label: 'dev', value: 'dev' },
      { label: 'my, own' },
    ])
  })

  test('keeps text answers verbatim', () => {
    const text: QuestionData = { questions: [{ id: 'q', type: 'text', question: 'Why?', options: [{ value: 'x' }] }] }
    expect(resolveQuestionAnswers(text, 'x')?.[0].choices).toEqual([{ label: 'x' }])
  })

  test('treats the skip placeholder and blank answers as skipped', () => {
    expect(resolveQuestionAnswers(select, SKIPPED_QUESTION_ANSWER)?.[0].choices).toEqual([])
    expect(resolveQuestionAnswers(select, '')?.[0].choices).toEqual([])
    expect(resolveQuestionAnswers(select, null)?.[0].choices).toEqual([])
  })

  test('parses multi-question JSON per question, with skipped and unexpected keys', () => {
    const data: QuestionData = {
      questions: [
        ...select.questions,
        ...multi.questions,
        { id: 'note', type: 'text', question: 'Notes?', optional: true },
      ],
    }
    const answer = JSON.stringify({ risk: 'reject', envs: 'dev', extra: 'from the API' }, null, 2)
    expect(resolveQuestionAnswers(data, answer)).toEqual([
      { questionId: 'risk', question: 'Proceed?', choices: [{ label: 'Reject', value: 'reject' }] },
      { questionId: 'envs', question: 'Which environments?', choices: [{ label: 'dev', value: 'dev' }] },
      { questionId: 'note', question: 'Notes?', choices: [] },
      { questionId: 'extra', question: 'extra', choices: [{ label: 'from the API' }] },
    ])
    expect(resolveQuestionAnswers(data, SKIPPED_QUESTION_ANSWER)?.map((item) => item.choices)).toEqual([[], [], []])
  })

  test('returns null when the answer cannot be attributed', () => {
    const data: QuestionData = { questions: [...select.questions, ...multi.questions] }
    expect(resolveQuestionAnswers(data, 'not json')).toBeNull()
    expect(resolveQuestionAnswers(data, '["accept"]')).toBeNull()
    expect(resolveQuestionAnswers(null, 'accept')).toBeNull()
    expect(resolveQuestionAnswers({ questions: [] }, 'accept')).toBeNull()
  })
})

describe('formatQuestionAnswerChoices', () => {
  test('shows label with value, free text verbatim, and a skipped placeholder', () => {
    expect(
      formatQuestionAnswerChoices([
        { label: 'Accept the risk', value: 'accept' },
        { label: 'dev', value: 'dev' },
        { label: 'mine' },
      ])
    ).toBe('Accept the risk (accept), dev, mine')
    expect(formatQuestionAnswerChoices([])).toBe('(skipped)')
  })
})

describe('parseQuestionAnswerCardData', () => {
  test('accepts the persisted shape and rejects malformed metadata', () => {
    const data = {
      questionId: 'q-1',
      answeredBy: 'Noah',
      answeredAt: '2026-10-15T00:00:00.000Z',
      questions: [
        { questionId: 'risk', question: 'Proceed?', choices: [{ label: 'Accept the risk', value: 'accept' }] },
      ],
    }
    expect(parseQuestionAnswerCardData(data)).toEqual(data)
    expect(parseQuestionAnswerCardData({ ...data, answeredBy: 5 })).toEqual({ ...data, answeredBy: undefined } as never)
    expect(parseQuestionAnswerCardData(null)).toBeNull()
    expect(parseQuestionAnswerCardData({ questionId: 'q', questions: [{ question: 'x', choices: [] }] })).toBeNull()
    expect(
      parseQuestionAnswerCardData({
        questionId: 'q',
        questions: [{ questionId: 'a', question: 'x', choices: [{ label: 1 }] }],
      })
    ).toBeNull()
  })
})
