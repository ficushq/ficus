import { describe, expect, it } from 'bun:test'
import type { QuestionData, QuestionItem } from '@ficus/shared'
import {
  EMPTY_ANSWER,
  OTHER_OPTION,
  formatAnswer,
  formatQuestionValue,
  initialAnswers,
  isAnswerComplete,
  isQuestionAnswered,
  toggleChoice,
} from './answerFormat'

const text = (id: string, extra: Partial<QuestionItem> = {}): QuestionItem => ({
  id,
  type: 'text',
  question: `Q ${id}`,
  ...extra,
})
const select = (id: string, extra: Partial<QuestionItem> = {}): QuestionItem => ({
  id,
  type: 'select',
  question: `Q ${id}`,
  options: [{ value: 'a' }, { value: 'b', label: 'Bee' }],
  ...extra,
})
const multi = (id: string, extra: Partial<QuestionItem> = {}): QuestionItem => ({
  id,
  type: 'multi-select',
  question: `Q ${id}`,
  options: [{ value: 'x' }, { value: 'y' }, { value: 'z' }],
  ...extra,
})
const data = (...questions: QuestionItem[]): QuestionData => ({ questions })

describe('initialAnswers', () => {
  it('uses defaults, then [] for multi-select and "" otherwise', () => {
    expect(initialAnswers(data(text('t'), select('s'), multi('m')))).toEqual({ t: '', s: '', m: [] })
    expect(
      initialAnswers(data(text('t', { default: 'hi' }), select('s', { default: 'b' }), multi('m', { default: ['y'] })))
    ).toEqual({ t: 'hi', s: 'b', m: ['y'] })
  })
})

describe('isQuestionAnswered / isAnswerComplete', () => {
  it('requires non-blank text', () => {
    expect(isQuestionAnswered(text('t'), '')).toBe(false)
    expect(isQuestionAnswered(text('t'), '   ')).toBe(false)
    expect(isQuestionAnswered(text('t'), 'ok')).toBe(true)
    expect(isQuestionAnswered(text('t'), undefined)).toBe(false)
  })

  it('always passes optional questions', () => {
    expect(isQuestionAnswered(text('t', { optional: true }), '')).toBe(true)
    expect(isQuestionAnswered(multi('m', { optional: true }), [])).toBe(true)
  })

  it('requires a selection, and the Other text when Other is picked', () => {
    expect(isQuestionAnswered(select('s'), '')).toBe(false)
    expect(isQuestionAnswered(select('s'), 'a')).toBe(true)
    expect(isQuestionAnswered(select('s'), OTHER_OPTION)).toBe(false)
    expect(isQuestionAnswered(select('s'), OTHER_OPTION, '  ')).toBe(false)
    expect(isQuestionAnswered(select('s'), OTHER_OPTION, 'custom')).toBe(true)
  })

  it('requires at least one multi-select pick, and Other text when Other is picked', () => {
    expect(isQuestionAnswered(multi('m'), [])).toBe(false)
    expect(isQuestionAnswered(multi('m'), 'x')).toBe(false)
    expect(isQuestionAnswered(multi('m'), ['x'])).toBe(true)
    expect(isQuestionAnswered(multi('m'), [OTHER_OPTION])).toBe(false)
    expect(isQuestionAnswered(multi('m'), ['x', OTHER_OPTION], 'w')).toBe(true)
  })

  it('checks every question together', () => {
    const q = data(text('t'), select('s'), multi('m', { optional: true }))
    expect(isAnswerComplete(q, { t: 'a', s: '', m: [] })).toBe(false)
    expect(isAnswerComplete(q, { t: 'a', s: 'b', m: [] })).toBe(true)
    expect(isAnswerComplete(q, { t: 'a', s: OTHER_OPTION, m: [] }, { s: 'mine' })).toBe(true)
  })
})

describe('formatQuestionValue', () => {
  it('trims text and drops blank answers', () => {
    expect(formatQuestionValue(text('t'), '  hello  ')).toBe('hello')
    expect(formatQuestionValue(text('t'), '   ')).toBeUndefined()
  })

  it('uses the Other text for select, else the trimmed choice', () => {
    expect(formatQuestionValue(select('s'), 'b')).toBe('b')
    expect(formatQuestionValue(select('s'), OTHER_OPTION, '  own  ')).toBe('own')
    expect(formatQuestionValue(select('s'), OTHER_OPTION, '')).toBeUndefined()
    expect(formatQuestionValue(select('s'), '')).toBeUndefined()
  })

  it('joins multi-select picks with ", " in pick order, Other text last', () => {
    expect(formatQuestionValue(multi('m'), ['z', 'x'])).toBe('z, x')
    expect(formatQuestionValue(multi('m'), [OTHER_OPTION, 'y'], ' w ')).toBe('y, w')
    expect(formatQuestionValue(multi('m'), [OTHER_OPTION], '')).toBeUndefined()
    expect(formatQuestionValue(multi('m'), [])).toBeUndefined()
  })
})

describe('formatAnswer', () => {
  it('sends a lone question as its raw value', () => {
    expect(formatAnswer(data(text('t')), { t: ' Blue ' })).toBe('Blue')
    expect(formatAnswer(data(select('s')), { s: 'b' })).toBe('b')
    expect(formatAnswer(data(multi('m')), { m: ['x', 'y'] })).toBe('x, y')
    expect(formatAnswer(data(select('s')), { s: OTHER_OPTION }, { s: 'teal' })).toBe('teal')
  })

  it('sends "(empty)" for a skipped optional lone question', () => {
    expect(formatAnswer(data(text('t', { optional: true })), { t: '' })).toBe(EMPTY_ANSWER)
    expect(EMPTY_ANSWER).toBe('(empty)')
  })

  it('sends several questions as pretty JSON keyed by question id, like the web', () => {
    const q = data(text('name'), select('size'), multi('extras'))
    const answer = formatAnswer(
      q,
      { name: 'Tom', size: OTHER_OPTION, extras: ['x', OTHER_OPTION] },
      { size: 'huge', extras: 'basil' }
    )
    expect(answer).toBe(JSON.stringify({ name: 'Tom', size: 'huge', extras: 'x, basil' }, null, 2))
    expect(JSON.parse(answer)).toEqual({ name: 'Tom', size: 'huge', extras: 'x, basil' })
  })

  it('omits skipped optional questions from the JSON', () => {
    const q = data(text('a'), text('b', { optional: true }))
    expect(formatAnswer(q, { a: 'yes', b: '' })).toBe(JSON.stringify({ a: 'yes' }, null, 2))
  })

  it('sends "(empty)" when every question of several was skipped', () => {
    const q = data(text('a', { optional: true }), multi('b', { optional: true }))
    expect(formatAnswer(q, { a: '', b: [] })).toBe(EMPTY_ANSWER)
  })
})

describe('toggleChoice', () => {
  it('adds and removes choices, keeping order', () => {
    expect(toggleChoice([], 'a')).toEqual(['a'])
    expect(toggleChoice(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleChoice(['a', 'b'], 'a')).toEqual(['b'])
    expect(toggleChoice('stray', 'a')).toEqual(['a'])
  })
})
