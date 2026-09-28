import { describe, test, expect, mock, spyOn } from 'bun:test'
import * as k8s from '@kubernetes/client-node'
import { K8sPodManager, podDeathSignal, type PodState } from './pod-manager'
import { reconcilableSpecHash } from './pod-spec'
import * as secretStoreModule from '../../secrets/store'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { resourceDiagnostics } from '../../../lib/infra/resource-diagnostics'

describe('K8sPodManager', () => {
  test('module exports K8sPodManager class', () => {
    expect(K8sPodManager).toBeDefined()
  })

  describe('podDeathSignal', () => {
    test('maps terminal pod phases and evictions', () => {
      expect(podDeathSignal('Running', 'Evicted')).toBe('evicted')
      expect(podDeathSignal('Failed')).toBe('failed')
      expect(podDeathSignal('Succeeded')).toBe('succeeded')
      expect(podDeathSignal('Running')).toBeNull()
    })
  })

  test('syncAuthSecret ships ONLY the callback secret — never the legacy FICUS_PASSWORD', async () => {
    const storeSpy = spyOn(secretStoreModule, 'getSecretStore').mockReturnValue({
      get: (k: string) =>
        k === 'FICUS_PASSWORD' ? 'PASSWORD-MUST-NOT-SHIP' : k === 'SANDBOX_CALLBACK_SECRET' ? 'cb-secret' : undefined,
    } as any)
    let captured: any
    const fakeThis = {
      namespace: 'tau-sandboxes',
      coreApi: {
        async replaceNamespacedSecret({ body }: any) {
          captured = body
          return {}
        },
      },
    }
    try {
      await (K8sPodManager.prototype as any)['syncAuthSecret'].call(fakeThis)
    } finally {
      storeSpy.mockRestore()
    }
    expect(captured.stringData['sandbox-callback-secret']).toBe('cb-secret')
    expect(captured.stringData.password).toBeUndefined()
    // The password must not leak into the secret under any key.
    expect(JSON.stringify(captured)).not.toContain('PASSWORD-MUST-NOT-SHIP')
  })

  test('getPodEndpoint returns correct DNS', () => {
    const endpoint = K8sPodManager.prototype.getPodEndpoint.call(
      { namespace: 'tau-sandboxes', pods: new Map(), portForwards: new Map() },
      'tau-sandbox-squad-abc123'
    )
    expect(endpoint).toBe('tau-sandbox-squad-abc123.tau-sandboxes.tau-sandboxes.svc.cluster.local:50051')
  })

  test('getPodEndpoint works with different namespace', () => {
    const endpoint = K8sPodManager.prototype.getPodEndpoint.call(
      { namespace: 'custom-ns', pods: new Map(), portForwards: new Map() },
      'my-pod'
    )
    expect(endpoint).toBe('my-pod.tau-sandboxes.custom-ns.svc.cluster.local:50051')
  })

  test('getPodEndpoint does not use app port-forwards for executor traffic', () => {
    const endpoint = K8sPodManager.prototype.getPodEndpoint.call(
      {
        namespace: 'custom-ns',
        pods: new Map(),
        portForwards: new Map([
          ['squad_abc123:5173', { podName: 'my-pod', localPort: 61234, targetPort: 5173, process: { exitCode: null } }],
        ]),
      },
      'my-pod'
    )
    expect(endpoint).toBe('my-pod.tau-sandboxes.custom-ns.svc.cluster.local:50051')
  })

  test('getPodState returns null for unknown sandbox', () => {
    const result = K8sPodManager.prototype.getPodState.call({ pods: new Map() }, 'nonexistent')
    expect(result).toBeNull()
  })

  test('getPodState returns tracked pod state', () => {
    const podState: PodState = {
      sandboxId: 'squad_abc123',
      podName: 'tau-sandbox-squad-abc123',
      status: 'ready',
      lastActivity: new Date(),
      idleTimeout: 900_000,
      alwaysOn: false,
    }
    const pods = new Map([['squad_abc123', podState]])
    const result = K8sPodManager.prototype.getPodState.call({ pods }, 'squad_abc123')
    expect(result).toEqual(podState)
    expect(result!.status).toBe('ready')
  })

  describe('checkIdlePods', () => {
    test('does not terminate idle ready pods when active localDeployments keep sandbox alive', async () => {
      const terminatePod = mock(async () => {})
      const shouldKeepAlive = mock(async () => true)
      const manager = {
        pods: new Map<string, PodState>([
          [
            'squad_abc123',
            {
              sandboxId: 'squad_abc123',
              podName: 'tau-sb-squad-abc123',
              status: 'ready',
              lastActivity: new Date(Date.now() - 60_000),
              idleTimeout: 1,
              alwaysOn: false,
            },
          ],
        ]),
        shouldKeepAlive,
        terminatePod,
      }

      await K8sPodManager.prototype['checkIdlePods'].call(manager)

      expect(shouldKeepAlive).toHaveBeenCalledWith('squad_abc123')
      expect(terminatePod).not.toHaveBeenCalled()
    })
  })

  // The manager skips a bashrc write when the content hash matches what the pod
  // already has; every path that drops or replaces a pod's state must drop the
  // hash too, or a fresh pod would never get its bashrc written.
  describe('bashrc hash invalidation', () => {
    test('clearPodState forgets the pod bashrc hash', () => {
      const fakeThis = { pods: new Map(), bashrcHashes: new Map([['agent_x', 'hash']]) }
      K8sPodManager.prototype.clearPodState.call(fakeThis as any, 'agent_x')
      expect(fakeThis.bashrcHashes.has('agent_x')).toBe(false)
    })

    test('terminatePod forgets the pod bashrc hash', async () => {
      const fakeThis = {
        namespace: 'tau-sandboxes',
        pods: new Map(),
        bashrcHashes: new Map([['agent_x', 'hash']]),
        coreApi: { deleteNamespacedPod: mock(async () => {}) },
        getPodName: () => 'tau-sb-agent-x',
        stopPortForward: () => {},
      }
      await K8sPodManager.prototype['terminatePod'].call(fakeThis as any, 'agent_x', 'manual')
      expect(fakeThis.bashrcHashes.has('agent_x')).toBe(false)
    })
  })

  describe('terminatePod', () => {
    test('manual termination force-deletes immediately (gracePeriodSeconds 0) so a restart can recreate without a 30s drain', async () => {
      const deleteNamespacedPod = mock(async () => {})
      const fakeThis = {
        namespace: 'tau-sandboxes',
        pods: new Map(),
        bashrcHashes: new Map(),
        coreApi: { deleteNamespacedPod },
        getPodName: () => 'tau-sb-agent-x',
        stopPortForward: () => {},
      }

      await K8sPodManager.prototype['terminatePod'].call(fakeThis as any, 'agent_x', 'manual')

      expect(deleteNamespacedPod).toHaveBeenCalledWith({
        name: 'tau-sb-agent-x',
        namespace: 'tau-sandboxes',
        gracePeriodSeconds: 0,
      })
    })

    test('idle termination uses the default graceful deletion', async () => {
      const deleteNamespacedPod = mock(async () => {})
      const fakeThis = {
        namespace: 'tau-sandboxes',
        pods: new Map(),
        bashrcHashes: new Map(),
        coreApi: { deleteNamespacedPod },
        getPodName: () => 'tau-sb-agent-x',
        stopPortForward: () => {},
      }

      await K8sPodManager.prototype['terminatePod'].call(fakeThis as any, 'agent_x', 'idle')

      expect(deleteNamespacedPod).toHaveBeenCalledWith({ name: 'tau-sb-agent-x', namespace: 'tau-sandboxes' })
    })
  })

  describe('ensurePod terminating-pod race (restart)', () => {
    test('drains a still-terminating pod and creates a fresh one instead of adopting the dying pod', async () => {
      // A restart deletes the pod (graceful) then immediately re-ensures. K8s still
      // reports the old pod as Running with a deletionTimestamp; adopting it would
      // make us wait on a corpse forever. We must drain it, then create fresh.
      const readNamespacedPod = mock(async () => ({
        metadata: { name: 'tau-sb-agent-x', deletionTimestamp: '2026-06-29T00:00:00Z' },
        status: { phase: 'Running' },
      }))
      const createNamespacedPod = mock(async () => ({}))
      const waitForPodDeletion = mock(async () => {})
      const waitForPodReady = mock(async () => {})
      const syncAuthSecret = mock(async () => {})
      const createPodSpec = mock(async () => ({ metadata: {}, spec: {} }))
      const getPodEndpoint = mock(() => 'tau-sb-agent-x.endpoint:50051')

      const fakeThis = {
        namespace: 'tau-sandboxes',
        pods: new Map(),
        bashrcHashes: new Map(),
        coreApi: { readNamespacedPod, createNamespacedPod },
        getPodName: () => 'tau-sb-agent-x',
        waitForPodDeletion,
        waitForPodReady,
        syncAuthSecret,
        createPodSpec,
        updatePodState: () => {},
        getPodEndpoint,
        touchPod: () => {},
      }

      await K8sPodManager.prototype['ensurePod'].call(fakeThis as any, 'agent_x', { sandboxType: 'agent' } as any)

      expect(waitForPodDeletion).toHaveBeenCalledWith('tau-sb-agent-x')
      expect(createNamespacedPod).toHaveBeenCalledTimes(1)
      expect(waitForPodReady).toHaveBeenCalledWith('tau-sb-agent-x')
    })
  })

  describe('sandbox.status emission', () => {
    test('updatePodState emits sandbox.status when the status actually changes', () => {
      const emitSpy = spyOn(eventEmitter, 'emit').mockImplementation(() => {})
      const fakeThis = {
        pods: new Map([['agent_x', { sandboxId: 'agent_x', podName: 'tau-sb-agent-x', status: 'pending' }]]),
      }

      K8sPodManager.prototype['updatePodState'].call(fakeThis as any, 'agent_x', 'starting')

      expect(emitSpy).toHaveBeenCalledWith('sandbox.status', { sandboxId: 'agent_x' })
      emitSpy.mockRestore()
    })

    test('updatePodState does not emit on a no-op status update', () => {
      const emitSpy = spyOn(eventEmitter, 'emit').mockImplementation(() => {})
      const fakeThis = {
        pods: new Map([['agent_x', { sandboxId: 'agent_x', podName: 'tau-sb-agent-x', status: 'ready' }]]),
      }

      K8sPodManager.prototype['updatePodState'].call(fakeThis as any, 'agent_x', 'ready')

      expect(emitSpy).not.toHaveBeenCalled()
      emitSpy.mockRestore()
    })

    test('terminatePod emits sandbox.status after the pod is deleted', async () => {
      const emitSpy = spyOn(eventEmitter, 'emit').mockImplementation(() => {})
      const fakeThis = {
        namespace: 'tau-sandboxes',
        pods: new Map(),
        bashrcHashes: new Map(),
        coreApi: { deleteNamespacedPod: mock(async () => {}) },
        getPodName: () => 'tau-sb-agent-x',
        stopPortForward: () => {},
      }

      await K8sPodManager.prototype['terminatePod'].call(fakeThis as any, 'agent_x', 'manual')

      expect(emitSpy).toHaveBeenCalledWith('sandbox.status', { sandboxId: 'agent_x' })
      emitSpy.mockRestore()
    })
  })

  describe('cleanupTerminalPods', () => {
    test('deletes succeeded and evicted sandbox pods but leaves running pods alone', async () => {
      const deleteNamespacedPod = mock(async () => {})
      const listNamespacedPod = mock(async () => ({
        items: [
          {
            metadata: { name: 'tau-sb-succeeded', labels: { app: 'tau-sandbox' } },
            status: { phase: 'Succeeded' },
          },
          {
            metadata: { name: 'tau-sb-evicted', labels: { app: 'tau-sandbox' } },
            status: { phase: 'Failed', reason: 'Evicted' },
          },
          {
            metadata: { name: 'tau-sb-running', labels: { app: 'tau-sandbox' } },
            status: { phase: 'Running' },
          },
        ],
      }))
      const manager = {
        namespace: 'tau-sandboxes',
        coreApi: { listNamespacedPod, deleteNamespacedPod },
        bashrcHashes: new Map(),
        pods: new Map([
          ['squad_succeeded', { podName: 'tau-sb-succeeded' }],
          ['squad_evicted', { podName: 'tau-sb-evicted' }],
          ['squad_running', { podName: 'tau-sb-running' }],
        ]),
      }

      const result = await K8sPodManager.prototype.cleanupTerminalPods.call(manager)

      expect(result).toEqual({ deleted: 2 })
      expect(listNamespacedPod).toHaveBeenCalledWith({ namespace: 'tau-sandboxes', labelSelector: 'app=tau-sandbox' })
      expect(deleteNamespacedPod).toHaveBeenCalledTimes(2)
      expect(deleteNamespacedPod).toHaveBeenCalledWith({ name: 'tau-sb-succeeded', namespace: 'tau-sandboxes' })
      expect(deleteNamespacedPod).toHaveBeenCalledWith({ name: 'tau-sb-evicted', namespace: 'tau-sandboxes' })
      expect(manager.pods.has('squad_succeeded')).toBe(false)
      expect(manager.pods.has('squad_evicted')).toBe(false)
      expect(manager.pods.has('squad_running')).toBe(true)
    })
  })

  describe('checkClusterConnectivity', () => {
    test('checks namespaced pod access instead of cluster-scoped namespace access', async () => {
      const readNamespacedPod = mock(() => {
        throw { statusCode: 404 }
      })
      const manager = {
        coreApi: {
          readNamespacedPod,
          listNamespace: mock(() => {
            throw new Error('must not be called')
          }),
        },
        namespace: 'tau-sandboxes',
        kc: { getCurrentCluster: () => ({ server: 'https://kubernetes.default.svc' }) },
      }

      const result = await K8sPodManager.prototype.checkClusterConnectivity.call(manager)

      expect(result).toBe(true)
      expect(readNamespacedPod).toHaveBeenCalledWith({ name: 'tau-connectivity-check', namespace: 'tau-sandboxes' })
      expect(manager.coreApi.listNamespace).not.toHaveBeenCalled()
    })

    test('returns false when service account lacks sandbox pod permissions', async () => {
      const manager = {
        coreApi: {
          readNamespacedPod: mock(() => {
            throw { statusCode: 403, message: 'pods is forbidden' }
          }),
        },
        namespace: 'tau-sandboxes',
        kc: { getCurrentCluster: () => ({ server: 'https://kubernetes.default.svc' }) },
      }

      const result = await K8sPodManager.prototype.checkClusterConnectivity.call(manager)

      expect(result).toBe(false)
    })
  })

  describe('queryPodStatus', () => {
    function createMockManager(readResult: any) {
      const readNamespacedPod = typeof readResult === 'function' ? readResult : mock(() => readResult)
      return {
        coreApi: { readNamespacedPod },
        namespace: 'tau-sandboxes',
        // getPodName is private, replicate its logic
        getPodName: (sandboxId: string) => `tau-sandbox-${sandboxId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
      }
    }

    test('returns not_found when pod does not exist', async () => {
      const manager = createMockManager(() => {
        throw { statusCode: 404 }
      })
      const result = await K8sPodManager.prototype.queryPodStatus.call(manager, 'squad-xyz')
      expect(result.status).toBe('not_found')
    })

    test('returns running when pod is ready', async () => {
      const manager = createMockManager({
        metadata: {},
        status: {
          phase: 'Running',
          conditions: [{ type: 'Ready', status: 'True' }],
          containerStatuses: [
            {
              name: 'sandbox',
              state: { running: { startedAt: '2026-03-06T08:00:00Z' } },
            },
          ],
          initContainerStatuses: [],
        },
      })
      const result = await K8sPodManager.prototype.queryPodStatus.call(manager, 'squad-abc')
      expect(result.status).toBe('running')
      expect(result.containerReady).toBe(true)
      expect(result.startedAt).toBe('2026-03-06T08:00:00.000Z')
    })

    test('returns pending when pod is in Pending phase', async () => {
      const manager = createMockManager({
        metadata: {},
        status: {
          phase: 'Pending',
          conditions: [],
          containerStatuses: [
            {
              name: 'sandbox',
              state: { waiting: { reason: 'ContainerCreating' } },
            },
          ],
          initContainerStatuses: [],
        },
      })
      const result = await K8sPodManager.prototype.queryPodStatus.call(manager, 'squad-abc')
      expect(result.status).toBe('pending')
      expect(result.reason).toBe('ContainerCreating')
    })

    test('returns starting when init container is running', async () => {
      const manager = createMockManager({
        metadata: {},
        status: {
          phase: 'Pending',
          conditions: [],
          containerStatuses: [],
          initContainerStatuses: [
            {
              name: 'sandbox-init',
              state: { running: { startedAt: '2026-03-06T08:00:00Z' } },
            },
          ],
        },
      })
      const result = await K8sPodManager.prototype.queryPodStatus.call(manager, 'squad-abc')
      expect(result.status).toBe('starting')
      expect(result.reason).toBe('InitContainer running')
    })

    test('returns terminating when deletionTimestamp is set', async () => {
      const manager = createMockManager({
        metadata: { deletionTimestamp: '2026-03-06T08:10:00Z' },
        status: { phase: 'Running' },
      })
      const result = await K8sPodManager.prototype.queryPodStatus.call(manager, 'squad-abc')
      expect(result.status).toBe('terminating')
    })

    test('returns failed when pod phase is Failed', async () => {
      const manager = createMockManager({
        metadata: {},
        status: {
          phase: 'Failed',
          conditions: [],
          containerStatuses: [
            {
              name: 'sandbox',
              state: { terminated: { reason: 'OOMKilled' } },
            },
          ],
          initContainerStatuses: [],
        },
      })
      const result = await K8sPodManager.prototype.queryPodStatus.call(manager, 'squad-abc')
      expect(result.status).toBe('failed')
      expect(result.reason).toBe('OOMKilled')
    })

    test('returns starting when Running but container not ready', async () => {
      const manager = createMockManager({
        metadata: {},
        status: {
          phase: 'Running',
          conditions: [{ type: 'Ready', status: 'False' }],
          containerStatuses: [
            {
              name: 'sandbox',
              state: { running: { startedAt: '2026-03-06T08:00:00Z' } },
            },
          ],
          initContainerStatuses: [],
        },
      })
      const result = await K8sPodManager.prototype.queryPodStatus.call(manager, 'squad-abc')
      expect(result.status).toBe('starting')
      expect(result.containerReady).toBe(false)
    })
  })

  describe('isSpecDrifted', () => {
    function managerWithPod(state: Partial<PodState> | null) {
      const pods = new Map<string, PodState>()
      if (state) pods.set('squad_abc', { sandboxId: 'squad_abc', podName: 'p', ...state } as PodState)
      return { pods } as unknown as K8sPodManager
    }

    test('true when the running hash differs from the desired spec', () => {
      const mgr = managerWithPod({ status: 'ready', specHash: reconcilableSpecHash({ ephemeralStorageLimitGi: 25 }) })
      expect(K8sPodManager.prototype.isSpecDrifted.call(mgr, 'squad_abc', { ephemeralStorageLimitGi: 50 })).toBe(true)
    })

    test('false when the running hash matches the desired spec', () => {
      const mgr = managerWithPod({ status: 'ready', specHash: reconcilableSpecHash({ ephemeralStorageLimitGi: 25 }) })
      expect(K8sPodManager.prototype.isSpecDrifted.call(mgr, 'squad_abc', { ephemeralStorageLimitGi: 25 })).toBe(false)
    })

    test('false when the pod is not ready, untracked, or has no known hash', () => {
      const notReady = managerWithPod({ status: 'starting', specHash: 'x' })
      expect(K8sPodManager.prototype.isSpecDrifted.call(notReady, 'squad_abc', { ephemeralStorageLimitGi: 50 })).toBe(
        false
      )
      const noHash = managerWithPod({ status: 'ready' })
      expect(K8sPodManager.prototype.isSpecDrifted.call(noHash, 'squad_abc', { ephemeralStorageLimitGi: 50 })).toBe(
        false
      )
      const untracked = managerWithPod(null)
      expect(K8sPodManager.prototype.isSpecDrifted.call(untracked, 'squad_abc', { ephemeralStorageLimitGi: 50 })).toBe(
        false
      )
    })
  })

  describe('streamPodLogs', () => {
    // Default context: a pod whose container has already started, so the
    // readiness gate passes on the first poll and the stream starts immediately.
    function mgr(status: any = { status: 'running', containerReady: true, startedAt: 't' }) {
      const queryPodStatus = mock(async () => status)
      return {
        ctx: {
          kc: {},
          namespace: 'tau-sandboxes',
          pods: new Map(),
          getPodName: (id: string) => `pod-${id}`,
          queryPodStatus,
        } as unknown as K8sPodManager,
        queryPodStatus,
      }
    }

    // Wait until `fn()` is truthy or a bound elapses (the gate is async).
    async function until<T>(fn: () => T | undefined, timeoutMs = 3000): Promise<T> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const v = fn()
        if (v) return v
        if (Date.now() >= deadline) throw new Error('until() timed out')
        await new Promise((r) => setTimeout(r, 10))
      }
    }

    test('streams the sandbox container with forwarded options and forwards chunks', async () => {
      const ac = { abort: () => {} }
      const abortSpy = spyOn(ac, 'abort')
      const logSpy = spyOn(k8s.Log.prototype, 'log').mockResolvedValue(ac as any)

      const chunks: string[] = []
      const handle = K8sPodManager.prototype.streamPodLogs.call(
        mgr().ctx,
        'squad_abc',
        { tailLines: 500, follow: true, previous: true },
        (c: Buffer) => chunks.push(c.toString())
      )

      // The stream starts asynchronously once the readiness gate passes.
      const call = await until(() => logSpy.mock.calls[0])
      const [ns, pod, container, stream, options] = call as any[]
      expect(ns).toBe('tau-sandboxes')
      expect(pod).toBe('pod-squad_abc')
      expect(container).toBe('sandbox')
      expect(options).toMatchObject({ follow: true, tailLines: 500, previous: true })

      stream.write(Buffer.from('hello'))
      expect(chunks).toEqual(['hello'])

      await new Promise((r) => setTimeout(r, 0)) // let log() promise resolve
      handle.cancel()
      handle.cancel()
      expect(abortSpy).toHaveBeenCalledTimes(1)
      expect(stream.destroyed).toBe(true)
      stream.write(Buffer.from('after-cancel'))
      expect(chunks).toEqual(['hello'])

      logSpy.mockRestore()
    })

    test('aborts the Kubernetes request when a consumer callback fails', async () => {
      const ac = { abort: mock(() => {}) }
      const logSpy = spyOn(k8s.Log.prototype, 'log').mockResolvedValue(ac as any)
      const errors: Error[] = []
      K8sPodManager.prototype.streamPodLogs.call(
        mgr().ctx,
        'squad_abc',
        { tailLines: 10 },
        () => {
          throw new Error('consumer closed')
        },
        (error: Error) => errors.push(error)
      )

      const [, , , stream] = (await until(() => logSpy.mock.calls[0])) as any[]
      await new Promise((resolve) => setTimeout(resolve, 0))
      stream.write(Buffer.from('chunk'))
      await until(() => errors[0])

      expect(ac.abort).toHaveBeenCalledTimes(1)
      expect(stream.destroyed).toBe(true)
      logSpy.mockRestore()
    })

    test('waits for the container to start before requesting logs (does not surface a raw ContainerCreating error)', async () => {
      const logSpy = spyOn(k8s.Log.prototype, 'log').mockResolvedValue({ abort: () => {} } as any)
      // First poll: still ContainerCreating; second poll: container has started.
      let polls = 0
      const queryPodStatus = mock(async () => {
        polls += 1
        return polls < 2
          ? { status: 'pending', reason: 'ContainerCreating', containerReady: false }
          : { status: 'running', containerReady: true, startedAt: 't' }
      })
      const ctx = {
        kc: {},
        namespace: 'tau-sandboxes',
        pods: new Map(),
        getPodName: (id: string) => `pod-${id}`,
        queryPodStatus,
      } as unknown as K8sPodManager

      const errors: string[] = []
      K8sPodManager.prototype.streamPodLogs.call(
        ctx,
        'squad_abc',
        { tailLines: 500 },
        () => {},
        (e: Error) => errors.push(e.message)
      )

      // While ContainerCreating, the log request must NOT be made.
      expect(logSpy.mock.calls.length).toBe(0)
      // Once the container starts, the stream begins — with no raw kube error.
      await until(() => logSpy.mock.calls[0])
      expect(errors).toEqual([])
      expect(polls).toBeGreaterThanOrEqual(2)

      logSpy.mockRestore()
    })

    test('translates a raw kube ApiException into a friendly message (no HTTP-Code block)', async () => {
      // The k8s client throws an ApiException whose message is the raw HTTP block.
      const apiErr: any = new Error(
        'HTTP-Code: 204\nMessage: Error occurred in log request\nBody: undefined\nHeaders: {"audit-id":"x"}'
      )
      apiErr.code = 204
      const logSpy = spyOn(k8s.Log.prototype, 'log').mockRejectedValue(apiErr)

      const baseline = resourceDiagnostics.snapshot().pod_log_transport.active
      const errors: string[] = []
      const chunks: string[] = []
      K8sPodManager.prototype.streamPodLogs.call(
        mgr().ctx,
        'squad_abc',
        { tailLines: 500 },
        (chunk: Buffer) => chunks.push(chunk.toString()),
        (e: Error) => errors.push(e.message)
      )

      const msg = await until(() => errors[0])
      const [, , , stream] = logSpy.mock.calls[0] as any[]
      expect(msg).not.toContain('HTTP-Code')
      expect(msg.toLowerCase()).toContain('starting')
      expect(stream.destroyed).toBe(true)
      stream.write(Buffer.from('after-error'))
      expect(chunks).toEqual([])
      expect(resourceDiagnostics.snapshot().pod_log_transport.active).toBe(baseline)

      logSpy.mockRestore()
    })

    test('cancel during the readiness wait aborts cleanly — no log request, no error', async () => {
      const logSpy = spyOn(k8s.Log.prototype, 'log').mockResolvedValue({ abort: () => {} } as any)
      const errors: string[] = []
      const handle = K8sPodManager.prototype.streamPodLogs.call(
        mgr({ status: 'pending', reason: 'ContainerCreating', containerReady: false }).ctx,
        'squad_abc',
        { tailLines: 500 },
        () => {},
        (e: Error) => errors.push(e.message)
      )
      handle.cancel()
      await new Promise((r) => setTimeout(r, 50))
      expect(logSpy.mock.calls.length).toBe(0)
      expect(errors).toEqual([])

      logSpy.mockRestore()
    })

    test('a pod that no longer exists yields a friendly error, not a raw kube block', async () => {
      const logSpy = spyOn(k8s.Log.prototype, 'log').mockResolvedValue({ abort: () => {} } as any)
      const baseline = resourceDiagnostics.snapshot().pod_log_transport.active
      const errors: string[] = []
      K8sPodManager.prototype.streamPodLogs.call(
        mgr({ status: 'not_found' }).ctx,
        'squad_abc',
        { tailLines: 500 },
        () => {},
        (e: Error) => errors.push(e.message)
      )
      const msg = await until(() => errors[0])
      expect(msg).not.toContain('HTTP-Code')
      expect(logSpy.mock.calls.length).toBe(0)
      expect(resourceDiagnostics.snapshot().pod_log_transport.active).toBe(baseline)

      logSpy.mockRestore()
    })
  })
})

describe('provisioning readiness classification', () => {
  test('throws safe structured terminal context', async () => {
    const fakeThis = {
      namespace: 'tau-sandboxes',
      coreApi: { readNamespacedPod: async () => ({ status: { phase: 'Failed' } }) },
      sleep: async () => {},
      now: () => 0,
    }
    await expect((K8sPodManager.prototype as any).waitForPodReady.call(fakeThis, 'pod', 10)).rejects.toMatchObject({
      kind: 'terminal',
    })
  })

  test('classifies a plain Pending readiness timeout as correlated scheduling failure', async () => {
    let now = 0
    const fakeThis = {
      namespace: 'tau-sandboxes',
      coreApi: { readNamespacedPod: async () => ({ status: { phase: 'Pending' } }) },
      sleep: async () => {
        now += 10
      },
      now: () => now,
    }
    await expect((K8sPodManager.prototype as any).waitForPodReady.call(fakeThis, 'pod', 10)).rejects.toMatchObject({
      kind: 'unschedulable',
    })
  })

  test('fails continuously Pending scheduling after a 30-second grace, not the full readiness timeout', async () => {
    let now = 0
    let reads = 0
    const fakeThis = {
      namespace: 'tau-sandboxes',
      coreApi: {
        readNamespacedPod: async () => {
          reads++
          return { status: { phase: 'Pending' } }
        },
      },
      sleep: async () => {
        now += 10_000
      },
      now: () => now,
    }
    await expect((K8sPodManager.prototype as any).waitForPodReady.call(fakeThis, 'pod', 300_000)).rejects.toMatchObject(
      {
        kind: 'unschedulable',
      }
    )
    expect(now).toBe(30_000)
    expect(reads).toBe(4)
  })

  test('classifies Running-but-never-Ready as sandbox-specific executor failure', async () => {
    let now = 0
    const fakeThis = {
      namespace: 'tau-sandboxes',
      coreApi: { readNamespacedPod: async () => ({ status: { phase: 'Running' } }) },
      sleep: async () => {
        now += 10
      },
      now: () => now,
    }
    await expect((K8sPodManager.prototype as any).waitForPodReady.call(fakeThis, 'pod', 10)).rejects.toMatchObject({
      kind: 'executor',
    })
  })

  test('classifies CrashLoopBackOff as sandbox-specific terminal failure', async () => {
    const fakeThis = {
      namespace: 'tau-sandboxes',
      coreApi: {
        readNamespacedPod: async () => ({
          status: { phase: 'Running', containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
        }),
      },
      sleep: async () => {},
      now: () => 0,
    }
    await expect((K8sPodManager.prototype as any).waitForPodReady.call(fakeThis, 'pod', 300_000)).rejects.toMatchObject(
      {
        kind: 'terminal',
      }
    )
  })

  test.each([
    ['ImagePullBackOff', 'image'],
    ['ErrImagePull', 'image'],
    ['ImageInspectError', 'image'],
    ['ContainerCreating', 'storage'],
  ])('classifies a sustained %s readiness wait as %s', async (reason, kind) => {
    let now = 0
    const fakeThis = {
      namespace: 'tau-sandboxes',
      coreApi: {
        readNamespacedPod: async () => ({
          status: {
            phase: 'Pending',
            conditions: [{ type: 'PodScheduled', status: 'True' }],
            containerStatuses: [{ state: { waiting: { reason } } }],
          },
        }),
      },
      sleep: async (ms: number) => {
        now += ms
      },
      now: () => now,
    }

    await expect((K8sPodManager.prototype as any).waitForPodReady.call(fakeThis, 'pod', 10)).rejects.toMatchObject({
      kind,
    })
  })

  // Blast radius: a placed pod whose CONTAINER is broken says nothing about cluster
  // capacity. These reasons are all sandbox/image-scoped, but any of them reaching the
  // `unschedulable` bucket makes them correlated evidence — so a typo'd image tag on a
  // perfectly healthy cluster would open the CLUSTER breaker and stop all agent work.
  test.each(['InvalidImageName', 'CreateContainerError', 'ErrImageNeverPull', 'PodInitializing'])(
    'never reports a placed pod waiting on %s as a cluster scheduling failure',
    async (reason) => {
      let now = 0
      const fakeThis = {
        namespace: 'tau-sandboxes',
        coreApi: {
          readNamespacedPod: async () => ({
            status: {
              phase: 'Pending',
              conditions: [{ type: 'PodScheduled', status: 'True' }],
              containerStatuses: [{ name: 'sandbox', state: { waiting: { reason } } }],
            },
          }),
        },
        sleep: async (ms: number) => {
          now += ms
        },
        now: () => now,
      }
      const error = await (K8sPodManager.prototype as any).waitForPodReady
        .call(fakeThis, 'pod', 5_000)
        .catch((value: unknown) => value)
      expect(error.kind).not.toBe('unschedulable')
    }
  )

  test('preserves unschedulable context at readiness timeout without leaking messages', async () => {
    let now = 0
    const fakeThis = {
      namespace: 'tau-sandboxes',
      coreApi: {
        readNamespacedPod: async () => ({
          status: {
            conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'TOKEN-SECRET' }],
          },
        }),
      },
      sleep: async () => {
        now += 10
      },
      now: () => now,
    }
    const error = await (K8sPodManager.prototype as any).waitForPodReady
      .call(fakeThis, 'pod', 10)
      .catch((value: unknown) => value)
    expect(error).toMatchObject({ kind: 'unschedulable' })
    expect(JSON.stringify(error)).not.toContain('TOKEN-SECRET')
  })
})
