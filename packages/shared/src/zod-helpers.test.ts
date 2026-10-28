import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { boundedRecord, keyedRecord } from './zod-helpers'

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

describe('boundedRecord', () => {
  test('rejects cardinality before parsing children', () => {
    let calls = 0
    const schema = boundedRecord(
      z.record(
        z.string(),
        z.preprocess((v) => {
          calls++
          return v
        }, z.number())
      ),
      2
    )
    const result = schema.safeParse({ a: 'bad', b: 'bad', c: 'bad' })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues).toMatchObject([{ code: 'too_big', maximum: 2 }])
    expect(calls).toBe(0)
  })
  test('preserves boundaries, types, keys, defaults and optionality', () => {
    const schema = boundedRecord(keyedRecord(z.string().regex(/^[a-z]+$/, 'Lowercase only'), z.number()), 2)
    expect(schema.parse({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 })
    expect(schema.optional().parse(undefined)).toBeUndefined()
    expect(schema.nullable().parse(null)).toBeNull()
    expect(schema.default({}).parse(undefined)).toEqual({})
    for (const value of [null, [], 3, { a: 'bad' }, { A: 1 }]) expect(schema.safeParse(value).success).toBe(false)
    const inherited = Object.assign(Object.create({ inherited: 3 }), { a: 1, b: 2 })
    expect(schema.safeParse(inherited).success).toBe(true)
    expect(z.toJSONSchema(schema)).toMatchObject({ type: 'object', maxProperties: 2 })
  })
  test('gates unknown enum keys before sparse record validation', () => {
    const schema = boundedRecord(z.partialRecord(z.enum(['a', 'b']), z.number()), 2)
    expect(schema.parse({ a: 1 })).toEqual({ a: 1 })
    const result = schema.safeParse({ x: 1, y: 2, z: 3 })
    expect(!result.success && result.error.issues).toMatchObject([{ code: 'too_big' }])
  })
})
