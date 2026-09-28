import type { ExecutionStatus } from '@ficus/shared'

/** States that preserve the one-active-execution invariant. */
export const ACTIVE_EXECUTION_STATUSES = [
  'queued',
  'waiting-maintenance',
  'waiting-sandbox',
  'running',
  'stopping',
] as const satisfies readonly ExecutionStatus[]

export function isActiveExecutionStatus(status: ExecutionStatus): boolean {
  return (ACTIVE_EXECUTION_STATUSES as readonly ExecutionStatus[]).includes(status)
}
