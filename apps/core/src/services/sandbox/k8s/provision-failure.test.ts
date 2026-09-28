import { describe, expect, test } from 'bun:test'
import { ApiException } from '@kubernetes/client-node'
import { K8sProvisionAttemptError, SandboxProvisionError } from './provision-errors'
import { DEFAULT_PROVISION_CONFIG, parseProvisionConfig } from './provision-config'
import { classifyProvisionFailure, getProvisionRecoveryDisposition } from './provision-failure'
import { observedFailureMessage } from './provision-coordinator'

describe('classifyProvisionFailure', () => {
  test.each([
    [{ code: 'ECONNREFUSED' }, 'control_plane_unavailable', 'certain'],
    [{ code: 'ENOTFOUND' }, 'control_plane_unavailable', 'certain'],
    [{ code: 'ETIMEDOUT' }, 'control_plane_unavailable', 'certain'],
    [{ response: { statusCode: 408 } }, 'control_plane_throttled', 'certain'],
    [{ response: { statusCode: 429 } }, 'control_plane_throttled', 'certain'],
    [{ response: { statusCode: 503 } }, 'control_plane_error', 'certain'],
    [{ response: { statusCode: 403 } }, 'cluster_authorization', 'certain'],
    [{ response: { statusCode: 422 } }, 'invalid_sandbox_spec', 'sandbox'],
    [{ response: { statusCode: 409 } }, 'invalid_sandbox_spec', 'sandbox'],
    [{ kind: 'unschedulable', reason: 'Insufficient cpu' }, 'unschedulable_capacity', 'correlated'],
    [new K8sProvisionAttemptError('storage', 'safe'), 'storage_substrate', 'correlated'],
    [new K8sProvisionAttemptError('image', 'safe'), 'invalid_sandbox_image', 'sandbox'],
    [{ kind: 'terminal' }, 'sandbox_terminal', 'sandbox'],
    [{ kind: 'executor' }, 'executor_unready', 'sandbox'],
    [{ name: 'AbortError' }, 'cancelled', 'neutral'],
    [{ strange: true }, 'unknown', 'neutral'],
  ] as const)('classifies %o', (input, code, breaker) => {
    expect(classifyProvisionFailure(input)).toMatchObject({ code, breaker })
  })

  test('classifies a real Kubernetes ApiException numeric code', () => {
    const error = new ApiException(503, 'Service unavailable', { token: 'TOKEN-SECRET' }, {})
    expect(classifyProvisionFailure(error)).toMatchObject({ code: 'control_plane_error', breaker: 'certain' })
    expect(JSON.stringify(classifyProvisionFailure(error))).not.toContain('TOKEN-SECRET')
  })

  // Lock the whole `certain` arm against the errors the library and runtime REALLY
  // produce. Spot-checking one status left the arm free to rot: @kubernetes/client-node
  // puts the status on `.code` as a NUMBER, so before this every Kubernetes 4xx/5xx
  // classified as `unknown`/`neutral` and an API-server outage could not open the breaker.
  test.each([
    [503, 'control_plane_error', 'certain'],
    [500, 'control_plane_error', 'certain'],
    [429, 'control_plane_throttled', 'certain'],
    [408, 'control_plane_throttled', 'certain'],
    [401, 'cluster_authorization', 'certain'],
    [403, 'cluster_authorization', 'certain'],
    [422, 'invalid_sandbox_spec', 'sandbox'],
    [409, 'invalid_sandbox_spec', 'sandbox'],
  ] as const)('classifies a real ApiException(%i)', (status, code, breaker) => {
    expect(classifyProvisionFailure(new ApiException(status, 'rejected', { body: 'x' }, {}))).toMatchObject({
      code,
      breaker,
    })
  })

  test("classifies Bun's actual connection-refused error, not a hand-written Node shape", async () => {
    let error: unknown
    try {
      await fetch('http://127.0.0.1:1')
    } catch (caught) {
      error = caught
    }
    expect((error as { code?: unknown }).code).toBe('ConnectionRefused')
    expect(classifyProvisionFailure(error)).toMatchObject({ code: 'control_plane_unavailable', breaker: 'certain' })
  })

  test('does not read a DOMException numeric code as an HTTP status', () => {
    // DOMException.TIMEOUT_ERR === 23, and `.code` is also where ApiException puts a status.
    expect(classifyProvisionFailure(new DOMException('timed out', 'TimeoutError'))).toMatchObject({
      breaker: 'neutral',
    })
  })

  test('classifies Bun connection refusal and traverses nested causes', () => {
    expect(classifyProvisionFailure({ name: 'ConnectionRefused' })).toMatchObject({
      code: 'control_plane_unavailable',
      breaker: 'certain',
    })
    expect(classifyProvisionFailure({ cause: { cause: { code: 'ECONNREFUSED' } } })).toMatchObject({
      code: 'control_plane_unavailable',
      breaker: 'certain',
    })
  })

  test.each([
    ['SANDBOX_PROVISION_BUSY', undefined, true],
    ['SANDBOX_PROVISION_COORDINATION_UNAVAILABLE', undefined, true],
    ['SANDBOX_PROVISION_FAILED', 'unschedulable_capacity', true],
    ['SANDBOX_PROVISION_FAILED', 'storage_substrate', true],
    ['SANDBOX_PROVISION_UNAVAILABLE', 'cluster_authorization', false],
    ['SANDBOX_PROVISION_FAILED', 'invalid_sandbox_image', false],
    ['SANDBOX_PROVISION_FAILED', 'invalid_sandbox_spec', false],
    ['SANDBOX_PROVISION_FAILED', 'sandbox_terminal', false],
    ['SANDBOX_PROVISION_FAILED', 'unknown', false],
  ] as const)('returns a safe recovery disposition for %s / %s', (code, reasonCode, recoverable) => {
    const error = new SandboxProvisionError(code, 'safe', 10_000, {
      scope: 'scope',
      sandboxKey: 'box',
      reasonCode,
      circuitVersion: 2,
      refusalId: '00000000-0000-4000-8000-000000000001',
    })

    expect(getProvisionRecoveryDisposition(error) !== null).toBe(recoverable)
  })

  test('requires coordinator context before recovering a provisioning error', () => {
    expect(getProvisionRecoveryDisposition(new SandboxProvisionError('SANDBOX_PROVISION_BUSY', 'safe'))).toBeNull()
  })

  test('never exposes Kubernetes response bodies', () => {
    const failure = classifyProvisionFailure({ response: { statusCode: 422 }, body: 'TOKEN-SECRET' })
    const error = new SandboxProvisionError('SANDBOX_PROVISION_FAILED', failure.publicMessage)
    expect(JSON.stringify({ failure, error: { code: error.code, message: error.message } })).not.toContain(
      'TOKEN-SECRET'
    )
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined()
  })
})

describe('parseProvisionConfig', () => {
  test('parses positive integer settings', () => {
    expect(parseProvisionConfig({ FICUS_K8S_PROVISION_MAX_CONCURRENT: '7' }).maxConcurrent).toBe(7)
  })

  test.each(['0', '-1', 'nope', '1.5', ''])('uses defaults for invalid value %p', (value) => {
    expect(parseProvisionConfig({ FICUS_K8S_PROVISION_MAX_WAITERS: value }).maxWaiters).toBe(
      DEFAULT_PROVISION_CONFIG.maxWaiters
    )
  })
})

describe('observedFailureMessage', () => {
  test('is distinguishable from the classifier fallback and carries the known code', () => {
    const observed = observedFailureMessage('failed', 'unschedulable_capacity')
    // The whole point: these two must never be byte-identical again.
    expect(observed).not.toBe(classifyProvisionFailure({ strange: true }).publicMessage)
    expect(observed).toContain('unschedulable_capacity')
    expect(observed).toContain('concurrent attempt')
  })

  test('distinguishes cancellation from failure', () => {
    expect(observedFailureMessage('cancelled')).toContain('was cancelled')
    expect(observedFailureMessage('failed')).toContain('failed')
  })
})
