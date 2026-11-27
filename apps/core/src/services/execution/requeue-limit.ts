import type { InterruptionCause } from '@ficus/shared/restart-context'
import { createLogger } from '../../lib/infra/logger'
import type { HardInterruption, InterruptedToolCall } from '../agent/interrupted-tool-calls'
import type { RecoveryRecord } from '../recovery/store'

const log = createLogger('requeue-limit')

/**
 * How many hard interruptions (startup recovery or the lease sweep) one execution may take before
 * it stops resuming. 5 matches pi-durable's `restartLimit`. A graceful restart (a shutdown pause
 * marker) never counts: it drains at a tool boundary, so it says nothing about the run itself.
 */
export const DEFAULT_EXECUTION_REQUEUE_LIMIT = 5
export const EXECUTION_REQUEUE_LIMIT_ENV = 'FICUS_EXECUTION_REQUEUE_LIMIT'

let warnedInvalid: string | undefined

/**
 * A non-negative integer from the environment; 0 turns the cap off. A whole number too large to
 * represent exactly still means "practically never". Anything else uses the default, with one
 * warning per distinct invalid value rather than one per recovered execution.
 */
export function executionRequeueLimit(value: string | undefined = process.env[EXECUTION_REQUEUE_LIMIT_ENV]): number {
  const raw = value?.trim()
  if (!raw) return DEFAULT_EXECUTION_REQUEUE_LIMIT
  if (!/^\d+$/.test(raw)) {
    if (warnedInvalid !== raw) {
      warnedInvalid = raw
      log.warn(
        `Ignoring invalid ${EXECUTION_REQUEUE_LIMIT_ENV} '${raw}'; using the default of ${DEFAULT_EXECUTION_REQUEUE_LIMIT}`
      )
    }
    return DEFAULT_EXECUTION_REQUEUE_LIMIT
  }
  return Math.min(Number(raw), Number.MAX_SAFE_INTEGER)
}

/** Whether an execution with this many hard interruptions must not run again. */
export function requeueLimitReached(interruptions: number, limit: number = executionRequeueLimit()): boolean {
  return limit > 0 && interruptions >= limit
}

function causeText(cause: InterruptionCause): string {
  return cause === 'lease_lapsed' ? 'the worker running it stopped renewing its lease' : 'Core stopped unexpectedly'
}

/** The chat notice startup recovery or the lease sweep posts for the interruption that reaches the cap. */
export function requeueLimitNotice(interruptions: number, cause: InterruptionCause): string {
  return `[System] Agent's execution was cut off ${interruptions} times without finishing, most recently because ${causeText(cause)}. It will not resume automatically: something it runs may be what stops Core. The squad manager or owner decides through the recovery hold.`
}

/** What the last interruption cut off, for whoever decides Continue or Stop; undefined when it could not be read. */
function cutOffText(calls: Pick<InterruptedToolCall, 'toolName' | 'repeated'>[] | undefined): string {
  if (!calls) return 'The calls it cut off could not be read.'
  if (calls.length === 0) return 'It was cut off between tool calls.'
  const shown = calls.slice(0, 3).map((call) => `${call.toolName}${call.repeated ? ' (cut off before too)' : ''}`)
  const more = calls.length > shown.length ? ` and ${calls.length - shown.length} more` : ''
  return `It cut off ${shown.join(', ')}${more}.`
}

/** The failure recorded on the native recovery hold; one line, so it survives `lastErrorLine`. */
export class ExecutionRequeueLimitError extends Error {
  constructor(
    readonly interruptions: number,
    readonly interruptionCause: InterruptionCause,
    calls?: Pick<InterruptedToolCall, 'toolName' | 'repeated'>[]
  ) {
    super(
      `The run was cut off ${interruptions} times without finishing, most recently because ${causeText(interruptionCause)}. ${cutOffText(calls)}`
    )
    this.name = 'ExecutionRequeueLimitError'
  }
}

/**
 * Record the calls the capped interruption cut off in the agent's session file on Core, exactly as
 * a resumed runner would (`recordInterruptedToolCalls`, once per notice, `repeated` for a call cut
 * off before). The run is not resumed, so without this the continued run after Continue would see
 * pi-ai's generic placeholder for the call most likely to be stopping Core. This only reads and
 * appends to the local session file: no sandbox, model call or tool starts.
 */
export async function recordCappedInterruption(
  agentId: string,
  interruption: HardInterruption
): Promise<InterruptedToolCall[] | undefined> {
  try {
    const { findSessionFile, getSessionDir } = await import('../../lib/infra/session-files')
    const dir = getSessionDir(agentId)
    const file = findSessionFile(dir)
    if (!file) return []
    const { SessionManager } = await import('@earendil-works/pi-coding-agent')
    const { recordInterruptedToolCalls } = await import('../agent/interrupted-tool-calls')
    return recordInterruptedToolCalls(SessionManager.open(file, dir, dir), interruption).calls
  } catch (error) {
    // The hold matters more than its wording; open it even when the session cannot be read.
    log.error(`Could not record the calls cut off for capped execution ${interruption.executionId}:`, error)
    return undefined
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
  interruption: HardInterruption & { interruptionCount: number }
}): Promise<RecoveryRecord> {
  const { recordRecoveryFailure } = await import('../recovery/store')
  const { EXECUTION_RECOVERY_OPERATION } = await import('../recovery/executions')
  const { interruption } = input
  log.warn('Execution reached the requeue limit; holding it for a recovery decision', {
    agentId: input.agentId,
    executionId: interruption.executionId,
    interruptions: interruption.interruptionCount,
  })
  const calls = await recordCappedInterruption(input.agentId, interruption)
  return recordRecoveryFailure(
    { agentId: input.agentId, executionId: interruption.executionId },
    {
      operationKey: EXECUTION_RECOVERY_OPERATION,
      attempted: 'continue the task',
      invocationId: `${interruption.executionId}:requeue-limit:${interruption.noticeId}`,
      error: new ExecutionRequeueLimitError(interruption.interruptionCount, interruption.cause, calls),
    }
  )
}
