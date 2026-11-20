import { beforeEach, describe, expect, it } from 'bun:test'
import type { AccountStoreV1 } from '../agent/account-store'
import { buildProviderChains, FleetAlertRuntime } from './runtime'
import { providerHealth, resetProviderHealthForTests } from '../provider-health/registry'

describe('FleetAlertRuntime', () => {
  beforeEach(() => resetProviderHealthForTests())

  it('keeps elapsed but unresolved observations visible to alert reconciliation', async () => {
    providerHealth.markExhausted('anthropic', { reason: 'rate-limit', retryAt: Date.now() + 5 })
    await Bun.sleep(10)
    let observed: readonly unknown[] = []
    const runtime = new FleetAlertRuntime({
      getEnabledChains: async () => [],
      getDemand: async () => new Map(),
      reconcileProvider: async ({ records }) => {
        observed = records
        return { fleetStarved: false }
      },
      reconcileDeadFleet: async () => {},
      reconcileSandboxOverload: async () => {},
      reconcileSlotCapacity: async () => {},
      drainNotifications: async () => {},
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    })

    runtime.start()
    await runtime.stop()

    expect(observed).toEqual([expect.objectContaining({ provider: 'anthropic', kind: 'rate-limit' })])
  })

  it('runs the complete alert pipeline immediately, periodically, without overlap, and stops cleanly', async () => {
    const calls: string[] = []
    let release!: () => void
    const blocked = new Promise<void>((resolve) => (release = resolve))
    let intervalCallback!: () => void
    let cleared: unknown
    const runtime = new FleetAlertRuntime({
      intervalMs: 123,
      now: () => new Date('2026-08-18T00:00:00Z'),
      getEnabledChains: async () => {
        calls.push('chains')
        return [[{ provider: 'openai', credentialUsable: true }]]
      },
      getHealth: () => ({ records: [], diagnostics: [] }),
      getDemand: async () => {
        calls.push('demand')
        return new Map()
      },
      reconcileProvider: async () => {
        calls.push('provider')
        return { fleetStarved: true }
      },
      reconcileDeadFleet: async () => {
        calls.push('dead')
        await blocked
      },
      reconcileSandboxOverload: async () => {
        calls.push('overload')
      },
      reconcileSlotCapacity: async () => {
        calls.push('slots')
      },
      drainNotifications: async () => {
        calls.push('notify')
      },
      setIntervalFn: (callback, ms) => {
        expect(ms).toBe(123)
        intervalCallback = callback
        return 42
      },
      clearIntervalFn: (handle) => {
        cleared = handle
      },
    })

    runtime.start()
    await Bun.sleep(0)
    intervalCallback()
    await Bun.sleep(0)
    expect(calls).toEqual(['chains', 'demand', 'provider', 'dead', 'overload', 'slots'])

    release()
    await runtime.stop()
    expect(calls).toEqual(['chains', 'demand', 'provider', 'dead', 'overload', 'slots', 'notify'])
    expect(cleared).toBe(42)
  })

  it('still reconciles other alerts and delivers notifications when sandbox probing or slot reading fails', async () => {
    const calls: string[] = []
    const runtime = new FleetAlertRuntime({
      now: () => new Date('2026-09-24T00:00:00Z'),
      getEnabledChains: async () => [],
      getHealth: () => ({ records: [] }),
      getDemand: async () => new Map(),
      reconcileProvider: async () => {
        calls.push('provider')
        return { fleetStarved: false }
      },
      reconcileDeadFleet: async () => {
        calls.push('dead')
      },
      reconcileSandboxOverload: async ({ now }) => {
        calls.push(`overload@${now.toISOString()}`)
        throw new Error('box probe exploded')
      },
      reconcileSlotCapacity: async () => {
        calls.push('slots')
        throw new Error('slot read exploded')
      },
      drainNotifications: async () => {
        calls.push('notify')
      },
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    })

    runtime.start()
    await runtime.stop()

    expect(calls).toEqual(['provider', 'dead', 'overload@2026-09-24T00:00:00.000Z', 'slots', 'notify'])
  })

  it('maps enabled model chains to exact usable stored accounts and provider-wide runtime credentials', () => {
    const store: AccountStoreV1 = {
      version: 1,
      accounts: {
        openai: [
          { id: 'enabled', enabled: true, credential: { type: 'api_key', key: 'secret' } },
          { id: 'disabled', enabled: false, credential: { type: 'api_key', key: 'secret' } },
        ],
      },
    }
    expect(
      buildProviderChains(['openai:gpt-5,anthropic:claude', 'openai:gpt-5'], store, (p) => p === 'anthropic')
    ).toEqual([
      [
        { provider: 'openai', accountId: 'enabled', credentialUsable: true },
        { provider: 'anthropic', credentialUsable: true },
      ],
      [{ provider: 'openai', accountId: 'enabled', credentialUsable: true }],
    ])
  })
})
