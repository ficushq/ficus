import { z } from 'zod'
import { boundedRecord } from './zod-helpers'

type Path = { key: string | number; parent?: Path }
function issuePath(path?: Path): Array<string | number> {
  const parts: Array<string | number> = []
  while (path) {
    parts.push(path.key)
    path = path.parent
  }
  return parts.reverse()
}

/** Only caller-supplied metadata: do not apply these budgets to accumulated server-owned history. */
export const requestMetadataSchema = z
  .preprocess(
    (input, ctx) => {
      const stack: Array<{ value: unknown; path?: Path }> = [{ value: input }]
      const seen = new WeakSet<object>()
      while (stack.length) {
        const { value, path } = stack.pop()!
        if (!value || typeof value !== 'object' || seen.has(value)) continue
        seen.add(value)
        const fail = (origin: 'array' | 'object', maximum: number) => {
          ctx.addIssue({
            code: 'too_big',
            origin,
            maximum,
            inclusive: true,
            path: issuePath(path),
            message: `Use at most ${maximum} entries`,
          })
          return z.NEVER
        }
        if (Array.isArray(value)) {
          if (value.length > 1000) return fail('array', 1000)
          for (let key = 0; key < value.length; key++) stack.push({ value: value[key], path: { key, parent: path } })
        } else {
          let count = 0
          for (const key in value) {
            if (!Object.hasOwn(value, key)) continue
            if (++count > 256) return fail('object', 256)
            stack.push({ value: (value as Record<string, unknown>)[key], path: { key, parent: path } })
          }
        }
      }
      return input
    },
    boundedRecord(z.record(z.string(), z.unknown()), 256)
  )
  .meta({ maxProperties: 256 })
