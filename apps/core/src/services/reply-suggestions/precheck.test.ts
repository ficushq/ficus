import { describe, expect, test } from 'bun:test'
import { REPLY_SUGGESTION_FIXTURES } from './fixtures'
import { likelyAsksHuman, questionTail, stripNonQuestionText } from './precheck'

describe('likelyAsksHuman on the audit fixtures', () => {
  for (const fixture of REPLY_SUGGESTION_FIXTURES) {
    test(`${fixture.precheck ? 'passes' : 'skips'}: ${fixture.name}`, () => {
      expect(likelyAsksHuman(fixture.agent)).toBe(fixture.precheck)
    })
  }
})

describe('likelyAsksHuman', () => {
  test.each([
    'Want me to start it',
    'I can take this on. Should I go ahead',
    'Shall I merge it now.',
    'Let me know if you want the longer version.',
    'Either works; your call.',
    'Which do you prefer: the table or the list.',
    'Would you like a summary as well.',
  ])('asking phrase without a question mark: %s', (text) => {
    expect(likelyAsksHuman(text)).toBe(true)
  })

  test('only the last two paragraphs count', () => {
    expect(likelyAsksHuman('Ready to merge?\n\nI checked CI.\n\nAll green.')).toBe(false)
    expect(likelyAsksHuman('I checked CI.\n\nReady to merge?\n\nAll green.')).toBe(true)
  })

  test('a bold question as the final line is still a question', () => {
    expect(likelyAsksHuman('Everything is staged.\n\n**Want me to ship it?**')).toBe(true)
  })

  test('a bold-only heading line above the end is not', () => {
    expect(likelyAsksHuman('**Why did it fail?**\nThe token expired, so I rotated it.')).toBe(false)
  })

  test('an unterminated code fence hides what follows it', () => {
    expect(likelyAsksHuman('Here is the start:\n\n```\nconst x = a ? b : c')).toBe(false)
  })

  test('markdown links keep their label but lose the target', () => {
    expect(stripNonQuestionText('See [the run](https://ci.example.test/run?id=1).')).toBe('See the run.')
    expect(likelyAsksHuman('See [is it green?](https://ci.example.test/run?id=1)')).toBe(true)
  })

  test('empty text asks nothing', () => {
    expect(likelyAsksHuman('')).toBe(false)
    expect(questionTail('   \n\n  ')).toBe('')
  })
})
