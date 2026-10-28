import { afterEach, expect, spyOn, test } from 'bun:test'
import { signalSandboxProcess, stopSandboxContainer } from './workspace'
import { signalAgentSandboxProcess, stopAgentSandboxContainer } from './agents'

const spies: Array<{ mockRestore(): void }> = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

test('caller cancellation aborts the control without waiting for a wedged transport', async () => {
  let requestSignal: AbortSignal | undefined
  const fetch = spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    requestSignal = init?.signal as AbortSignal
    return new Promise(() => {})
  })
  spies.push(fetch)
  for (const control of [
    (signal: AbortSignal) => signalSandboxProcess('synthetic', 4242, 'TERM', signal),
    (signal: AbortSignal) => stopSandboxContainer('synthetic', 'synthetic-container', signal),
    (signal: AbortSignal) => signalAgentSandboxProcess('synthetic', 4242, 'TERM', signal),
    (signal: AbortSignal) => stopAgentSandboxContainer('synthetic', 'synthetic-container', signal),
  ]) {
    const controller = new AbortController()
    const pending = control(controller.signal).then(
      () => 'resolved',
      () => 'cancelled'
    )
    controller.abort()
    expect(await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve('unbounded'), 50))])).toBe(
      'cancelled'
    )
    expect(requestSignal?.aborted).toBe(true)
  }
})

test('timeout aborts transport, reports uncertain outcome, and allows an explicit retry', async () => {
  const { sandboxControlRequest } = await import('./sandboxControl')
  let signal: AbortSignal | undefined
  const fetch = spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    signal = init?.signal as AbortSignal
    return new Promise(() => {})
  })
  spies.push(fetch)
  await expect(sandboxControlRequest('/synthetic', { method: 'POST' }, 5)).rejects.toThrow(
    'the action may have taken effect. Refresh processes before retrying.'
  )
  expect(signal?.aborted).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(1)
  fetch.mockResolvedValue(Response.json({ ok: true }))
  await expect(sandboxControlRequest('/synthetic', { method: 'POST' }, 5)).resolves.toBeUndefined()
  expect(fetch).toHaveBeenCalledTimes(2)
})
