import { bashOutcomeUnknownForError, SandboxTransportError } from '../sandbox/client/http-client'
import {
  replayIsHarmless,
  withToolMetadata,
  type ClassifiedToolDefinition,
  type ToolReplay,
} from '../../tools/metadata'
import { recoveryInvocationKey, recoveryOperationKey } from './operation'
import { ToolFeedbackError } from '../../tools/tool-feedback'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { FORENSIC_ASK_REFUSAL, CREDENTIAL_INPUT_REFUSAL, HumanRequestRefusalError } from '@ficus/shared'
import {
  recordRecoveryFailure,
  settleRecoveryOperation,
  settleRecoveryOnModelTool,
  recoveryRetryDelay,
  RecoveryHeldError,
  recoveryHoldGuidance,
  type RecoveryOrigin,
} from './store'
import { RESTART_RECOVERY_BRIEF } from '@ficus/shared/restart-context'
import {
  commandCanceledForRestartError,
  restartContextForCommandError,
  restartResumesExecution,
} from '../sandbox/command-drain'
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
    error instanceof HumanRequestRefusalError ||
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

/**
 * A call cut off mid-flight by a lost sandbox connection: the stream ended before a result, or the
 * response broke off. A call that could not reach its box is not interrupted; that keeps counting.
 * Restart-tagged errors have their own path (a restart is already free).
 */
function interruptedMidCall(error: unknown): boolean {
  if (bashOutcomeUnknownForError(error)) return true
  const seen = new Set<unknown>()
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof SandboxTransportError && error.phase === 'response') return true
    seen.add(error)
    error = error.cause
  }
  return false
}

/** Guidance for an interrupted call that is harmless to run again; it does not spend the budget. */
export function harmlessInterruptionGuidance(replay: ToolReplay): string {
  const why =
    replay === 'safe'
      ? 'This tool only reads, so it is safe to run again.'
      : 'Running it again with the same arguments leaves the same final state, so it is safe to repeat.'
  return `The call was interrupted before it returned a result. ${why} This interruption does not count toward the recovery budget.`
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

/**
 * Observes real calls; it never blindly repeats Bash or external side effects. Also puts the tool's
 * replay class on its definition (`tools/metadata.ts`): a call to a `safe` or `idempotent` tool
 * that a lost connection cut off is not counted as an unexplained failure.
 */
export function wrapToolWithRecovery<T extends ToolDefinition>(
  tool: T,
  origin: () => RecoveryOrigin | undefined
): Omit<ClassifiedToolDefinition<T>, 'execute'> & { execute: ToolDefinition['execute'] } {
  const execute: ToolDefinition['execute'] = tool.execute.bind(tool)
  const classified = withToolMetadata(tool)
  const harmlessInterruption = (error: unknown) =>
    replayIsHarmless(classified.ficus.replay) && !restartContextForCommandError(error) && interruptedMidCall(error)
  return {
    ...classified,
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
            // Inner transport retries report here too; a harmless interruption spends nothing.
            if (harmlessInterruption(error)) return undefined
            const record = await recordRecoveryFailure(source, {
              operationKey: operation,
              attempted: attemptedAction(tool.name),
              invocationId:
                bashOutcomeUnknownForError(error)?.invocationId ??
                createHash('sha256').update(`${source.executionId}:${toolCallId}:${ordinal++}`).digest('hex'),
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
            if (harmlessInterruption(error)) {
              const message = error instanceof Error ? error.message : String(error)
              throw new Error(`${message}\n\n${harmlessInterruptionGuidance(classified.ficus.replay)}`, {
                cause: error,
              })
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
                  // The cause is deliberately the operation's own error, not the
                  // accounting failure (logged above): callers walk this chain for
                  // the operation's restart context and failure details.
                  // eslint-disable-next-line preserve-caught-error -- see the comment above
                  { cause: error }
                )
              }
            }
            const guidance = !record
              ? 'Recovery accounting is unavailable. No recovery reference is available in this result; a durable record may already exist. Do not repeat the operation until its affected state and native recovery state can be reconciled.'
              : record.state.state === 'recovering'
                ? restart
                  ? // One brief per turn: a worker restart resumes the execution with the brief
                    // as its prompt prefix; a box-only restart keeps this turn running, so the
                    // tool result is the only carrier.
                    restartResumesExecution(restart)
                    ? ''
                    : RESTART_RECOVERY_BRIEF
                  : 'Inspect the affected state inside your authorized workspace before an explicit safe retry. Do not repeat unknown external side effects.'
                : `The unexplained-failure budget is exhausted. ${recoveryHoldGuidance(record)}`
            let message = error instanceof Error ? error.message : String(error)
            if (restart && !message.includes(`[reason: core_restart; restart id: ${restart.restartId}]`))
              message = `${commandCanceledForRestartError(restart).message} ${message}`
            throw Object.assign(
              new Error([message, guidance].filter(Boolean).join('\n\n'), { cause: error }),
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
