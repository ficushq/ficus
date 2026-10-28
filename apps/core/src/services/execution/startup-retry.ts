/** Startup only: never replay a model turn or an operation after settlement. */
export const STARTUP_RETRY_DELAYS_MS = [5_000, 15_000, 45_000] as const

/**
 * A box's machine that isn't ready yet — re-bootstrapping after a deploy, still registering, or
 * briefly unreachable — clears in seconds to minutes, so it gets a longer schedule (~8.5 min)
 * than a dropped database connection.
 */
export const MACHINE_STARTUP_RETRY_DELAYS_MS = [10_000, 20_000, 30_000, 60_000, 120_000, 240_000] as const

/**
 * A box's socket port held by something else (BoxPortBusyError: an outgoing
 * connection in TIME_WAIT, or a squatter). TIME_WAIT clears within a minute, so
 * the first retries come quickly. A squatter never leaves, so the schedule stays
 * short (~5 min) and then the run fails with the full systemd reason.
 */
export const BOX_PORT_BUSY_RETRY_DELAYS_MS = [10_000, 20_000, 40_000, 80_000, 160_000] as const

/** Align the three stop-proof retries with physical-generation cooldowns so
 * each retry can make a new authoritative verification attempt. */
export const STOP_VERIFICATION_STARTUP_RETRY_DELAYS_MS = [30_000, 60_000, 120_000] as const

/** The startup retry code for a busy box port. */
export const BOX_PORT_BUSY_RETRY_CODE = 'box_port_busy'
/** Host lock contention shares the existing bounded provisioning retry budget. */
export const BOX_LOCK_TIMEOUT_RETRY_CODE = 'box_lock_timeout'

/** Machine statuses that come back to `ready` by themselves; anything else fails at once. */
const TRANSIENT_MACHINE_STATUSES = new Set(['registered', 'bootstrapping', 'unreachable'])
const MACHINE_READINESS_ERRORS = new Set(['MachineUnavailableError', 'MachineNotReadyError'])

/** The retry schedule for a startup retry code (see {@link startupRetryCode}). */
export function startupRetryDelays(code: string): readonly number[] {
  if (code === 'box_stop_unverified') return STOP_VERIFICATION_STARTUP_RETRY_DELAYS_MS
  if (code === BOX_PORT_BUSY_RETRY_CODE || code === BOX_LOCK_TIMEOUT_RETRY_CODE) return BOX_PORT_BUSY_RETRY_DELAYS_MS
  return code.startsWith('machine_') ? MACHINE_STARTUP_RETRY_DELAYS_MS : STARTUP_RETRY_DELAYS_MS
}

// Preserve the original error type, cause, and admission identity. The runner
// marks only its setup catch; run() also awaits a model turn and can reject later.
const startupFailures = new WeakSet<Error>()
export function markExecutionStartupFailure<T>(error: T): T {
  if (error instanceof Error) startupFailures.add(error)
  return error
}
export function isExecutionStartupFailure(error: unknown): boolean {
  return error instanceof Error && startupFailures.has(error)
}

const DATABASE_CONNECTION_ERRORS = new Set([
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
])

/**
 * Why a startup failure is worth retrying, or null. Drizzle and admission effects can wrap the
 * original error, so the cause chain is walked. A machine that isn't ready yet yields
 * `machine_<status>`; port and host-lock contention yield `box_port_busy` and
 * `box_lock_timeout` (matched by name to avoid importing the machine modules here).
 * Any other box provisioning failure is not retried.
 */
export function startupRetryCode(error: unknown): string | null {
  const seen = new Set<object>()
  let setupFallback: string | null = null
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error)
    if (error.name === 'VmPostProvisionSetupError') setupFallback = 'sandbox_readiness_pending'
    const code = (error as Error & { code?: unknown }).code
    if (typeof code === 'string' && DATABASE_CONNECTION_ERRORS.has(code)) return code
    const machineStatus = (error as Error & { machineStatus?: unknown }).machineStatus
    if (
      MACHINE_READINESS_ERRORS.has(error.name) &&
      typeof machineStatus === 'string' &&
      TRANSIENT_MACHINE_STATUSES.has(machineStatus)
    )
      return `machine_${machineStatus}`
    // Older box servers encode this pre-spawn refusal in their terminal SSE
    // error instead of a structured code. Match only the exact server refusal
    // (and our setup wrapper), never generic exit 127 or arbitrary contention.
    if (
      error.name === 'BoxBashBusyError' ||
      /^(?:Command failed \(exit 127\): )?Failed to start bash invocation: bash invocation is already active$/.test(
        error.message
      )
    )
      return 'box_bash_busy'
    if (error.name === 'SandboxReadinessPendingError') return 'sandbox_readiness_pending'
    if (error.name === 'BoxPortBusyError') return BOX_PORT_BUSY_RETRY_CODE
    if (error.name === 'BoxStopUnverifiedError') return 'box_stop_unverified'
    if (error.name === 'BoxLockTimeoutError') return BOX_LOCK_TIMEOUT_RETRY_CODE
    error = error.cause
  }
  return setupFallback
}

/** The first error in the cause chain with this name, if any. */
export function findInCauseChain(error: unknown, name: string): Error | null {
  const seen = new Set<object>()
  while (error instanceof Error && !seen.has(error)) {
    if (error.name === name) return error
    seen.add(error)
    error = error.cause
  }
  return null
}

/**
 * The stream notice for a startup failure that was queued for retry: why the
 * run is waiting and that it resumes by itself. A busy box port names the port
 * and its holder (BoxPortBusyError.summary).
 */
export function startupRetryNotice(error: unknown): string {
  const code = startupRetryCode(error)
  if (code === 'box_stop_unverified')
    return 'The sandbox is still verifying its previous stop; this will retry automatically.'
  if (code === 'box_bash_busy')
    return 'The sandbox is finishing another startup command; this will retry automatically.'
  if (code === 'sandbox_readiness_pending') return 'The sandbox is finishing setup; this will retry automatically.'
  if (code === BOX_PORT_BUSY_RETRY_CODE) {
    const summary = (findInCauseChain(error, 'BoxPortBusyError') as (Error & { summary?: unknown }) | null)?.summary
    const reason = typeof summary === 'string' ? ` (${summary})` : ''
    return `The sandbox could not start because its port on the machine is busy${reason}; this will retry automatically.`
  }
  if (code === BOX_LOCK_TIMEOUT_RETRY_CODE) {
    return 'The sandbox provisioning lock is busy; this will retry automatically.'
  }
  if (code?.startsWith('machine_')) {
    return 'The sandbox machine is still starting up; this will start automatically once it is ready.'
  }
  return 'Execution startup hit a temporary database connection failure and has been queued for retry.'
}
