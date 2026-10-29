import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentTool } from '@earendil-works/pi-agent-core'

/** A confirmed task-level refusal/outcome, not a lost remote operation. */
export class ToolFeedbackError extends Error {
  constructor(
    public readonly kind: 'input' | 'exit' | 'aborted',
    message: string,
    options?: ErrorOptions & { exitCode?: number }
  ) {
    super(message, options)
    this.exitCode = options?.exitCode
  }
  readonly exitCode?: number
}

/** SDK read validation happens after our I/O boundary. Preserve remote failures
 * without interpreting their wording; SDK-only validation is ordinary feedback.
 */
export function withReadFeedback<Operations extends object>(
  operations: Operations,
  create: (operations: Operations) => AgentTool<any>
): AgentTool<any> {
  const calls = new AsyncLocalStorage<{ remoteFailure: boolean }>()
  const wrapped = Object.fromEntries(
    Object.entries(operations).map(([name, operation]) => [
      name,
      typeof operation !== 'function'
        ? operation
        : async (...args: unknown[]) => {
            const call = calls.getStore()
            try {
              const result = await operation(...args)
              if (call) call.remoteFailure = false
              return result
            } catch (error) {
              if (call) call.remoteFailure = true
              throw error
            }
          },
    ])
  ) as Operations
  const tool = create(wrapped)
  const execute = tool.execute.bind(tool)
  return {
    ...tool,
    execute: (...args) =>
      calls.run({ remoteFailure: false }, async () => {
        try {
          return await execute(...args)
        } catch (error) {
          if (calls.getStore()!.remoteFailure) throw error
          throw new ToolFeedbackError('input', error instanceof Error ? error.message : String(error), { cause: error })
        }
      }),
  }
}
