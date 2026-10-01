import { expect, test } from 'bun:test'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { getPostgresError, hasErrorCode, publicErrorMessage } from './errors'

test('reads only bounded PostgreSQL codes and constraint names from driver causes', () => {
  const driver = Object.assign(new Error('private'), { code: '23505', constraint_name: 'machines_name_unique' })
  const wrapped = new DrizzleQueryError('private SQL', ['private'], driver)
  expect(getPostgresError(driver)).toEqual({ code: '23505', constraint: 'machines_name_unique' })
  expect(getPostgresError(new Error('outer', { cause: wrapped }))).toEqual(getPostgresError(driver))
  expect(getPostgresError({ code: 'ECONNRESET' })).toBeUndefined()
  expect(getPostgresError({ code: 23505 })).toBeUndefined()
  expect(getPostgresError({ code: '23505', constraint_name: {} })).toEqual({ code: '23505' })
})

test('cause inspection terminates on cycles, excessive depth, primitives and accessors', () => {
  const cyclic: { cause?: unknown } = {}
  cyclic.cause = cyclic
  expect(getPostgresError(cyclic)).toBeUndefined()
  let deep: unknown = { code: '23505' }
  for (let i = 0; i < 10; i++) deep = { cause: deep }
  expect(getPostgresError(deep)).toBeUndefined()
  expect(getPostgresError(null)).toBeUndefined()
  expect(getPostgresError('23505')).toBeUndefined()
  expect(
    getPostgresError({
      get cause() {
        throw new Error('must not execute')
      },
    })
  ).toBeUndefined()
  expect(
    getPostgresError({
      get code() {
        throw new Error('must not execute')
      },
    })
  ).toBeUndefined()
})

test('public query errors are fixed summaries, even behind another wrapper', () => {
  const query = new DrizzleQueryError('private SQL', ['private'], new Error('private driver'))
  expect(publicErrorMessage(query)).toBe('Database query failed')
  expect(publicErrorMessage(new Error('outer private', { cause: query }))).toBe('Database query failed')
  expect(publicErrorMessage(new Error('Controlled validation error'))).toBe('Controlled validation error')
})

test('transport-code inspection is allowlisted and handles wrapped and cyclic errors', () => {
  const codes = new Set(['ECONNRESET'])
  expect(hasErrorCode(new Error('outer', { cause: { code: 'ECONNRESET' } }), codes)).toBe(true)
  expect(hasErrorCode({ code: 'private-code' }, codes)).toBe(false)
  const cycle: { cause?: unknown } = {}
  cycle.cause = cycle
  expect(hasErrorCode(cycle, codes)).toBe(false)
})

test('copied query messages remain private even when their typed wrapper or cause was lost', () => {
  expect(publicErrorMessage(new Error('Failed query: SQL_CANARY\nparams: VALUE_CANARY'))).toBe('Database query failed')
})

test('non-Error query strings and copied error records are safe without changing controlled messages', () => {
  expect(publicErrorMessage('Failed query: SQL_CANARY\nparams: VALUE_CANARY')).toBe('Database query failed')
  expect(publicErrorMessage({ message: 'Failed query: SQL_CANARY\nparams: VALUE_CANARY' })).toBe(
    'Database query failed'
  )
  expect(publicErrorMessage('Controlled error')).toBe('Controlled error')
  expect(publicErrorMessage({ message: 'Controlled error' })).toBe('Controlled error')
  expect(publicErrorMessage(undefined, 'Unknown error')).toBe('Unknown error')
})

test('keeps an empty ordinary Error message unchanged', () => {
  expect(publicErrorMessage(new Error())).toBe('')
})
