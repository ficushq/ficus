import { expect, test } from 'bun:test'
import { waitForVmSetupReady } from './readiness'
import { startupRetryCode, startupRetryDelays } from '../../execution/startup-retry'
import type { VmSetupState } from './setup-state'

const state = (readiness: VmSetupState['readiness']) => ({ readiness, pendingInvocationId: null }) as VmSetupState

for (const readiness of ['pending', 'reconciling'] as const) {
  test(`${readiness} cannot admit execution before readiness and times out retryably`, async () => {
    let now = 0
    let reads = 0
    const error = await waitForVmSetupReady(
      async () => {
        reads++
        return state(readiness)
      },
      {
        now: () => now,
        sleep: async (ms) => {
          now += ms
        },
        timeoutMs: 1000,
      }
    ).catch((error) => error)
    expect(reads).toBeGreaterThan(1)
    expect(now).toBe(1000)
    expect(startupRetryCode(error)).toBe('sandbox_readiness_pending')
  })
}

test('ready and degraded admit only after the setup invocation is cleared', async () => {
  for (const readiness of ['ready', 'ready_degraded'] as const) {
    let sleeps = 0
    const result = await waitForVmSetupReady(
      async () => ({ ...state(readiness), pendingInvocationId: sleeps ? null : 'owner-setup' }),
      {
        sleep: async () => {
          sleeps++
        },
      }
    )
    expect(sleeps).toBe(1)
    expect(result.readiness).toBe(readiness)
  }
})

test('readiness acquisition honors cancellation before reading or admitting', async () => {
  const signal = AbortSignal.abort(new Error('stopped'))
  await expect(waitForVmSetupReady(async () => state('ready'), { signal })).rejects.toThrow('stopped')
})

test('single-active Bash startup conflict retries, without treating arbitrary exit 127 as transient', () => {
  const conflict = new Error(
    'Command failed (exit 127): Failed to start bash invocation: bash invocation is already active'
  )
  expect(startupRetryCode(conflict)).toBe('box_bash_busy')
  expect(startupRetryCode(new Error('wrapped', { cause: conflict }))).toBe('box_bash_busy')
  expect(startupRetryCode(new Error('Command failed (exit 127): command not found'))).toBeNull()
  expect(startupRetryCode(new Error('bash invocation is already active'))).toBeNull()
})

test('stop-verification retry schedule clears each physical cooldown with retries remaining', () => {
  expect(startupRetryDelays('box_stop_unverified')).toEqual([30_000, 60_000, 120_000])
})
