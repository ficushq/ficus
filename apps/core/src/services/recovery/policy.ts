import { RECOVERY_ATTEMPT_BUDGET, RECOVERY_MANAGER_CYCLES, type RecoverySummary } from '@ficus/shared'

export interface RecoveryState {
  state: 'recovering' | 'waiting-manager' | 'waiting-owner' | 'stopped' | 'resolved'
  attempted: string
  failures: number
  cycleFailures: number
  managerCycles: number
  ownerEscalated: boolean
  nextRetryAt: number | null
  lastError: string | null
  /** Only replay-safe pre-model startup failures can be settled by model-tool progress. */
  startupOnly?: boolean
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

/** Internal runtime input only. No caller-facing API accepts counted outcomes or restart claims. */
export function failedRecovery(
  previous: RecoveryState,
  failure: { kind: 'unknown'; error: string } | { kind: 'restart' },
  now: number
): RecoveryState {
  if (previous.state !== 'recovering') throw new Error('Recovery is held; an authorized decision is required')
  if (failure.kind === 'restart') return { ...previous, nextRetryAt: now }
  const cycleFailures = previous.cycleFailures + 1
  const exhausted = cycleFailures >= RECOVERY_ATTEMPT_BUDGET
  const ownerEscalated = previous.ownerEscalated || (exhausted && previous.managerCycles >= RECOVERY_MANAGER_CYCLES)
  return {
    ...previous,
    failures: previous.failures + 1,
    cycleFailures,
    lastError: failure.error,
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
    text: `I tried to ${state.attempted.charAt(0).toLowerCase()}${state.attempted.slice(1)} ${state.failures} times. The last error was: ${state.lastError ?? 'No unexplained failure was recorded.'}`,
  }
}
