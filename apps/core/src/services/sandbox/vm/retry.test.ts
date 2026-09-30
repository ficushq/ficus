import { describe, expect, test } from 'bun:test'
import { retryDelays, runIdempotentSandboxOperation } from './retry'
import { SandboxTransportError } from '../client/http-client'

describe('VM sandbox retry policy', () => {
  test('uses bounded deterministic 0/200/800ms delays with at most 20% jitter', () => {
    const delays = retryDelays('squad_s1', 'read', 3)
    expect(delays[0]).toBe(0)
    expect(delays[1]).toBeGreaterThanOrEqual(200)
    expect(delays[1]).toBeLessThanOrEqual(240)
    expect(delays[2]).toBeGreaterThanOrEqual(800)
    expect(delays[2]).toBeLessThanOrEqual(960)
    expect(retryDelays('squad_s1', 'read', 3)).toEqual(delays)
  })

  test('recovers transport and retries only an explicitly idempotent operation', async () => {
    const first = { id: 1 }
    const second = { id: 2 }
    const seen: number[] = []
    const sleeps: number[] = []

    const result = await runIdempotentSandboxOperation({
      sandboxId: 'squad_s1',
      operationClass: 'read',
      getClient: () => first,
      recoverClient: async () => second,
      operation: async (client) => {
        seen.push(client.id)
        if (client === first) throw new SandboxTransportError('connection_reset', 'connect', new Error('reset'))
        return 'ok'
      },
      sleep: async (ms) => void sleeps.push(ms),
    })

    expect(result).toBe('ok')
    expect(seen).toEqual([1, 2])
    expect(sleeps).toHaveLength(1)
  })
})
