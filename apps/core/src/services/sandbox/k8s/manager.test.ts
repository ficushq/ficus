import { describe, test, expect, spyOn, mock } from 'bun:test'
import { EventEmitter } from 'events'
import { emitProvisionTransition, K8sSandboxManager } from './manager'
import { SandboxProvisionError } from './provision-errors'
import { reconcilableSpecHash } from './pod-spec'
import { K8sPodManager } from './pod-manager'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { observeSandboxSetupProgress, type SandboxSetupProgressEvent } from '../setup-progress'

describe('K8sSandboxManager', () => {
  test('managed toolchain uses isolated agent path and explicit cache clearing', async () => {
    const manager = new K8sSandboxManager('test')
    const calls: string[] = []
    const stream = () => {
      const value = new EventEmitter() as any
      value.cancel = () => {}
      queueMicrotask(() => {
        value.emit('data', { exitCode: 0 })
        value.emit('end')
      })
      return value
    }
    const client = {
      bash: ({ command }: { command: string }) => {
        calls.push(command)
        return stream()
      },
      toolchainReady: async (active: boolean) => void calls.push(`active:${active}`),
      close: () => {},
    }
    ;(manager as any).sandboxes.set('agent_x', {
      sandboxId: 'agent_x',
      client,
      workspaceMount: '/workspace/squad',
    })

    const progress: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(manager, 'agent_x', (event) => progress.push(event))
    expect(
      await manager.reconcileToolchain(
        'agent_x',
        { workspacePath: '/host', k8s: { sandboxType: 'agent' } },
        { reportStage: async () => {} }
      )
    ).toBe('cleared')
    expect(calls[0]).toContain('/private/.tau/toolchain/.ready')
    expect(calls).toContain('active:false')
    expect(progress[0]).toMatchObject({ type: 'started', reason: 'toolchain_reconcile' })
    expect(progress.at(-1)).toMatchObject({ type: 'finished', outcome: 'ready' })
    await manager.cleanup()
  })

  test('generation-fenced stop preserves B from stale A and stops only the exact generation', async () => {
    const manager = new K8sSandboxManager('test')
    let closed = 0
    ;(manager as any).sandboxes.set('agent_x', {
      sandboxId: 'agent_x',
      lifecycleGeneration: 'generation-b',
      client: { close: () => closed++ },
      workspaceMount: '/workspace',
    })

    await expect(manager.stopSandbox('agent_x', { lifecycleGeneration: 'generation-a' })).resolves.toEqual({
      kind: 'generation-mismatch',
      actualLifecycleGeneration: 'generation-b',
    })
    expect(closed).toBe(0)
    expect((manager as any).sandboxes.has('agent_x')).toBe(true)

    await expect(manager.stopSandbox('agent_x', { lifecycleGeneration: 'generation-b' })).resolves.toEqual({
      kind: 'stopped',
    })
    expect(closed).toBe(1)
    expect((manager as any).sandboxes.has('agent_x')).toBe(false)
    await expect(manager.stopSandbox('agent_x')).resolves.toEqual({ kind: 'not-found' })
  })

  test('no-create attachment adopts only an existing ready pod', async () => {
    const attached: string[] = []
    const self = {
      sandboxes: new Map(),
      podManager: {
        queryPodStatus: async () => ({ status: 'running', containerReady: true }),
        getPodName: () => 'pod-1',
      },
      attachProvisionedSandbox: async (_sandboxId: string, podName: string) => void attached.push(podName),
    }
    await expect(
      K8sSandboxManager.prototype.attachExistingSandbox.call(self as any, 's', { workspacePath: '/workspace' })
    ).resolves.toBe(true)
    expect(attached).toEqual(['pod-1'])
    self.podManager.queryPodStatus = async () => ({ status: 'not_found', containerReady: false })
    await expect(
      K8sSandboxManager.prototype.attachExistingSandbox.call(self as any, 'missing', { workspacePath: '/workspace' })
    ).resolves.toBe(false)
    expect(attached).toEqual(['pod-1'])
  })

  test('module exports K8sSandboxManager', () => {
    expect(K8sSandboxManager).toBeDefined()
  })

  test('emits only the safe provisioning transition hint', () => {
    const emitSpy = spyOn(eventEmitter, 'emit').mockImplementation(() => {})

    emitProvisionTransition('scope-hash', {
      from: 'half_open',
      to: 'open',
      version: 4,
      reasonCode: 'control_plane_unavailable',
      retryAfterMs: 30_000,
      inFlight: 0,
    })

    expect(emitSpy).toHaveBeenCalledWith('sandbox.provision-transition', {
      scopeHash: 'scope-hash',
      from: 'half_open',
      to: 'open',
      version: 4,
      reasonCode: 'control_plane_unavailable',
      retryAfterMs: 30_000,
    })
    emitSpy.mockRestore()
  })

  test('markDevboxReady flips the flag and emits sandbox.status', () => {
    const emitSpy = spyOn(eventEmitter, 'emit').mockImplementation(() => {})
    const state = { sandboxId: 'agent_x', devboxReady: false } as any

    K8sSandboxManager.prototype['markDevboxReady'].call({} as any, state)

    expect(state.devboxReady).toBe(true)
    expect(emitSpy).toHaveBeenCalledWith('sandbox.status', { sandboxId: 'agent_x' })
    emitSpy.mockRestore()
  })

  test('getWorkspaceLayout is the fixed container layout: /private for solo (no squadId)', () => {
    const layout = K8sSandboxManager.prototype.getWorkspaceLayout({})
    expect(layout.privateMount).toBe('/private')
    expect(layout.workspaceMount).toBe('/workspace')
    expect(layout.memoryMount).toBe('/memory')
  })

  test('getWorkspaceLayout(squadId) returns squad-namespaced container mounts', () => {
    const layout = K8sSandboxManager.prototype.getWorkspaceLayout({ squadId: 'sq1' })
    expect(layout.workspaceMount).toBe('/workspace/sq1')
    expect(layout.memoryMount).toBe('/memory/sq1')
    expect(layout.cwd).toBe('/workspace/sq1')
    expect(layout.privateMount).toBe('/private')
  })

  test('getWorkspaceLayout is env-independent (k8s pods keep container mounts even if FICUS_SANDBOX_RUNTIME leaks)', () => {
    const prev = process.env.FICUS_SANDBOX_RUNTIME
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    try {
      expect(K8sSandboxManager.prototype.getWorkspaceLayout({ squadId: 'sq1' }).workspaceMount).toBe('/workspace/sq1')
    } finally {
      if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = prev
    }
  })

  test('getSpawnHook returns null (K8s uses WebSockets instead)', () => {
    const result = K8sSandboxManager.prototype.getSpawnHook.call({ sandboxes: new Map() }, 'test-id', '/workspace')
    expect(result).toBeNull()
  })

  test('hasSandbox returns false for unknown id', () => {
    const result = K8sSandboxManager.prototype.hasSandbox.call({ sandboxes: new Map() }, 'unknown')
    expect(result).toBe(false)
  })

  test('getSandboxRuntime returns null for unknown id', () => {
    const result = K8sSandboxManager.prototype.getSandboxRuntime.call({ sandboxes: new Map() }, 'unknown')
    expect(result).toBeNull()
  })

  test('getLocalDeploymentTarget returns hosted pod DNS target', async () => {
    const previousLocal = process.env.FICUS_K8S_LOCAL
    const previousRuntime = process.env.FICUS_SANDBOX_RUNTIME
    process.env.FICUS_SANDBOX_RUNTIME = 'k8s'
    process.env.FICUS_K8S_LOCAL = 'false'
    const sandboxes = new Map([
      [
        'test-sandbox',
        {
          sandboxId: 'test-sandbox',
          podName: 'tau-sandbox-test',
          endpoint: 'tau-sandbox-test.tau-sandboxes.svc.cluster.local:50051',
          client: {} as any,
          workspacePath: '/host/workspace',
        },
      ],
    ])
    const podManager = { namespace: 'custom-ns', getPodState: () => null }

    try {
      const result = await K8sSandboxManager.prototype.getLocalDeploymentTarget.call(
        { sandboxes, podManager },
        'test-sandbox',
        5173
      )

      expect(result).toEqual({ host: 'tau-sandbox-test.tau-sandboxes.custom-ns.svc.cluster.local', port: 5173 })
    } finally {
      if (previousLocal === undefined) delete process.env.FICUS_K8S_LOCAL
      else process.env.FICUS_K8S_LOCAL = previousLocal
      if (previousRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = previousRuntime
    }
  })

  test('getLocalDeploymentTarget uses tracked pod state instead of local-dev endpoint host as pod name', async () => {
    const previousLocal = process.env.FICUS_K8S_LOCAL
    const previousRuntime = process.env.FICUS_SANDBOX_RUNTIME
    process.env.FICUS_SANDBOX_RUNTIME = 'k8s'
    process.env.FICUS_K8S_LOCAL = 'true'
    const sandboxes = new Map([
      [
        'test-sandbox',
        {
          sandboxId: 'test-sandbox',
          podName: 'localhost:59128',
          endpoint: 'localhost:59128',
          client: {} as any,
          workspacePath: '/host/workspace',
        },
      ],
    ])
    const forwarded: Array<{ sandboxId: string; podName: string; port: number }> = []
    const podManager = {
      namespace: 'custom-ns',
      getPodState: () => ({ podName: 'tau-sandbox-test' }),
      ensureAppPortForward: async (sandboxId: string, podName: string, port: number) => {
        forwarded.push({ sandboxId, podName, port })
        return 59668
      },
    }

    try {
      const result = await K8sSandboxManager.prototype.getLocalDeploymentTarget.call(
        { sandboxes, podManager },
        'test-sandbox',
        3000
      )

      expect(result).toEqual({ host: 'localhost', port: 59668 })
      expect(forwarded).toEqual([{ sandboxId: 'test-sandbox', podName: 'tau-sandbox-test', port: 3000 }])
    } finally {
      if (previousLocal === undefined) delete process.env.FICUS_K8S_LOCAL
      else process.env.FICUS_K8S_LOCAL = previousLocal
      if (previousRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = previousRuntime
    }
  })

  // A stale FICUS_K8S_LOCAL=true in a .env that now selects another runtime must
  // not route deployments through a k3d port-forward that does not exist.
  test('getLocalDeploymentTarget ignores FICUS_K8S_LOCAL when the runtime is not k8s', async () => {
    const previousLocal = process.env.FICUS_K8S_LOCAL
    const previousRuntime = process.env.FICUS_SANDBOX_RUNTIME
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    process.env.FICUS_K8S_LOCAL = 'true'
    const sandboxes = new Map([
      [
        'test-sandbox',
        {
          sandboxId: 'test-sandbox',
          podName: 'tau-sandbox-test',
          endpoint: 'tau-sandbox-test.tau-sandboxes.svc.cluster.local:50051',
          client: {} as any,
          workspacePath: '/host/workspace',
        },
      ],
    ])
    const podManager = {
      namespace: 'custom-ns',
      getPodState: () => null,
      ensureAppPortForward: async () => {
        throw new Error('must not port-forward when the runtime is not k8s')
      },
    }

    try {
      const result = await K8sSandboxManager.prototype.getLocalDeploymentTarget.call(
        { sandboxes, podManager },
        'test-sandbox',
        5173
      )

      expect(result).toEqual({ host: 'tau-sandbox-test.tau-sandboxes.custom-ns.svc.cluster.local', port: 5173 })
    } finally {
      if (previousLocal === undefined) delete process.env.FICUS_K8S_LOCAL
      else process.env.FICUS_K8S_LOCAL = previousLocal
      if (previousRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = previousRuntime
    }
  })

  test('getClientForSandbox returns null for unknown id', () => {
    const result = K8sSandboxManager.prototype.getClientForSandbox.call({ sandboxes: new Map() }, 'unknown')
    expect(result).toBeNull()
  })

  test('toContainerPath returns hostPath when sandbox not found', () => {
    const result = K8sSandboxManager.prototype.toContainerPath.call(
      { sandboxes: new Map() },
      'unknown',
      '/some/host/path'
    )
    expect(result).toBe('/some/host/path')
  })

  test('toContainerPath converts workspace paths correctly', () => {
    const sandboxes = new Map([
      [
        'test-sandbox',
        {
          sandboxId: 'test-sandbox',
          podName: 'tau-sandbox-test',
          endpoint: 'tau-sandbox-test.tau-sandboxes.svc.cluster.local:50051',
          client: {} as any,
          workspacePath: '/host/workspace',
          workspaceMount: '/workspace',
        },
      ],
    ])

    const result = K8sSandboxManager.prototype.toContainerPath.call(
      { sandboxes },
      'test-sandbox',
      '/host/workspace/src/file.ts'
    )
    expect(result).toBe('/workspace/src/file.ts')
  })

  test('toContainerPath preserves non-workspace paths', () => {
    const sandboxes = new Map([
      [
        'test-sandbox',
        {
          sandboxId: 'test-sandbox',
          podName: 'tau-sandbox-test',
          endpoint: 'tau-sandbox-test.tau-sandboxes.svc.cluster.local:50051',
          client: {} as any,
          workspacePath: '/host/workspace',
        },
      ],
    ])

    const result = K8sSandboxManager.prototype.toContainerPath.call(
      { sandboxes },
      'test-sandbox',
      '/other/path/file.ts'
    )
    expect(result).toBe('/other/path/file.ts')
  })

  test('toContainerPath follows state.workspaceMount (workspace-layout seam)', () => {
    // Inject a state with a non-default workspaceMount to prove the seam routes
    // through state.workspaceMount rather than a hardcoded CONTAINER_WORKSPACE_PATH.
    const sandboxes = new Map([
      [
        'test-sandbox',
        {
          sandboxId: 'test-sandbox',
          podName: 'tau-sandbox-test',
          endpoint: 'localhost:50051',
          client: {} as any,
          workspacePath: '/host/workspace',
          workspaceMount: '/custom-mount',
          devboxReady: false,
          bashrcWritten: false,
        },
      ],
    ])

    const result = K8sSandboxManager.prototype.toContainerPath.call(
      { sandboxes },
      'test-sandbox',
      '/host/workspace/sub'
    )
    expect(result).toBe('/custom-mount/sub')
  })

  // Regression: the squad spec-drift reconcile loop. createPod writes the
  // SPEC_HASH_ANNOTATION from {...opts.k8s, squadId: opts.squadId}, so the
  // desired hash from computeSpecHash MUST fold in opts.squadId too — otherwise
  // every reconcile pass sees a permanent drift (annotation has squadIds:[id],
  // desired has squadIds:[]) and recreates the pod forever.
  test('computeSpecHash folds in opts.squadId so it matches the created pod annotation', () => {
    const opts = { squadId: 'sq1', k8s: { ephemeralStorageLimitGi: 25 } } as any
    const desired = K8sSandboxManager.prototype.computeSpecHash.call(K8sSandboxManager.prototype as any, opts)

    // Matches the annotation createPod writes (squadId present)...
    expect(desired).toBe(reconcilableSpecHash({ ephemeralStorageLimitGi: 25, squadId: 'sq1' }))
    // ...and is NOT the squad-less hash that caused the infinite recreate loop.
    expect(desired).not.toBe(reconcilableSpecHash({ ephemeralStorageLimitGi: 25 }))
  })

  test('writes .bashrc to the namespaced workspace mount', async () => {
    const writes: any[] = []
    const client = {
      write: async (p: any) => {
        writes.push(p)
      },
    }
    await (K8sSandboxManager.prototype as any).ensureBashrc.call(
      { sandboxes: new Map(), podManager: new K8sPodManager('test') },
      'squad_sq1',
      client,
      '/host',
      '/workspace/sq1'
    )
    expect(writes[0].path).toBe('/workspace/sq1/.tau/.bashrc')
  })
})

// The 60s reconcile pass is whole-fleet maintenance driven off the DB, so
// running it in both the api and the worker (each entry point builds its own
// manager) did the identical work twice. Only the process that claims periodic
// maintenance may arm it; the other still builds a manager for the request path
// (ensure/exec/spawnShell). The pod idle sweep is NOT gated — it reaps only the
// pods its own process tracks, and the api creates pods of its own.
describe('periodic loop ownership', () => {
  test('a manager that does not own periodic maintenance arms no reconcile loop', async () => {
    const manager = new K8sSandboxManager('test', { runPeriodicLoops: false })
    try {
      expect((manager as any).reconcileInterval).toBeNull()
      // ...but it still sweeps the pods it tracks itself.
      expect((manager as any).podManager.idleCheckInterval).not.toBeNull()
    } finally {
      await manager.cleanup()
      ;(manager as any).podManager.destroy()
    }
  })

  test('the owning manager arms the reconcile loop', async () => {
    const manager = new K8sSandboxManager('test', { runPeriodicLoops: true })
    try {
      expect((manager as any).reconcileInterval).not.toBeNull()
    } finally {
      await manager.cleanup()
      ;(manager as any).podManager.destroy()
    }
  })

  test('defaults to running the reconcile loop when no option is passed', async () => {
    const manager = new K8sSandboxManager('test')
    try {
      expect((manager as any).reconcileInterval).not.toBeNull()
    } finally {
      await manager.cleanup()
      ;(manager as any).podManager.destroy()
    }
  })

  test('startPeriodicMaintenance is idempotent (a late claim cannot double-arm)', async () => {
    const manager = new K8sSandboxManager('test', { runPeriodicLoops: false })
    try {
      manager.startPeriodicMaintenance()
      const reconcile = (manager as any).reconcileInterval
      expect(reconcile).not.toBeNull()
      manager.startPeriodicMaintenance()
      expect((manager as any).reconcileInterval).toBe(reconcile)
    } finally {
      await manager.cleanup()
      ;(manager as any).podManager.destroy()
    }
  })
})

// The reconcile loop used to rewrite every squad pod's bashrc over the network
// every 60s whether or not the content changed. Write only on a real change.
describe('ensureBashrc content gating', () => {
  function harness() {
    const podManager = new K8sPodManager('test')
    const writes: any[] = []
    let fail = false
    const client = {
      write: async (p: any) => {
        if (fail) throw new Error('write failed')
        writes.push(p)
      },
    }
    const self = { sandboxes: new Map(), podManager }
    const ensure = (sandboxId: string, workspacePath = '/host', mount = '/workspace/sq1') =>
      (K8sSandboxManager.prototype as any).ensureBashrc.call(self, sandboxId, client, workspacePath, mount)
    return { podManager, writes, ensure, setFail: (value: boolean) => void (fail = value) }
  }

  test('writes on the first call and skips an identical repeat', async () => {
    const { writes, ensure } = harness()
    await ensure('squad_sq1')
    expect(writes).toHaveLength(1)
    await ensure('squad_sq1')
    await ensure('squad_sq1')
    expect(writes).toHaveLength(1)
  })

  test('writes again when the bashrc content changes', async () => {
    const { writes, ensure } = harness()
    await ensure('squad_sq1')
    // A different workspace mount changes the generated bashrc body.
    await ensure('squad_sq1', '/host', '/workspace/sq2')
    expect(writes).toHaveLength(2)
    await ensure('squad_sq1', '/host', '/workspace/sq2')
    expect(writes).toHaveLength(2)
  })

  test('tracks the hash per sandbox, not globally', async () => {
    const { writes, ensure } = harness()
    await ensure('squad_sq1')
    await ensure('agent_a1')
    expect(writes).toHaveLength(2)
  })

  test('writes again after the pod is recreated', async () => {
    const { podManager, writes, ensure } = harness()
    await ensure('squad_sq1')
    expect(writes).toHaveLength(1)
    // A recreate drops the pod's tracked state; the fresh pod has no bashrc.
    podManager.clearPodState('squad_sq1')
    await ensure('squad_sq1')
    expect(writes).toHaveLength(2)
  })

  test('a failed write is retried on the next call', async () => {
    const { writes, ensure, setFail } = harness()
    setFail(true)
    await ensure('squad_sq1')
    expect(writes).toHaveLength(0)
    setFail(false)
    await ensure('squad_sq1')
    expect(writes).toHaveLength(1)
  })
})

describe('provisioning gate lifecycle', () => {
  test('fully ready tracked sandbox bypasses cold coordination', async () => {
    const state = { podName: 'pod', devboxReady: true }
    const run = mock(async () => {
      throw new Error('cold gate should not run')
    })
    const fakeThis = {
      recreateOnNextEnsure: new Map(),
      sandboxes: new Map([['box', state]]),
      podManager: { hasPod: () => true, touchPod: mock(() => {}) },
      provisionCoordinator: { run },
    }
    const events: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(fakeThis as any, 'box', (event) => events.push(event))
    expect(
      await K8sSandboxManager.prototype.ensureSandbox.call(fakeThis as any, 'box', { workspacePath: '/tmp' })
    ).toBe('pod')
    expect(run).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  test('keeps cold setup progress active through coordinated provision and attachment', async () => {
    const events: SandboxSetupProgressEvent[] = []
    const provisionReached = Promise.withResolvers<void>()
    const attachGate = Promise.withResolvers<void>()
    const fakeThis = {
      recreateOnNextEnsure: new Map(),
      sandboxes: new Map(),
      provisionScope: 'scope',
      podManager: { hasPod: () => false },
      provisionCoordinator: {
        run: async (input: any) => {
          const provisioned = await input.provision(new AbortController().signal)
          provisionReached.resolve()
          await attachGate.promise
          return input.attach(provisioned.podName, new AbortController().signal)
        },
      },
      toPodConfig: () => undefined,
      attachProvisionedSandbox: async () => 'pod',
      _ensureSandbox: async () => 'pod',
      rejectClientReady: () => {},
    }
    observeSandboxSetupProgress(fakeThis as any, 'box', (event) => events.push(event))

    const ensuring = K8sSandboxManager.prototype.ensureSandbox.call(fakeThis as any, 'box', {
      workspacePath: '/tmp',
    })
    await provisionReached.promise
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'started', reason: 'runtime_start' })

    attachGate.resolve()
    await expect(ensuring).resolves.toBe('pod')
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'ready' })
  })

  test('reports reconnect work for a tracked sandbox that is not ready', async () => {
    const events: SandboxSetupProgressEvent[] = []
    const fakeThis = {
      recreateOnNextEnsure: new Map(),
      sandboxes: new Map([['box', { podName: 'pod', devboxReady: false }]]),
      provisionScope: 'scope',
      podManager: { hasPod: () => true },
      provisionCoordinator: { run: async () => 'pod' },
      toPodConfig: () => undefined,
      attachProvisionedSandbox: async () => 'pod',
      _ensureSandbox: async () => 'pod',
      rejectClientReady: () => {},
    }
    observeSandboxSetupProgress(fakeThis as any, 'box', (event) => events.push(event))

    await K8sSandboxManager.prototype.ensureSandbox.call(fakeThis as any, 'box', { workspacePath: '/tmp' })

    expect(events[0]).toMatchObject({ type: 'started', reason: 'runtime_reconnect' })
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'ready' })
  })

  test('reports failed coordinated setup and preserves SandboxProvisionError', async () => {
    const error = new SandboxProvisionError('SANDBOX_PROVISION_FAILED', 'Sandbox setup failed safely.')
    const events: SandboxSetupProgressEvent[] = []
    const fakeThis = {
      recreateOnNextEnsure: new Map(),
      sandboxes: new Map(),
      provisionScope: 'scope',
      provisionCoordinator: { run: async () => Promise.reject(error) },
      toPodConfig: () => undefined,
      rejectClientReady: () => {},
    }
    observeSandboxSetupProgress(fakeThis as any, 'box', (event) => events.push(event))

    await expect(
      K8sSandboxManager.prototype.ensureSandbox.call(fakeThis as any, 'box', { workspacePath: '/tmp' })
    ).rejects.toBe(error)
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'failed' })
  })

  test('reports explicit recreation through coordinated readiness', async () => {
    const events: SandboxSetupProgressEvent[] = []
    const fakeThis = {
      sandboxes: new Map(),
      provisionScope: 'scope',
      podManager: { terminatePod: async () => {} },
      provisionCoordinator: { run: async () => 'new-pod' },
      toPodConfig: () => undefined,
      attachProvisionedSandbox: async () => 'new-pod',
      _ensureSandbox: async () => 'new-pod',
    }
    observeSandboxSetupProgress(fakeThis as any, 'box', (event) => events.push(event))

    await K8sSandboxManager.prototype.recreateSandbox.call(fakeThis as any, 'box', { workspacePath: '/tmp' })

    expect(events[0]).toMatchObject({ type: 'started', reason: 'spec_reconcile' })
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'ready' })
  })

  test('expired recreate intent cannot cause a stale destructive recreation', async () => {
    const recreate = mock(async () => 'new-pod')
    const run = mock(async () => 'warm-pod')
    const fakeThis = {
      recreateOnNextEnsure: new Map([['box', Date.now() - 1]]),
      recreateSandbox: recreate,
      sandboxes: new Map(),
      provisionScope: 'scope',
      provisionCoordinator: { run },
      toPodConfig: () => undefined,
      attachProvisionedSandbox: async () => 'pod',
      _ensureSandbox: async () => 'pod',
    }
    expect(
      await K8sSandboxManager.prototype.ensureSandbox.call(fakeThis as any, 'box', { workspacePath: '/tmp' })
    ).toBe('warm-pod')
    expect(recreate).not.toHaveBeenCalled()
  })

  test('requested recreate enters coordinated recreate before destructive work', async () => {
    const recreate = mock(async () => 'new-pod')
    const fakeThis = { recreateOnNextEnsure: new Map([['box', Date.now() + 30_000]]), recreateSandbox: recreate }
    expect(
      await K8sSandboxManager.prototype.ensureSandbox.call(fakeThis as any, 'box', { workspacePath: '/tmp' })
    ).toBe('new-pod')
    expect(recreate).toHaveBeenCalledTimes(1)
  })
})

describe('shared client readiness', () => {
  test('shares one promise and resolves without waiting for devbox completion', async () => {
    const fakeThis = { sandboxes: new Map(), clientReady: new Map() }
    const first = K8sSandboxManager.prototype.waitForClientReady.call(fakeThis as any, 'box')
    const second = K8sSandboxManager.prototype.waitForClientReady.call(fakeThis as any, 'box')
    expect(first).toBe(second)
    const client = { health: async () => ({ devboxReady: false }) }
    ;(K8sSandboxManager.prototype as any).resolveClientReady.call(fakeThis, 'box', client)
    expect(await first).toBe(client as any)
    expect(fakeThis.clientReady.size).toBe(0)
  })
})

describe('bounded manager cleanup', () => {
  test('devbox health wait aborts even when HTTP health never settles', async () => {
    const controller = new AbortController()
    const waiting = (K8sSandboxManager.prototype as any).waitForDevbox.call(
      {},
      { health: () => new Promise(() => {}) },
      'box',
      300_000,
      controller.signal
    )
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('cleanup aborts coordination before closing clients and clears resources', async () => {
    const order: string[] = []
    const close = mock(() => order.push('client-close'))
    const fakeThis = {
      reconcileInterval: setInterval(() => {}, 60_000),
      sandboxes: new Map([['box', { client: { close } }]]),
      clientReady: new Map(),
      provisionCoordinator: { shutdown: mock(async () => order.push('coordinator-shutdown')) },
      podManager: { destroy: mock(() => order.push('pod-destroy')) },
    }
    await K8sSandboxManager.prototype.cleanup.call(fakeThis as any)
    expect(order).toEqual(['coordinator-shutdown', 'client-close', 'pod-destroy'])
    expect(fakeThis.sandboxes.size).toBe(0)
    expect(fakeThis.reconcileInterval).toBeNull()
  })
  test('cleanup closes a client cached by an abort continuation after the first drain', async () => {
    const earlyClose = mock(() => {})
    const lateClose = mock(() => {})
    const sandboxes = new Map<string, any>([['early', { client: { close: earlyClose } }]])
    const fakeThis = {
      reconcileInterval: null,
      sandboxes,
      clientReady: new Map(),
      provisionCoordinator: {
        shutdown: async () => {
          await Promise.resolve()
          sandboxes.set('late', { client: { close: lateClose } })
        },
      },
      podManager: { destroy: mock(() => {}) },
    }
    await K8sSandboxManager.prototype.cleanup.call(fakeThis as any)
    expect(earlyClose).toHaveBeenCalledTimes(1)
    expect(lateClose).toHaveBeenCalledTimes(1)
    expect(sandboxes.size).toBe(0)
  })
})
