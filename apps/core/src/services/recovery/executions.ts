import type { ExecutionFailure } from '../execution/failure-classification'
import { routeFailure } from '../execution/failure-routing'

export const EXECUTION_RECOVERY_OPERATION = 'execution:run'

/** Preserve provider, admission, provisioning-follower and deliberate stop policies. */
export function isUnexplainedExecutionFailure(error: string, failure?: ExecutionFailure): boolean {
  if (routeFailure(error).disposition.status === 'waiting-input') return false
  if (!failure) return true
  if (failure.failureClass === 'provider_model' || failure.failureClass === 'provider_transport') return false
  if (failure.failureClass === 'platform_pre_tool_refusal') return failure.failureReason.startsWith('phase_')
  return ['internal', 'setup_unclassified', 'settlement'].includes(failure.failureReason)
}
