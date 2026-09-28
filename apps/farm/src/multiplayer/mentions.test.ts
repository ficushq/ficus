import { describe, expect, test } from 'bun:test'
import type { FarmPerson } from '@ficus/shared'
import { findMentions, mentionCandidates, mentionQuery, mentionsUser } from './mentions'

const ROSA: FarmPerson = { id: 'rosa', name: 'Rosa Díaz' }
const ROSS: FarmPerson = { id: 'ross', name: 'Ross' }
const SAM: FarmPerson = { id: 'sam', name: 'sam@example.com' }
const PEOPLE = [ROSA, ROSS, SAM]

describe('mentions', () => {
  test('find full names, first names and email names, the longest match winning', () => {
    const body = '@Rosa Díaz and @ross, ping @sam. Also @rosa!'
    expect(findMentions(body, PEOPLE).map((m) => [body.slice(m.start, m.end), m.userId])).toEqual([
      ['@Rosa Díaz', 'rosa'],
      ['@ross', 'ross'],
      ['@sam', 'sam'],
      ['@rosa', 'rosa'],
    ])
  })

  test('ignore emails, partial words and strangers', () => {
    expect(findMentions('mail rosa@ross.dev', PEOPLE)).toEqual([])
    expect(findMentions('@Rosalind and @rossi and @nobody', PEOPLE)).toEqual([])
    expect(mentionsUser('thanks @Ross', PEOPLE, 'ross')).toBe(true)
    expect(mentionsUser('thanks @Rosa', PEOPLE, 'ross')).toBe(false)
  })

  test('know when a name is being typed, and suggest people for it', () => {
    expect(mentionQuery('hi @ro', 6)).toEqual({ start: 3, query: 'ro' })
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionQuery('mail a@b', 8)).toBeNull()
    expect(mentionQuery('hi @ro there', 12)).toBeNull()
    expect(mentionCandidates('ro', PEOPLE, null).map((p) => p.id)).toEqual(['rosa', 'ross'])
    expect(mentionCandidates('dí', PEOPLE, null).map((p) => p.id)).toEqual(['rosa'])
    expect(mentionCandidates('', PEOPLE, 'sam').map((p) => p.id)).toEqual(['rosa', 'ross'])
  })
})
