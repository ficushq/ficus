import type { ExecutionFailure } from '../execution/failure-classification'
import { routeFailure } from '../execution/failure-routing'

export const EXECUTION_RECOVERY_OPERATION = 'execution:run'

/** Preserve provider, admission, provisioning-follower and deliberate stop policies.
 * Known request validation is an explained immediate hold handled separately by
 * Execution.fail, not an unexplained provider outage or a retryable failure. */
export function isUnexplainedExecutionFailure(error: string, failure?: ExecutionFailure, cause?: unknown): boolean {
  if (routeFailure(error, undefined, cause).disposition.status === 'waiting-input') return false
  if (!failure) return true
  if (failure.failureClass === 'provider_model' || failure.failureClass === 'provider_transport') return false
  if (failure.failureClass === 'platform_pre_tool_refusal') return failure.failureReason.startsWith('phase_')
  return ['internal', 'setup_unclassified', 'settlement'].includes(failure.failureReason)
}
