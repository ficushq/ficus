import { describe, expect, test } from 'bun:test'
import {
  AdmissionEffectRefusedError,
  AdmissionLeaseLostError,
  LiveAdmissionOwnerConflictError,
  NestedAdmissionEffectError,
  type AdmissionLease,
} from '../maintenance/admission-reservation'
import {
  CAPACITY_REFUSAL_FAILURE,
  MISSING_RESOURCE_FAILURE,
  SANDBOX_RECOVERY_EXHAUSTED_FAILURE,
  classifySettlementFailure,
  classifySetupFailure,
  classifyTurnFailure,
  executionOutcomeOf,
} from './failure-classification'

function lease(): AdmissionLease {
  return {
    executionId: '00000000-0000-4000-8000-000000000001',
    token: crypto.randomUUID(),
    claimEpoch: 1n,
    generation: 1,
    holderRevision: 0n,
    ownerId: 'worker:test',
    ownerIncarnation: crypto.randomUUID(),
  }
}

describe('classifySetupFailure', () => {
  test('an admission effect refusal classifies as platform_pre_tool_refusal with the refusal reason', () => {
    for (const refusal of ['fence-closed', 'lease-lost', 'phase-conflict'] as const) {
      const error = new AdmissionEffectRefusedError(lease().executionId, 'sandbox-ensure', refusal)
      expect(classifySetupFailure(error)).toEqual({
        failureClass: 'platform_pre_tool_refusal',
        failureReason: `admission_${refusal}`,
      })
    }
  })

  test('a lease-lost error classifies as platform_pre_tool_refusal', () => {
    const error = new AdmissionLeaseLostError(lease().executionId, 'settlement', 'finish-refused')
    expect(classifySetupFailure(error)).toEqual({
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'admission_lease_lost',
    })
  })

  test('a live owner conflict classifies as platform_pre_tool_refusal', () => {
    const error = new LiveAdmissionOwnerConflictError(lease().executionId)
    expect(classifySetupFailure(error)).toEqual({
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'admission_owner_conflict',
    })
  })

  test('a nested effect error classifies as platform_pre_tool_refusal', () => {
    expect(classifySetupFailure(new NestedAdmissionEffectError())).toEqual({
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'admission_nested_effect',
    })
  })

  test('every platform write phase classifies as platform_pre_tool_refusal with its phase name', async () => {
    const { attachAdmissionEffectPhase } = await import('../maintenance/admission-reservation')
    for (const phase of [
      'session-create',
      'sandbox-ensure',
      'sandbox-drift-recreate',
      'toolchain-reconcile',
      'workspace-watch-configure',
      'local-deployment-restart',
    ] as const) {
      const error = attachAdmissionEffectPhase(new Error('adapter rejected'), phase)
      expect(classifySetupFailure(error)).toEqual({
        failureClass: 'platform_pre_tool_refusal',
        failureReason: `phase_${phase}`,
      })
    }
  })

  test('any other setup error classifies as execution_failure / setup_unclassified', () => {
    expect(classifySetupFailure(new Error('agent type exploded'))).toEqual({
      failureClass: 'execution_failure',
      failureReason: 'setup_unclassified',
    })
    // Non-Error throws still classify (never undefined for setup).
    expect(classifySetupFailure('agent exploded')).toEqual({
      failureClass: 'execution_failure',
      failureReason: 'setup_unclassified',
    })
  })

  test('the agent-session/settlement/sandbox-recovery phases are NOT pre-tool platform refusals', async () => {
    const { attachAdmissionEffectPhase } = await import('../maintenance/admission-reservation')
    for (const phase of ['agent-session', 'settlement', 'sandbox-recovery'] as const) {
      const error = attachAdmissionEffectPhase(new Error('failed mid-turn'), phase)
      expect(classifySetupFailure(error)).toEqual({
        failureClass: 'execution_failure',
        failureReason: 'setup_unclassified',
      })
    }
  })
})

describe('classifyTurnFailure', () => {
  const TRANSPORT = 'Provider transport failure: The socket connection was closed unexpectedly'
  const RESET = 'Provider transport failure: Connection reset (ECONNRESET)'

  test('a durable provider transport failure classifies as provider_transport', () => {
    expect(classifyTurnFailure(new Error(TRANSPORT), false)).toEqual({
      failureClass: 'provider_transport',
      failureReason: 'transport',
    })
    expect(classifyTurnFailure(new Error(RESET), true)).toEqual({
      failureClass: 'provider_transport',
      failureReason: 'transport',
    })
  })

  test('a lease lost before any assistant output is a platform pre-tool refusal', () => {
    const error = new AdmissionLeaseLostError(lease().executionId, 'agent-session', 'lease-lost')
    expect(classifyTurnFailure(error, false)).toEqual({
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'admission_lease_lost',
    })
  })

  test('a lease lost after assistant output is an execution_failure, not a platform refusal', () => {
    const error = new AdmissionLeaseLostError(lease().executionId, 'agent-session', 'lease-lost')
    expect(classifyTurnFailure(error, true)).toEqual({
      failureClass: 'execution_failure',
      failureReason: 'admission_lease_lost',
    })
  })

  test('a ficus-internal error classifies as execution_failure / internal', () => {
    // The one closed-set text guard, used defensively: these strings are all
    // ones Ficus itself throws (see INTERNAL_EXECUTION_ERROR_MARKERS).
    expect(classifyTurnFailure(new Error('sandbox provisioning failed'), false)).toEqual({
      failureClass: 'execution_failure',
      failureReason: 'internal',
    })
    expect(classifyTurnFailure(new Error('Admission effect was revoked or superseded'), false)).toEqual({
      failureClass: 'execution_failure',
      failureReason: 'internal',
    })
  })

  test('anything else at the model-call boundary classifies as provider_model / model_call', () => {
    expect(classifyTurnFailure(new Error('API error (500): provider exploded'), false)).toEqual({
      failureClass: 'provider_model',
      failureReason: 'model_call',
    })
  })
})

describe('fixed classifier constants', () => {
  test('capacity refusal is a platform pre-tool refusal', () => {
    expect(CAPACITY_REFUSAL_FAILURE).toEqual({
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'capacity_reservation_refused',
    })
  })
  test('missing resource is an execution failure', () => {
    expect(MISSING_RESOURCE_FAILURE).toEqual({
      failureClass: 'execution_failure',
      failureReason: 'missing_resource',
    })
  })
  test('sandbox recovery exhausted is a platform pre-tool refusal', () => {
    expect(SANDBOX_RECOVERY_EXHAUSTED_FAILURE).toEqual({
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'sandbox_provision_exhausted',
    })
  })
  test('settlement failures are execution failures', () => {
    expect(classifySettlementFailure(new Error('persist rejected'))).toEqual({
      failureClass: 'execution_failure',
      failureReason: 'settlement',
    })
  })
  test('reason codes fit the 64-char column', () => {
    for (const failure of [
      CAPACITY_REFUSAL_FAILURE,
      MISSING_RESOURCE_FAILURE,
      SANDBOX_RECOVERY_EXHAUSTED_FAILURE,
      classifySettlementFailure(new Error('x'))!,
      classifySetupFailure(new Error('x'))!,
      classifySetupFailure(new AdmissionEffectRefusedError('e', 'workspace-watch-configure', 'phase-conflict'))!,
      classifyTurnFailure(new Error('x'), false)!,
    ]) {
      expect(failure.failureReason.length).toBeLessThanOrEqual(64)
    }
  })
})

describe('executionOutcomeOf', () => {
  const base = { id: 'exec-1', error: null as string | null, failureReason: null as string | null }

  test('active statuses map to running', () => {
    for (const status of ['queued', 'waiting-maintenance', 'waiting-sandbox', 'running', 'stopping'] as const) {
      expect(executionOutcomeOf({ ...base, status, failureClass: null })).toEqual({ kind: 'running' })
    }
  })

  test('completed maps to completed and stopped maps to voluntary_stop — status alone', () => {
    expect(executionOutcomeOf({ ...base, status: 'completed', failureClass: null })).toEqual({ kind: 'completed' })
    expect(executionOutcomeOf({ ...base, status: 'stopped', failureClass: null })).toEqual({ kind: 'voluntary_stop' })
  })

  test('provider_transport maps to provider_failure with retryableTransport', () => {
    expect(
      executionOutcomeOf({ ...base, status: 'failed', failureClass: 'provider_transport', failureReason: 'transport' })
    ).toEqual({
      kind: 'provider_failure',
      failureClass: 'provider_transport',
      failureReason: 'transport',
      retryableTransport: true,
    })
  })

  test('provider_model maps to provider_failure without retryableTransport', () => {
    expect(
      executionOutcomeOf({ ...base, status: 'failed', failureClass: 'provider_model', failureReason: 'model_call' })
    ).toEqual({
      kind: 'provider_failure',
      failureClass: 'provider_model',
      failureReason: 'model_call',
      retryableTransport: false,
    })
  })

  test('platform_pre_tool_refusal maps to its own outcome', () => {
    expect(
      executionOutcomeOf({
        ...base,
        status: 'failed',
        failureClass: 'platform_pre_tool_refusal',
        failureReason: 'admission_fence-closed',
      })
    ).toEqual({
      kind: 'platform_pre_tool_refusal',
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'admission_fence-closed',
    })
  })

  test('stored execution_failure maps to execution_failure classified', () => {
    expect(
      executionOutcomeOf({
        ...base,
        status: 'failed',
        failureClass: 'execution_failure',
        failureReason: 'settlement',
      })
    ).toEqual({
      kind: 'execution_failure',
      failureClass: 'execution_failure',
      failureReason: 'settlement',
      classified: true,
    })
  })

  test('a legacy failed row with NULL class falls back structurally to execution_failure unclassified', () => {
    expect(executionOutcomeOf({ ...base, status: 'failed', failureClass: null })).toEqual({
      kind: 'execution_failure',
      failureClass: null,
      failureReason: null,
      classified: false,
    })
  })

  test('set-wise: map over rows', () => {
    const rows = [
      { ...base, id: 'a', status: 'running' as const, failureClass: null },
      { ...base, id: 'b', status: 'failed' as const, failureClass: 'platform_pre_tool_refusal' as const },
    ]
    expect(rows.map(executionOutcomeOf).map((o) => o.kind)).toEqual(['running', 'platform_pre_tool_refusal'])
  })
})
