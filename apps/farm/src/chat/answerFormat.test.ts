import { describe, expect, it } from 'bun:test'
import type { QuestionItem } from '@ficus/shared'
import { OTHER, answersComplete, formatAnswer, initialAnswers } from './answerFormat'

const text = (id: string, extra: Partial<QuestionItem> = {}): QuestionItem => ({
  id,
  type: 'text',
  question: id,
  ...extra,
})
const select = (id: string, extra: Partial<QuestionItem> = {}): QuestionItem => ({
  id,
  type: 'select',
  question: id,
  options: [{ value: 'a' }, { value: 'b' }],
  ...extra,
})
const multi = (id: string, extra: Partial<QuestionItem> = {}): QuestionItem => ({
  id,
  type: 'multi-select',
  question: id,
  options: [{ value: 'x' }, { value: 'y' }, { value: 'z' }],
  ...extra,
})

describe('formatAnswer', () => {
  it('sends a lone question as its raw, trimmed value', () => {
    expect(formatAnswer([text('q')], { q: '  ship it  ' })).toBe('ship it')
  })

  it('sends several questions as pretty JSON keyed by question id', () => {
    const answer = formatAnswer([text('why'), select('which')], { why: 'because', which: 'b' })
    expect(answer).toBe(JSON.stringify({ why: 'because', which: 'b' }, null, 2))
  })

  it('joins multi-select values with ", " and swaps Other for its text', () => {
    expect(formatAnswer([multi('m')], { m: ['x', OTHER, 'z'] }, { m: ' custom ' })).toBe('x, z, custom')
  })

  it('uses the Other text for a select', () => {
    expect(formatAnswer([select('s')], { s: OTHER }, { s: 'my own' })).toBe('my own')
  })

  it('sends "(empty)" for a skipped optional lone question', () => {
    expect(formatAnswer([text('q', { optional: true })], { q: '   ' })).toBe('(empty)')
  })

  it('sends "(empty)" when every optional question is skipped, and omits skipped ones otherwise', () => {
    const qs = [text('a', { optional: true }), multi('b', { optional: true })]
    expect(formatAnswer(qs, { a: '', b: [] })).toBe('(empty)')
    expect(formatAnswer(qs, { a: 'yes', b: [] })).toBe(JSON.stringify({ a: 'yes' }, null, 2))
  })
})

describe('initialAnswers / answersComplete', () => {
  it('starts from defaults, [] for multi-select and "" otherwise', () => {
    expect(initialAnswers([text('t', { default: 'hi' }), multi('m'), select('s')])).toEqual({ t: 'hi', m: [], s: '' })
  })

  it('requires every non-optional answer and the text for a chosen Other', () => {
    const qs = [select('s'), multi('m'), text('t', { optional: true })]
    expect(answersComplete(qs, { s: 'a', m: [] })).toBe(false)
    expect(answersComplete(qs, { s: 'a', m: ['x'] })).toBe(true)
    expect(answersComplete(qs, { s: OTHER, m: ['x'] })).toBe(false)
    expect(answersComplete(qs, { s: OTHER, m: ['x'] }, { s: 'mine' })).toBe(true)
    expect(answersComplete([text('t')], { t: '  ' })).toBe(false)
  })
})
