import { afterEach, describe, expect, it } from 'bun:test'
import {
  getActiveSessionCount,
  isSessionReserved,
  registerSession,
  releaseSessionReservation,
  removeSession,
  removeSessionIfCurrent,
  reserveSession,
  beginTransitionalOperation,
  endTransitionalOperation,
  isTransitionalOperationInProgress,
  listTransitionalOperations,
  isSessionHeldFor,
  markExecutionSettling,
  clearExecutionSettling,
} from './session-state'

describe('execution session-state reservations', () => {
  it('fences stale teardown against both successor sessions and reservations', () => {
    const agentId = `agent-${crypto.randomUUID()}`
    const successorId = crypto.randomUUID()
    const stale = {} as any
    let disposed = 0
    const successor = { dispose: () => disposed++ } as any
    try {
      expect(reserveSession(agentId, successorId)).toBe(true)
      expect(removeSessionIfCurrent(agentId, stale)).toBe(false)
      expect(removeSessionIfCurrent(agentId, undefined as any)).toBe(false)
      expect(isSessionReserved(agentId, successorId)).toBe(true)
      registerSession(agentId, {
        session: successor,
        collector: {} as any,
        buffer: {} as any,
        agentId,
        executionId: successorId,
      })
      expect(removeSessionIfCurrent(agentId, stale)).toBe(false)
      expect(disposed).toBe(0)
      expect(isSessionHeldFor(agentId, successorId)).toBe(true)
      expect(removeSessionIfCurrent(agentId, successor)).toBe(true)
      expect(disposed).toBe(1)
      expect(removeSessionIfCurrent(agentId, successor)).toBe(false)
      expect(disposed).toBe(1)
    } finally {
      removeSession(agentId)
    }
  })

  it('counts pre-session reservations as active capacity', () => {
    const agentId = `agent-${crypto.randomUUID()}`
    const executionId = crypto.randomUUID()
    const baseline = getActiveSessionCount()

    expect(reserveSession(agentId, executionId)).toBe(true)
    expect(getActiveSessionCount()).toBe(baseline + 1)
    expect(isSessionReserved(agentId, executionId)).toBe(true)

    releaseSessionReservation(agentId, executionId)
    expect(getActiveSessionCount()).toBe(baseline)
  })

  it('keeps the active count stable when a reservation becomes a registered session', () => {
    const agentId = `agent-${crypto.randomUUID()}`
    const executionId = crypto.randomUUID()
    const baseline = getActiveSessionCount()

    expect(reserveSession(agentId, executionId)).toBe(true)
    registerSession(agentId, {
      session: {} as any,
      collector: {} as any,
      buffer: {} as any,
      agentId,
      executionId,
    })

    expect(getActiveSessionCount()).toBe(baseline + 1)
    expect(isSessionReserved(agentId, executionId)).toBe(false)

    removeSession(agentId)
    expect(getActiveSessionCount()).toBe(baseline)
  })

  it('rejects reservations for agents that already have active capacity', () => {
    const agentId = `agent-${crypto.randomUUID()}`
    const executionId = crypto.randomUUID()

    expect(reserveSession(agentId, executionId)).toBe(true)
    expect(reserveSession(agentId, crypto.randomUUID())).toBe(false)
    expect(reserveSession(agentId, executionId)).toBe(true)

    removeSession(agentId)
  })
})

describe('transitional operation tracker', () => {
  const agentId = 'agent-1'

  afterEach(() => {
    endTransitionalOperation(agentId)
  })

  it('records begin/end and reports in-progress operations', () => {
    expect(isTransitionalOperationInProgress(agentId)).toBe(false)
    beginTransitionalOperation(agentId, 'compact')
    expect(isTransitionalOperationInProgress(agentId)).toBe(true)
    const entries = listTransitionalOperations()
    expect(entries.find(([id]) => id === agentId)?.[1].kind).toBe('compact')
    endTransitionalOperation(agentId)
    expect(isTransitionalOperationInProgress(agentId)).toBe(false)
  })

  it('does not panic on double end', () => {
    endTransitionalOperation(agentId)
    expect(isTransitionalOperationInProgress(agentId)).toBe(false)
  })
})

describe('execution settling hold', () => {
  // The abandoned-lease sweep only spares executions THIS process holds
  // (isSessionHeldFor). completeNormally/onError drop the session BEFORE the
  // execution row leaves 'running' — turn hooks, message save, terminal CAS
  // can take 4-20s — and the lease (renewed only inside effects) has long
  // expired, so the sweep re-queued live, finishing executions and posted a
  // bogus "[System] Agent recovered after a process restart." (observed live,
  // 8 times in 10 minutes on a single worker with no restart). A settling hold
  // keeps the execution "held" from session teardown through its terminal
  // transition.
  it('keeps an execution held after removeSession until settling is cleared', () => {
    const agentId = `agent-${crypto.randomUUID()}`
    const executionId = crypto.randomUUID()
    registerSession(agentId, { session: {} as any, collector: {} as any, buffer: {} as any, agentId, executionId })
    expect(isSessionHeldFor(agentId, executionId)).toBe(true)

    markExecutionSettling(agentId, executionId)
    removeSession(agentId)
    // Session is gone, but the execution is still settling → still held.
    expect(isSessionHeldFor(agentId, executionId)).toBe(true)

    clearExecutionSettling(agentId, executionId)
    expect(isSessionHeldFor(agentId, executionId)).toBe(false)
  })

  it('a settling hold is per-execution: it never shields a different execution of the same agent', () => {
    const agentId = `agent-${crypto.randomUUID()}`
    const settling = crypto.randomUUID()
    const other = crypto.randomUUID()
    markExecutionSettling(agentId, settling)
    expect(isSessionHeldFor(agentId, settling)).toBe(true)
    expect(isSessionHeldFor(agentId, other)).toBe(false)
    // Clearing with the wrong execution id is a no-op.
    clearExecutionSettling(agentId, other)
    expect(isSessionHeldFor(agentId, settling)).toBe(true)
    clearExecutionSettling(agentId, settling)
    expect(isSessionHeldFor(agentId, settling)).toBe(false)
  })
})
