import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { keyedRecord } from './zod-helpers'

describe('keyedRecord', () => {
  const schema = keyedRecord(
    z.string().regex(/^[a-z_]+$/, 'Use lowercase letters, digits and underscores.'),
    z.number()
  )

  test('reports the key schema message at the key path', () => {
    const result = schema.safeParse({ 'Bad Key': 1 })
    expect(!result.success && result.error.issues.map((issue) => [issue.code, issue.path, issue.message])).toEqual([
      ['invalid_key', ['Bad Key'], 'Use lowercase letters, digits and underscores.'],
    ])
  })

  test('joins several key messages', () => {
    const strict = keyedRecord(
      z
        .string()
        .min(3, 'Too short.')
        .regex(/^[a-z]+$/, 'Lowercase only.'),
      z.number()
    )
    const result = strict.safeParse({ A: 1 })
    expect(!result.success && result.error.issues[0]!.message).toBe('Too short.; Lowercase only.')
  })

  test('accepts and rejects exactly what z.record accepts', () => {
    const plain = z.record(z.string().regex(/^[a-z_]+$/), z.number())
    for (const value of [{ ok: 1 }, { ok: 'x' }, { 'Bad Key': 1 }, {}, null, []])
      expect(schema.safeParse(value).success).toBe(plain.safeParse(value).success)
  })

  test('keeps value messages unchanged', () => {
    const result = schema.safeParse({ ok: 'x' })
    expect(!result.success && result.error.issues.map((issue) => [issue.code, issue.path])).toEqual([
      ['invalid_type', ['ok']],
    ])
  })
})
