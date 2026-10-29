import { recoveryInvocationKey, recoveryOperationKey } from './operation'
import { ToolFeedbackError } from '../../tools/tool-feedback'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { FORENSIC_ASK_REFUSAL, CREDENTIAL_INPUT_REFUSAL } from '@ficus/shared'
import {
  recordRecoveryFailure,
  settleRecoveryOperation,
  settleRecoveryOnModelTool,
  recoveryRetryDelay,
  RecoveryHeldError,
  type RecoveryOrigin,
} from './store'
import { commandCanceledForRestartError, restartContextForCommandError } from '../sandbox/command-drain'
import { toolRecoveryContext, type ToolRecoveryContext } from './context'
import { createLogger } from '../../lib/infra/logger'
const log = createLogger('recovery-boundary')

function attemptedAction(name: string): string {
  if (name === 'bash' || name === 'squad_bash') return 'run the requested command'
  if (name === 'read') return 'read the project files'
  if (name === 'write' || name === 'edit') return 'update the project files'
  if (name === 'sandbox_status') return 'check whether the workspace is ready'
  return 'complete the requested operation'
}
function explainedFailure(error: unknown): boolean {
  if (error instanceof RecoveryHeldError || error instanceof RecoveryBusyError || error instanceof ToolFeedbackError)
    return true
  if (!(error instanceof Error)) return false
  if (
    error.name === 'AbortError' ||
    error.name === 'ZodError' ||
    error.message === FORENSIC_ASK_REFUSAL ||
    error.message === CREDENTIAL_INPUT_REFUSAL
  )
    return true
  const code = (error as Error & { code?: string }).code
  if (code && ['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'EISDIR', 'ENOTDIR', 'EEXIST'].includes(code)) return true
  const status = (error as Error & { status?: number }).status
  return status !== undefined && [400, 401, 403, 404, 409, 422].includes(status)
}

// One non-locking progress probe per execution, shared by all tools. Bounded
// retention avoids retaining completed executions in long-lived workers.
const modelProgress = new Map<string, Promise<void>>()
async function observeModelProgress(origin: RecoveryOrigin) {
  let pending = modelProgress.get(origin.executionId)
  if (!pending) {
    pending = settleRecoveryOnModelTool(origin).catch((error) => {
      modelProgress.delete(origin.executionId)
      log.warn('Unable to record model progress', error)
    })
    modelProgress.set(origin.executionId, pending)
    if (modelProgress.size > 512) modelProgress.delete(modelProgress.keys().next().value!)
  }
  await pending
}

const activeOperations = new Set<string>()

class RecoveryBusyError extends Error {
  constructor() {
    super('This operation is already running; inspect its result rather than starting a duplicate.')
  }
}
async function exclusiveOperation<T>(key: string, run: () => Promise<T>): Promise<T> {
  if (activeOperations.has(key)) throw new RecoveryBusyError()
  activeOperations.add(key)
  try {
    return await run()
  } finally {
    activeOperations.delete(key)
  }
}

/** Observes real calls; it never blindly repeats Bash or external side effects. */
export function wrapToolWithRecovery<T extends ToolDefinition>(
  tool: T,
  origin: () => RecoveryOrigin | undefined
): Omit<T, 'execute'> & { execute: ToolDefinition['execute'] } {
  const execute: ToolDefinition['execute'] = tool.execute.bind(tool)
  return {
    ...tool,
    execute: async (...args: Parameters<ToolDefinition['execute']>) => {
      const source = origin()
      if (!source) return execute(...args)
      await observeModelProgress(source)
      const [toolCallId, params, signal] = args
      const operation = recoveryOperationKey(tool.name, params)
      const invocation = recoveryInvocationKey(tool.name, params)
      return exclusiveOperation(`${source.agentId}:${invocation}`, async () => {
        let ordinal = 0
        const observed = new Set<unknown>()
        const context: ToolRecoveryContext = {
          beforeAttempt: async () => {
            signal?.throwIfAborted()
            for (;;) {
              const wait = await recoveryRetryDelay(source, operation).catch((error) => {
                if (error instanceof RecoveryHeldError) throw error
                log.warn('Recovery preflight unavailable; preserving the tool operation', error)
                return 0
              })
              if (!wait) break
              await delay(wait, undefined, { signal })
            }
          },
          failed: async (error) => {
            const record = await recordRecoveryFailure(source, {
              operationKey: operation,
              attempted: attemptedAction(tool.name),
              invocationId: createHash('sha256')
                .update(`${source.executionId}:${toolCallId}:${ordinal++}`)
                .digest('hex'),
              error,
            }).catch((accountingError) => {
              log.error('Unable to persist recovery outcome', accountingError)
              return undefined
            })
            observed.add(error)
            context.latest = record
            return record
          },
          observed: (error) => {
            const seen = new Set<unknown>()
            while (error && !seen.has(error)) {
              if (observed.has(error)) return true
              seen.add(error)
              error = error instanceof Error ? error.cause : undefined
            }
            return false
          },
        }
        await context.beforeAttempt()
        return toolRecoveryContext.run(context, async () => {
          let result: Awaited<ReturnType<ToolDefinition['execute']>>
          try {
            result = (await execute(...args)) as Awaited<ReturnType<ToolDefinition['execute']>>
            if (
              (result as { isError?: boolean }).isError &&
              !Number.isInteger((result as { structuredContent?: { exit_code?: number } }).structuredContent?.exit_code)
            ) {
              const text = result.content
                .filter((part) => part.type === 'text')
                .map((part) => (part.type === 'text' ? part.text : ''))
                .join('\n')
              throw new Error(text || 'The tool failed without a confirmed result')
            }
          } catch (error) {
            const restart = restartContextForCommandError(error)
            if ((!restart && signal?.aborted) || explainedFailure(error)) {
              throw error
            }
            let record = context.latest
            if (!context.observed(error)) {
              try {
                record = await context.failed(error)
              } catch (accountingError) {
                log.error('Unable to persist recovery outcome', accountingError)
                const message = error instanceof Error ? error.message : String(error)
                throw new Error(
                  `${message}\n\nRecovery accounting is unavailable. Do not repeat the operation until its affected state can be reconciled.`,
                  { cause: error }
                )
              }
            }
            const guidance =
              !record || record.state.state === 'recovering'
                ? 'Inspect the affected state inside your authorized workspace before an explicit safe retry. Do not repeat unknown external side effects.'
                : 'The unexplained-failure budget is exhausted. A generated Continue/Stop recovery decision is pending; do not request technical evidence from a person.'
            let message = error instanceof Error ? error.message : String(error)
            if (restart && !message.startsWith('This command was cancelled by a Ficus restart at '))
              message = `${commandCanceledForRestartError(restart).message} ${message}`
            throw Object.assign(
              new Error(`${message}\n\n${guidance}`, { cause: error }),
              restart ? { reason: 'core_restart', restart } : {}
            )
          }
          // An accounting outage must not turn a confirmed successful side effect
          // into an apparently failed operation that an agent might repeat.
          const outcome = result as { isError?: boolean; structuredContent?: { exit_code?: number } }
          const exitCode = outcome.structuredContent?.exit_code
          if (!outcome.isError && (!Number.isInteger(exitCode) || exitCode === 0))
            await settleRecoveryOperation(source, operation, `${source.executionId}:${toolCallId}:success`).catch(
              (error) => log.error('Unable to settle confirmed recovery outcome', error)
            )
          return result
        })
      })
    },
  }
}
