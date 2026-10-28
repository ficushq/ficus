import { zValidator as honoZValidator } from '@hono/zod-validator'
import type { Context } from 'hono'

/**
 * The 400 body Core has always answered for a failed request validation.
 *
 * Zod 3 serialized a `ZodError` as `{ issues, name }`, so `@hono/zod-validator`'s
 * `c.json(result, 400)` sent the issues. Zod 4 keeps `issues` out of `JSON.stringify`, which
 * would leave clients (the CLI, client-core, tool renderers) with only a message string.
 */
export function validationFailureBody(error: { issues: readonly unknown[] }) {
  return { success: false as const, error: { name: 'ZodError' as const, issues: error.issues } }
}

type ValidatorHook = (
  result: { success: boolean; error?: { issues: readonly unknown[] } },
  c: Context
) => unknown | Promise<unknown>

function zValidatorWithIssues(target: never, schema: never, hook?: ValidatorHook, options?: never) {
  return honoZValidator(
    target,
    schema,
    async (result: Parameters<ValidatorHook>[0], c: Context) => {
      // A route's own hook decides first, e.g. a content-free refusal.
      if (hook) {
        const response = await hook(result, c)
        if (response) return response as Response
      }
      if (!result.success && result.error) return c.json(validationFailureBody(result.error), 400)
    },
    options
  )
}

/**
 * `@hono/zod-validator`'s `zValidator`, answering failures with {@link validationFailureBody}.
 * Routes import it from here; a guard test keeps them from using the package directly.
 */
export const zValidator = zValidatorWithIssues as unknown as typeof honoZValidator
