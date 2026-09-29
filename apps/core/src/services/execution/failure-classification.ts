import { executionFailureClassEnum, executions } from '../../db/schema'
import { isActiveExecutionStatus } from './status'
import {
  AdmissionEffectRefusedError,
  AdmissionLeaseLostError,
  LiveAdmissionOwnerConflictError,
  NestedAdmissionEffectError,
  admissionEffectPhaseFromError,
} from '../maintenance/admission-reservation'
import { isDurableProviderTransportFailure, isInternalExecutionError } from '../../lib/error'

/** Stored failure-class values (schema enum `execution_failure_class`). */
export type ExecutionFailureClassValue = (typeof executionFailureClassEnum.enumValues)[number]

/** What a failure site passes to the fenced terminal write. */
export interface ExecutionFailure {
  failureClass: ExecutionFailureClassValue
  /** Bounded machine-readable reason code (fits the 64-char column). */
  failureReason: string
}

/**
 * The structural classification contract for pre-tool admission failures.
 *
 * Rules (design doc docs/plans/2026-09-04-surface-pretool-admission-failures.md):
 * - classify by error TYPE + site context only; never parse prose (the single
 *   exception is the closed-set `isInternalExecutionError` guard below, which
 *   matches only strings Ficus itself throws).
 * - `platform_pre_tool_refusal` means admission/sandbox/session infrastructure
 *   refused BEFORE any agent output: the incident class the stream must never
 *   display as ordinary `idle`.
 */
const PLATFORM_EFFECT_PHASES = new Set<string>([
  'session-create',
  'sandbox-ensure',
  'sandbox-drift-recreate',
  'toolchain-reconcile',
  'workspace-watch-configure',
  'local-deployment-restart',
])

/**
 * Classify a runner SETUP failure (before the first model turn). Anything the
 * admission infrastructure raised, or any adapter failure inside a platform
 * effect phase, is a `platform_pre_tool_refusal`; everything else fails the
 * execution without the platform-refusal semantics.
 */
export function classifySetupFailure(err: unknown): ExecutionFailure {
  if (err instanceof AdmissionEffectRefusedError) {
    return { failureClass: 'platform_pre_tool_refusal', failureReason: `admission_${err.refusal}` }
  }
  if (err instanceof AdmissionLeaseLostError) {
    return { failureClass: 'platform_pre_tool_refusal', failureReason: 'admission_lease_lost' }
  }
  if (err instanceof LiveAdmissionOwnerConflictError) {
    return { failureClass: 'platform_pre_tool_refusal', failureReason: 'admission_owner_conflict' }
  }
  if (err instanceof NestedAdmissionEffectError) {
    return { failureClass: 'platform_pre_tool_refusal', failureReason: 'admission_nested_effect' }
  }
  const phase = admissionEffectPhaseFromError(err)
  if (phase && PLATFORM_EFFECT_PHASES.has(phase)) {
    return { failureClass: 'platform_pre_tool_refusal', failureReason: `phase_${phase}` }
  }
  return { failureClass: 'execution_failure', failureReason: 'setup_unclassified' }
}

/**
 * Classify a failure at the model-call boundary (prompt dispatch or settled
 * run). `hasAssistantOutput` distinguishes a lease lost before any output
 * (platform refused mid-turn setup) from one lost after output (ordinary
 * execution failure — the agent already produced work).
 */
export function classifyTurnFailure(err: unknown, hasAssistantOutput: boolean): ExecutionFailure {
  if (err instanceof AdmissionLeaseLostError) {
    return {
      failureClass: hasAssistantOutput ? 'execution_failure' : 'platform_pre_tool_refusal',
      failureReason: 'admission_lease_lost',
    }
  }
  // The transport sentinel is an exact closed-set match against the two
  // durable marker strings the model-call boundary emits — not prose parsing.
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : err != null ? String(err) : ''
  if (isDurableProviderTransportFailure(text)) {
    return { failureClass: 'provider_transport', failureReason: 'transport' }
  }
  if (text && isInternalExecutionError(text)) {
    return { failureClass: 'execution_failure', failureReason: 'internal' }
  }
  return { failureClass: 'provider_model', failureReason: 'model_call' }
}

/** Settlement runs after the turn; its failures are never pre-tool refusals. */
export function classifySettlementFailure(err: unknown): ExecutionFailure {
  void err
  return { failureClass: 'execution_failure', failureReason: 'settlement' }
}

/** `Execution.run()`'s session-capacity reservation refusal (before any tool/output). */
export const CAPACITY_REFUSAL_FAILURE: ExecutionFailure = {
  failureClass: 'platform_pre_tool_refusal',
  failureReason: 'capacity_reservation_refused',
}

/** A runner's required resource (agent type, machine, …) was missing at setup. */
export const MISSING_RESOURCE_FAILURE: ExecutionFailure = {
  failureClass: 'execution_failure',
  failureReason: 'missing_resource',
}

/**
 * The execution's owning agent was removed (unspawned/terminated, or its row
 * deleted) before the run could start.
 *
 * Class choice (documented per stream 7dd2bce2): `execution_failure`, NOT
 * `platform_pre_tool_refusal` — nothing in admission/sandbox/session ever
 * refused this execution; the resource that would run it is simply gone. That
 * is the same structural situation as MISSING_RESOURCE_FAILURE's missing
 * agent type/machine, so it lives in the same class, with a dedicated reason
 * code so consumers can tell "agent removed" from "setup resource missing"
 * without parsing prose. The choice also has a functional consequence:
 * platform-failure-notice notifies work-stream owners ONLY for
 * failureClass = platform_pre_tool_refusal, so keeping a benign agent-removal
 * settle in execution_failure is what stops it from spurring owner notices.
 * No enum change or migration: `failure_reason` is a bounded varchar within
 * the existing class.
 */
export const AGENT_REMOVED_FAILURE: ExecutionFailure = {
  failureClass: 'execution_failure',
  failureReason: 'agent_removed',
}

/** Sandbox provisioning recovery exhausted its deadline (infrastructure). */
export const SANDBOX_RECOVERY_EXHAUSTED_FAILURE: ExecutionFailure = {
  failureClass: 'platform_pre_tool_refusal',
  failureReason: 'sandbox_provision_exhausted',
}

/** Any execution row shape `executionOutcomeOf` needs. */
export type ExecutionOutcomeRow = Pick<
  typeof executions.$inferSelect,
  'id' | 'status' | 'error' | 'failureClass' | 'failureReason'
>

/**
 * The six-way terminal/live outcome view over any execution row — the stable
 * contract the continuation watchdog (stream `7eb73436`) consumes to tell
 * `agent stopped` from `platform refused admission` WITHOUT matching prose.
 *
 * Pure: reads stored columns only, safe to map over rows set-wise and to call
 * inside any existing transaction. Legacy rows (NULL `failureClass`) resolve
 * structurally by status.
 */
export type ExecutionOutcome =
  | { kind: 'running' }
  | { kind: 'completed' }
  | { kind: 'voluntary_stop' }
  | {
      kind: 'provider_failure'
      failureClass: 'provider_transport' | 'provider_model'
      failureReason: string | null
      /** True only for the auto-continuable transport sentinel. */
      retryableTransport: boolean
    }
  | { kind: 'platform_pre_tool_refusal'; failureClass: 'platform_pre_tool_refusal'; failureReason: string | null }
  | {
      kind: 'execution_failure'
      failureClass: ExecutionFailureClassValue | null
      failureReason: string | null
      /** False for legacy rows written before classification existed. */
      classified: boolean
    }

export function executionOutcomeOf(row: ExecutionOutcomeRow): ExecutionOutcome {
  const { status, failureClass, failureReason } = row
  if (isActiveExecutionStatus(status)) return { kind: 'running' }
  if (status === 'completed') return { kind: 'completed' }
  if (status === 'stopped') return { kind: 'voluntary_stop' }
  // status === 'failed'
  switch (failureClass) {
    case 'provider_transport':
    case 'provider_model':
      return {
        kind: 'provider_failure',
        failureClass,
        failureReason,
        retryableTransport: failureClass === 'provider_transport',
      }
    case 'platform_pre_tool_refusal':
      return { kind: 'platform_pre_tool_refusal', failureClass, failureReason }
    case 'execution_failure':
      return { kind: 'execution_failure', failureClass, failureReason, classified: true }
    default:
      // Legacy row written before classification existed.
      return { kind: 'execution_failure', failureClass: null, failureReason: null, classified: false }
  }
}
