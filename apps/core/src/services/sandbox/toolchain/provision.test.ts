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
      let loaded: string | undefined
      h.deps.readLockPin = async (squad, fingerprint) => {
        reads.push([squad, fingerprint])
        return stored
      }
      h.deps.storeLockPin = async (_squad, fingerprint, lock, replacing) =>
        void stores.push({ fingerprint, lock, replacing })
      const manager = {
        reconcileToolchain: async (_id: string, _opts: SandboxOptions, request: ManagedToolchainRequest) => {
          loaded = await request.loadPinnedLock?.()
          if (resolved) await request.recordResolvedLock?.(resolved.lock, { unrealizable: resolved.unrealizable })
          return 'applied' as const
        },
      } as ISandboxManager
      return { ...h, manager, reads, stores, loaded: () => loaded }
    }

    it('hands the runtime the squad pin for the current fingerprint', async () => {
      const h = pinHarness(devboxLock(), undefined)
      await ensureSandboxToolchain(h.manager, 'squad_one', opts, squadId, h.deps)
      expect(h.reads).toEqual([[squadId, fingerprintToolchain(config)]])
      expect(h.loaded()).toBe(devboxLock())
      expect(h.stores).toEqual([])
    })

    it('records the first fresh resolution without replacing anything', async () => {
      const h = pinHarness(null, { lock: devboxLock(), unrealizable: false })
      await ensureSandboxToolchain(h.manager, 'squad_one', opts, squadId, h.deps)
      expect(h.loaded()).toBeUndefined()
      expect(h.stores).toEqual([
        { fingerprint: fingerprintToolchain(config), lock: devboxLock(), replacing: undefined },
      ])
    })

    it('treats a corrupt pin as missing and lets the fresh resolution replace it', async () => {
      const h = pinHarness('{not json', { lock: devboxLock(), unrealizable: false })
      await ensureSandboxToolchain(h.manager, 'squad_one', opts, squadId, h.deps)
      expect(h.loaded()).toBeUndefined()
      expect(h.stores).toEqual([
        { fingerprint: fingerprintToolchain(config), lock: devboxLock(), replacing: '{not json' },
      ])
    })

    it('replaces only the pin that failed to install', async () => {
      const fresh = devboxLock('346dd96ad74dc4457a9db9de4f4f57dab2e5731d')
      const h = pinHarness(devboxLock(), { lock: fresh, unrealizable: true })
      await ensureSandboxToolchain(h.manager, 'squad_one', opts, squadId, h.deps)
      expect(h.stores).toEqual([{ fingerprint: fingerprintToolchain(config), lock: fresh, replacing: devboxLock() }])
    })

    it('never stores a resolved lock that fails validation', async () => {
      const poisoned = devboxLock().replace('NixOS/nixpkgs', 'attacker/nixpkgs')
      const h = pinHarness(null, { lock: poisoned, unrealizable: false })
      await ensureSandboxToolchain(h.manager, 'squad_one', opts, squadId, h.deps)
      expect(h.stores).toEqual([])
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
