import { describe, expect, it } from 'bun:test'
import type { ISandboxManager, ManagedToolchainRequest, SandboxOptions } from '../types'
import { fingerprintToolchain } from './config'
import {
  createToolchainProvisioner,
  ensureSandboxToolchain,
  ToolchainProvisioningError,
  type ToolchainProvisionDeps,
} from './provision'
import type { ToolchainReconcileSnapshot } from './state'

const opts: SandboxOptions = { workspacePath: '/workspace' }
const squadId = '11111111-1111-4111-8111-111111111111'
const config = { packages: ['python3@latest'], setupScript: 'echo ready' }

function harness(initial: ToolchainReconcileSnapshot) {
  let snapshot = initial
  const calls: string[] = []
  const manager = {
    reconcileToolchain: async (_id, _opts, request) => {
      calls.push(`runtime:${request.config?.packages.join(',') ?? 'clear'}`)
      if (request.config) await request.reportStage('installing')
      return request.config ? ('applied' as const) : ('cleared' as const)
    },
  } as ISandboxManager
  const deps: ToolchainProvisionDeps = {
    readSnapshot: async () => {
      calls.push('snapshot')
      return snapshot
    },
    markDesired: async () => void calls.push('desired'),
    markActivationRequired: async () => void calls.push('activation'),
    markStage: async ({ status }) => void calls.push(`stage:${status}`),
    markReady: async () => void calls.push('ready'),
    markFailed: async ({ errorCode }) => void calls.push(`failed:${errorCode}`),
    clearState: async () => void calls.push('clear'),
    withLease: async (_sandboxId, reconcile) => {
      calls.push('lease')
      return reconcile()
    },
    readLockPin: async () => null,
    storeLockPin: async () => {},
    verifyLock: async () => ({ ok: false, reason: 'not verified in this test' }),
  }
  return { manager, deps, calls, setSnapshot: (next: ToolchainReconcileSnapshot) => (snapshot = next) }
}

const REV = 'c7def046b9a883d46974757852106483d741586f'
function devboxLock(rev = REV): string {
  return JSON.stringify({
    lockfile_version: '1',
    packages: { 'python3@latest': { resolved: `github:NixOS/nixpkgs/${rev}#python3`, source: 'devbox-search' } },
  })
}

describe('sandbox toolchain provisioning orchestration', () => {
  it('uses the true no-declaration fast path without a lease or runtime mutation', async () => {
    const { manager, deps, calls } = harness({ config: undefined, provision: undefined, activation: undefined })
    await ensureSandboxToolchain(manager, 'squad_clean', opts, squadId, deps)
    expect(calls).toEqual(['snapshot'])
  })

  it('re-reads managed evidence under the lease before clearing it', async () => {
    const { manager, deps, calls } = harness({
      config: undefined,
      provision: undefined,
      activation: { sandboxId: 'squad_one', squadId, updatedAt: new Date() },
    })
    await ensureSandboxToolchain(manager, 'squad_one', opts, squadId, deps)
    expect(calls).toEqual(['snapshot', 'lease', 'snapshot', 'runtime:clear', 'clear'])
  })

  it('reconciles declaration changes committed before the locked re-read', async () => {
    const h = harness({
      config: undefined,
      provision: undefined,
      activation: { sandboxId: 'squad_one', squadId, updatedAt: new Date() },
    })
    h.deps.withLease = async (_sandboxId, reconcile) => {
      h.setSnapshot({ config, provision: undefined, activation: undefined })
      return reconcile()
    }
    await ensureSandboxToolchain(h.manager, 'squad_one', opts, squadId, h.deps)
    expect(h.calls).toContain('runtime:python3@latest')
    expect(h.calls).not.toContain('runtime:clear')
  })

  it('persists activation evidence immediately before configured runtime work', async () => {
    const { manager, deps, calls } = harness({ config, provision: undefined, activation: undefined })
    await ensureSandboxToolchain(manager, 'squad_one', opts, squadId, deps)
    expect(calls).toEqual([
      'snapshot',
      'lease',
      'snapshot',
      'desired',
      'activation',
      'runtime:python3@latest',
      'stage:installing',
      'ready',
    ])
  })

  it('retains evidence when runtime clear fails', async () => {
    const { deps, calls } = harness({
      config: undefined,
      provision: undefined,
      activation: { sandboxId: 'squad_one', squadId, updatedAt: new Date() },
    })
    const manager = {
      reconcileToolchain: async () => {
        calls.push('runtime:clear')
        throw new Error('clear failed')
      },
    } as unknown as ISandboxManager
    await expect(ensureSandboxToolchain(manager, 'squad_one', opts, squadId, deps)).rejects.toBeInstanceOf(
      ToolchainProvisioningError
    )
    expect(calls).not.toContain('clear')
  })

  it('queues a declaration removal behind an apply instead of swallowing its wake-up', async () => {
    const calls: string[] = []
    let current: ToolchainReconcileSnapshot = { config, provision: undefined, activation: undefined }
    let releaseApply!: () => void
    let activeRuntimeCalls = 0
    let maxRuntimeConcurrency = 0
    const blocked = new Promise<void>((resolve) => (releaseApply = resolve))
    const manager = {
      reconcileToolchain: async (_id: string, _opts: SandboxOptions, request: any) => {
        activeRuntimeCalls++
        maxRuntimeConcurrency = Math.max(maxRuntimeConcurrency, activeRuntimeCalls)
        calls.push(request.config ? 'runtime:apply' : 'runtime:clear')
        try {
          if (request.config) await blocked
          return request.config ? 'applied' : 'cleared'
        } finally {
          activeRuntimeCalls--
        }
      },
    } as ISandboxManager
    const deps: ToolchainProvisionDeps = {
      readSnapshot: async () => current,
      withLease: async (_id, reconcile) => reconcile(),
      markDesired: async () => {},
      markActivationRequired: async () => {
        current = {
          ...current,
          activation: { sandboxId: 'squad_race', squadId, updatedAt: new Date() },
        }
      },
      markStage: async () => {},
      markReady: async () => {},
      markFailed: async () => {},
      clearState: async () => {
        current = { config: undefined, provision: undefined, activation: undefined }
      },
      readLockPin: async () => null,
      storeLockPin: async () => {},
      verifyLock: async () => ({ ok: false, reason: 'not verified in this test' }),
    }
    const provision = createToolchainProvisioner()
    const applying = provision(manager, 'squad_race', opts, squadId, deps)
    while (!calls.includes('runtime:apply')) await Bun.sleep(1)
    current = { ...current, config: undefined }
    const clearing = provision(manager, 'squad_race', opts, squadId, deps)
    releaseApply()
    await Promise.all([applying, clearing])
    expect(calls).toEqual(['runtime:apply', 'runtime:clear'])
    expect(maxRuntimeConcurrency).toBe(1)
    expect(current).toEqual({ config: undefined, provision: undefined, activation: undefined })
  })

  describe('pinned devbox.lock', () => {
    // A runtime stub that loads the pin and then reports what it resolved.
    function pinHarness(stored: string | null, resolved: { lock: string; unrealizable: boolean } | undefined) {
      const h = harness({ config, provision: undefined, activation: undefined })
      const reads: Array<[string, string]> = []
      const stores: Array<{ fingerprint: string; lock: string; replacing?: string }> = []
      const verified: string[] = []
      let loaded: string | undefined
      h.deps.readLockPin = async (squad, fingerprint) => {
        reads.push([squad, fingerprint])
        return stored
      }
      h.deps.storeLockPin = async (_squad, fingerprint, lock, replacing) =>
        void stores.push({ fingerprint, lock, replacing })
      // Stands in for upstream verification: Core stores what it built, never the captured bytes.
      h.deps.verifyLock = async (captured) => {
        verified.push(captured)
        return captured.includes('attacker')
          ? { ok: false, reason: 'not upstream' }
          : { ok: true, lock: `verified:${captured}` }
      }
      const manager = {
        reconcileToolchain: async (_id: string, _opts: SandboxOptions, request: ManagedToolchainRequest) => {
          loaded = await request.loadPinnedLock?.()
          if (resolved) await request.recordResolvedLock?.(resolved.lock, { unrealizable: resolved.unrealizable })
          return 'applied' as const
        },
      } as ISandboxManager
      return { ...h, manager, reads, stores, verified, loaded: () => loaded }
    }

    it('hands the runtime the squad pin for the current fingerprint', async () => {
      const h = pinHarness(devboxLock(), undefined)
      await ensureSandboxToolchain(h.manager, 'squad_one', opts, squadId, h.deps)
      expect(h.reads).toEqual([[squadId, fingerprintToolchain(config)]])
      expect(h.loaded()).toBe(devboxLock())
      expect(h.stores).toEqual([])
    })

    it('stores the verified pin Core built from the first fresh resolution', async () => {
      const h = pinHarness(null, { lock: devboxLock(), unrealizable: false })
      await ensureSandboxToolchain(h.manager, 'squad_one', opts, squadId, h.deps)
      expect(h.loaded()).toBeUndefined()
      expect(h.verified).toEqual([devboxLock()])
      expect(h.stores).toEqual([
        { fingerprint: fingerprintToolchain(config), lock: `verified:${devboxLock()}`, replacing: undefined },
      ])
    })

    it('treats a corrupt pin as missing and lets a verified resolution replace it', async () => {
      const h = pinHarness('{not json', { lock: devboxLock(), unrealizable: false })
      await ensureSandboxToolchain(h.manager, 'squad_one', opts, squadId, h.deps)
      expect(h.loaded()).toBeUndefined()
      expect(h.stores).toEqual([
        { fingerprint: fingerprintToolchain(config), lock: `verified:${devboxLock()}`, replacing: '{not json' },
      ])
    })

    it('does not reuse a stored pin with a content-hashed package entry', async () => {
      const hashed = devboxLock().replace('#python3', '?narHash=sha256-AAAA#python3')
      const h = pinHarness(hashed, undefined)
      await ensureSandboxToolchain(h.manager, 'squad_one', opts, squadId, h.deps)
      expect(h.loaded()).toBeUndefined()
    })

    // A box can make its own pinned install fail; that must not let it move the pin.
    it('never replaces a pin because a pinned install failed', async () => {
      const fresh = devboxLock('346dd96ad74dc4457a9db9de4f4f57dab2e5731d')
      const h = pinHarness(devboxLock(), { lock: fresh, unrealizable: true })
      await ensureSandboxToolchain(h.manager, 'squad_one', opts, squadId, h.deps)
      expect(h.verified).toEqual([])
      expect(h.stores).toEqual([])
      expect(h.calls).toContain('ready')
    })

    it('never stores a resolved lock that fails verification', async () => {
      const poisoned = devboxLock().replace('NixOS/nixpkgs', 'attacker/nixpkgs')
      const h = pinHarness(null, { lock: poisoned, unrealizable: false })
      await ensureSandboxToolchain(h.manager, 'squad_one', opts, squadId, h.deps)
      expect(h.stores).toEqual([])
      expect(h.calls).toContain('ready')
    })

    it('resolves afresh when the pin cannot be read', async () => {
      const h = pinHarness(null, undefined)
      h.deps.readLockPin = async () => Promise.reject(new Error('db down'))
      await ensureSandboxToolchain(h.manager, 'squad_one', opts, squadId, h.deps)
      expect(h.loaded()).toBeUndefined()
      expect(h.calls).toContain('ready')
    })
  })

  it('fails safely when a configured runtime has no adapter', async () => {
    const { deps, calls } = harness({ config, provision: undefined, activation: undefined })
    await expect(
      ensureSandboxToolchain({} as ISandboxManager, 'squad_one', opts, squadId, deps)
    ).rejects.toBeInstanceOf(ToolchainProvisioningError)
    expect(calls).toContain('failed:devbox_unavailable')
  })
})

describe('settling the toolchain without blocking the sandbox', () => {
  function gated() {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    return { gate, release }
  }

  /** A runtime whose install (or applied-path check) waits on a gate the test controls. */
  function slowRuntime(calls: string[], gate: Promise<void>, behaviour: 'install' | 'unchanged' | 'fail' = 'install') {
    return {
      reconcileToolchain: async (_id: string, _opts: SandboxOptions, request: ManagedToolchainRequest) => {
        calls.push('runtime')
        if (behaviour === 'unchanged') {
          await gate
          return 'unchanged' as const
        }
        await request.reportStage('installing')
        await gate
        if (behaviour === 'fail') {
          const { ToolchainAdapterError } = await import('./provision')
          throw new ToolchainAdapterError('setup_failed', 1)
        }
        return 'applied' as const
      },
    } as ISandboxManager
  }

  it('returns as soon as a slow install starts and finishes it in the background', async () => {
    const h = harness({ config, provision: undefined, activation: undefined })
    const { gate, release } = gated()
    const provisioner = createToolchainProvisioner()
    const outcome = await provisioner.settle(slowRuntime(h.calls, gate), 'squad_slow', opts, squadId, {
      deps: h.deps,
      waitMs: 60_000,
    })
    expect(outcome).toBe('installing')
    expect(provisioner.isInstalling('squad_slow')).toBe(true)
    expect(h.calls).not.toContain('ready')

    release()
    await provisioner(slowRuntime(h.calls, gate), 'squad_slow', opts, squadId, h.deps)
    expect(h.calls).toContain('ready')
    expect(provisioner.isInstalling('squad_slow')).toBe(false)
  })

  it('waits for an already-applied toolchain so the first command has it', async () => {
    const h = harness({ config, provision: undefined, activation: undefined })
    const { gate, release } = gated()
    const provisioner = createToolchainProvisioner()
    let returned = false
    const settling = provisioner
      .settle(slowRuntime(h.calls, gate, 'unchanged'), 'squad_unchanged', opts, squadId, {
        deps: h.deps,
        waitMs: 60_000,
      })
      .then((outcome) => {
        returned = true
        return outcome
      })
    while (!h.calls.includes('runtime')) await Bun.sleep(1)
    await Bun.sleep(10)
    expect(returned).toBe(false)
    release()
    expect(await settling).toBe('settled')
  })

  it('reports a failed install without throwing and records the readiness failure', async () => {
    const h = harness({ config, provision: undefined, activation: undefined })
    const { gate, release } = gated()
    release()
    const provisioner = createToolchainProvisioner()
    // The runtime reports install work first, so settle returns early; the
    // failure lands in the recorded status rather than in the caller.
    expect(
      await provisioner.settle(slowRuntime(h.calls, gate, 'fail'), 'squad_fail', opts, squadId, {
        deps: h.deps,
        waitMs: 60_000,
      })
    ).toBe('installing')
    while (!h.calls.includes('failed:setup_failed')) await Bun.sleep(1)
    expect(h.calls).not.toContain('ready')

    // A failure before any install work returns `failed`, still without throwing.
    const noAdapter = harness({ config, provision: undefined, activation: undefined })
    expect(
      await provisioner.settle({} as ISandboxManager, 'squad_no_adapter', opts, squadId, { deps: noAdapter.deps })
    ).toBe('failed')
    expect(noAdapter.calls).toContain('failed:devbox_unavailable')
  })

  it('lets every other ensure through while an attach-triggered install is running, without stacking reconciles', async () => {
    const h = harness({ config, provision: undefined, activation: undefined })
    const { gate, release } = gated()
    const provisioner = createToolchainProvisioner()
    const runtime = slowRuntime(h.calls, gate)
    // The integration projection awaits the full reconcile.
    const projection = provisioner(runtime, 'squad_busy', opts, squadId, h.deps)
    while (!provisioner.isInstalling('squad_busy')) await Bun.sleep(1)

    // Agent turns starting meanwhile return immediately.
    const outcomes = await Promise.all(
      [1, 2, 3].map(() => provisioner.settle(runtime, 'squad_busy', opts, squadId, { deps: h.deps, waitMs: 60_000 }))
    )
    expect(outcomes).toEqual(['installing', 'installing', 'installing'])

    release()
    await projection
    // One follow-up reconcile is shared by all three ensures.
    while (h.calls.filter((call) => call === 'ready').length < 2) await Bun.sleep(1)
    await Bun.sleep(20)
    expect(h.calls.filter((call) => call === 'runtime').length).toBe(2)
    expect(provisioner.isInstalling('squad_busy')).toBe(false)
  })

  it('stops waiting when another process holds the provisioning lease for an install', async () => {
    const h = harness({
      config,
      provision: {
        sandboxId: 'squad_peer',
        squadId,
        desiredFingerprint: fingerprintToolchain(config),
        status: 'installing',
        updatedAt: new Date(),
      },
      activation: undefined,
    })
    const { gate, release } = gated()
    h.deps.withLease = async (_id, reconcile) => {
      await gate
      return reconcile()
    }
    const provisioner = createToolchainProvisioner()
    const started = Date.now()
    expect(
      await provisioner.settle(slowRuntime(h.calls, Promise.resolve()), 'squad_peer', opts, squadId, {
        deps: h.deps,
        waitMs: 60_000,
      })
    ).toBe('installing')
    expect(Date.now() - started).toBeLessThan(5_000)
    release()
  })

  it('stops waiting after the budget when the lease is held without a visible install', async () => {
    const h = harness({ config, provision: undefined, activation: undefined })
    const { gate, release } = gated()
    h.deps.withLease = async (_id, reconcile) => {
      await gate
      return reconcile()
    }
    const provisioner = createToolchainProvisioner()
    expect(
      await provisioner.settle(slowRuntime(h.calls, Promise.resolve()), 'squad_lease', opts, squadId, {
        deps: h.deps,
        waitMs: 20,
      })
    ).toBe('installing')
    expect(h.calls).not.toContain('runtime')
    release()
  })
})
