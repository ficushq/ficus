import { RECOVERY_ATTEMPT_BUDGET, RECOVERY_MANAGER_CYCLES, type RecoverySummary } from '@ficus/shared'

export interface RecoveryState {
  state: 'recovering' | 'waiting-manager' | 'waiting-owner' | 'stopped' | 'resolved'
  attempted: string
  failures: number
  cycleFailures: number
  managerCycles: number
  ownerEscalated: boolean
  /** Temporary routing fallback, not a permanent escalation of this scope. */
  ownerFallback?: boolean
  nextRetryAt: number | null
  lastError: string | null
  /** Only replay-safe pre-model startup failures can be settled by model-tool progress. */
  startupOnly?: boolean
  /** Known-invalid model requests hold immediately, without fabricated retries. */
  requestValidation?: boolean
  /** Runtime-issued version that opened this validation hold, for notice deduplication. */
  validationHoldVersion?: number
  /** The latest failure was an execution reaching the requeue (crash-loop) cap. */
  requeueLimit?: boolean
}

export function initialRecoveryState(attempted: string): RecoveryState {
  return {
    state: 'recovering',
    attempted,
    failures: 0,
    cycleFailures: 0,
    managerCycles: 0,
    ownerEscalated: false,
    nextRetryAt: null,
    lastError: null,
  }
}

/** Preserve policy history, but not a prior record's unavailable-manager route. */
export function successorRecoveryState(attempted: string, previous?: RecoveryState): RecoveryState {
  return {
    ...initialRecoveryState(attempted),
    managerCycles: previous?.managerCycles ?? 0,
    failures: previous?.failures ?? 0,
    ownerEscalated: previous?.ownerEscalated === true && previous.ownerFallback !== true,
  }
}

/** Internal runtime input only. No caller-facing API accepts counted outcomes or restart claims. */
export function failedRecovery(
  previous: RecoveryState,
  failure: { kind: 'unknown' | 'request-validation' | 'requeue-limit'; error: string } | { kind: 'restart' },
  now: number
): RecoveryState {
  if (previous.state !== 'recovering') throw new Error('Recovery is held; an authorized decision is required')
  if (failure.kind === 'restart') return { ...previous, nextRetryAt: now }
  const requestValidation = failure.kind === 'request-validation'
  // An execution at the requeue cap already spent its interruptions as attempts; running it
  // again could take Core down again, so it exhausts the cycle at once instead of retrying
  // with backoff. It is an ordinary exhausted cycle, not a new kind of hold.
  const cycleFailures = failure.kind === 'requeue-limit' ? RECOVERY_ATTEMPT_BUDGET : previous.cycleFailures + 1
  const exhausted = requestValidation || cycleFailures >= RECOVERY_ATTEMPT_BUDGET
  const ownerEscalated = previous.ownerEscalated || (exhausted && previous.managerCycles >= RECOVERY_MANAGER_CYCLES)
  return {
    ...previous,
    failures: previous.failures + 1,
    cycleFailures,
    lastError: failure.error,
    requestValidation,
    requeueLimit: failure.kind === 'requeue-limit',
    ownerEscalated,
    state: exhausted ? (ownerEscalated ? 'waiting-owner' : 'waiting-manager') : 'recovering',
    nextRetryAt: exhausted ? null : now + 1000 * 2 ** (cycleFailures - 1),
  }
}

export function continueRecovery(previous: RecoveryState, actor: 'manager' | 'owner', now: number): RecoveryState {
  if (!['waiting-manager', 'waiting-owner', 'stopped'].includes(previous.state))
    throw new Error('Recovery is not awaiting a decision')
  if (actor === 'manager' && (previous.ownerEscalated || previous.managerCycles >= RECOVERY_MANAGER_CYCLES)) {
    throw new Error('Only the owner may authorize another recovery cycle')
  }
  if (actor === 'owner' && !previous.ownerEscalated) throw new Error('Recovery must reach the manager first')
  return {
    ...previous,
    state: 'recovering',
    cycleFailures: 0,
    nextRetryAt: now,
    managerCycles: previous.managerCycles + (actor === 'manager' ? 1 : 0),
  }
}

export function recoverySummary(state: RecoveryState): RecoverySummary {
  return {
    attempted: state.attempted,
    attemptCount: state.failures,
    lastError: state.lastError,
    text: state.requeueLimit
      ? `I stopped resuming this run. ${state.lastError} Continue starts it again in a new run, which may stop Core again; Stop keeps it held.`
      : state.requestValidation
        ? `The provider rejected the tool-search function name in the model request. Recovery is held after ${state.failures} actual failure${state.failures === 1 ? '' : 's'}. Correct the request or safely re-plan before Continue; do not replay the unchanged invalid request. The last error was: ${state.lastError}`
        : `I tried to ${state.attempted.charAt(0).toLowerCase()}${state.attempted.slice(1)} ${state.failures} times. The last error was: ${state.lastError ?? 'No unexplained failure was recorded.'}`,
  }
}
