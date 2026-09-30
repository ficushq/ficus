/** Startup only: never replay a model turn or an operation after settlement. */
export const STARTUP_RETRY_DELAYS_MS = [5_000, 15_000, 45_000] as const

/**
 * A box's machine that isn't ready yet — re-bootstrapping after a deploy, still registering, or
 * briefly unreachable — clears in seconds to minutes, so it gets a longer schedule (~8.5 min)
 * than a dropped database connection.
 */
export const MACHINE_STARTUP_RETRY_DELAYS_MS = [10_000, 20_000, 30_000, 60_000, 120_000, 240_000] as const

/** Machine statuses that come back to `ready` by themselves; anything else fails at once. */
const TRANSIENT_MACHINE_STATUSES = new Set(['registered', 'bootstrapping', 'unreachable'])
const MACHINE_READINESS_ERRORS = new Set(['MachineUnavailableError', 'MachineNotReadyError'])

/** The retry schedule for a startup retry code (see {@link startupRetryCode}). */
export function startupRetryDelays(code: string): readonly number[] {
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
 * `machine_<status>` (matched by name to avoid importing the machine modules here).
 */
export function startupRetryCode(error: unknown): string | null {
  const seen = new Set<object>()
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error)
    const code = (error as Error & { code?: unknown }).code
    if (typeof code === 'string' && DATABASE_CONNECTION_ERRORS.has(code)) return code
    const machineStatus = (error as Error & { machineStatus?: unknown }).machineStatus
    if (
      MACHINE_READINESS_ERRORS.has(error.name) &&
      typeof machineStatus === 'string' &&
      TRANSIENT_MACHINE_STATUSES.has(machineStatus)
    )
      return `machine_${machineStatus}`
    error = error.cause
  }
  return null
}
