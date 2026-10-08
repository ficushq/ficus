import { SANDBOX_IDENTITY_LEGACY } from '../retired-identity.fixture'
import { describe, test, expect } from 'bun:test'
import { prepullSandboxImages, prepullPodName, prepullPodNames, type PrepullDeps } from './image-prepull'
import {} from '../identity-names'

interface Call {
  op: 'create' | 'read' | 'delete'
  name: string
}

/** Fake CoreV1Api that records calls and drives pod phase via a script. */
function makeFakeApi(opts: { phase?: string; createError?: unknown } = {}) {
  const calls: Call[] = []
  const api = {
    async createNamespacedPod({ body }: { namespace: string; body: any }) {
      calls.push({ op: 'create', name: body.metadata.name })
      if (opts.createError) throw opts.createError
      return body
    },
    async readNamespacedPod({ name }: { name: string; namespace: string }) {
      calls.push({ op: 'read', name })
      return { status: { phase: opts.phase ?? 'Succeeded' } }
    },
    async deleteNamespacedPod({ name }: { name: string; namespace: string }) {
      calls.push({ op: 'delete', name })
      return {}
    },
  }
  return { api: api as unknown as PrepullDeps['coreApi'], calls }
}

const baseDeps = (api: PrepullDeps['coreApi']): PrepullDeps => ({
  coreApi: api,
  namespace: 'tau-sandboxes-dev',
  isLocalDev: true,
  pollMs: 1,
  waitTimeoutMs: 2_000,
})

describe('prepullSandboxImages', () => {
  test('creates one throwaway pod per distinct image (squad + agent) and cleans each up', async () => {
    const { api, calls } = makeFakeApi({ phase: 'Succeeded' })
    await prepullSandboxImages(baseDeps(api))

    const created = calls
      .filter((c) => c.op === 'create')
      .map((c) => c.name)
      .sort()
    expect(created).toEqual([prepullPodName('agent'), prepullPodName('squad')].sort())

    // Each created pod is also deleted (cleanup) — pods have no native TTL.
    for (const name of [prepullPodName('squad'), prepullPodName('agent')]) {
      expect(calls.some((c) => c.op === 'delete' && c.name === name)).toBe(true)
    }
  })

  test('deletes any leftover pod BEFORE creating (idempotent across boots)', async () => {
    const { api, calls } = makeFakeApi({ phase: 'Succeeded' })
    await prepullSandboxImages(baseDeps(api))

    const squad = prepullPodName('squad')
    const firstDelete = calls.findIndex((c) => c.op === 'delete' && c.name === squad)
    const create = calls.findIndex((c) => c.op === 'create' && c.name === squad)
    expect(firstDelete).toBeGreaterThanOrEqual(0)
    expect(firstDelete).toBeLessThan(create)
  })

  test('spec is minimal & safe: /bin/true command, restartPolicy Never, Always pull, prepull label', async () => {
    let captured: any
    const api = {
      async createNamespacedPod({ body }: any) {
        if (body.metadata.name === prepullPodName('squad')) captured = body
        return body
      },
      async readNamespacedPod() {
        return { status: { phase: 'Succeeded' } }
      },
      async deleteNamespacedPod() {
        return {}
      },
    } as unknown as PrepullDeps['coreApi']

    await prepullSandboxImages(baseDeps(api))

    expect(captured.spec.restartPolicy).toBe('Never')
    expect(captured.spec.activeDeadlineSeconds).toBeGreaterThan(0)
    const c = captured.spec.containers[0]
    expect(c.command).toEqual(['/bin/true'])
    expect(c.imagePullPolicy).toBe('Always')
    expect(c.image).toBe('ficus-registry:5000/ficus-sandbox:latest')
    expect(captured.metadata.labels.app).toBe('ficus-sandbox-prepull')
  })

  test('never throws even if pod creation fails (best-effort, non-fatal)', async () => {
    const { api } = makeFakeApi({ createError: new Error('apiserver down') })
    // Must resolve, not reject — Core startup fire-and-forgets this.
    await expect(prepullSandboxImages(baseDeps(api))).resolves.toBeUndefined()
  })

  test('cleans up even when the pull pod reaches Failed', async () => {
    const { api, calls } = makeFakeApi({ phase: 'Failed' })
    await prepullSandboxImages(baseDeps(api))
    expect(calls.some((c) => c.op === 'delete' && c.name === prepullPodName('squad'))).toBe(true)
  })

  test('a pod stuck Pending terminates on the wait timeout and still cleans up', async () => {
    const { api, calls } = makeFakeApi({ phase: 'Pending' })
    // Tight bound so the loop exits via timeout, not via a terminal phase.
    await prepullSandboxImages({ ...baseDeps(api), pollMs: 1, waitTimeoutMs: 30 })
    // It polled (didn't break early) and still deleted the pod after giving up.
    expect(calls.some((c) => c.op === 'read' && c.name === prepullPodName('squad'))).toBe(true)
    expect(calls.some((c) => c.op === 'delete' && c.name === prepullPodName('squad'))).toBe(true)
  })

  test('409 on create (another replica already made it) proceeds to poll + cleanup, not early-return', async () => {
    const { api, calls } = makeFakeApi({ phase: 'Succeeded', createError: { statusCode: 409 } })
    await prepullSandboxImages(baseDeps(api))
    // 409 is not a hard failure: it must still poll the existing pod and clean up.
    expect(calls.some((c) => c.op === 'read' && c.name === prepullPodName('squad'))).toBe(true)
    expect(calls.some((c) => c.op === 'delete' && c.name === prepullPodName('squad'))).toBe(true)
  })

  // I1 (fix round 1): a pod left over from a crash mid-prepull BEFORE this
  // release carries the legacy `tau-sb-prepull-` name, not the write one —
  // the prior-boot cleanup must find and delete it too, or it leaks forever.
  test('deletes a leftover pod under EVERY prepull name, not just the write one', async () => {
    const { api, calls } = makeFakeApi({ phase: 'Succeeded' })
    await prepullSandboxImages(baseDeps(api))

    const names = prepullPodNames('squad')
    expect(names).toHaveLength(1)
    expect(names).not.toContain(prepullPodName('squad', SANDBOX_IDENTITY_LEGACY.k8sPodNamePrefix))
    for (const name of names) {
      expect(calls.some((c) => c.op === 'delete' && c.name === name)).toBe(true)
    }
  })
})
