import { expect, test } from 'bun:test'

async function policy() {
  const module = await import('./policy')
  expect(typeof module.initialRecoveryState).toBe('function')
  return module
}

test('three unexplained failures are required, with persisted backoff and a generated summary', async () => {
  const { initialRecoveryState, failedRecovery, recoverySummary } = await policy()
  let state = initialRecoveryState('Run project tests')
  state = failedRecovery(state, { kind: 'unknown', error: 'test process failed' }, 1000)
  expect(state).toMatchObject({ failures: 1, cycleFailures: 1, nextRetryAt: 2000, state: 'recovering' })
  state = failedRecovery(state, { kind: 'unknown', error: 'test process failed' }, 2000)
  expect(state).toMatchObject({ failures: 2, nextRetryAt: 4000, state: 'recovering' })
  state = failedRecovery(state, { kind: 'unknown', error: 'test process failed' }, 4000)
  expect(state).toMatchObject({ failures: 3, state: 'waiting-manager' })
  expect(recoverySummary(state)).toEqual({
    attempted: 'Run project tests',
    attemptCount: 3,
    lastError: 'test process failed',
    text: 'I tried to run project tests 3 times. The last error was: test process failed',
  })
})

test('verified restart is free and never opens a wait', async () => {
  const { initialRecoveryState, failedRecovery } = await policy()
  const state = failedRecovery(initialRecoveryState('Run project tests'), { kind: 'restart' }, 1000)
  expect(state).toMatchObject({ failures: 0, cycleFailures: 0, state: 'recovering', nextRetryAt: 1000 })
})

test('manager gets one extra cycle; exhaustion automatically escalates to owner', async () => {
  const { initialRecoveryState, failedRecovery, continueRecovery } = await policy()
  let state = initialRecoveryState('Run project tests')
  for (let attempt = 0; attempt < 3; attempt++)
    state = failedRecovery(state, { kind: 'unknown', error: 'failed' }, attempt * 10000)
  state = continueRecovery(state, 'manager', 30000)
  expect(state).toMatchObject({ managerCycles: 1, cycleFailures: 0, state: 'recovering' })
  for (let attempt = 0; attempt < 3; attempt++)
    state = failedRecovery(state, { kind: 'unknown', error: 'failed' }, 30000 + attempt * 10000)
  expect(state).toMatchObject({ failures: 6, managerCycles: 1, state: 'waiting-owner', ownerEscalated: true })
  expect(() => continueRecovery(state, 'manager', 60000)).toThrow('owner')
  state = continueRecovery(state, 'owner', 60000)
  expect(state).toMatchObject({ managerCycles: 1, cycleFailures: 0, state: 'recovering' })
  for (let attempt = 0; attempt < 3; attempt++)
    state = failedRecovery(state, { kind: 'unknown', error: 'failed' }, 60000 + attempt * 10000)
  expect(state.state).toBe('waiting-owner')
})

test('neither an early continuation nor a restart clears a stopped or exhausted recovery gate', async () => {
  const { initialRecoveryState, failedRecovery, continueRecovery } = await policy()
  const state = initialRecoveryState('Run project tests')
  expect(() => continueRecovery(state, 'manager', 0)).toThrow()
  expect(() => failedRecovery({ ...state, state: 'stopped' }, { kind: 'restart' }, 0)).toThrow()
})

test('deterministic request validation holds on the first actual failure and immediately escalates after a manager continuation', async () => {
  const { initialRecoveryState, failedRecovery, continueRecovery, recoverySummary } = await policy()
  const rejected = { kind: 'request-validation' as const, error: 'The provider rejected a tool-search function name.' }
  let state = failedRecovery(initialRecoveryState('continue the task'), rejected, 1000)
  expect(state).toMatchObject({ failures: 1, cycleFailures: 1, state: 'waiting-manager', nextRetryAt: null })
  expect(recoverySummary(state).text).toContain('Correct the request or safely re-plan before Continue')
  state = continueRecovery(state, 'manager', 2000)
  state = failedRecovery(state, rejected, 3000)
  expect(state).toMatchObject({ failures: 2, cycleFailures: 1, managerCycles: 1, state: 'waiting-owner' })
  expect(() => continueRecovery(state, 'manager', 4000)).toThrow('owner')
})

test('an execution at the requeue cap holds on its first counted failure, and a second cap escalates to the owner', async () => {
  const { initialRecoveryState, failedRecovery, continueRecovery } = await policy()
  const error = 'The execution was interrupted 5 times without finishing.'
  let state = failedRecovery(initialRecoveryState('continue the task'), { kind: 'requeue-limit', error }, 1000)
  expect(state).toMatchObject({
    state: 'waiting-manager',
    failures: 1,
    cycleFailures: 3,
    nextRetryAt: null,
    lastError: error,
    requestValidation: false,
    ownerEscalated: false,
  })
  // An earlier unexplained failure in the same cycle does not change it: the cap holds at once.
  const partial = failedRecovery(initialRecoveryState('continue the task'), { kind: 'unknown', error: 'x' }, 0)
  expect(failedRecovery(partial, { kind: 'requeue-limit', error }, 1000)).toMatchObject({
    state: 'waiting-manager',
    failures: 2,
    cycleFailures: 3,
  })
  state = continueRecovery(state, 'manager', 2000)
  state = failedRecovery(state, { kind: 'requeue-limit', error }, 3000)
  expect(state).toMatchObject({ state: 'waiting-owner', ownerEscalated: true, managerCycles: 1 })
})
