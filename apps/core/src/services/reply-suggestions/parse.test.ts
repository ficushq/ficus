import { describe, expect, test } from 'bun:test'
import { cleanReply, MAX_REPLY_CHARS, MAX_REPLY_SUGGESTIONS, parseReplySuggestions } from './parse'

describe('parseReplySuggestions', () => {
  test('reads a plain JSON array', () => {
    expect(parseReplySuggestions('["Yes, start it", "Not now", "Explain more"]')).toEqual([
      'Yes, start it',
      'Not now',
      'Explain more',
    ])
  })

  test('reads a fenced block, surrounding prose, or a replies object', () => {
    expect(parseReplySuggestions('```json\n["A", "B"]\n```')).toEqual(['A', 'B'])
    expect(parseReplySuggestions('Here you go: ["Option A", "Option B"] hope that helps')).toEqual([
      'Option A',
      'Option B',
    ])
    expect(parseReplySuggestions('{"replies": ["Yes", "No"]}')).toEqual(['Yes', 'No'])
  })

  test('bad JSON or the wrong shape yields nothing', () => {
    expect(parseReplySuggestions('Yes, start it / Not now')).toEqual([])
    expect(parseReplySuggestions('["Yes", "No"')).toEqual([])
    expect(parseReplySuggestions('{"answer": "Yes"}')).toEqual([])
    expect(parseReplySuggestions('"Yes"')).toEqual([])
    expect(parseReplySuggestions('')).toEqual([])
    expect(parseReplySuggestions('[]')).toEqual([])
  })

  test('keeps at most four replies', () => {
    const replies = parseReplySuggestions('["1", "2", "3", "4", "5", "6"]')
    expect(replies).toEqual(['1', '2', '3', '4'])
    expect(replies).toHaveLength(MAX_REPLY_SUGGESTIONS)
  })

  test('drops replies that are too long, not strings, links or duplicates', () => {
    const long = 'x'.repeat(MAX_REPLY_CHARS + 1)
    expect(
      parseReplySuggestions(
        JSON.stringify(['Yes', long, 42, null, { text: 'No' }, 'see https://evil.test', 'yes', 'Not now'])
      )
    ).toEqual(['Yes', 'Not now'])
  })

  test('a single usable reply is not worth a row of chips', () => {
    expect(parseReplySuggestions(JSON.stringify(['Yes', 'x'.repeat(200)]))).toEqual([])
  })

  test('replies become plain single-line text', () => {
    expect(parseReplySuggestions(JSON.stringify(['  "Go with\nyour pick"  ', 'Not\u202e now\u0007']))).toEqual([
      'Go with your pick',
      'Not now',
    ])
  })
})

describe('cleanReply', () => {
  test('counts characters, not UTF-16 units', () => {
    expect(cleanReply('👍'.repeat(MAX_REPLY_CHARS))).toBe('👍'.repeat(MAX_REPLY_CHARS))
    expect(cleanReply('👍'.repeat(MAX_REPLY_CHARS + 1))).toBeNull()
  })

  test('quotes and whitespace alone are no reply', () => {
    expect(cleanReply('  ""  ')).toBeNull()
    expect(cleanReply('\u200b')).toBeNull()
  })
})
