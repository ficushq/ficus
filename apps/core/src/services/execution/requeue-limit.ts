import type { InterruptionCause } from '@ficus/shared/restart-context'
import { createLogger } from '../../lib/infra/logger'
import type { RecoveryRecord } from '../recovery/store'

const log = createLogger('requeue-limit')

/**
 * How many hard interruptions (startup recovery or the lease sweep) one execution may take before
 * it stops resuming. 5 matches pi-durable's `restartLimit`. A graceful restart (a shutdown pause
 * marker) never counts: it drains at a tool boundary, so it says nothing about the run itself.
 */
export const DEFAULT_EXECUTION_REQUEUE_LIMIT = 5
export const EXECUTION_REQUEUE_LIMIT_ENV = 'FICUS_EXECUTION_REQUEUE_LIMIT'

/** A non-negative integer from the environment; 0 turns the cap off. Anything else uses the default. */
export function executionRequeueLimit(value: string | undefined = process.env[EXECUTION_REQUEUE_LIMIT_ENV]): number {
  const raw = value?.trim()
  if (!raw) return DEFAULT_EXECUTION_REQUEUE_LIMIT
  const limit = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(limit)) {
    log.warn(
      `Ignoring invalid ${EXECUTION_REQUEUE_LIMIT_ENV} '${raw}'; using the default of ${DEFAULT_EXECUTION_REQUEUE_LIMIT}`
    )
    return DEFAULT_EXECUTION_REQUEUE_LIMIT
  }
  return limit
}

/** Whether an execution with this many hard interruptions must not run again. */
export function requeueLimitReached(interruptions: number, limit: number = executionRequeueLimit()): boolean {
  return limit > 0 && interruptions >= limit
}

function causeText(cause: InterruptionCause): string {
  return cause === 'lease_lapsed' ? 'its admission lease lapsed' : 'an interruption of unknown cause'
}

/** The chat notice startup recovery or the lease sweep posts for the interruption that reaches the cap. */
export function requeueLimitNotice(interruptions: number, cause: InterruptionCause): string {
  return `[System] Agent's execution was interrupted ${interruptions} times without finishing, most recently because ${causeText(cause)}. It will not resume automatically: something it runs may be what stops Core. The squad manager or owner decides through the recovery hold.`
}

/** The failure recorded on the native recovery hold; one line, so it survives `lastErrorLine`. */
export class ExecutionRequeueLimitError extends Error {
  constructor(
    readonly interruptions: number,
    readonly interruptionCause: InterruptionCause
  ) {
    super(
      `The execution was interrupted ${interruptions} times without finishing, most recently because ${causeText(interruptionCause)}, so it was not resumed again.`
    )
    this.name = 'ExecutionRequeueLimitError'
  }
}

/**
 * Open the native recovery hold for an execution at the requeue cap, before its runner starts.
 * The hold is the existing `execution:run` episode, so it escalates to the manager and then the
 * owner like any exhausted recovery. One counted failure per recovery notice: a repeated pickup of
 * the same requeue does not count twice.
 */
export async function holdExecutionAtRequeueLimit(input: {
  agentId: string
  executionId: string
  noticeId: string
  interruptions: number
  cause: InterruptionCause
}): Promise<RecoveryRecord> {
  const { recordRecoveryFailure } = await import('../recovery/store')
  const { EXECUTION_RECOVERY_OPERATION } = await import('../recovery/executions')
  log.warn('Execution reached the requeue limit; holding it for a recovery decision', {
    agentId: input.agentId,
    executionId: input.executionId,
    interruptions: input.interruptions,
  })
  return recordRecoveryFailure(
    { agentId: input.agentId, executionId: input.executionId },
    {
      operationKey: EXECUTION_RECOVERY_OPERATION,
      attempted: 'continue the task',
      invocationId: `${input.executionId}:requeue-limit:${input.noticeId}`,
      error: new ExecutionRequeueLimitError(input.interruptions, input.cause),
    }
  )
}
