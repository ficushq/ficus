import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

// Legacy forms deliberately remain in these comparisons: the cleanup must preserve
// parsed values and complete public issues (including their order and messages).
const inputs: unknown[] = [
  undefined,
  null,
  true,
  {},
  [],
  '',
  'bad',
  0,
  -1,
  1.5,
  NaN,
  Infinity,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  '12345678-1234-4234-8234-123456789abc',
  '11111111-1111-1111-1111-111111111111',
  'person@example.com',
  ' person@example.com ',
  'https://EXAMPLE.com:443/a b',
  'mailto:person@example.com',
  '2026-10-28T00:00:00Z',
  '2026-10-28T00:00:00.123+02:00',
]

function result(schema: z.ZodType, input: unknown) {
  const parsed = schema.safeParse(input)
  return parsed.success ? { data: parsed.data } : { issues: parsed.error.issues }
}

describe('Zod 4 idiom compatibility', () => {
  const pairs = [
    ['UUID', z.string().uuid(), z.uuid()],
    ['email', z.string().email(), z.email()],
    ['URL', z.string().url(), z.url()],
    ['datetime', z.string().datetime(), z.iso.datetime()],
    [
      'offset datetime',
      z.string().datetime({ offset: true, precision: 3 }),
      z.iso.datetime({ offset: true, precision: 3 }),
    ],
    ['integer', z.number().int().min(0).max(10), z.int().min(0).max(10)],
    // Removing safe() would remove a duplicate issue for unsafe integers. Retain it.
    ['safe integer', z.number().int().safe().nonnegative(), z.int().safe().nonnegative()],
  ] as const
  for (const [name, legacy, modern] of pairs) {
    test(`${name} preserves parsed values and complete error issues`, () => {
      for (const input of inputs) expect(result(modern, input)).toEqual(result(legacy, input))
    })
  }

  test('object constructors preserve unknown-key handling, defaults and nested issue paths', () => {
    const shape = { nested: z.object({ value: z.string() }), count: z.int().default(1) }
    const pairs = [
      [z.object(shape).strict(), z.strictObject(shape)],
      [z.object(shape).passthrough(), z.looseObject(shape)],
      [z.object(shape).strict().extend({ id: z.string() }).strict(), z.strictObject(shape).extend({ id: z.string() })],
    ]
    for (const [legacy, modern] of pairs) {
      for (const input of [
        ...inputs,
        { nested: { value: 'ok', extra: true } },
        { nested: { value: 2 }, count: 1.5, extra: true },
        { nested: { value: 'ok' }, extra: true, id: 'id' },
      ]) {
        expect(result(modern!, input)).toEqual(result(legacy!, input))
      }
    }
  })

  test('flattenError preserves the public formErrors/fieldErrors payload', () => {
    const schema = z.strictObject({ items: z.array(z.object({ value: z.string() })) })
    for (const input of [null, {}, { items: [{ value: 1 }, { value: false }], extra: true }]) {
      const parsed = schema.safeParse(input)
      expect(parsed.success).toBe(false)
      if (!parsed.success) expect(z.flattenError(parsed.error)).toEqual(parsed.error.flatten())
    }
  })
})
