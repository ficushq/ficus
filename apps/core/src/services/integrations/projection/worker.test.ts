import { expect, test } from 'bun:test'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { IntegrationProjectionFailure } from './reconciler'
import { IntegrationProjectionWorker, PROJECTION_SWEEP_BACKSTOP_TICKS } from './worker'

test('periodic drift discovery can requeue a ready credential revision after a dropped rotation event', async () => {
  let pending = false
  const completed: unknown[] = []
  const worker = new IntegrationProjectionWorker({
    repository: {
      claim: async () =>
        pending
          ? ({ squadId: 'squad', providerKey: 'notion', generation: 2n, leaseToken: 'lease', attempts: 0 } as any)
          : null,
      complete: async (input) => {
        completed.push(input)
        pending = false
      },
      fail: async () => undefined,
    },
    discoverDrift: async () => {
      // Models ready applied revision 1 versus encrypted bundle revision 2.
      pending = true
    },
    reconcile: async () => ({ fingerprint: 'a'.repeat(64), credentialRevision: 2n }),
  })
  expect(await worker.runBatch()).toBe(1)
  expect(completed).toContainEqual(expect.objectContaining({ credentialRevision: 2n }))
})

test('a twenty-claim drain performs global maintenance exactly once', async () => {
  let remaining = 20
  let sweeps = 0
  let driftScans = 0
  const worker = new IntegrationProjectionWorker({
    repository: {
      sweepMissing: async () => void (sweeps += 1),
      claim: async (_now, leaseExpiresAt, leaseToken) =>
        remaining-- > 0
          ? ({
              squadId: `squad-${remaining}`,
              providerKey: 'notion',
              generation: 1n,
              attempts: 0,
              leaseToken,
              leaseExpiresAt,
            } as any)
          : null,
      complete: async () => true,
      fail: async () => true,
    },
    discoverDrift: async () => void (driftScans += 1),
    reconcile: async () => ({ fingerprint: 'a'.repeat(64), credentialRevision: 1n }),
  })
  expect(await worker.runBatch()).toBe(20)
  expect({ sweeps, driftScans }).toEqual({ sweeps: 1, driftScans: 1 })
})

test('projection worker completes claimed generation and retries sanitized failures', async () => {
  const completed: unknown[] = []
  const failed: unknown[] = []
  const claims = [
    {
      squadId: 'squad',
      providerKey: 'notion',
      generation: 1n,
      leaseToken: 'lease',
      attempts: 0,
    },
    {
      squadId: 'squad',
      providerKey: 'notion',
      generation: 2n,
      leaseToken: 'lease-2',
      attempts: 1,
    },
    {
      squadId: 'squad',
      providerKey: 'notion',
      generation: 3n,
      leaseToken: 'lease-3',
      attempts: 0,
    },
  ] as any[]
  const worker = new IntegrationProjectionWorker({
    repository: {
      claim: async () => claims.shift() ?? null,
      complete: async (input) => void completed.push(input),
      fail: async (input) => void failed.push(input),
    },
    reconcile: async (claim) => {
      if (claim.generation === 2n) throw new Error('raw TOKEN-SENTINEL')
      if (claim.generation === 3n) throw new IntegrationProjectionFailure('protected_env_write_failed')
      return { fingerprint: 'a'.repeat(64), credentialRevision: 3n }
    },
    now: () => new Date('2026-08-29T03:00:00.000Z'),
    uuid: () => 'lease',
  })
  expect(await worker.runOnce()).toBe(true)
  expect(completed).toHaveLength(1)
  expect(await worker.runOnce()).toBe(true)
  expect(failed).toHaveLength(1)
  expect(JSON.stringify(failed, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))).not.toContain(
    'TOKEN-SENTINEL'
  )
  expect(await worker.runOnce()).toBe(true)
  expect(failed.at(-1)).toMatchObject({ code: 'protected_env_write_failed' })
})

// `IntegrationProjectionWorker.start()` fires its first tick synchronously
// (runImmediately defaults on, and runMaintenance reaches the sweep before its
// first await), so a started worker has always already run pass 1.
test('sweeps the assignments table on change and on the slow backstop, not every tick', async () => {
  // `sweepMissing` is a full `INSERT ... SELECT` over
  // integration_connection_assignments; it used to run on every one of these.
  let sweeps = 0
  const worker = new IntegrationProjectionWorker({
    repository: {
      sweepMissing: async () => void (sweeps += 1),
      claim: async () => null,
      complete: async () => true,
      fail: async () => true,
    },
    reconcile: async () => ({ fingerprint: 'a'.repeat(64), credentialRevision: null }),
  })
  worker.start()
  try {
    // A fresh process has never reconciled, so its first pass sweeps.
    expect(sweeps).toBe(1)

    await worker.runBatch()
    await worker.runBatch()
    expect(sweeps).toBe(1)

    eventEmitter.emit('integration.projection-invalidated', { squadId: 'squad', providerKey: 'notion' })
    await worker.runBatch()
    expect(sweeps).toBe(2)

    // Nothing changes from here on, so only the backstop can fire — and it
    // must, exactly once, on the PROJECTION_SWEEP_BACKSTOP_TICKS-th pass.
    for (let pass = 1; pass < PROJECTION_SWEEP_BACKSTOP_TICKS; pass += 1) await worker.runBatch()
    expect(sweeps).toBe(2)
    await worker.runBatch()
    expect(sweeps).toBe(3)
  } finally {
    await worker.stop()
  }
})

test('an invalidation raised during a sweep leaves the next pass dirty', async () => {
  let sweeps = 0
  const worker = new IntegrationProjectionWorker({
    repository: {
      sweepMissing: async () => {
        sweeps += 1
        if (sweeps === 1) {
          eventEmitter.emit('integration.projection-invalidated', { squadId: 'squad', providerKey: 'notion' })
        }
      },
      claim: async () => null,
      complete: async () => true,
      fail: async () => true,
    },
    reconcile: async () => ({ fingerprint: 'a'.repeat(64), credentialRevision: null }),
  })
  worker.start()
  try {
    expect(sweeps).toBe(1)
    // The invalidation landed while sweep 1 was in flight; swallowing it would
    // leave the assignment unprojected for the full 10-minute backstop.
    await worker.runBatch()
    expect(sweeps).toBe(2)
    await worker.runBatch()
    expect(sweeps).toBe(2)
  } finally {
    await worker.stop()
  }
})

test('the projection-invalidated event still drives an immediate reconcile', async () => {
  let pending = false
  const completed: unknown[] = []
  const worker = new IntegrationProjectionWorker({
    repository: {
      sweepMissing: async () => {},
      claim: async () =>
        pending
          ? ({ squadId: 'squad', providerKey: 'notion', generation: 1n, leaseToken: 'lease', attempts: 0 } as any)
          : null,
      complete: async (input) => {
        pending = false
        completed.push(input)
      },
      fail: async () => true,
    },
    reconcile: async () => ({ fingerprint: 'a'.repeat(64), credentialRevision: 1n }),
  })
  worker.start()
  try {
    expect(completed).toHaveLength(0)
    pending = true
    eventEmitter.emit('integration.projection-invalidated', { squadId: 'squad', providerKey: 'notion' })
    for (let attempt = 0; attempt < 100 && completed.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(completed).toHaveLength(1)
  } finally {
    await worker.stop()
  }
})

test('a projection whose install outlasts the lease keeps renewing it instead of being claimed again', async () => {
  const renewals: { leaseToken: string; leaseExpiresAt: Date }[] = []
  const completed: unknown[] = []
  let claims = 0
  let release!: () => void
  const install = new Promise<void>((resolve) => (release = resolve))
  const worker = new IntegrationProjectionWorker({
    leaseRenewMs: 5,
    repository: {
      claim: async (_now, leaseExpiresAt, leaseToken) =>
        claims++ === 0
          ? ({
              squadId: 'squad',
              providerKey: 'linear',
              generation: 4n,
              attempts: 0,
              leaseToken,
              leaseExpiresAt,
            } as any)
          : null,
      renew: async (input) => {
        renewals.push({ leaseToken: input.leaseToken, leaseExpiresAt: input.leaseExpiresAt })
        return true
      },
      complete: async (input) => {
        completed.push(input)
        return true
      },
      fail: async () => true,
    },
    reconcile: async () => {
      await install
      return { fingerprint: 'b'.repeat(64), credentialRevision: null }
    },
    uuid: () => 'lease-1',
  })
  const running = worker.runOnce()
  while (renewals.length < 3) await Bun.sleep(2)
  release()
  expect(await running).toBe(true)
  const afterCompletion = renewals.length
  await Bun.sleep(30)
  // Renewal stops with the reconcile, and every renewal used the claim's own lease.
  expect(renewals.length).toBe(afterCompletion)
  expect(new Set(renewals.map((renewal) => renewal.leaseToken))).toEqual(new Set(['lease-1']))
  expect(completed).toEqual([expect.objectContaining({ leaseToken: 'lease-1', generation: 4n })])
})

test('renewal stops once the claim is lost and a failed reconcile still records its failure', async () => {
  let renewals = 0
  const failed: unknown[] = []
  let release!: () => void
  const install = new Promise<void>((resolve) => (release = resolve))
  const worker = new IntegrationProjectionWorker({
    leaseRenewMs: 5,
    repository: {
      claim: async (_now, leaseExpiresAt, leaseToken) =>
        ({ squadId: 'squad', providerKey: 'linear', generation: 1n, attempts: 0, leaseToken, leaseExpiresAt }) as any,
      renew: async () => {
        renewals += 1
        return false
      },
      complete: async () => true,
      fail: async (input) => {
        failed.push(input)
        return true
      },
    },
    reconcile: async () => {
      await install
      throw new IntegrationProjectionFailure('toolchain_readiness_failed')
    },
  })
  const running = worker.runOnce()
  while (renewals < 1) await Bun.sleep(2)
  await Bun.sleep(30)
  expect(renewals).toBe(1)
  release()
  await running
  expect(failed).toEqual([expect.objectContaining({ code: 'toolchain_readiness_failed' })])
})
