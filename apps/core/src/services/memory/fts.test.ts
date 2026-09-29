import { describe, expect, it } from 'bun:test'
import { escapeLike, queryTerms } from './fts'

describe('queryTerms', () => {
  it('lowercases, dedupes and drops stop words and bare punctuation', () => {
    expect(queryTerms('Why did we choose the SQLite store? SQLite!')).toEqual(['choose', 'sqlite', 'store'])
  })

  it('keeps identifiers whole', () => {
    expect(queryTerms('ERR_SOCKET_TIMEOUT in farm-chat.ts')).toEqual(['err_socket_timeout', 'farm-chat.ts'])
  })

  it('caps the number of terms', () => {
    expect(queryTerms(Array.from({ length: 20 }, (_, i) => `word${i}`).join(' '))).toHaveLength(12)
  })

  it('returns nothing for stop words only', () => {
    expect(queryTerms('what is the')).toEqual([])
  })
})

describe('escapeLike', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(escapeLike('100%_done\\')).toBe('100\\%\\_done\\\\')
  })
})
