import { describe, expect, test } from 'bun:test'
import { BashCleanupUnprovenError, BashOutcomeUnknownError, type SandboxClient } from '../client/http-client'
import { reconcileVmSetup, type VmSetupReconcilerDeps } from './setup-reconciler'
import type { VmSetupState } from './setup-state'

function state(overrides: Partial<VmSetupState> = {}): VmSetupState {
  return {
    sandboxId: 'squad_s1',
    desiredFingerprint: 'fingerprint',
    readiness: 'pending',
    reasons: [],
    attemptCount: 0,
    nextAttemptAt: null,
    pendingInvocationId: null,
    pendingInvocationKind: null,
    lastFailureClass: null,
    lastAttemptAt: null,
    updatedAt: new Date(0),
    ...overrides,
  }
}

describe('reconcileVmSetup', () => {
  test('logs one bounded line naming the failed component — the durable row only keeps the reason code', async () => {
    const client = { cancelBashInvocation: async () => {} } as unknown as SandboxClient
    const warnings: string[] = []
    const deps: VmSetupReconcilerDeps = {
      withLease: async (_id, fn) => fn(),
      ensureFingerprint: async () => state(),
      markReconciling: async () => true,
      setPendingInvocation: async () => true,
      clearPendingInvocation: async () => true,
      markDegraded: async (input) => state({ readiness: 'ready_degraded', reasons: input.reasons, attemptCount: 1 }),
      markReady: async () => true,
      getClient: () => client,
      recoverClient: async () => client,
      seedDevbox: async () => {},
      signalDevboxReady: async () => {
        throw new Error('Devbox shell environment is not live')
      },
      writeBashrc: async () => {},
      configureGit: async () => {},
      sleep: async () => {},
      now: () => new Date(0),
      log: { warn: (message) => warnings.push(message) },
    }

    const result = await reconcileVmSetup(
      { sandboxId: 'squad_s1', fingerprint: 'fingerprint', devboxInvocationId: 'devbox-1', configureGit: false },
      deps
    )

    expect(result.reasons).toEqual(['devbox_unavailable'])
    expect(warnings).toEqual(['VM setup devbox step failed for squad_s1: Error: Devbox shell environment is not live'])
  })

  test('recovers after ambiguous Devbox loss, proves cleanup, and runs later components on the fresh client', async () => {
    const oldClient = {
      cancelBashInvocation: async () => {
        throw new BashCleanupUnprovenError('dead transport', 'inv-1')
      },
    } as unknown as SandboxClient
    const freshClient = { cancelBashInvocation: async () => {} } as unknown as SandboxClient
    let current = oldClient
    let durable = state()
    let devboxCalls = 0
    const componentClients: SandboxClient[] = []
    const deps: VmSetupReconcilerDeps = {
      withLease: async (_id, fn) => fn(),
      ensureFingerprint: async () => durable,
      markReconciling: async () => true,
      setPendingInvocation: async () => true,
      clearPendingInvocation: async () => true,
      markDegraded: async (input) =>
        (durable = state({
          readiness: 'ready_degraded',
          reasons: input.reasons,
          attemptCount: 1,
          nextAttemptAt: new Date(60_000),
        })),
      markReady: async () => true,
      getClient: () => current,
      recoverClient: async () => (current = freshClient),
      seedDevbox: async () => {
        devboxCalls++
        throw new BashOutcomeUnknownError('inv-1', 'socket_closed')
      },
      signalDevboxReady: async () => {},
      writeBashrc: async (client) => {
        componentClients.push(client)
      },
      configureGit: async (client) => {
        componentClients.push(client)
      },
      sleep: async () => {},
      now: () => new Date(600_000),
    }

    const result = await reconcileVmSetup(
      {
        sandboxId: 'squad_s1',
        fingerprint: 'fingerprint',
        devboxInvocationId: 'devbox-1',
        configureGit: true,
        now: new Date(0),
      },
      deps
    )

    expect(devboxCalls).toBe(1)
    expect(componentClients).toEqual([freshClient, freshClient])
    expect(result.readiness).toBe('ready_degraded')
    expect(result.reasons).toEqual(['devbox_unavailable'])
  })

  test('aborts before effects when the durable fingerprint generation was replaced', async () => {
    let effects = 0
    const deps: VmSetupReconcilerDeps = {
      withLease: async <T>(_id: string, fn: () => Promise<T>) => fn(),
      ensureFingerprint: async () => state(),
      markReconciling: async () => false,
      setPendingInvocation: async () => true,
      clearPendingInvocation: async () => true,
      markDegraded: async () => null,
      markReady: async () => false,
      getClient: () => ({}) as SandboxClient,
      recoverClient: async () => ({}) as SandboxClient,
      seedDevbox: async () => {
        effects++
      },
      signalDevboxReady: async () => {},
      writeBashrc: async () => {
        effects++
      },
      configureGit: async () => {
        effects++
      },
      sleep: async () => {},
      now: () => new Date(0),
    }
    await expect(
      reconcileVmSetup(
        { sandboxId: 'squad_s1', fingerprint: 'stale', devboxInvocationId: 'devbox-1', configureGit: true },
        deps
      )
    ).rejects.toThrow('fingerprint changed')
    expect(effects).toBe(0)
  })

  test('anchors degraded backoff at completion time after long setup work', async () => {
    let degradedAt: Date | undefined
    const deps: VmSetupReconcilerDeps = {
      withLease: async <T>(_id: string, fn: () => Promise<T>) => fn(),
      ensureFingerprint: async () => state(),
      markReconciling: async () => true,
      setPendingInvocation: async () => true,
      clearPendingInvocation: async () => true,
      markDegraded: async (input) => {
        degradedAt = input.now
        return state({ readiness: 'ready_degraded', reasons: input.reasons, attemptCount: 1 })
      },
      markReady: async () => true,
      getClient: () => ({}) as SandboxClient,
      recoverClient: async () => ({}) as SandboxClient,
      seedDevbox: async () => {
        throw new Error('install failed')
      },
      signalDevboxReady: async () => {},
      writeBashrc: async () => {},
      configureGit: async () => {},
      sleep: async () => {},
      now: () => new Date(600_000),
    }
    await reconcileVmSetup(
      {
        sandboxId: 'squad_s1',
        fingerprint: 'fingerprint',
        devboxInvocationId: 'devbox-1',
        configureGit: false,
        now: new Date(0),
      },
      deps
    )
    expect(degradedAt?.getTime()).toBe(600_000)
  })

  test('skips a degraded setup until its retry is due', async () => {
    const durable = state({
      readiness: 'ready_degraded',
      reasons: ['devbox_unavailable'],
      attemptCount: 2,
      nextAttemptAt: new Date(60_000),
    })
    let calls = 0
    const deps = {
      withLease: async <T>(_id: string, fn: () => Promise<T>) => fn(),
      ensureFingerprint: async () => durable,
      markReconciling: async () => true,
      setPendingInvocation: async () => true,
      clearPendingInvocation: async () => true,
      markDegraded: async () => durable,
      markReady: async () => true,
      getClient: () => ({}) as SandboxClient,
      recoverClient: async () => ({}) as SandboxClient,
      seedDevbox: async () => {
        calls++
      },
      signalDevboxReady: async () => {},
      writeBashrc: async () => {},
      configureGit: async () => {},
      sleep: async () => {},
      now: () => new Date(0),
    } satisfies VmSetupReconcilerDeps

    const result = await reconcileVmSetup(
      {
        sandboxId: 'squad_s1',
        fingerprint: 'fingerprint',
        devboxInvocationId: 'devbox-1',
        configureGit: true,
        now: new Date(0),
      },
      deps
    )
    expect(result).toBe(durable)
    expect(calls).toBe(0)
  })

  test('retains a crash fence and starts no effects when cleanup fails on both clients', async () => {
    const pending = state({ pendingInvocationId: 'prior-inv', pendingInvocationKind: 'devbox_install' })
    const dead = {
      cancelBashInvocation: async () => {
        throw new Error('dead')
      },
    } as unknown as SandboxClient
    let effects = 0
    let cleared = 0
    const deps: VmSetupReconcilerDeps = {
      withLease: async (_id, fn) => fn(),
      ensureFingerprint: async () => pending,
      markReconciling: async () => true,
      setPendingInvocation: async () => true,
      clearPendingInvocation: async () => {
        cleared++
        return true
      },
      markDegraded: async (input) =>
        state({ ...pending, readiness: 'ready_degraded', reasons: input.reasons, attemptCount: 1 }),
      markReady: async () => true,
      getClient: () => dead,
      recoverClient: async () => dead,
      seedDevbox: async () => {
        effects++
      },
      signalDevboxReady: async () => {
        effects++
      },
      writeBashrc: async () => {
        effects++
      },
      configureGit: async () => {
        effects++
      },
      sleep: async () => {},
      now: () => new Date(1),
    }
    const result = await reconcileVmSetup(
      { sandboxId: 'squad_s1', fingerprint: 'fingerprint', devboxInvocationId: 'new-inv', configureGit: true },
      deps
    )
    expect(result.reasons).toEqual(['command_outcome_ambiguous'])
    expect(effects).toBe(0)
    expect(cleared).toBe(0)
  })
  test('fences Git before admission and retries it once only after ambiguous cleanup proof', async () => {
    const client = { cancelBashInvocation: async () => {} } as unknown as SandboxClient
    const events: string[] = []
    let gitCalls = 0
    const deps: VmSetupReconcilerDeps = {
      withLease: async (_id, fn) => fn(),
      ensureFingerprint: async () => state(),
      markReconciling: async () => true,
      setPendingInvocation: async (_id, _fp, id, kind) => {
        events.push(`set:${kind}:${id}`)
        return true
      },
      clearPendingInvocation: async (_id, _fp, id) => {
        events.push(`clear:${id}`)
        return true
      },
      markDegraded: async (input) => state({ readiness: 'ready_degraded', reasons: input.reasons }),
      markReady: async () => true,
      getClient: () => client,
      recoverClient: async () => client,
      seedDevbox: async () => {},
      signalDevboxReady: async () => {},
      writeBashrc: async () => {},
      configureGit: async () => {
        events.push('git')
        gitCalls++
        if (gitCalls === 1) throw new BashOutcomeUnknownError('git-1', 'socket_closed')
      },
      sleep: async () => {},
      now: () => new Date(1),
    }
    await reconcileVmSetup(
      {
        sandboxId: 'squad_s1',
        fingerprint: 'fingerprint',
        devboxInvocationId: 'devbox-1',
        gitInvocationId: 'git-1',
        configureGit: true,
      },
      deps
    )
    expect(events.filter((event) => event.includes('git'))).toEqual([
      'set:git_config:git-1',
      'git',
      'git',
      'clear:git-1',
    ])
  })

  test('persists a newly observed callback fallback from prior ready without comfort effects', async () => {
    let durable = state({ readiness: 'ready' })
    let effects = 0
    const deps = {
      withLease: async (_id: string, fn: () => Promise<any>) => fn(),
      ensureFingerprint: async () => durable,
      markReconciling: async () => true,
      setPendingInvocation: async () => true,
      clearPendingInvocation: async () => true,
      mergeObservedReasons: async (_id: string, _fp: string, reasons: any[]) =>
        (durable = state({ readiness: 'ready_degraded', reasons, attemptCount: 1, nextAttemptAt: new Date(30_000) })),
      markDegraded: async (input: any) =>
        (durable = state({
          readiness: 'ready_degraded',
          reasons: input.reasons,
          attemptCount: 1,
          nextAttemptAt: new Date(30_000),
        })),
      markReady: async () => true,
      getClient: () => ({}) as SandboxClient,
      recoverClient: async () => ({}) as SandboxClient,
      seedDevbox: async () => {
        effects++
      },
      signalDevboxReady: async () => {},
      writeBashrc: async () => {
        effects++
      },
      configureGit: async () => {
        effects++
      },
      sleep: async () => {},
      now: () => new Date(0),
    } satisfies VmSetupReconcilerDeps
    const result = await reconcileVmSetup(
      {
        sandboxId: 'squad_s1',
        fingerprint: 'fingerprint',
        devboxInvocationId: 'devbox-1',
        configureGit: true,
        initialReasons: ['callback_transport_degraded'],
      },
      deps
    )
    expect(result).toMatchObject({
      readiness: 'ready_degraded',
      reasons: ['callback_transport_degraded'],
      attemptCount: 1,
    })
    expect(effects).toBe(0)
  })

  test('merges new callback fallback into non-due degradation without changing backoff or comfort effects', async () => {
    const retry = new Date(60_000)
    let durable = state({
      readiness: 'ready_degraded',
      reasons: ['devbox_unavailable'],
      attemptCount: 2,
      nextAttemptAt: retry,
    })
    let effects = 0
    const deps = {
      withLease: async (_id: string, fn: () => Promise<any>) => fn(),
      ensureFingerprint: async () => durable,
      markReconciling: async () => true,
      setPendingInvocation: async () => true,
      clearPendingInvocation: async () => true,
      mergeObservedReasons: async (_id: string, _fp: string, reasons: any[]) =>
        (durable = { ...durable, reasons: [...durable.reasons, ...reasons] }),
      markDegraded: async () => durable,
      markReady: async () => true,
      getClient: () => ({}) as SandboxClient,
      recoverClient: async () => ({}) as SandboxClient,
      seedDevbox: async () => {
        effects++
      },
      signalDevboxReady: async () => {},
      writeBashrc: async () => {
        effects++
      },
      configureGit: async () => {
        effects++
      },
      sleep: async () => {},
      now: () => new Date(0),
    } satisfies VmSetupReconcilerDeps
    const result = await reconcileVmSetup(
      {
        sandboxId: 'squad_s1',
        fingerprint: 'fingerprint',
        devboxInvocationId: 'devbox-1',
        configureGit: true,
        initialReasons: ['callback_transport_degraded'],
        now: new Date(0),
      },
      deps
    )
    expect(result).toMatchObject({
      reasons: ['devbox_unavailable', 'callback_transport_degraded'],
      attemptCount: 2,
      nextAttemptAt: retry,
    })
    expect(effects).toBe(0)
  })
})
