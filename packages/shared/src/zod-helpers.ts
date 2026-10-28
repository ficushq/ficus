import { z } from 'zod'

/**
 * `z.record` whose key failures carry the key schema's own messages.
 *
 * Zod 4 wraps a rejected key in one `invalid_key` issue ("Invalid key in record") and hides the
 * key schema's issues inside it; zod 3 reported the key schema's message at the key's path. Key
 * patterns such as decision names explain themselves ("Use lowercase letters…"), so keep that.
 * Parsing behaves exactly like `z.record(key, value)`.
 */
export function keyedRecord<Key extends z.core.$ZodRecordKey, Value extends z.core.SomeType>(key: Key, value: Value) {
  return z.record(key, value, {
    error: (issue) =>
      issue.code === 'invalid_key' ? issue.issues.map((inner) => inner.message ?? inner.code).join('; ') : undefined,
  })
}

/** Reject oversized request maps before record key/value parsing can accumulate issues. */
export function boundedRecord<S extends z.ZodType>(schema: S, maxEntries: number) {
  return z
    .preprocess((value, ctx) => {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        let count = 0
        for (const key in value) {
          if (!Object.hasOwn(value, key)) continue
          if (++count > maxEntries) {
            ctx.addIssue({
              code: 'too_big',
              origin: 'object',
              maximum: maxEntries,
              inclusive: true,
              message: `Use at most ${maxEntries} entries`,
            })
            return z.NEVER
          }
        }
      }
      return value
    }, schema)
    .meta({ maxProperties: maxEntries })
}
