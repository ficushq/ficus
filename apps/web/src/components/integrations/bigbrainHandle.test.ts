import { describe, expect, test } from 'bun:test'
import { managedBigbrainOwnerSchema } from '@ficus/shared/managed-bigbrain'
import { bigbrainHandleProblem, isValidBigbrainHandle, suggestBigbrainHandle } from './bigbrainHandle'

const serverAccepts = (handle: string) => managedBigbrainOwnerSchema.shape.handle.safeParse(handle).success

describe('bigbrainHandleProblem', () => {
  test('agrees with the shared server schema', () => {
    const cases = [
      'ada',
      'a',
      '0',
      'ada.lovelace',
      'ada_l-1',
      'ada.',
      'a'.repeat(64),
      'a'.repeat(65),
      '-ada',
      '.ada',
      '_ada',
      'Ada',
      'ada lovelace',
      'ada@example.com',
      'adé',
      'ficus-reader',
      'ficus-reader2',
    ]
    for (const handle of cases) expect([handle, isValidBigbrainHandle(handle)]).toEqual([handle, serverAccepts(handle)])
  })

  test('explains each kind of rejection in plain words', () => {
    expect(bigbrainHandleProblem('')).toBeNull()
    expect(bigbrainHandleProblem('ada')).toBeNull()
    expect(bigbrainHandleProblem('ada lovelace')).toBe('Use only lowercase letters, numbers, “.”, “_” and “-”.')
    expect(bigbrainHandleProblem('-ada')).toBe('Start with a lowercase letter or number.')
    expect(bigbrainHandleProblem('a'.repeat(65))).toBe('Use at most 64 characters.')
    expect(bigbrainHandleProblem('ficus-reader')).toBe('“ficus-reader” is reserved. Choose another handle.')
  })
})

describe('suggestBigbrainHandle', () => {
  test('uses the email name, without a +tag', () => {
    expect(suggestBigbrainHandle({ email: 'Ada.Lovelace+ficus@example.com', displayName: 'Countess' })).toBe(
      'ada.lovelace'
    )
  })

  test('falls back to a sanitized display name', () => {
    expect(suggestBigbrainHandle({ email: '', displayName: '  José Núñez!' })).toBe('jose-nunez')
    expect(suggestBigbrainHandle({ email: null, displayName: '__Ada__' })).toBe('ada')
  })

  test('never suggests an invalid or reserved handle', () => {
    expect(suggestBigbrainHandle(undefined)).toBe('')
    expect(suggestBigbrainHandle({ email: '+tag@example.com', displayName: '日本' })).toBe('')
    expect(suggestBigbrainHandle({ email: 'ficus-reader@example.com', displayName: null })).toBe('')
    const long = suggestBigbrainHandle({ email: `${'a'.repeat(63)}-b${'c'.repeat(10)}@example.com` })
    expect(long).toBe(`${'a'.repeat(63)}`)
    expect(isValidBigbrainHandle(long)).toBe(true)
  })
})
