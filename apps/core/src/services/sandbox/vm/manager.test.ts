import { describe, test, expect, afterEach } from 'bun:test'
import { createHash } from 'crypto'
import { EventEmitter } from 'events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import {
  VmSandboxManager,
  computeVmSetupFingerprint,
  defaultBoxProvisionVersion,
  type VmSandboxManagerDeps,
} from './manager'
import {
  boxUnixUser,
  computeProvisioningMarker,
  type BoxChainHealth,
  type BoxEnv,
  type EnsureBoxOpts,
} from '../../machines/box-manager'
import type { BoxStepTimings } from '../../machines/box-timing'
import type { PlacementRequest } from '../../machines/placement'
import { MachineNotReadyError } from '../../machines/queries'
import type { SandboxOptions, SandboxRuntime } from '../types'
import type { VmSetupState } from './setup-state'
import { observeSandboxSetupProgress, type SandboxSetupProgressEvent } from '../setup-progress'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A fake bash stream that emits the scripted output then ends on next tick. */
function makeBashStream(script: { stdout?: string; stderr?: string; exitCode?: number; error?: string }) {
  const stream = new EventEmitter() as any
  stream.cancel = () => {}
  queueMicrotask(() => {
    stream.emit('data', {
      stdout: script.stdout !== undefined ? Buffer.from(script.stdout).toString('base64') : undefined,
      stderr: script.stderr !== undefined ? Buffer.from(script.stderr).toString('base64') : undefined,
      exitCode: script.exitCode,
      error: script.error,
    })
    stream.emit('end')
  })
  return stream
}

/** A fake duplex shell stream sufficient for HttpPtyWrapper's constructor. */
function makeShellStream() {
  const stream = new EventEmitter() as any
  stream.write = () => true
  stream.end = () => {}
  stream.cancel = () => {}
  return stream
}

interface FakeClient {
  endpoint: string
  bashCalls: Array<{ command: string; cwd?: string; invocationId?: string }>
  writeCalls: Array<{ path: string; mode?: string }>
  shellCalls: number
  devboxReadyCalls: number
  toolchainReadyCalls: boolean[]
  /** Every `health()` — a real one is a TCP connect that WAKES an idle box. */
  healthCalls: number
  /** When set, `devboxReady()` rejects with this — models an unreachable box. */
  devboxReadyError?: Error
  healthError?: Error
  uptimeSeconds: number
  closed: number
  bash: (req: any) => any
  write: (req: any) => Promise<void>
  shell: () => any
  devboxReady: () => Promise<void>
  toolchainReady: (active?: boolean) => Promise<void>
  health: () => Promise<{ healthy: boolean; devboxReady: boolean; version: string; uptimeSeconds: number }>
  close: () => void
}

function makeFakeClient(endpoint: string, bashScript = { stdout: 'ok', exitCode: 0 }): FakeClient {
  const client: FakeClient = {
    endpoint,
    bashCalls: [],
    writeCalls: [],
    shellCalls: 0,
    devboxReadyCalls: 0,
    toolchainReadyCalls: [],
    healthCalls: 0,
    closed: 0,
    uptimeSeconds: 1,
    bash(req: any) {
      client.bashCalls.push({ command: req.command, cwd: req.cwd, invocationId: req.invocationId })
      return makeBashStream(bashScript)
    },
    async write(req: any) {
      client.writeCalls.push({ path: req.path, mode: req.mode })
    },
    shell() {
      client.shellCalls++
      return makeShellStream()
    },
    async devboxReady() {
      client.devboxReadyCalls++
      if (client.devboxReadyError) throw client.devboxReadyError
    },
    async toolchainReady(active = true) {
      client.toolchainReadyCalls.push(active)
    },
    async health() {
      client.healthCalls++
      if (client.healthError) throw client.healthError
      return { healthy: true, devboxReady: true, version: 'test', uptimeSeconds: client.uptimeSeconds }
    },
    close() {
      client.closed++
    },
  }
  return client
}

/** Records every effect the manager drives so tests can assert order/args. */
interface Harness {
  deps: Partial<VmSandboxManagerDeps>
  log: string[]
  ensureCalls: EnsureBoxOpts[]
  removeCalls: Array<{ sandboxId: string; archivePrivate?: boolean; timeoutMs?: number }>
  stopCalls: string[]
  releasedMachines: string[]
  clients: Map<string, FakeClient>
  createdEndpoints: string[]
  /** authToken passed to createClient, in creation order (undefined = none). */
  createdClientTokens: Array<string | undefined>
  resolveMachineCalls: PlacementRequest[]
  resolveBoxApiUrlCalls: string[]
  syncCalls: string[]
  seedCalls: Array<{ sandboxId: string; role: EnsureBoxOpts['role'] }>
  setNow: (n: number) => void
  setProvisionVersion: (v: string) => void
  /** Simulate a relocated box: the next ensure hands back a NEW forward. */
  rotateBoxEndpoint: (sandboxId: string) => void
  setBoxStatus: (s: 'ready' | 'stopped' | 'starting' | 'failed' | 'absent') => void
  /** Override the chain the fake boxChainHealth returns (null = derive from the status). */
  setBoxChain: (chain: BoxChainHealth | null) => void
  setAppUrl: (u: string | undefined) => void
  setGithubToken: (t: string) => void
  setSyncBoxFiles: (
    fn: (
      client: any,
      sandboxId: string,
      opts: SandboxOptions,
      box?: unknown,
      fence?: any,
      trackSetupWork?: <T>(operation: () => Promise<T>) => Promise<T>
    ) => Promise<void>
  ) => void
  setSeedBoxDevbox: (
    fn: (client: any, sandboxId: string, role: EnsureBoxOpts['role']) => Promise<BoxStepTimings>
  ) => void
  // Attach-on-miss (getOrAttachClient) fakes: a settable machine_boxes row +
  // machine row, with the tunnel effects recorded.
  setMachineBoxRow: (
    row: { machineId: string; port: number; status: string; reconcilableSpecHash?: string | null } | null
  ) => void
  setMachineStatus: (status: string) => void
  ensureMasterCalls: string[]
  addForwardCalls: Array<{ machineId: string; remotePort: number }>
  removeForwardCalls: Array<{ machineId: string; remotePort: number }>
  persistCalls: Array<{ sandboxId: string; atMs: number }>
  setSetupState: (state: VmSetupState | null) => void
}

/**
 * Canonical {@link BoxChainHealth} for each coarse boxStatus value, mirroring
 * box-manager.ts's real boxChainHealth mapping (see its describe block in
 * box-manager.test.ts) so this harness's `setBoxStatus` fake stays a faithful
 * stand-in for the real dependency.
 */
function chainForBoxStatus(status: 'ready' | 'stopped' | 'starting' | 'failed' | 'absent'): BoxChainHealth {
  switch (status) {
    case 'ready':
      return { boxProvisioned: true, machine: 'reachable', boxServer: 'up' }
    case 'starting':
      return { boxProvisioned: true, machine: 'unknown', boxServer: 'unknown' }
    case 'failed':
      return { boxProvisioned: true, machine: 'unreachable', boxServer: 'unknown' }
    case 'stopped':
      return { boxProvisioned: true, machine: 'unknown', boxServer: 'down' }
    case 'absent':
      return { boxProvisioned: false, machine: 'unknown', boxServer: 'unknown' }
  }
}

function makeHarness(opts?: { machineForSandbox?: (id: string) => string; bashScript?: any }): Harness {
  const log: string[] = []
  const ensureCalls: EnsureBoxOpts[] = []
  const removeCalls: Array<{ sandboxId: string; archivePrivate?: boolean; timeoutMs?: number }> = []
  const stopCalls: string[] = []
  const releasedMachines: string[] = []
  const clients = new Map<string, FakeClient>()
  const createdEndpoints: string[] = []
  const createdClientTokens: Array<string | undefined> = []
  const resolveMachineCalls: PlacementRequest[] = []
  const resolveBoxApiUrlCalls: string[] = []
  const syncCalls: string[] = []
  let nowValue = 1000
  let provisionVersion = 'prov-1'
  let boxStatusValue: 'ready' | 'stopped' | 'starting' | 'failed' | 'absent' = 'ready'
  let boxChainOverride: BoxChainHealth | null = null
  let appUrl: string | undefined = 'https://app.example.com'
  let githubToken = 'ghtok'
  const machineForSandbox = opts?.machineForSandbox ?? (() => 'm1')
  const seedCalls: Array<{ sandboxId: string; role: EnsureBoxOpts['role'] }> = []
  let syncBoxFiles: (
    client: any,
    sandboxId: string,
    opts: SandboxOptions,
    box?: unknown,
    fence?: any,
    trackSetupWork?: <T>(operation: () => Promise<T>) => Promise<T>
  ) => Promise<void> = async (client, sandboxId) => {
    log.push(`sync:${sandboxId}`)
    syncCalls.push(sandboxId)
    // Mirror production's first artifact so the fake client records a write.
    await client.write({ path: `/home/${boxUnixUser(sandboxId)}/bin/tau`, mode: '0755' })
  }
  // Default seed is a recording no-op so existing tests don't pay for the real
  // seeder (which would call client.read/bash the fake client doesn't script).
  let seedBoxDevbox = async (_client: any, sandboxId: string, role: EnsureBoxOpts['role']) => {
    log.push(`seed:${sandboxId}`)
    seedCalls.push({ sandboxId, role })
    return {}
  }

  // Attach-on-miss state: no row by default (getOrAttachClient resolves null).
  let machineBoxRow: { machineId: string; port: number; status: string; reconcilableSpecHash?: string | null } | null =
    null
  let machineStatus = 'ready'
  let setupState: VmSetupState | null = null
  const ensureMasterCalls: string[] = []
  const addForwardCalls: Array<{ machineId: string; remotePort: number }> = []
  const removeForwardCalls: Array<{ machineId: string; remotePort: number }> = []
  const persistCalls: Array<{ sandboxId: string; atMs: number }> = []
  let attachLocalPort = 61000

  let port = 40000
  const boxPorts = new Map<string, number>()
  const deps: Partial<VmSandboxManagerDeps> = {
    // The manager resolves the machine ONCE (via a resolvePlacement-shaped request)
    // and hands its id to ensureBox; the reverse-tunnel callback (resolveBoxApiUrl)
    // uses that same machine. The full request is recorded so tests can assert its
    // shape (role/squadId/dedicated) and that placement happens exactly once.
    async resolveMachine(req: PlacementRequest) {
      resolveMachineCalls.push(req)
      const id = req.explicitMachineId ?? machineForSandbox(req.sandboxId)
      return { id, name: id } as any
    },
    async resolveBoxApiUrl(machine: any) {
      resolveBoxApiUrlCalls.push(machine.id)
      return `http://127.0.0.1:59999`
    },
    syncBoxFiles: (client: any, sandboxId: string, o: SandboxOptions, box: unknown, fence: any, trackSetupWork: any) =>
      syncBoxFiles(client, sandboxId, o, box, fence, trackSetupWork),
    seedBoxDevbox: (client: any, sandboxId: string, role: EnsureBoxOpts['role']) =>
      seedBoxDevbox(client, sandboxId, role),
    async ensureBox(o: EnsureBoxOpts) {
      ensureCalls.push(o)
      log.push(`ensureBox:${o.sandboxId}`)
      // The manager now always passes a concrete machineId (the resolved machine).
      const machineId = o.machineId ?? machineForSandbox(o.sandboxId)
      // A re-ensure over a still-healthy box returns the SAME forward, exactly as
      // production does: box-manager's healthy fast path hands back the existing
      // port. Handing out a fresh port per call made every re-ensure look like a
      // moved box, which is why no test could observe the client being swapped out
      // from under an in-flight command. Tests that want a genuinely relocated box
      // call rotateBoxEndpoint().
      let boxPort = boxPorts.get(o.sandboxId)
      if (boxPort === undefined) {
        boxPort = ++port
        boxPorts.set(o.sandboxId, boxPort)
      }
      return {
        machine: { id: machineId, name: machineId } as any,
        box: {
          sandboxId: o.sandboxId,
          machineId,
          unixUser: boxUnixUser(o.sandboxId),
          port: boxPort,
          status: 'ready',
          authToken: `tok-${o.sandboxId}`,
        } as any,
        endpoint: `http://127.0.0.1:${5000 + boxPort}`,
      }
    },
    async stopBox(sandboxId: string) {
      stopCalls.push(sandboxId)
      log.push(`stopBox:${sandboxId}`)
      return { kind: 'verified' as const }
    },
    async removeBox(sandboxId: string, o: { archivePrivate?: boolean; timeoutMs?: number }) {
      removeCalls.push({ sandboxId, archivePrivate: o.archivePrivate, timeoutMs: o.timeoutMs })
      log.push(`removeBox:${sandboxId}:${o.archivePrivate}`)
    },
    async boxChainHealth() {
      return { status: boxStatusValue, chain: boxChainOverride ?? chainForBoxStatus(boxStatusValue) }
    },
    async releaseMachineForwards(machineId: string) {
      releasedMachines.push(machineId)
      log.push(`releaseMachineForwards:${machineId}`)
    },
    async getMachineBox(sandboxId: string) {
      if (!machineBoxRow) return null
      return {
        sandboxId,
        machineId: machineBoxRow.machineId,
        unixUser: boxUnixUser(sandboxId),
        port: machineBoxRow.port,
        status: machineBoxRow.status,
        authToken: `row-tok-${sandboxId}`,
        reconcilableSpecHash: machineBoxRow.reconcilableSpecHash ?? null,
        updatedAt: new Date(),
      } as any
    },
    async getMachine(machineId: string) {
      return { id: machineId, name: machineId, status: machineStatus } as any
    },
    async ensureMaster(machine: any) {
      ensureMasterCalls.push(machine.id)
    },
    async addForward(machine: any, remotePort: number) {
      addForwardCalls.push({ machineId: machine.id, remotePort })
      return ++attachLocalPort
    },
    async refreshForward(machine: any, remotePort: number) {
      addForwardCalls.push({ machineId: machine.id, remotePort })
      return ++attachLocalPort
    },
    async removeForward(machineId: string, remotePort: number) {
      removeForwardCalls.push({ machineId, remotePort })
    },
    async persistBoxActivity(sandboxId: string, atMs: number) {
      persistCalls.push({ sandboxId, atMs })
    },
    createClient(endpoint: string, authToken?: string) {
      createdEndpoints.push(endpoint)
      createdClientTokens.push(authToken)
      const c = makeFakeClient(endpoint, opts?.bashScript)
      clients.set(endpoint, c)
      return c as any
    },
    async resolveGitHubIdentity() {
      return { githubToken, gitUserName: 'Bot', gitUserEmail: 'bot@example.com' }
    },
    getSecret(key: string) {
      return key === 'SANDBOX_CALLBACK_SECRET' ? 'cbsecret' : undefined
    },
    async getBundleVersion() {
      return 'bundle-1'
    },
    getBoxProvisionVersion() {
      return provisionVersion
    },
    getAppUrl() {
      return appUrl
    },
    async getSetupState() {
      return setupState
    },
    async deleteSetupState() {
      setupState = null
    },
    async withSetupLease<T>(_sandboxId: string, fn: () => Promise<T>) {
      return fn()
    },
    async ensureSetupFingerprint(sandboxId: string, fingerprint: string) {
      if (!setupState || setupState.desiredFingerprint !== fingerprint) {
        setupState = {
          sandboxId,
          desiredFingerprint: fingerprint,
          readiness: 'pending',
          reasons: [],
          attemptCount: 0,
          nextAttemptAt: null,
          pendingInvocationId: null,
          pendingInvocationKind: null,
          lastFailureClass: null,
          lastAttemptAt: null,
          updatedAt: new Date(),
        }
      }
      return setupState
    },
    async setSetupPendingInvocation(_sandboxId: string, _fingerprint: string, invocationId: string, kind: string) {
      log.push(`pending:${kind}`)
      if (!setupState || (setupState.pendingInvocationId && setupState.pendingInvocationId !== invocationId))
        return false
      setupState = { ...setupState, pendingInvocationId: invocationId, pendingInvocationKind: kind }
      return true
    },
    async clearSetupPendingInvocation(_sandboxId: string, _fingerprint: string, invocationId: string) {
      if (!setupState || setupState.pendingInvocationId !== invocationId) return false
      setupState = { ...setupState, pendingInvocationId: null, pendingInvocationKind: null }
      return true
    },
    async markSetupPending(_sandboxId: string, fingerprint: string, now: Date) {
      if (!setupState || setupState.desiredFingerprint !== fingerprint) return false
      setupState = { ...setupState, readiness: 'pending', reasons: [], nextAttemptAt: null, updatedAt: now }
      return true
    },
    async restoreSetupAfterAssets(_sandboxId: string, fingerprint: string, prior: VmSetupState, now: Date) {
      if (!setupState || setupState.desiredFingerprint !== fingerprint || setupState.pendingInvocationId) return false
      setupState = { ...prior, updatedAt: now }
      return true
    },
    async markSetupReconciling(_sandboxId: string, _fingerprint: string, now: Date) {
      if (setupState) setupState = { ...setupState, readiness: 'reconciling', lastAttemptAt: now, updatedAt: now }
      return Boolean(setupState)
    },
    async markSetupRepairNeeded(_sandboxId: string, fingerprint: string, reason: any, now: Date) {
      if (!setupState || setupState.desiredFingerprint !== fingerprint) return null
      if (setupState.readiness === 'ready')
        setupState = {
          ...setupState,
          readiness: 'ready_degraded',
          reasons: [reason],
          attemptCount: 0,
          nextAttemptAt: now,
          lastFailureClass: null,
          updatedAt: now,
        }
      return setupState
    },
    async mergeSetupObservedReasons(_sandboxId: string, fingerprint: string, reasons: any[], now: Date) {
      if (!setupState || setupState.desiredFingerprint !== fingerprint) return null
      setupState = { ...setupState, reasons: [...new Set([...setupState.reasons, ...reasons])], updatedAt: now }
      return setupState
    },
    async markSetupDegraded(input: any) {
      if (!setupState) return null
      setupState = {
        ...setupState,
        readiness: 'ready_degraded',
        reasons: input.reasons,
        attemptCount: setupState.attemptCount + 1,
        nextAttemptAt: new Date((input.now ?? new Date()).getTime() + 30_000),
        updatedAt: input.now ?? new Date(),
      }
      return setupState
    },
    async markSetupReady(_sandboxId: string, _fingerprint: string, now: Date) {
      if (setupState)
        setupState = {
          ...setupState,
          readiness: 'ready',
          reasons: [],
          attemptCount: 0,
          nextAttemptAt: null,
          updatedAt: now,
        }
      return Boolean(setupState)
    },
    now() {
      return nowValue
    },
  }

  return {
    deps,
    log,
    ensureCalls,
    removeCalls,
    stopCalls,
    releasedMachines,
    clients,
    createdEndpoints,
    createdClientTokens,
    resolveMachineCalls,
    resolveBoxApiUrlCalls,
    syncCalls,
    seedCalls,
    setNow: (n) => (nowValue = n),
    setProvisionVersion: (v) => (provisionVersion = v),
    rotateBoxEndpoint: (sandboxId: string) => boxPorts.delete(sandboxId),
    setBoxStatus: (s) => (boxStatusValue = s),
    setBoxChain: (chain) => (boxChainOverride = chain),
    setAppUrl: (u) => (appUrl = u),
    setGithubToken: (t) => (githubToken = t),
    setSyncBoxFiles: (fn) => (syncBoxFiles = fn),
    setSeedBoxDevbox: (fn) => (seedBoxDevbox = fn),
    setMachineBoxRow: (row) => (machineBoxRow = row),
    setMachineStatus: (status) => (machineStatus = status),
    ensureMasterCalls,
    addForwardCalls,
    removeForwardCalls,
    persistCalls,
    setSetupState: (state) => (setupState = state),
  }
}

const squadOpts: SandboxOptions = { workspacePath: '/core/host/ws', squadId: 's1', k8s: { sandboxType: 'squad' } }
const agentOpts: SandboxOptions = { workspacePath: '/core/host/private', k8s: { sandboxType: 'agent' } }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VmSandboxManager', () => {
  test('no-create attachment delegates to durable existing-box discovery', async () => {
    const found = { getOrAttachClient: async () => ({}) }
    await expect(
      VmSandboxManager.prototype.attachExistingSandbox.call(found as any, 's', { workspacePath: '/workspace' })
    ).resolves.toBe(true)
    const absent = { getOrAttachClient: async () => null }
    await expect(
      VmSandboxManager.prototype.attachExistingSandbox.call(absent as any, 's', { workspacePath: '/workspace' })
    ).resolves.toBe(false)
  })

  test('uses the durable VM box generation to fence stale stops across manager instances', async () => {
    const h = makeHarness()
    let leaseTail = Promise.resolve()
    h.deps.withSetupLease = async <T>(_sandboxId: string, operation: () => Promise<T>) => {
      const previous = leaseTail
      const release = Promise.withResolvers<void>()
      leaseTail = previous.then(() => release.promise)
      await previous
      try {
        return await operation()
      } finally {
        release.resolve()
      }
    }
    const newerEnsureReady = Promise.withResolvers<void>()
    const releaseNewerEnsure = Promise.withResolvers<void>()
    let blockNewerEnsure = false
    const ensureBox = h.deps.ensureBox!
    h.deps.ensureBox = async (options) => {
      const result = await ensureBox(options)
      if (blockNewerEnsure) {
        blockNewerEnsure = false
        newerEnsureReady.resolve()
        await releaseNewerEnsure.promise
      }
      h.setMachineBoxRow({
        machineId: result.box.machineId,
        port: result.box.port,
        status: 'ready',
        reconcilableSpecHash: options.env.FICUS_BOX_SPEC_HASH,
      })
      return result
    }
    const staleManager = new VmSandboxManager(h.deps)
    const currentManager = new VmSandboxManager(h.deps)
    const sandboxId = 'agent_generation_fence'

    await staleManager.ensureSandbox(sandboxId, { ...agentOpts, lifecycleGeneration: 'generation-a' })
    blockNewerEnsure = true
    const newerEnsure = currentManager.ensureSandbox(sandboxId, {
      ...agentOpts,
      lifecycleGeneration: 'generation-b',
    })
    await newerEnsureReady.promise
    h.stopCalls.length = 0
    const staleStop = staleManager.stopSandbox(sandboxId, { lifecycleGeneration: 'generation-a' })
    await Bun.sleep(10)
    expect(h.stopCalls).toEqual([])

    releaseNewerEnsure.resolve()
    await Promise.all([newerEnsure, staleStop])
    expect(h.stopCalls).toEqual([])
    await currentManager.stopSandbox(sandboxId, { lifecycleGeneration: 'generation-b' })
    expect(h.stopCalls).toEqual([sandboxId])
  })

  test('an absent authoritative row settles a fenced stop without caller-generation fallback', async () => {
    const h = makeHarness()
    const manager = new VmSandboxManager(h.deps)
    const sandboxId = 'agent_absent_generation_fence'
    await manager.ensureSandbox(sandboxId, { ...agentOpts, lifecycleGeneration: 'generation-a' })
    const client = (manager as any).sandboxes.get(sandboxId).client as FakeClient
    h.stopCalls.length = 0
    h.deps.getMachineBox = async () => null

    await expect(manager.stopSandbox(sandboxId, { lifecycleGeneration: 'generation-a' })).resolves.toEqual({
      kind: 'not-found',
    })
    expect(h.stopCalls).toEqual([])
    expect(client.closed).toBe(1)
    expect((manager as any).sandboxes.has(sandboxId)).toBe(false)
  })

  test('setup retirement keeps durable state after an unverified physical stop', async () => {
    const h = makeHarness()
    const ensureBox = h.deps.ensureBox!
    h.deps.ensureBox = async (options) => {
      const result = await ensureBox(options)
      h.setMachineBoxRow({
        machineId: result.box.machineId,
        port: result.box.port,
        status: 'ready',
        reconcilableSpecHash: options.env.FICUS_BOX_SPEC_HASH,
      })
      return result
    }
    let setupDeletes = 0
    let unverified = false
    const stopBox = h.deps.stopBox!
    h.deps.deleteSetupState = async () => void setupDeletes++
    h.deps.stopBox = async (sandboxId) => (unverified ? { kind: 'unverified' } : stopBox(sandboxId))
    const manager = new VmSandboxManager(h.deps)
    const sandboxId = 'agent_setup_unverified'
    await manager.ensureSandbox(sandboxId, { ...agentOpts, lifecycleGeneration: 'generation-a' })
    unverified = true

    await expect(manager.retireSetupRecovery(sandboxId, 'generation-a')).resolves.toEqual({ kind: 'unverified' })
    expect(setupDeletes).toBe(0)
  })

  test('setup retirement preserves a newly woken generation and deletes state only for an exact winner', async () => {
    const h = makeHarness()
    const ensureBox = h.deps.ensureBox!
    h.deps.ensureBox = async (options) => {
      const result = await ensureBox(options)
      h.setMachineBoxRow({
        machineId: result.box.machineId,
        port: result.box.port,
        status: 'ready',
        reconcilableSpecHash: options.env.FICUS_BOX_SPEC_HASH,
      })
      return result
    }
    let setupDeletes = 0
    h.deps.deleteSetupState = async () => {
      setupDeletes++
    }
    const staleManager = new VmSandboxManager(h.deps)
    const currentManager = new VmSandboxManager(h.deps)
    const sandboxId = 'agent_setup_retirement_fence'

    await staleManager.ensureSandbox(sandboxId, { ...agentOpts, lifecycleGeneration: 'generation-a' })
    await currentManager.ensureSandbox(sandboxId, { ...agentOpts, lifecycleGeneration: 'generation-b' })
    h.stopCalls.length = 0

    await expect(staleManager.retireSetupRecovery(sandboxId, 'generation-a')).resolves.toEqual({
      kind: 'generation-mismatch',
      actualLifecycleGeneration: 'generation-b',
    })

    expect(h.stopCalls).toEqual([])
    expect(setupDeletes).toBe(0)
    await expect(currentManager.exec(sandboxId, ['echo', 'still-live'])).resolves.toEqual(Buffer.from('ok'))

    await expect(currentManager.retireSetupRecovery(sandboxId, 'generation-b')).resolves.toEqual({ kind: 'retired' })
    expect(h.stopCalls).toEqual([sandboxId])
    expect(setupDeletes).toBe(1)
  })

  test('rejects a stale legacy-resource stop before touching current same-manager generation state', async () => {
    const h = makeHarness()
    const ensureBox = h.deps.ensureBox!
    h.deps.ensureBox = async (options) => {
      const result = await ensureBox(options)
      h.setMachineBoxRow({
        machineId: result.box.machineId,
        port: result.box.port,
        status: 'ready',
        reconcilableSpecHash: options.env.FICUS_BOX_SPEC_HASH,
      })
      return result
    }
    const manager = new VmSandboxManager(h.deps)
    const sandboxId = 'agent_same_manager_generation_fence'
    await manager.ensureSandbox(sandboxId, agentOpts)
    await manager.ensureSandbox(sandboxId, { ...agentOpts, lifecycleGeneration: 'generation-b' })
    const currentState = (manager as any).sandboxes.get(sandboxId)
    const currentClient = currentState.client as FakeClient
    ;(manager as any).healthObservations.set(sandboxId, { observedAt: 1, status: 'running' })
    h.stopCalls.length = 0

    await manager.stopSandbox(sandboxId, { lifecycleGeneration: null })

    expect(h.stopCalls).toEqual([])
    expect(currentClient.closed).toBe(0)
    expect((manager as any).sandboxes.get(sandboxId)).toBe(currentState)
    expect((manager as any).healthObservations.has(sandboxId)).toBe(true)
    await expect(manager.exec(sandboxId, ['echo', 'still-live'])).resolves.toEqual(Buffer.from('ok'))

    await manager.stopSandbox(sandboxId)
    expect(h.stopCalls).toEqual([sandboxId])
    expect(currentClient.closed).toBe(1)
  })

  test('module exports VmSandboxManager', () => {
    expect(VmSandboxManager).toBeDefined()
  })

  test('concurrent stale-client recovery publishes one authenticated replacement', async () => {
    const h = makeHarness()
    h.setMachineBoxRow({ machineId: 'm1', port: 50100, status: 'ready' })
    const mgr = new VmSandboxManager(h.deps)
    const stale = (await mgr.getOrAttachClient('squad_s1')) as any as FakeClient
    stale.healthError = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })

    const recovered = await Promise.all(
      Array.from({ length: 10 }, () => mgr.recoverClient('squad_s1', stale as any, stale.healthError!))
    )

    expect(new Set(recovered).size).toBe(1)
    expect(recovered[0]).not.toBe(stale as any)
    expect(h.addForwardCalls).toHaveLength(2) // initial attach + one exact refresh
    expect(h.createdEndpoints).toHaveLength(2)
    expect(mgr.getClientForSandbox('squad_s1')).toBeNull()
    expect(await mgr.getOrAttachClient('squad_s1')).toBe(recovered[0])
  })

  test('serializes stop behind a gated ensure so teardown cannot be resurrected', async () => {
    const h = makeHarness()
    const originalEnsure = h.deps.ensureBox!
    let entered!: () => void
    const enteredEnsure = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.deps.ensureBox = async (opts) => {
      entered()
      await gate
      return originalEnsure(opts)
    }
    const mgr = new VmSandboxManager(h.deps)
    const ensuring = mgr.ensureSandbox('squad_s1', squadOpts)
    await enteredEnsure
    const stopping = mgr.stopSandbox('squad_s1')
    expect(h.stopCalls).toHaveLength(0)
    release()
    await expect(ensuring).rejects.toThrow('Sandbox not found')
    await stopping
    expect(mgr.getClientForSandbox('squad_s1')).toBeNull()
    expect(h.stopCalls).toEqual(['squad_s1'])
  })

  test('serializes remove behind gated recovery so a candidate cannot survive teardown', async () => {
    const h = makeHarness()
    const originalRefresh = h.deps.refreshForward!
    let entered!: () => void
    const enteredRefresh = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.deps.refreshForward = async (machine, port) => {
      entered()
      await gate
      return originalRefresh(machine, port)
    }
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    h.setMachineBoxRow({ machineId: 'm1', port: 50100, status: 'ready' })
    const failed = mgr.getClientForSandbox('squad_s1') as any as FakeClient
    failed.healthError = new Error('socket closed')
    const recovering = mgr.recoverClient('squad_s1', failed as any, failed.healthError)
    await enteredRefresh
    const removing = mgr.removeSandbox('squad_s1')
    expect(h.removeCalls).toHaveLength(0)
    release()
    await recovering
    await removing
    expect(mgr.getClientForSandbox('squad_s1')).toBeNull()
    expect(h.removeCalls).toEqual([{ sandboxId: 'squad_s1', archivePrivate: false, timeoutMs: 5 * 60_000 }])
  })

  test('serializes a full ensure publication behind exact-forward recovery', async () => {
    const h = makeHarness()
    const originalRefresh = h.deps.refreshForward!
    let entered!: () => void
    const enteredRefresh = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.deps.refreshForward = async (machine, port) => {
      entered()
      await gate
      return originalRefresh(machine, port)
    }
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    h.setMachineBoxRow({ machineId: 'm1', port: 50100, status: 'ready' })
    const failed = mgr.getClientForSandbox('squad_s1') as any as FakeClient
    failed.healthError = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    const recovering = mgr.recoverClient('squad_s1', failed as any, failed.healthError)
    await enteredRefresh
    const ensuring = mgr.ensureSandbox('squad_s1', squadOpts)
    await Promise.resolve()
    expect(h.ensureCalls).toHaveLength(1)
    release()
    const recovered = await recovering
    await ensuring
    expect(h.ensureCalls).toHaveLength(2)
    expect(mgr.getClientForSandbox('squad_s1')).not.toBe(recovered)
  })

  test('serializes same-machine token rotation so stale recovery cleans only its generation', async () => {
    const h = makeHarness()
    let token = 'old-token'
    const originalEnsure = h.deps.ensureBox!
    h.deps.ensureBox = async (opts) => {
      const placed = await originalEnsure(opts)
      placed.box.authToken = token
      return placed
    }
    h.deps.getMachineBox = async (sandboxId) =>
      ({
        sandboxId,
        machineId: 'm1',
        unixUser: 'tau',
        port: 50100,
        status: 'ready',
        authToken: token,
        updatedAt: new Date(),
      }) as any
    const originalRefresh = h.deps.refreshForward!
    let entered!: () => void
    const enteredRefresh = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.deps.refreshForward = async (machine, port) => {
      entered()
      await gate
      return originalRefresh(machine, port)
    }
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    const failed = mgr.getClientForSandbox('squad_s1') as any as FakeClient
    failed.healthError = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    const recovering = mgr.recoverClient('squad_s1', failed as any, failed.healthError)
    await enteredRefresh
    token = 'new-token'
    const ensuring = mgr.ensureSandbox('squad_s1', squadOpts)
    release()
    await expect(recovering).rejects.toThrow('changed while its connection was recovering')
    await ensuring
    expect(mgr.getClientForSandbox('squad_s1')).not.toBe(failed)
    expect(h.ensureCalls).toHaveLength(2)
  })

  test('classifies an authenticated uptime regression as a box-server restart', async () => {
    const h = makeHarness()
    h.setMachineBoxRow({ machineId: 'm1', port: 50100, status: 'ready' })
    const mgr = new VmSandboxManager(h.deps)
    const failed = (await mgr.getOrAttachClient('squad_s1')) as any as FakeClient
    failed.uptimeSeconds = 120
    await mgr.getSandboxStatus('squad_s1')
    failed.healthError = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    const priorLog = console.log
    const lines: string[] = []
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    try {
      await mgr.recoverClient('squad_s1', failed as any, failed.healthError)
    } finally {
      console.log = priorLog
    }
    expect(lines.find((line) => line.includes('VM transport recovery complete'))).toContain('"box":"restart_observed"')
  })

  test('projects ControlMaster loss with reverse rebound using bounded diagnostics', async () => {
    const h = makeHarness()
    h.setMachineBoxRow({ machineId: 'm1', port: 50100, status: 'ready' })
    h.deps.refreshForwardDetailed = async () => ({
      localPort: 61001,
      master: 'restarted',
      forward: 'rebound',
      reverses: 'invalidated',
    })
    h.deps.resolveBoxApiTransport = async () => ({
      url: 'http://127.0.0.1:49000',
      reverse: 'bound',
      allocation: 'pinned',
    })
    const mgr = new VmSandboxManager(h.deps)
    const failed = (await mgr.getOrAttachClient('squad_s1')) as any as FakeClient
    failed.healthError = new Error('socket closed')
    const priorLog = console.log
    const lines: string[] = []
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    try {
      await mgr.recoverClient('squad_s1', failed as any, failed.healthError)
    } finally {
      console.log = priorLog
    }
    const complete = lines.find((line) => line.includes('VM transport recovery complete'))
    expect(complete).toContain('"master":"restarted"')
    expect(complete).toContain('"reverse":"rebound"')
  })

  test('projects reverse-tunnel loss without exposing the direct callback URL', async () => {
    const h = makeHarness()
    h.setMachineBoxRow({ machineId: 'm1', port: 50100, status: 'ready' })
    h.deps.refreshForwardDetailed = async () => ({
      localPort: 61001,
      master: 'preserved',
      forward: 'rebound',
      reverses: 'preserved',
    })
    h.deps.resolveBoxApiTransport = async () => ({
      url: 'https://user:secret@example.com/?token=hidden',
      reverse: 'lost',
      allocation: 'direct_fallback',
    })
    const mgr = new VmSandboxManager(h.deps)
    const failed = (await mgr.getOrAttachClient('squad_s1')) as any as FakeClient
    failed.healthError = new Error('socket closed')
    const priorLog = console.log
    const lines: string[] = []
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    try {
      await mgr.recoverClient('squad_s1', failed as any, failed.healthError)
    } finally {
      console.log = priorLog
    }
    const complete = lines.find((line) => line.includes('VM transport recovery complete')) ?? ''
    expect(complete).toContain('"reverse":"lost"')
    expect(complete).not.toContain('secret')
    expect(complete).not.toContain('example.com')
  })

  test('a delayed old exec failure repairs against the client that launched it', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    h.setMachineBoxRow({ machineId: 'm1', port: 50100, status: 'ready' })
    const stale = [...h.clients.values()][0]
    const delayed = new EventEmitter() as any
    delayed.invocationId = 'old-invocation'
    delayed.cancelAndWait = async () => {
      throw new Error('old transport gone')
    }
    stale.bash = () => delayed

    const failedClients: unknown[] = []
    const originalRecover = mgr.recoverClient.bind(mgr)
    ;(mgr as any).recoverClient = async (id: string, failed: unknown, cause: Error) => {
      failedClients.push(failed)
      return originalRecover(id, failed as any, cause)
    }
    const exec = mgr.exec('squad_s1', ['echo', 'once']).catch(() => undefined)
    stale.healthError = new Error('socket closed')
    await originalRecover('squad_s1', stale as any, stale.healthError)
    delayed.emit('error', new Error('late generation-one failure'))
    await exec

    expect(failedClients.at(-1)).toBe(stale as any)
  })

  test('does not claim a legacy physically-ready box is setup-ready without durable state', async () => {
    const h = makeHarness()
    h.setBoxStatus('ready')
    h.setSetupState(null)
    const mgr = new VmSandboxManager(h.deps)
    expect(await mgr.getSandboxStatus('squad_legacy')).toMatchObject({
      status: 'starting',
      reason: 'sandbox setup has not been reconciled',
      devboxReady: false,
    })
  })

  test('persists live Devbox cache loss so lifecycle repair becomes due', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    const client = [...h.clients.values()][0]
    client.health = async () => ({
      healthy: true,
      devboxReady: client.devboxReadyCalls >= 2,
      version: 'test',
      uptimeSeconds: 1,
    })

    expect(await mgr.getSandboxStatus('squad_s1')).toMatchObject({
      status: 'running',
      readiness: 'ready_degraded',
      degradation: { reasons: ['devbox_unavailable'], attemptCount: 0 },
    })
    await mgr.ensureSandbox('squad_s1', squadOpts)
    expect([...h.clients.values()].reduce((sum, value) => sum + value.devboxReadyCalls, 0)).toBe(2)
    expect(await mgr.getSandboxStatus('squad_s1')).toMatchObject({ status: 'running', readiness: 'ready' })
  })

  test('status discovery distinguishes failed typed transport recovery from healthy Devbox cache loss', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    const client = [...h.clients.values()][0]
    client.healthError = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })

    expect(await mgr.getSandboxStatus('squad_s1')).toMatchObject({
      status: 'running',
      readiness: 'ready_degraded',
      devboxReady: false,
      degradation: { reasons: ['transport_recovery_failed'], attemptCount: 0 },
    })
  })

  test('reports a live box as running with durable degraded setup readiness', async () => {
    const h = makeHarness()
    h.setBoxStatus('ready')
    h.setSetupState({
      sandboxId: 'squad_s1',
      desiredFingerprint: 'f',
      readiness: 'ready_degraded',
      reasons: ['devbox_unavailable'],
      attemptCount: 2,
      nextAttemptAt: new Date('2026-01-01T00:02:00Z'),
      pendingInvocationId: null,
      pendingInvocationKind: null,
      lastFailureClass: null,
      lastAttemptAt: new Date(),
      updatedAt: new Date(),
    })
    const mgr = new VmSandboxManager(h.deps)

    expect(await mgr.getSandboxStatus('squad_s1')).toMatchObject({
      status: 'running',
      readiness: 'ready_degraded',
      devboxReady: false,
      degradation: { reasons: ['devbox_unavailable'], attemptCount: 2, nextAttemptAt: '2026-01-01T00:02:00.000Z' },
    })
  })

  test('managed toolchain clear uses the isolated box-home directory', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('agent_a1', agentOpts)
    const client = [...h.clients.values()].at(-1)!

    const progress: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(mgr, 'agent_a1', (event) => progress.push(event))
    expect(
      await mgr.reconcileToolchain('agent_a1', agentOpts, {
        reportStage: async () => {},
      })
    ).toBe('cleared')
    expect(client.bashCalls.at(-1)?.command).toContain('/home/box_')
    expect(client.bashCalls.at(-1)?.command).toContain('/.tau/toolchain/.ready')
    expect(client.bashCalls.at(-1)?.command).not.toContain('/.tau/devbox')
    expect(client.toolchainReadyCalls).toEqual([false])
    expect(progress[0]).toMatchObject({ type: 'started', reason: 'toolchain_reconcile' })
    expect(progress.at(-1)).toMatchObject({ type: 'finished', outcome: 'ready' })
  })

  test('managed toolchain current marker emits no progress and mutation failure is reported', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('agent_a1', agentOpts)
    const client = [...h.clients.values()].at(-1)!
    const progress: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(mgr, 'agent_a1', (event) => progress.push(event))
    ;(client as any).read = async () => ({ content: Buffer.from('fingerprint').toString('base64') })

    await expect(
      mgr.reconcileToolchain('agent_a1', agentOpts, {
        config: { packages: ['a'] },
        fingerprint: 'fingerprint',
        devboxJson: '{}',
        reportStage: async () => {},
      })
    ).resolves.toBe('unchanged')
    expect(progress).toEqual([])
    ;(client as any).read = async () => ({ content: Buffer.from('stale').toString('base64') })
    client.toolchainReady = async () => {
      throw new Error('activation failed')
    }
    await expect(
      mgr.reconcileToolchain('agent_a1', agentOpts, {
        config: { packages: ['a'] },
        fingerprint: 'fingerprint',
        devboxJson: '{}',
        reportStage: async () => {},
      })
    ).rejects.toMatchObject({ code: 'activation_failed' })
    expect(progress[0]).toMatchObject({ type: 'started', reason: 'toolchain_reconcile' })
    expect(progress.at(-1)).toMatchObject({ type: 'finished', outcome: 'failed' })
  })

  test('ensureSandbox derives BoxEnv, creates a client on the stripped endpoint, tracks the box', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)

    const result = await mgr.ensureSandbox('squad_s1', squadOpts)

    expect(result).toBe('squad_s1')
    expect(h.ensureCalls).toHaveLength(1)
    const call = h.ensureCalls[0]
    expect(call.sandboxId).toBe('squad_s1')
    expect(call.role).toBe('squad')

    // Env parity: identity + secrets + spec hash are all rendered.
    expect(call.env.FICUS_SANDBOX_ID).toBe('squad_s1')
    expect(call.env.FICUS_SQUAD_ID).toBe('s1')
    expect(call.env.FICUS_SANDBOX_UMASK).toBe('0002')
    expect(call.env.GITHUB_TOKEN).toBeUndefined()
    expect(call.env.GH_TOKEN).toBeUndefined()
    expect(call.env.GIT_USER_NAME).toBe('Bot')
    expect(call.env.GIT_USER_EMAIL).toBe('bot@example.com')
    expect(call.env.SANDBOX_CALLBACK_SECRET).toBe('cbsecret')
    expect(call.env.APP_URL).toBe('https://app.example.com')
    // The callback URL is the reverse tunnel (resolveBoxApiUrl), NEVER the
    // public-looking APP_URL — the tunnel is the default box→core path.
    expect(call.env.FICUS_API_URL).toBe('http://127.0.0.1:59999')
    expect(call.env.FICUS_BOX_SPEC_HASH).toBe(mgr.computeSpecHash(squadOpts))
    // EnsureBoxOpts.specHash is NOT just computeSpecHash(opts) — it folds in a
    // hash of the caller env too (computeProvisioningMarker), so box-manager's
    // resume fast path also busts on a rotated secret, not only a bundle/role/
    // provision-script change. Reconstructed here from the same env the
    // assertions above just verified, matching computeProvisioningMarker's
    // canonicalization exactly.
    expect(call.specHash).toBe(computeProvisioningMarker(mgr.computeSpecHash(squadOpts), call.env))
    expect(call.specHash).not.toBe(mgr.computeSpecHash(squadOpts))
    // FICUS_SANDBOX_ROLE mirrors pod-spec: a squad box is 'squad'.
    expect(call.env.FICUS_SANDBOX_ROLE).toBe('squad')

    // Client created against host:port (no scheme), carrying the box row's
    // executor auth token so every request passes the server's auth gate.
    expect(h.createdEndpoints).toHaveLength(1)
    expect(h.createdEndpoints[0]).toMatch(/^127\.0\.0\.1:\d+$/)
    expect(h.createdClientTokens).toEqual(['tok-squad_s1'])

    expect(mgr.hasSandbox('squad_s1')).toBe(true)
    expect(mgr.getClient('squad_s1')).not.toBeNull()
    // 'vm' isn't in the SandboxRuntime union until Task 5 adds it.
    expect(mgr.getSandboxRuntime('squad_s1')).toBe('vm' as SandboxRuntime)
  })

  test('ensureSandbox is idempotent / deduplicated per sandbox', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    const [a, b] = await Promise.all([
      mgr.ensureSandbox('squad_s1', squadOpts),
      mgr.ensureSandbox('squad_s1', squadOpts),
    ])
    expect(a).toBe('squad_s1')
    expect(b).toBe('squad_s1')
    // Concurrent identical calls share the in-flight run.
    expect(h.ensureCalls).toHaveLength(1)
  })

  test('replays physical setup progress to an in-flight ensure joiner', async () => {
    const h = makeHarness()
    const originalEnsureBox = h.deps.ensureBox!
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let started!: () => void
    const setupStarted = new Promise<void>((resolve) => (started = resolve))
    let physicalCalls = 0
    h.deps.ensureBox = async (opts) => {
      physicalCalls++
      const finish = opts.beginPhysicalWork?.('runtime_start')
      started()
      await gate
      try {
        return await originalEnsureBox(opts)
      } finally {
        finish?.('ready')
      }
    }
    const mgr = new VmSandboxManager(h.deps)
    const firstEvents: SandboxSetupProgressEvent[] = []
    const joinedEvents: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(mgr, 'squad_s1', (event) => firstEvents.push(event))

    const first = mgr.ensureSandbox('squad_s1', squadOpts)
    await setupStarted
    observeSandboxSetupProgress(mgr, 'squad_s1', (event) => joinedEvents.push(event))
    const joined = mgr.ensureSandbox('squad_s1', squadOpts)

    expect(joinedEvents[0]).toMatchObject({ type: 'started', reason: 'runtime_start' })
    expect(joinedEvents[0]?.operationId).toBe(firstEvents[0]?.operationId)
    release()
    await Promise.all([first, joined])
    expect(joinedEvents.at(-1)).toMatchObject({ type: 'finished', outcome: 'ready' })
    expect(physicalCalls).toBe(1)
  })

  test('placement-once: resolves the machine a single time and hands its id to ensureBox', async () => {
    const h = makeHarness()
    // resolveBoxApiUrl (the reverse-tunnel callback — always consulted now)
    // must reuse the SAME resolved machine rather than placing a second time.
    const mgr = new VmSandboxManager(h.deps)

    await mgr.ensureSandbox('squad_s1', squadOpts)

    // Machine resolved exactly once for the whole ensure.
    expect(h.resolveMachineCalls).toEqual([
      { sandboxId: 'squad_s1', role: 'squad', squadId: 's1', explicitMachineId: null, dedicated: false },
    ])
    // ensureBox received the resolved machine's id (no undefined pin, no re-placement).
    expect(h.ensureCalls).toHaveLength(1)
    expect(h.ensureCalls[0].machineId).toBe('m1')
    // The reverse-tunnel callback targeted that same machine.
    expect(h.resolveBoxApiUrlCalls).toEqual(['m1'])
  })

  test('callback URL always delegates to resolveBoxApiUrl — a public APP_URL no longer short-circuits', async () => {
    const h = makeHarness()
    // APP_URL defaults to the public-LOOKING 'https://app.example.com'. The old
    // heuristic would have baked it as FICUS_API_URL directly, returning BEFORE
    // resolveBoxApiUrl was ever consulted — a footgun when the URL is gated or
    // unreachable from the box. The reverse tunnel is the default now.
    const mgr = new VmSandboxManager(h.deps)

    await mgr.ensureSandbox('squad_s1', squadOpts)

    const call = h.ensureCalls[0]
    // Callback URL is resolveBoxApiUrl's result, NOT the public APP_URL.
    expect(call.env.FICUS_API_URL).toBe('http://127.0.0.1:59999')
    expect(h.resolveBoxApiUrlCalls).toEqual(['m1'])
    // APP_URL env still carries the public app url (distinct from the callback URL).
    expect(call.env.APP_URL).toBe('https://app.example.com')
  })

  test('placement-once: an explicit machineId pin is honored and threaded to ensureBox', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    const pinned: SandboxOptions = { ...squadOpts, machineId: 'm-pinned' }

    await mgr.ensureSandbox('squad_s1', pinned)

    expect(h.resolveMachineCalls).toEqual([
      { sandboxId: 'squad_s1', role: 'squad', squadId: 's1', explicitMachineId: 'm-pinned', dedicated: false },
    ])
    expect(h.ensureCalls[0].machineId).toBe('m-pinned')
  })

  test('a bind rejected by a reaper-claimed machine re-places once (env rebuilt against the new machine)', async () => {
    // The empty-machine reaper can CLAIM the resolved machine (status flip to
    // 'reaping') between placement and ensureBox's bind; the bind then throws
    // MachineNotReadyError. The manager must treat that as re-placeable: re-run
    // placement AND rebuild the (machine-specific) env, then succeed — never
    // surface it as an agent-visible failure.
    let placement = 0
    const h = makeHarness({ machineForSandbox: () => (placement++ === 0 ? 'm-reaped' : 'm-fresh') })
    // The callback URL is per-machine (reverse tunnel) by default, so a re-place
    // must rebuild the env against the fresh machine.
    const realEnsure = h.deps.ensureBox!
    let ensureAttempts = 0
    h.deps.ensureBox = async (o: EnsureBoxOpts) => {
      ensureAttempts++
      const finish = o.beginPhysicalWork?.('runtime_start')
      if (ensureAttempts === 1) {
        finish?.('failed')
        throw new MachineNotReadyError(`machine ${o.machineId} is not ready (status reaping); refusing to bind`)
      }
      const result = await realEnsure(o)
      finish?.('ready')
      return result
    }
    const mgr = new VmSandboxManager(h.deps)
    const progress: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(mgr, 'squad_s1', (event) => progress.push(event))

    const result = await mgr.ensureSandbox('squad_s1', squadOpts)

    expect(result).toBe('squad_s1')
    expect(ensureAttempts).toBe(2)
    // Placement ran again (fresh machine), and the reverse-tunnel callback env
    // was rebuilt against the NEW machine — not reused from the doomed one.
    expect(h.resolveMachineCalls).toHaveLength(2)
    expect(h.resolveBoxApiUrlCalls).toEqual(['m-reaped', 'm-fresh'])
    expect(mgr.hasSandbox('squad_s1')).toBe(true)
    const physicalStarts = progress.filter((event) => event.type === 'started' && event.reason === 'runtime_start')
    expect(physicalStarts).toHaveLength(1)
    expect(progress.filter((event) => event.operationId === physicalStarts[0]!.operationId)).toEqual([
      physicalStarts[0],
      expect.objectContaining({ type: 'finished', outcome: 'ready' }),
    ])
  })

  test('a second consecutive bind rejection propagates (the re-place is bounded)', async () => {
    const h = makeHarness()
    h.deps.ensureBox = async (o: EnsureBoxOpts) => {
      throw new MachineNotReadyError(`machine ${o.machineId} is not ready (status reaping); refusing to bind`)
    }
    const mgr = new VmSandboxManager(h.deps)

    await expect(mgr.ensureSandbox('squad_s1', squadOpts)).rejects.toBeInstanceOf(MachineNotReadyError)
    expect(h.resolveMachineCalls).toHaveLength(2) // exactly one re-place, then surface
  })

  test('an agent box scoped to a squad reaches placement with role=agent + that squadId (squad-per-VM engages)', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    // A collaborating agent box carries the squad it works in (slice-6 setter);
    // placement must see role=agent + that squadId so squad-per-VM keys on it.
    const squadAgentOpts: SandboxOptions = {
      workspacePath: '/core/host/private',
      squadId: 's1',
      k8s: { sandboxType: 'agent' },
    }

    await mgr.ensureSandbox('agent_a1', squadAgentOpts)

    expect(h.resolveMachineCalls).toEqual([
      { sandboxId: 'agent_a1', role: 'agent', squadId: 's1', explicitMachineId: null, dedicated: false },
    ])
  })

  test('a solo agent reaches placement with no squadId (commons request)', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)

    // agentOpts carries no squadId, and getSquadIdFromSandbox('agent_a1') is null,
    // so placement sees a solo agent → the commons path (no squadId).
    await mgr.ensureSandbox('agent_a1', agentOpts)

    expect(h.resolveMachineCalls).toHaveLength(1)
    const req = h.resolveMachineCalls[0]
    expect(req.sandboxId).toBe('agent_a1')
    expect(req.role).toBe('agent')
    expect(req.squadId).toBeUndefined()
    expect(req.explicitMachineId).toBeNull()
    expect(req.dedicated).toBe(false)
  })

  test('a system-manager box reaches placement as role=system-manager with no squadId', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    const smOpts: SandboxOptions = { workspacePath: '/core/host/private', k8s: { sandboxType: 'system-manager' } }

    await mgr.ensureSandbox('system_manager_x', smOpts)

    const req = h.resolveMachineCalls[0]
    expect(req.role).toBe('system-manager')
    expect(req.squadId).toBeUndefined()
  })

  test('the dedicated flag is threaded from opts into the placement request', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    const dedicatedOpts: SandboxOptions = { ...agentOpts, dedicated: true }

    await mgr.ensureSandbox('agent_a1', dedicatedOpts)

    expect(h.resolveMachineCalls[0].dedicated).toBe(true)
  })

  test('the resolved machine is the exact one ensureBox is pinned to', async () => {
    const h = makeHarness({ machineForSandbox: () => 'm-resolved' })
    const mgr = new VmSandboxManager(h.deps)

    await mgr.ensureSandbox('squad_s1', squadOpts)

    // resolvePlacement ran once and its machine id is what ensureBox is pinned to.
    expect(h.resolveMachineCalls).toHaveLength(1)
    expect(h.ensureCalls[0].machineId).toBe('m-resolved')
  })

  test('syncBoxFiles runs after ensureBox and before ensure returns, with a live client', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)

    await mgr.ensureSandbox('squad_s1', squadOpts)

    // Order: the box is ensured, THEN files are synced.
    const ensureIdx = h.log.indexOf('ensureBox:squad_s1')
    const syncIdx = h.log.indexOf('sync:squad_s1')
    expect(ensureIdx).toBeGreaterThanOrEqual(0)
    expect(syncIdx).toBeGreaterThan(ensureIdx)
    // Sync used the tracked client (the fake sync writes the CLI through it).
    const client = [...h.clients.values()][0]
    expect(client.writeCalls.map((w) => w.path)).toContain(`/home/${boxUnixUser('squad_s1')}/bin/tau`)
  })

  test('bridges selected asset mutation progress through the manager hub', async () => {
    const h = makeHarness()
    h.setSyncBoxFiles(async (_client, _sandboxId, _opts, _box, _fence, trackSetupWork) => {
      await trackSetupWork!(async () => undefined)
    })
    const mgr = new VmSandboxManager(h.deps)
    const progress: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(mgr, 'squad_s1', (event) => progress.push(event))

    await mgr.ensureSandbox('squad_s1', squadOpts)

    const assetStart = progress.find((event) => event.type === 'started' && event.reason === 'asset_reconcile')!
    expect(assetStart).toBeDefined()
    expect(progress.filter((event) => event.operationId === assetStart.operationId).at(-1)).toMatchObject({
      type: 'finished',
      outcome: 'ready',
    })
  })

  test('bridges failed asset mutation progress without swallowing the error', async () => {
    const h = makeHarness()
    const error = new Error('asset mutation failed')
    h.setSyncBoxFiles(async (_client, _sandboxId, _opts, _box, _fence, trackSetupWork) => {
      await trackSetupWork!(async () => Promise.reject(error))
    })
    const mgr = new VmSandboxManager(h.deps)
    const progress: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(mgr, 'squad_s1', (event) => progress.push(event))

    await expect(mgr.ensureSandbox('squad_s1', squadOpts)).rejects.toBe(error)

    expect(progress.find((event) => event.type === 'finished' && event.outcome === 'failed')).toBeDefined()
  })

  test('a syncBoxFiles failure is fatal for the ensure', async () => {
    const h = makeHarness()
    h.setSyncBoxFiles(async () => {
      throw new Error('sync exploded')
    })
    const mgr = new VmSandboxManager(h.deps)
    await expect(mgr.ensureSandbox('squad_s1', squadOpts)).rejects.toThrow('sync exploded')
    expect(await mgr.getSandboxStatus('squad_s1')).toMatchObject({
      status: 'starting',
      reason: 'required sandbox assets are not ready',
    })
  })

  test('publishes the file-sync fence before admitting every required-asset Bash effect', async () => {
    const h = makeHarness()
    let observedId: string | undefined
    h.setSyncBoxFiles(async (client, sandboxId, _opts, _box, fence) => {
      const id = 'stable-file-sync-id'
      await fence.before(id, 'file_sync')
      observedId = id
      h.log.push(`sync:${sandboxId}`)
      client.bash({ command: 'mkdir required', invocationId: id })
      await fence.after(id)
    })
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)

    expect(h.log.indexOf('pending:file_sync')).toBeLessThan(h.log.indexOf('sync:squad_s1'))
    expect(observedId).toBe('stable-file-sync-id')
  })

  test('a successful same-fingerprint asset refresh preserves ready without rerunning comfort setup', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    const seedCalls = h.seedCalls.length
    const gitCalls = [...h.clients.values()].reduce(
      (sum, client) => sum + client.bashCalls.filter((call) => call.command.startsWith('git config')).length,
      0
    )

    await mgr.ensureSandbox('squad_s1', squadOpts)
    expect(h.seedCalls).toHaveLength(seedCalls)
    expect(
      [...h.clients.values()].reduce(
        (sum, client) => sum + client.bashCalls.filter((call) => call.command.startsWith('git config')).length,
        0
      )
    ).toBe(gitCalls)
  })

  test('a non-due degraded generation refreshes assets without retrying comfort setup', async () => {
    const h = makeHarness()
    h.setSeedBoxDevbox(async () => {
      h.seedCalls.push({ sandboxId: 'squad_s1', role: 'squad' })
      throw new Error('seed unavailable')
    })
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    const before = await mgr.getSandboxStatus('squad_s1')
    await mgr.ensureSandbox('squad_s1', squadOpts)
    const after = await mgr.getSandboxStatus('squad_s1')

    expect(h.seedCalls).toHaveLength(1)
    expect(after).toMatchObject({
      status: 'running',
      readiness: 'ready_degraded',
      degradation: (before as any).degradation,
    })
  })

  test('reports a due degraded comfort repair as setup reconciliation', async () => {
    const h = makeHarness()
    let attempts = 0
    h.setSeedBoxDevbox(async () => {
      attempts++
      h.seedCalls.push({ sandboxId: 'squad_s1', role: 'squad' })
      if (attempts === 1) throw new Error('seed unavailable')
      return {}
    })
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    const degraded = await mgr.getSandboxStatus('squad_s1')
    h.setNow(new Date((degraded as any).degradation.nextAttemptAt).getTime())
    const progress: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(mgr, 'squad_s1', (event) => progress.push(event))

    await mgr.ensureSandbox('squad_s1', squadOpts)

    const setupStart = progress.find((event) => event.type === 'started' && event.reason === 'setup_reconcile')!
    expect(setupStart).toBeDefined()
    expect(progress.filter((event) => event.operationId === setupStart.operationId).at(-1)).toMatchObject({
      type: 'finished',
      outcome: 'ready',
    })
  })

  test('uses one attempt timestamp at the degraded repair boundary', async () => {
    const h = makeHarness()
    h.setSeedBoxDevbox(async () => {
      h.seedCalls.push({ sandboxId: 'squad_s1', role: 'squad' })
      throw new Error('seed unavailable')
    })
    const originalRestore = h.deps.restoreSetupAfterAssets!
    const originalSync = h.deps.syncBoxFiles!
    let armBoundary = false
    let nextAttemptAt = 0
    let boundaryPending = false
    let boundaryActive = false
    let boundaryReads = 0
    let restoreCalls = 0
    h.deps.now = () => {
      if (boundaryPending) {
        // The asset timer's closing read — still before the boundary.
        boundaryPending = false
        boundaryActive = true
        return 1000
      }
      if (!boundaryActive) return 1000
      return boundaryReads++ === 0 ? nextAttemptAt - 1 : nextAttemptAt
    }
    h.deps.restoreSetupAfterAssets = async (...args) => {
      restoreCalls++
      return originalRestore(...args)
    }
    // The boundary is "required assets synced, setup attempt about to start".
    // A box that already holds a (degraded) ready generation is not demoted and
    // restored around the sync, so arm on sync completion, not on restore.
    h.deps.syncBoxFiles = async (...args) => {
      await originalSync(...args)
      if (armBoundary) boundaryPending = true
    }
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    const degraded = await mgr.getSandboxStatus('squad_s1')
    nextAttemptAt = new Date((degraded as any).degradation.nextAttemptAt).getTime()
    armBoundary = true
    const progress: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(mgr, 'squad_s1', (event) => progress.push(event))

    await mgr.ensureSandbox('squad_s1', squadOpts)

    // Only the never-ready first ensure publishes pending + restores; the
    // degraded re-ensure keeps its generation through the sync.
    expect(restoreCalls).toBe(1)
    expect(h.seedCalls).toHaveLength(1)
    expect(progress.some((event) => event.type === 'started' && event.reason === 'setup_reconcile')).toBe(false)
  })

  test('a same-fingerprint required asset refresh failure revokes prior ready state', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    expect(await mgr.getSandboxStatus('squad_s1')).toMatchObject({ status: 'running', readiness: 'ready' })

    h.setSyncBoxFiles(async () => {
      throw new Error('refresh failed')
    })
    await expect(mgr.ensureSandbox('squad_s1', squadOpts)).rejects.toThrow('refresh failed')
    expect(await mgr.getSandboxStatus('squad_s1')).toMatchObject({
      status: 'starting',
      reason: 'required sandbox assets are not ready',
    })
  })

  test('a same-fingerprint required asset re-sync keeps a ready box running while it runs', async () => {
    // The keep-warm sweep re-ensures every live box each minute. A slow
    // re-sync must not demote an already-ready box to `starting` for its
    // duration — that was the Running/Starting status flap under host load.
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    expect(await mgr.getSandboxStatus('squad_s1')).toMatchObject({ status: 'running', readiness: 'ready' })

    let syncStarted!: () => void
    const started = new Promise<void>((resolve) => (syncStarted = resolve))
    let releaseSync!: () => void
    const gate = new Promise<void>((resolve) => (releaseSync = resolve))
    h.setSyncBoxFiles(async () => {
      syncStarted()
      await gate
    })

    const reEnsure = mgr.ensureSandbox('squad_s1', squadOpts)
    await started
    const duringSync = await mgr.getSandboxStatus('squad_s1')
    releaseSync()
    await reEnsure

    expect(duringSync).toMatchObject({ status: 'running', readiness: 'ready' })
    expect(await mgr.getSandboxStatus('squad_s1')).toMatchObject({ status: 'running', readiness: 'ready' })
  })

  test('devbox seeding runs AFTER file-sync, with the box role', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)

    await mgr.ensureSandbox('squad_s1', squadOpts)

    // Order: files synced, THEN the comfort set seeded (a broken sync would abort
    // the ensure before we ever seed).
    const syncIdx = h.log.indexOf('sync:squad_s1')
    const seedIdx = h.log.indexOf('seed:squad_s1')
    expect(syncIdx).toBeGreaterThanOrEqual(0)
    expect(seedIdx).toBeGreaterThan(syncIdx)
    // Seeded with the resolved box role.
    expect(h.seedCalls).toEqual([{ sandboxId: 'squad_s1', role: 'squad' }])
  })

  test('a devbox seeding failure is NON-fatal — the ensure still succeeds', async () => {
    const h = makeHarness()
    h.setSeedBoxDevbox(async () => {
      throw new Error('devbox install exploded')
    })
    const mgr = new VmSandboxManager(h.deps)

    // Contrast with syncBoxFiles (fatal): seeding failure must NOT reject the ensure.
    await expect(mgr.ensureSandbox('squad_s1', squadOpts)).resolves.toBe('squad_s1')
    expect(mgr.hasSandbox('squad_s1')).toBe(true)
  })

  test('POSTs /devbox-ready after a successful seed so the box caches its shellenv', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)

    await mgr.ensureSandbox('squad_s1', squadOpts)

    const client = [...h.clients.values()][0]
    expect(client.devboxReadyCalls).toBe(1)
  })

  test('does NOT POST /devbox-ready when seeding throws (nothing realized to cache)', async () => {
    const h = makeHarness()
    h.setSeedBoxDevbox(async () => {
      throw new Error('devbox install exploded')
    })
    const mgr = new VmSandboxManager(h.deps)

    await mgr.ensureSandbox('squad_s1', squadOpts)

    const client = [...h.clients.values()][0]
    expect(client.devboxReadyCalls).toBe(0)
  })

  test('a /devbox-ready POST failure is NON-fatal — the ensure still succeeds', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    // Make the client's devboxReady reject once the box is created.
    const origCreate = h.deps.createClient!
    h.deps.createClient = (endpoint: string) => {
      const c = origCreate(endpoint) as any
      c.devboxReadyError = new Error('box unreachable')
      return c
    }

    await expect(mgr.ensureSandbox('squad_s1', squadOpts)).resolves.toBe('squad_s1')
    expect(mgr.hasSandbox('squad_s1')).toBe(true)
    const client = [...h.clients.values()][0]
    expect(client.devboxReadyCalls).toBe(1)
  })

  test('writes the box interactive .tau/.bashrc at the box work root (box-user owned via /write)', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)

    await mgr.ensureSandbox('squad_s1', squadOpts)

    const client = [...h.clients.values()][0]
    const workRoot = `/home/${boxUnixUser('squad_s1')}/workspace`
    expect(client.writeCalls.map((w) => w.path)).toContain(`${workRoot}/.tau/.bashrc`)
  })

  describe('git credential helper (docker parity)', () => {
    const helperCalls = (client: FakeClient) =>
      client.bashCalls.filter((c) => c.command.includes('credential.https://github.com.helper'))

    test('never installs a process-token helper even when legacy identity material is returned', async () => {
      const h = makeHarness()
      const mgr = new VmSandboxManager(h.deps)
      await mgr.ensureSandbox('squad_s1', squadOpts)
      expect(helperCalls([...h.clients.values()][0])).toHaveLength(0)
      expect(h.ensureCalls[0].env.GITHUB_TOKEN).toBeUndefined()
    })

    test('applies nothing when the identity has no token', async () => {
      const h = makeHarness()
      h.setGithubToken('')
      const mgr = new VmSandboxManager(h.deps)

      await mgr.ensureSandbox('squad_s1', squadOpts)

      const client = [...h.clients.values()][0]
      expect(helperCalls(client)).toHaveLength(0)
    })

    test('provisioning does not depend on a legacy git-config command', async () => {
      const h = makeHarness({ bashScript: { stderr: 'git: not found', exitCode: 127 } })
      const mgr = new VmSandboxManager(h.deps)

      await expect(mgr.ensureSandbox('squad_s1', squadOpts)).resolves.toBe('squad_s1')
      expect(mgr.hasSandbox('squad_s1')).toBe(true)
      const client = [...h.clients.values()][0]
      expect(helperCalls(client)).toHaveLength(0)
    })
  })

  test('a "Box ready" summary-line formatting failure is NON-fatal — the ensure still succeeds', async () => {
    const h = makeHarness()
    // formatBoxReadyLine is pure measurement (see box-timing.ts's module doc):
    // an injected throw here must never fail an otherwise-fully-live box.
    const mgr = new VmSandboxManager({
      ...h.deps,
      formatBoxReadyLine: () => {
        throw new Error('formatter exploded')
      },
    })

    await expect(mgr.ensureSandbox('squad_s1', squadOpts)).resolves.toBe('squad_s1')
    expect(mgr.hasSandbox('squad_s1')).toBe(true)
  })

  test('exec runs the command via the client at the box work root and bumps lastActivityAt', async () => {
    const h = makeHarness({ bashScript: { stdout: 'hello', exitCode: 0 } })
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    expect(mgr.getLastActivityAt('squad_s1')).toBe(1000)
    // The ensure itself runs post-ensure setup over /bash (git credential
    // helper); only count the exec's own call.
    const client = [...h.clients.values()][0]
    const ensureBashCalls = client.bashCalls.length

    h.setNow(2000)
    const out = await mgr.exec('squad_s1', ['echo', 'hi'])
    expect(out.toString()).toBe('hello')

    const execCalls = client.bashCalls.slice(ensureBashCalls)
    expect(execCalls).toHaveLength(1)
    expect(execCalls[0].command).toBe("'echo' 'hi'")
    const expectedRoot = `/home/${boxUnixUser('squad_s1')}/workspace`
    expect(execCalls[0].cwd).toBe(expectedRoot)
    expect(mgr.getLastActivityAt('squad_s1')).toBe(2000)
  })

  test('exec and execStatus fail closed when the stream ends without a terminal exit code', async () => {
    const h = makeHarness({ bashScript: { stdout: 'partial' } })
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    await expect(mgr.exec('squad_s1', ['unknown'])).rejects.toThrow('ended without a terminal exit code')
    await expect(mgr.execStatus('squad_s1', ['unknown'])).rejects.toThrow('ended without a terminal exit code')
  })

  test('exec throws on non-zero exit code', async () => {
    const h = makeHarness({ bashScript: { stdout: 'boom', exitCode: 3 } })
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    await expect(mgr.exec('squad_s1', ['false'])).rejects.toThrow('exit code 3')
  })

  test('exec on an unknown sandbox throws', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    await expect(mgr.exec('squad_missing', ['ls'])).rejects.toThrow('not found')
  })

  test('execStatus returns the exit code without throwing', async () => {
    const h = makeHarness({ bashScript: { exitCode: 7 } })
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    expect(await mgr.execStatus('squad_s1', ['whatever'])).toBe(7)
  })

  test('spawnShell opens a shell and bumps lastActivityAt', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    h.setNow(3000)
    const pty = mgr.spawnShell('squad_s1', 80, 24)
    expect(pty).not.toBeNull()
    const client = [...h.clients.values()][0]
    expect(client.shellCalls).toBe(1)
    expect(mgr.getLastActivityAt('squad_s1')).toBe(3000)
  })

  test('spawnShell on an unknown sandbox returns null', () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    expect(mgr.spawnShell('nope', 80, 24)).toBeNull()
  })

  test('getSpawnHook returns null', () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    expect(mgr.getSpawnHook('squad_s1', '/x')).toBeNull()
  })

  test('streamLogs is NOT implemented, so the logs WS closes as unsupported instead of streaming silence', () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    // services/ws/logs.ts gates on `!manager.streamLogs`. A defined no-op used
    // to pass that gate and hand the user a permanently EMPTY stream; absence
    // makes the WS close with 'Log streaming is not supported for this runtime'.
    expect((mgr as { streamLogs?: unknown }).streamLogs).toBeUndefined()
  })

  test('getSandboxStatus maps box status to the k8s-shaped discriminant', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)

    h.setBoxStatus('ready')
    expect(await mgr.getSandboxStatus('squad_s1')).toEqual({
      status: 'running',
      readiness: 'ready',
      devboxReady: true,
      chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'up' },
    })

    // A mid-provision / transient box is a NON-terminal 'starting' — routes/agents.ts
    // keeps the session alive (it's in its running/starting/pending allow-list) and
    // outage.ts does not treat it as a crash. It must never collapse to 'failed'.
    h.setBoxStatus('starting')
    const starting = await mgr.getSandboxStatus('squad_s1')
    expect(starting.status).toBe('starting')
    expect(starting.reason).toBeDefined()
    expect(starting.chain).toEqual({ boxProvisioned: true, machine: 'unknown', boxServer: 'unknown' })

    // A terminal box failure (its machine gone/terminated) is 'failed' — outage.ts
    // treats this as a crash and registers a recovery watch.
    h.setBoxStatus('failed')
    const failed = await mgr.getSandboxStatus('squad_s1')
    expect(failed.status).toBe('failed')
    expect(failed.reason).toBeDefined()
    // The chain-health UI's "Machine unreachable" case.
    expect(failed.chain).toEqual({ boxProvisioned: true, machine: 'unreachable', boxServer: 'unknown' })

    h.setBoxStatus('stopped')
    const stopped = await mgr.getSandboxStatus('squad_s1')
    expect(stopped.status).toBe('not_found')
    // The chain-health UI's "Box server down — starts on next use" case.
    expect(stopped.chain).toEqual({ boxProvisioned: true, machine: 'unknown', boxServer: 'down' })

    h.setBoxStatus('absent')
    const absent = await mgr.getSandboxStatus('squad_s1')
    expect(absent.status).toBe('not_found')
    expect(absent.chain).toEqual({ boxProvisioned: false, machine: 'unknown', boxServer: 'unknown' })
  })

  test('getSandboxStatus never probes an idle box — the poll itself would wake it', async () => {
    // The UI polls this endpoint every few seconds while a squad/agent page is
    // open. Under socket activation `client.health()` is a TCP connect that
    // re-activates the server, so an open tab would make an idle box impossible.
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    const client = [...h.clients.values()][0]
    const before = client.healthCalls

    h.setBoxChain({ boxProvisioned: true, machine: 'reachable', boxServer: 'idle' })
    expect(await mgr.getSandboxStatus('squad_s1')).toEqual({
      status: 'running',
      readiness: 'ready',
      devboxReady: true,
      chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'idle' },
    })
    expect(client.healthCalls).toBe(before)
  })

  test('an idle box still reports the honest setup state (pending → starting, not running)', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    const client = [...h.clients.values()][0]
    const before = client.healthCalls

    h.setBoxChain({ boxProvisioned: true, machine: 'reachable', boxServer: 'idle' })
    h.setSetupState({
      sandboxId: 'squad_s1',
      desiredFingerprint: 'f',
      readiness: 'pending',
      reasons: [],
      attemptCount: 0,
      nextAttemptAt: null,
      pendingInvocationId: null,
      pendingInvocationKind: null,
      lastFailureClass: null,
      lastAttemptAt: null,
      updatedAt: new Date(),
    })
    const status = await mgr.getSandboxStatus('squad_s1')
    expect(status.status).toBe('starting')
    expect(client.healthCalls).toBe(before)
  })

  test('buildBoxEnv sets FICUS_SANDBOX_ROLE mirroring pod-spec (agent→agent, squad/system-manager→squad)', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)

    await mgr.ensureSandbox('agent_a1', agentOpts)
    expect(h.ensureCalls.at(-1)!.role).toBe('agent')
    expect(h.ensureCalls.at(-1)!.env.FICUS_SANDBOX_ROLE).toBe('agent')

    await mgr.ensureSandbox('squad_s1', squadOpts)
    expect(h.ensureCalls.at(-1)!.role).toBe('squad')
    expect(h.ensureCalls.at(-1)!.env.FICUS_SANDBOX_ROLE).toBe('squad')

    // system-manager boxes run the heavy squad-style runtime, so pod-spec maps them
    // to 'squad' (only 'agent' is the light role); mirror that exactly.
    const smOpts: SandboxOptions = { workspacePath: '/core/host/private', k8s: { sandboxType: 'system-manager' } }
    await mgr.ensureSandbox('system_manager_x', smOpts)
    expect(h.ensureCalls.at(-1)!.role).toBe('system-manager')
    expect(h.ensureCalls.at(-1)!.env.FICUS_SANDBOX_ROLE).toBe('squad')
  })

  test('stopSandbox parks the box, closes the client, and drops in-memory state', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    const client = [...h.clients.values()][0]

    await mgr.stopSandbox('squad_s1')

    expect(h.stopCalls).toEqual(['squad_s1'])
    expect(client.closed).toBe(1)
    expect(mgr.hasSandbox('squad_s1')).toBe(false)
  })

  test('reports an unverified low-level stop without retaining a stale client', async () => {
    const h = makeHarness()
    h.deps.stopBox = async (sandboxId) => {
      h.stopCalls.push(sandboxId)
      return { kind: 'unverified' }
    }
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    const client = [...h.clients.values()][0]

    expect(await mgr.stopSandbox('squad_s1')).toEqual({ kind: 'unverified' })
    expect(h.stopCalls).toEqual(['squad_s1'])
    expect(client.closed).toBe(1)
    expect(mgr.hasSandbox('squad_s1')).toBe(false)
  })

  test('removeSandbox archives private for agent boxes but not squad boxes', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)

    await mgr.ensureSandbox('agent_a1', agentOpts)
    await mgr.removeSandbox('agent_a1')
    expect(h.removeCalls).toContainEqual({ sandboxId: 'agent_a1', archivePrivate: true, timeoutMs: 5 * 60_000 })
    expect(mgr.hasSandbox('agent_a1')).toBe(false)

    await mgr.ensureSandbox('squad_s1', squadOpts)
    await mgr.removeSandbox('squad_s1')
    expect(h.removeCalls).toContainEqual({ sandboxId: 'squad_s1', archivePrivate: false, timeoutMs: 5 * 60_000 })
  })

  // Removal is dominated by a `tar czf` over the whole home, and the runner's
  // 30s default is not a budget for that. When this caller passed no timeout,
  // gzipping a 549MB home ran past 30s, the timeout was recorded as a failure,
  // the sweep retried every 60s, and each retry re-tarred the same live box —
  // 240 tarballs and 42GB onto one machine host until its disk was full.
  test('removal is given a real budget, not the runner default', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)

    await mgr.ensureSandbox('agent_a1', agentOpts)
    await mgr.removeSandbox('agent_a1')

    const call = h.removeCalls.find((c) => c.sandboxId === 'agent_a1')
    expect(call?.timeoutMs).toBeDefined()
    // Comfortably past what a large home takes to archive; matches the budget
    // provisioning already gets.
    expect(call!.timeoutMs!).toBeGreaterThanOrEqual(5 * 60_000)
  })

  test('full lifecycle ordering: ensure -> exec -> status -> stop -> remove', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    await mgr.exec('squad_s1', ['ls'])
    await mgr.getSandboxStatus('squad_s1')
    await mgr.stopSandbox('squad_s1')
    // Re-ensure to remove (removeSandbox works whether tracked or not).
    await mgr.ensureSandbox('squad_s1', squadOpts)
    await mgr.removeSandbox('squad_s1')

    expect(h.log.filter((l) => l.startsWith('ensureBox'))).toHaveLength(2)
    expect(h.stopCalls).toEqual(['squad_s1'])
    expect(h.removeCalls.map((r) => r.sandboxId)).toEqual(['squad_s1'])
  })

  test('a keep-warm re-ensure over an unchanged healthy box reuses the live client', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('agent_a1', agentOpts)
    const first = mgr.getClient('agent_a1') as unknown as FakeClient
    const createdBefore = h.createdEndpoints.length

    // Exactly what warmupWorkStreamAgentSandboxes drives roughly once a minute for
    // every agent in an active work stream.
    await mgr.ensureSandbox('agent_a1', agentOpts)

    expect(h.createdEndpoints.length).toBe(createdBefore)
    expect(mgr.getClient('agent_a1')).toBe(first as never)
    // close() aborts EVERY in-flight request on the client, and an aborted /bash
    // stream ends with no terminal exitCode — which reaches the agent as
    // "Bash invocation outcome is unknown; cleanup proof is required". Closing a
    // still-current client here killed live agent commands at a ~60s drumbeat.
    expect(first.closed).toBe(0)
  })

  test('a re-ensure onto a relocated box still replaces and closes the old client', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('agent_a1', agentOpts)
    const first = mgr.getClient('agent_a1') as unknown as FakeClient
    const createdBefore = h.createdEndpoints.length

    h.rotateBoxEndpoint('agent_a1')
    await mgr.ensureSandbox('agent_a1', agentOpts)

    expect(h.createdEndpoints.length).toBe(createdBefore + 1)
    expect(mgr.getClient('agent_a1')).not.toBe(first as never)
    // The old client addresses a forward that no longer exists, so it MUST close.
    expect(first.closed).toBe(1)
  })

  test('recreate never re-ensures over an unverified physical stop', async () => {
    const h = makeHarness()
    let unverified = false
    const stopBox = h.deps.stopBox!
    h.deps.stopBox = async (sandboxId) => (unverified ? { kind: 'unverified' } : stopBox(sandboxId))
    const manager = new VmSandboxManager(h.deps)
    await manager.ensureSandbox('squad_s1', squadOpts)
    h.log.length = 0
    unverified = true

    await expect(manager.recreateSandbox('squad_s1', squadOpts)).rejects.toThrow('until its stop is verified')
    expect(h.log).not.toContain('ensureBox:squad_s1')
  })

  test('spec drift detection and recreate = stop + re-ensure', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)

    // No drift right after ensure.
    expect(mgr.isSandboxSpecDrifted('squad_s1', squadOpts)).toBe(false)
    expect(await mgr.getRunningSandboxSpecHash('squad_s1')).toBe(mgr.computeSpecHash(squadOpts))

    // Change a spec input the box baked (provision script version) -> drift.
    h.setProvisionVersion('prov-2')
    expect(mgr.isSandboxSpecDrifted('squad_s1', squadOpts)).toBe(true)

    // Recreate parks then re-ensures (state persists on disk).
    const progress: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(mgr, 'squad_s1', (event) => progress.push(event))
    h.log.length = 0
    await mgr.recreateSandbox('squad_s1', squadOpts)
    expect(h.log[0]).toBe('stopBox:squad_s1')
    expect(h.log).toContain('ensureBox:squad_s1')
    const reconcileStart = progress.find((event) => event.type === 'started' && event.reason === 'spec_reconcile')!
    expect(progress.filter((event) => event.operationId === reconcileStart.operationId)).toEqual([
      reconcileStart,
      expect.objectContaining({ type: 'finished', outcome: 'ready' }),
    ])
    // After recreate the baked hash reflects the new provision version -> no drift.
    expect(mgr.isSandboxSpecDrifted('squad_s1', squadOpts)).toBe(false)
  })

  test('getRunningSandboxSpecHash reads the durable box spec after a Core restart', async () => {
    const h = makeHarness()
    h.setMachineBoxRow({
      machineId: 'machine-squad_s1',
      port: 40_001,
      status: 'ready',
      reconcilableSpecHash: 'old-bundle-spec',
    })
    const mgr = new VmSandboxManager(h.deps)
    expect(await mgr.getRunningSandboxSpecHash('squad_s1')).toBe('old-bundle-spec')
    h.setMachineBoxRow(null)
    expect(await mgr.getRunningSandboxSpecHash('squad_unknown')).toBeNull()
  })

  test("cleanup releases only this process's forwards for touched machines — never machine teardown — and closes clients", async () => {
    const h = makeHarness({ machineForSandbox: (id) => (id === 'squad_s1' ? 'm1' : 'm2') })
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    await mgr.ensureSandbox('agent_a1', agentOpts)
    const clients = [...h.clients.values()]

    await mgr.cleanup()

    // Routine shutdown cancels this process's own forwards per touched machine.
    // It must NOT `-O exit` the shared ControlMaster (that would sever the other
    // core process's forwards and every box's baked reverse-tunnel callback) —
    // guaranteed structurally: the deps surface exposes no machine-close hook,
    // only the forward release recorded here.
    expect(h.releasedMachines.sort()).toEqual(['m1', 'm2'])
    for (const c of clients) expect(c.closed).toBe(1)
    expect(mgr.hasSandbox('squad_s1')).toBe(false)
    expect(mgr.hasSandbox('agent_a1')).toBe(false)
  })

  test('toContainerPath rebases host paths onto the box work root, else returns as-is', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    const root = `/home/${boxUnixUser('squad_s1')}/workspace`
    expect(mgr.toContainerPath('squad_s1', '/core/host/ws/src/a.ts')).toBe(`${root}/src/a.ts`)
    expect(mgr.toContainerPath('squad_s1', '/etc/passwd')).toBe('/etc/passwd')
  })

  test('getWorkspaceLayout returns the box-native work root for a squad', () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    const expected = `/home/${boxUnixUser('squad_s1')}/workspace`
    expect(mgr.getWorkspaceLayout({ squadId: 's1' }).workspaceMount).toBe(expected)
    expect(mgr.getWorkspaceLayout({ squadId: 's1' }).cwd).toBe(expected)
  })

  test('getWorkspaceLayout(sandboxId) resolves a solo agent box to its own ~/.private (the old squadId-only wart)', () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    const home = `/home/${boxUnixUser('agent_a1')}`
    const layout = mgr.getWorkspaceLayout({ sandboxId: 'agent_a1' })
    expect(layout.workspaceMount).toBe(`${home}/.private`)
    expect(layout.privateMount).toBe(`${home}/.private`)
    expect(layout.cwd).toBe(`${home}/.private`)
    expect(layout.memoryMount).toBe(`${home}/memory`)
  })

  test('getLifecycleState seeds idle-policy from opts.k8s (idleTimeout in ms + alwaysOn)', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    const opts: SandboxOptions = {
      workspacePath: '/core/host/ws',
      squadId: 's1',
      k8s: { sandboxType: 'squad', idleTimeout: 1800000, alwaysOn: true },
    }
    await mgr.ensureSandbox('squad_s1', opts)

    expect(mgr.getLifecycleState('squad_s1')).toEqual({
      lastActivityAt: 1000,
      idleTimeoutMs: 1800000,
      alwaysOn: true,
      status: 'ready',
    })
  })

  test('getLifecycleState defaults idleTimeoutMs to DEFAULT_IDLE_TIMEOUT_MS and alwaysOn to true (vm always-on policy) when absent', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    // squadOpts carries no idleTimeout / alwaysOn.
    await mgr.ensureSandbox('squad_s1', squadOpts)

    const state = mgr.getLifecycleState('squad_s1')
    expect(state?.idleTimeoutMs).toBe(15 * 60 * 1000) // DEFAULT_IDLE_TIMEOUT_MS
    expect(state?.alwaysOn).toBe(true)
    expect(state?.status).toBe('ready')
  })

  test('getLifecycleState returns undefined for an untracked sandbox', () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    expect(mgr.getLifecycleState('squad_unknown')).toBeUndefined()
  })

  test('re-ensure refreshes idleTimeout; alwaysOn stays true under the vm default policy regardless of the caller opts', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', {
      workspacePath: '/core/host/ws',
      squadId: 's1',
      k8s: { sandboxType: 'squad', idleTimeout: 1800000, alwaysOn: true },
    })
    expect(mgr.getLifecycleState('squad_s1')?.alwaysOn).toBe(true)

    // The caller explicitly requests alwaysOn:false, but the vm-runtime default
    // policy (parking disabled) still wins — a single global switch, not a
    // per-box opt-out. idleTimeout still refreshes on re-ensure.
    await mgr.ensureSandbox('squad_s1', {
      workspacePath: '/core/host/ws',
      squadId: 's1',
      k8s: { sandboxType: 'squad', idleTimeout: 60000, alwaysOn: false },
    })
    expect(mgr.getLifecycleState('squad_s1')).toEqual({
      lastActivityAt: 1000,
      idleTimeoutMs: 60000,
      alwaysOn: true,
      status: 'ready',
    })
  })

  // -------------------------------------------------------------------------
  // computeProvisioningMarker — the resume fast-path marker must bust on a
  // rotated secret, not just a bundle/role/provision-script change (review
  // finding #1: the resume fast path skips the server.env push, so a stale
  // GITHUB_TOKEN/callback secret/API URL must force the full path).
  // -------------------------------------------------------------------------

  test('setup fingerprint changes for every setup-relevant input', () => {
    const base = { specHash: 'spec', devboxSeedHash: 'devbox', bashrcContent: 'bashrc', gitCredentialsRequired: false }
    const fingerprint = computeVmSetupFingerprint(base)
    expect(computeVmSetupFingerprint(base)).toBe(fingerprint)
    expect(computeVmSetupFingerprint({ ...base, specHash: 'other' })).not.toBe(fingerprint)
    expect(computeVmSetupFingerprint({ ...base, devboxSeedHash: 'other' })).not.toBe(fingerprint)
    expect(computeVmSetupFingerprint({ ...base, bashrcContent: 'other' })).not.toBe(fingerprint)
    expect(computeVmSetupFingerprint({ ...base, gitCredentialsRequired: true })).not.toBe(fingerprint)
  })

  describe('computeProvisioningMarker', () => {
    const baseEnv: BoxEnv = {
      FICUS_SANDBOX_ID: 'squad_s1',
      GITHUB_TOKEN: 'ghtok',
      GH_TOKEN: 'ghtok',
      SANDBOX_CALLBACK_SECRET: 'cbsecret',
      FICUS_API_URL: 'http://127.0.0.1:59999',
    }

    test('identical specHash + env produce the identical marker', () => {
      expect(computeProvisioningMarker('spec-1', { ...baseEnv })).toBe(
        computeProvisioningMarker('spec-1', { ...baseEnv })
      )
    })

    test('a rotated secret (GITHUB_TOKEN) changes the marker even though specHash is unchanged', () => {
      const before = computeProvisioningMarker('spec-1', baseEnv)
      const after = computeProvisioningMarker('spec-1', { ...baseEnv, GITHUB_TOKEN: 'rotated-token' })
      expect(before).not.toBe(after)
    })

    test('a changed callback secret or API URL also changes the marker', () => {
      const base = computeProvisioningMarker('spec-1', baseEnv)
      expect(computeProvisioningMarker('spec-1', { ...baseEnv, SANDBOX_CALLBACK_SECRET: 'new-secret' })).not.toBe(base)
      expect(computeProvisioningMarker('spec-1', { ...baseEnv, FICUS_API_URL: 'http://127.0.0.1:1' })).not.toBe(base)
    })

    test('a changed specHash changes the marker even with an identical env', () => {
      expect(computeProvisioningMarker('spec-1', baseEnv)).not.toBe(computeProvisioningMarker('spec-2', baseEnv))
    })

    test('key insertion order does not affect the marker (canonicalized)', () => {
      const reordered: BoxEnv = {
        FICUS_API_URL: baseEnv.FICUS_API_URL,
        SANDBOX_CALLBACK_SECRET: baseEnv.SANDBOX_CALLBACK_SECRET,
        GH_TOKEN: baseEnv.GH_TOKEN,
        GITHUB_TOKEN: baseEnv.GITHUB_TOKEN,
        FICUS_SANDBOX_ID: baseEnv.FICUS_SANDBOX_ID,
      }
      expect(computeProvisioningMarker('spec-1', baseEnv)).toBe(computeProvisioningMarker('spec-1', reordered))
    })
  })

  test('credential rotation does not restart a box or change its provisioning marker', async () => {
    const h = makeHarness()
    const mgr = new VmSandboxManager(h.deps)
    await mgr.ensureSandbox('squad_s1', squadOpts)
    const before = h.ensureCalls[0].specHash
    h.setGithubToken('rotated-token')
    await mgr.ensureSandbox('squad_s1', squadOpts)
    expect(h.ensureCalls[1].specHash).toBe(before)
    expect(h.ensureCalls[1].env.GITHUB_TOKEN).toBeUndefined()
  })

  describe('caller-independent provisioning marker', () => {
    // The provisioning marker must be a function of the BOX, not of whichever
    // caller happens to run ensure. A caller passing partial options (no
    // squadId, no sandboxType) used to compute a different spec hash than the
    // canonical ensure for the same box, so box-manager's healthy fast path
    // missed and it full-re-provisioned — env push + systemd unit RESTART —
    // then the next keep-warm tick (real options) saw the marker drifted BACK
    // and restarted the unit again, killing whatever ran on the box at a ~60s
    // drumbeat (terminal shells died with "[Process exited with code 0]").

    test('a partial-opts re-ensure of a squad box produces the SAME marker and role as the real ensure', async () => {
      const h = makeHarness()
      const mgr = new VmSandboxManager(h.deps)

      await mgr.ensureSandbox('squad_s1', squadOpts)
      await mgr.ensureSandbox('squad_s1', { workspacePath: '/core/host/ws', hostAccess: true })

      expect(h.ensureCalls).toHaveLength(2)
      expect(h.ensureCalls[1].specHash).toBe(h.ensureCalls[0].specHash)
      expect(h.ensureCalls[1].role).toBe('squad')
      expect(h.ensureCalls[1].env.FICUS_BOX_SPEC_HASH).toBe(h.ensureCalls[0].env.FICUS_BOX_SPEC_HASH)
      // The whole env must match too — the marker folds an env hash in, so a
      // caller-dependent env would still restart the unit.
      expect(h.ensureCalls[1].env).toEqual(h.ensureCalls[0].env)
    })

    test('a system_manager box keeps its prefix role and marker even when a caller passes sandboxType agent', async () => {
      // ensureWorkspaceSandbox (the per-turn runner path) hardcodes
      // sandboxType: 'agent' for every non-squad box, while the vm lifecycle
      // recovery ensures the same system_manager_<userId> box with
      // sandboxType: 'system-manager' — the box must not flip identity (and
      // marker, and FICUS_SANDBOX_ROLE) depending on who ensured it last.
      const h = makeHarness()
      const mgr = new VmSandboxManager(h.deps)

      await mgr.ensureSandbox('system_manager_u1', {
        workspacePath: '/core/host/private',
        k8s: { sandboxType: 'system-manager', alwaysOn: true },
      })
      await mgr.ensureSandbox('system_manager_u1', {
        workspacePath: '/core/host/private',
        k8s: { sandboxType: 'agent' },
      })

      expect(h.ensureCalls).toHaveLength(2)
      expect(h.ensureCalls[0].role).toBe('system-manager')
      expect(h.ensureCalls[1].role).toBe('system-manager')
      expect(h.ensureCalls[1].specHash).toBe(h.ensureCalls[0].specHash)
      expect(h.ensureCalls[1].env).toEqual(h.ensureCalls[0].env)
    })

    test('an agent box re-ensured without sandboxType keeps its prefix role and marker', async () => {
      const h = makeHarness()
      const mgr = new VmSandboxManager(h.deps)

      await mgr.ensureSandbox('agent_a1', agentOpts)
      await mgr.ensureSandbox('agent_a1', { workspacePath: '/core/host/private' })

      expect(h.ensureCalls[0].role).toBe('agent')
      expect(h.ensureCalls[1].role).toBe('agent')
      expect(h.ensureCalls[1].specHash).toBe(h.ensureCalls[0].specHash)
    })
  })

  describe('vm boxes always-on by default (park-on-idle policy)', () => {
    const ORIGINAL_ENV = process.env.FICUS_VM_BOX_PARK_ON_IDLE

    afterEach(() => {
      if (ORIGINAL_ENV === undefined) delete process.env.FICUS_VM_BOX_PARK_ON_IDLE
      else process.env.FICUS_VM_BOX_PARK_ON_IDLE = ORIGINAL_ENV
    })

    test('agent boxes default to alwaysOn:true too — the policy is role-agnostic (ensure.ts hardcodes alwaysOn:false for agents)', async () => {
      const h = makeHarness()
      const mgr = new VmSandboxManager(h.deps)
      await mgr.ensureSandbox('agent_a1', {
        workspacePath: '/core/host/ws',
        k8s: { sandboxType: 'agent', idleTimeout: 1800000, alwaysOn: false },
      })
      expect(mgr.getLifecycleState('agent_a1')?.alwaysOn).toBe(true)
    })

    test('FICUS_VM_BOX_PARK_ON_IDLE=true re-enables parking: the caller opts value is honored again', async () => {
      process.env.FICUS_VM_BOX_PARK_ON_IDLE = 'true'
      const h = makeHarness()
      const mgr = new VmSandboxManager(h.deps)
      await mgr.ensureSandbox('squad_s1', {
        workspacePath: '/core/host/ws',
        squadId: 's1',
        k8s: { sandboxType: 'squad', idleTimeout: 1800000, alwaysOn: false },
      })
      expect(mgr.getLifecycleState('squad_s1')?.alwaysOn).toBe(false)
    })

    test('FICUS_VM_BOX_PARK_ON_IDLE=true still lets an explicit alwaysOn:true opt-in through', async () => {
      process.env.FICUS_VM_BOX_PARK_ON_IDLE = 'true'
      const h = makeHarness()
      const mgr = new VmSandboxManager(h.deps)
      await mgr.ensureSandbox('squad_s1', {
        workspacePath: '/core/host/ws',
        squadId: 's1',
        k8s: { sandboxType: 'squad', idleTimeout: 1800000, alwaysOn: true },
      })
      expect(mgr.getLifecycleState('squad_s1')?.alwaysOn).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // getOrAttachClient — cross-process attach-on-miss
  // -------------------------------------------------------------------------

  describe('getOrAttachClient', () => {
    test('returns the tracked client for a box this process ensured, without touching the DB or tunnels', async () => {
      const h = makeHarness()
      const mgr = new VmSandboxManager(h.deps)
      await mgr.ensureSandbox('squad_s1', squadOpts)

      const client = await mgr.getOrAttachClient('squad_s1')

      expect(client).toBe(mgr.getClient('squad_s1')!)
      expect(h.ensureMasterCalls).toEqual([])
      expect(h.addForwardCalls).toEqual([])
    })

    test('attaches on a map miss: reads the ready row, tunnels in, and returns a client at the forwarded port', async () => {
      const h = makeHarness()
      const mgr = new VmSandboxManager(h.deps)
      // A box the WORKER ensured: ready row in the DB, nothing in THIS process.
      h.setMachineBoxRow({ machineId: 'm1', port: 50123, status: 'ready' })

      const client = await mgr.getOrAttachClient('agent_worker_box')

      expect(client).not.toBeNull()
      expect(h.ensureMasterCalls).toEqual(['m1'])
      expect(h.addForwardCalls).toEqual([{ machineId: 'm1', remotePort: 50123 }])
      // Client built at the local forwarded endpoint (bare host:port, no
      // scheme), presenting the ROW's executor auth token (the cross-process
      // source of truth for a box another process ensured).
      expect(h.createdEndpoints).toEqual(['127.0.0.1:61001'])
      expect(h.createdClientTokens).toEqual(['row-tok-agent_worker_box'])
      // The box is attached, not fully tracked (this process never built it).
      expect(mgr.hasSandbox('agent_worker_box')).toBe(false)

      // A successful attach persists a one-shot activity heartbeat: attached
      // reads never go through touch(), so a long rescan/ssh-push on a box near
      // its idle threshold would otherwise be parked mid-operation.
      expect(h.persistCalls).toEqual([{ sandboxId: 'agent_worker_box', atMs: 1000 }])

      // A second call reuses the attached client — no second forward.
      const again = await mgr.getOrAttachClient('agent_worker_box')
      expect(again).toBe(client!)
      expect(h.addForwardCalls).toHaveLength(1)
    })

    test('returns null when there is no row, the row is not ready, or the machine is not ready', async () => {
      const h = makeHarness()
      const mgr = new VmSandboxManager(h.deps)

      // No machine_boxes row at all.
      expect(await mgr.getOrAttachClient('agent_absent')).toBeNull()

      // A parked (stopped) row must not be attached to.
      h.setMachineBoxRow({ machineId: 'm1', port: 50123, status: 'stopped' })
      expect(await mgr.getOrAttachClient('agent_parked')).toBeNull()

      // A ready row on a machine that is no longer ready.
      h.setMachineBoxRow({ machineId: 'm1', port: 50123, status: 'ready' })
      h.setMachineStatus('unreachable')
      expect(await mgr.getOrAttachClient('agent_dead_machine')).toBeNull()

      expect(h.addForwardCalls).toEqual([])
    })

    test('concurrent misses share one attach (single forward)', async () => {
      const h = makeHarness()
      const mgr = new VmSandboxManager(h.deps)
      h.setMachineBoxRow({ machineId: 'm1', port: 50123, status: 'ready' })

      const [a, b] = await Promise.all([
        mgr.getOrAttachClient('agent_worker_box'),
        mgr.getOrAttachClient('agent_worker_box'),
      ])

      expect(a).not.toBeNull()
      expect(b).toBe(a!)
      expect(h.addForwardCalls).toHaveLength(1)
    })

    test('a full ensure supersedes the attached client (closes it); stop/cleanup drop it too', async () => {
      const h = makeHarness()
      const mgr = new VmSandboxManager(h.deps)
      h.setMachineBoxRow({ machineId: 'm1', port: 50123, status: 'ready' })

      await mgr.getOrAttachClient('squad_s1')
      const attached = h.clients.get('127.0.0.1:61001')!

      await mgr.ensureSandbox('squad_s1', squadOpts)
      expect(attached.closed).toBe(1)
      // The tracked (ensured) client now serves reads.
      expect(await mgr.getOrAttachClient('squad_s1')).toBe(mgr.getClient('squad_s1')!)

      // stopSandbox also drops a lingering attached client.
      await mgr.getOrAttachClient('agent_other')
      const otherAttached = h.clients.get('127.0.0.1:61002')!
      await mgr.stopSandbox('agent_other')
      expect(otherAttached.closed).toBe(1)

      // cleanup closes any remaining attached clients.
      await mgr.getOrAttachClient('agent_third')
      const thirdAttached = h.clients.get('127.0.0.1:61003')!
      await mgr.cleanup()
      expect(thirdAttached.closed).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Cross-process invalidation via box.status events
  // -------------------------------------------------------------------------

  describe('box.status invalidation', () => {
    test("box.status gone drops the tracked client AND this process's forward for that box", async () => {
      const h = makeHarness()
      const mgr = new VmSandboxManager(h.deps)
      await mgr.ensureSandbox('squad_evt_gone', squadOpts)
      const client = [...h.clients.values()][0]

      // A teardown served by the OTHER core process announces itself over the
      // distributed emitter; this process must drop its stale client + forward
      // (a reused MAX(port)+1 port would otherwise route to a DIFFERENT box).
      eventEmitter.emit('box.status', { sandboxId: 'squad_evt_gone', machineId: 'm1', status: 'gone', port: 50777 })

      expect(client.closed).toBe(1)
      expect(mgr.hasSandbox('squad_evt_gone')).toBe(false)
      expect(h.removeForwardCalls).toContainEqual({ machineId: 'm1', remotePort: 50777 })
      await mgr.cleanup()
    })

    test('box.status stopped drops an ATTACHED client too, and ready events are ignored', async () => {
      const h = makeHarness()
      const mgr = new VmSandboxManager(h.deps)
      h.setMachineBoxRow({ machineId: 'm1', port: 50123, status: 'ready' })
      await mgr.getOrAttachClient('agent_evt_attached')
      const attached = h.clients.get('127.0.0.1:61001')!

      // 'ready' must not tear anything down.
      eventEmitter.emit('box.status', {
        sandboxId: 'agent_evt_attached',
        machineId: 'm1',
        status: 'ready',
        port: 50123,
      })
      expect(attached.closed).toBe(0)

      eventEmitter.emit('box.status', {
        sandboxId: 'agent_evt_attached',
        machineId: 'm1',
        status: 'stopped',
        port: 50123,
      })

      expect(attached.closed).toBe(1)
      expect(h.removeForwardCalls).toContainEqual({ machineId: 'm1', remotePort: 50123 })
      // A later read re-attaches fresh rather than reusing the dropped client.
      const reattached = await mgr.getOrAttachClient('agent_evt_attached')
      expect(reattached).not.toBe(attached as any)
      await mgr.cleanup()
    })

    test('box.status stopped racing an in-flight attach: the client is NOT cached and its forward is released', async () => {
      const h = makeHarness()
      h.setMachineBoxRow({ machineId: 'm1', port: 50123, status: 'ready' })
      // Park the attach on a deferred addForward so the teardown event lands
      // mid-attach — the window where onBoxStatus finds nothing cached to
      // invalidate and only the tombstone can stop the attach from resurrecting
      // a client for the dead box (whose reallocated MAX(port)+1 port could
      // silently route into a DIFFERENT box).
      let releaseForward!: () => void
      const gate = new Promise<void>((resolve) => {
        releaseForward = resolve
      })
      const recordedAddForward = h.deps.addForward!
      h.deps.addForward = async (machine: any, remotePort: number) => {
        await gate
        return recordedAddForward(machine, remotePort)
      }
      const mgr = new VmSandboxManager(h.deps)

      const attachP = mgr.getOrAttachClient('agent_evt_race')
      eventEmitter.emit('box.status', { sandboxId: 'agent_evt_race', machineId: 'm1', status: 'stopped', port: 50123 })
      releaseForward()

      // The attach aborts: no client, no cached entry, no activity heartbeat.
      expect(await attachP).toBeNull()
      expect(h.persistCalls).toEqual([])
      // The forward it added mid-flight was released again — nothing strands.
      expect(h.addForwardCalls).toEqual([{ machineId: 'm1', remotePort: 50123 }])
      expect(h.removeForwardCalls).toContainEqual({ machineId: 'm1', remotePort: 50123 })

      // Nothing was cached AND the tombstone was cleared on settle: a later
      // read (the row reads ready again in this fake) attaches FRESH.
      const later = await mgr.getOrAttachClient('agent_evt_race')
      expect(later).not.toBeNull()
      expect(h.addForwardCalls).toHaveLength(2)
      await mgr.cleanup()
    })

    test('cleanup unsubscribes: post-shutdown events no longer drive removeForward', async () => {
      const h = makeHarness()
      const mgr = new VmSandboxManager(h.deps)
      await mgr.ensureSandbox('squad_evt_unsub', squadOpts)
      await mgr.cleanup()
      h.removeForwardCalls.length = 0

      eventEmitter.emit('box.status', { sandboxId: 'squad_evt_unsub', machineId: 'm1', status: 'gone', port: 50778 })

      expect(h.removeForwardCalls).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // Shutdown drain: cleanup must observe parked attaches/ensures before sweeping
  // -------------------------------------------------------------------------

  describe('cleanup drain', () => {
    test('cleanup drains an in-flight attach first, so its client is closed and its machine released, not stranded', async () => {
      const h = makeHarness()
      h.setMachineBoxRow({ machineId: 'm1', port: 50123, status: 'ready' })
      // Park the attach on a deferred addForward so cleanup starts while the
      // forward is still being established — the window where a sweep that
      // ignored attachInflight would run BEFORE the attach registers its
      // forward/adds m1 to touchedMachines, permanently stranding the listener
      // in the shared (process-surviving) master.
      let releaseForward!: () => void
      const gate = new Promise<void>((resolve) => {
        releaseForward = resolve
      })
      const recordedAddForward = h.deps.addForward!
      h.deps.addForward = async (machine: any, remotePort: number) => {
        await gate
        return recordedAddForward(machine, remotePort)
      }
      const mgr = new VmSandboxManager(h.deps)

      const attachP = mgr.getOrAttachClient('agent_cleanup_race')
      const cleanupP = mgr.cleanup()
      releaseForward()
      const [client] = await Promise.all([attachP, cleanupP])

      // The drain let the attach finish BEFORE the sweep: the just-cached
      // client was closed and the machine's forwards were released.
      expect(client).not.toBeNull()
      expect(h.addForwardCalls).toEqual([{ machineId: 'm1', remotePort: 50123 }])
      expect((client as unknown as FakeClient).closed).toBe(1)
      expect(h.releasedMachines).toContain('m1')
    })

    test('cleanup drains an in-flight ensure first, so its client is closed and its machine released, not stranded', async () => {
      const h = makeHarness()
      // Park the ensure inside ensureBox — cleanup starts before the manager
      // has tracked the box or touched its machine.
      let releaseEnsure!: () => void
      const gate = new Promise<void>((resolve) => {
        releaseEnsure = resolve
      })
      const recordedEnsureBox = h.deps.ensureBox!
      h.deps.ensureBox = async (o: EnsureBoxOpts) => {
        await gate
        return recordedEnsureBox(o)
      }
      const mgr = new VmSandboxManager(h.deps)

      const ensureP = mgr.ensureSandbox('squad_s1', squadOpts)
      const cleanupP = mgr.cleanup()
      releaseEnsure()
      await Promise.all([ensureP, cleanupP])

      // The drain let the ensure finish BEFORE the sweep: its tracked client
      // was closed and its machine's forwards were released.
      const client = [...h.clients.values()][0]
      expect(client.closed).toBe(1)
      expect(h.releasedMachines).toContain('m1')
    })
  })

  // -------------------------------------------------------------------------
  // Cross-process activity heartbeat persistence
  // -------------------------------------------------------------------------

  describe('activity heartbeat persistence', () => {
    test('touch persists the row heartbeat at most once per throttle interval', async () => {
      const h = makeHarness({ bashScript: { stdout: 'ok', exitCode: 0 } })
      const mgr = new VmSandboxManager(h.deps)
      await mgr.ensureSandbox('squad_s1', squadOpts) // ensure at t=1000 seeds the row heartbeat itself
      expect(h.persistCalls).toEqual([{ sandboxId: 'squad_s1', atMs: 1000 }])

      // First exec 31s after ensure → past the 30s throttle → persists.
      h.setNow(32_000)
      await mgr.exec('squad_s1', ['ls'])
      expect(h.persistCalls).toHaveLength(2)
      expect(h.persistCalls[1]).toEqual({ sandboxId: 'squad_s1', atMs: 32_000 })

      // A burst of activity within the throttle window persists nothing more...
      h.setNow(40_000)
      await mgr.exec('squad_s1', ['ls'])
      h.setNow(50_000)
      mgr.spawnShell('squad_s1', 80, 24)
      expect(h.persistCalls).toHaveLength(2)
      // ...but the in-memory activity still advanced (keepalive reads it live).
      expect(mgr.getLastActivityAt('squad_s1')).toBe(50_000)

      // Past the interval again → another persisted heartbeat.
      h.setNow(63_000)
      await mgr.exec('squad_s1', ['ls'])
      expect(h.persistCalls).toHaveLength(3)
      expect(h.persistCalls[2]).toEqual({ sandboxId: 'squad_s1', atMs: 63_000 })
      await mgr.cleanup()
    })

    test('ensure refreshes the row heartbeat unconditionally — a re-ensure over an already-healthy (fast-pathed) box included', async () => {
      const h = makeHarness()
      const mgr = new VmSandboxManager(h.deps)
      await mgr.ensureSandbox('squad_s1', squadOpts)
      expect(h.persistCalls).toEqual([{ sandboxId: 'squad_s1', atMs: 1000 }])

      // A much later re-ensure may take box-manager's healthy fast-path, which
      // returns BEFORE the ready upsert that seeds the heartbeat — so the row
      // heartbeat would be stale and the OTHER process's idle reaper
      // (max(local, row), both stale) could park a box under a live session.
      // The manager must therefore persist once per ensure, unconditionally.
      h.setNow(600_000)
      await mgr.ensureSandbox('squad_s1', squadOpts)
      expect(h.persistCalls).toHaveLength(2)
      expect(h.persistCalls[1]).toEqual({ sandboxId: 'squad_s1', atMs: 600_000 })
      await mgr.cleanup()
    })
  })

  describe('resolveToolApiUrl', () => {
    test('a tracked box gets exactly its baked callback URL', async () => {
      const h = makeHarness()
      const mgr = new VmSandboxManager(h.deps)
      await mgr.ensureSandbox('squad_s1', squadOpts)

      expect(mgr.resolveToolApiUrl('squad_s1')).toBe('http://127.0.0.1:59999')
      await mgr.cleanup()
    })

    test('an untracked sandbox yields "" — APP_URL must NEVER leak into an exec env', async () => {
      // APP_URL may be a gated/unreachable public URL (the exact footgun the
      // reverse-tunnel-default change removed from the bake path). Tools only
      // reach resolveToolApiUrl for tracked boxes (via getClientForSandbox), so
      // the untracked answer is a benign '' — not a possibly-poisonous APP_URL.
      const h = makeHarness()
      h.setAppUrl('https://gated.example.com')
      const mgr = new VmSandboxManager(h.deps)

      expect(mgr.resolveToolApiUrl('squad_unknown')).toBe('')
      await mgr.cleanup()
    })
  })
})

// ---------------------------------------------------------------------------
// The box-provision spec-hash ingredient (#1155 x #1163, fourth derivation).
//
// `provisionVersion` is one of computeSpecHash's four inputs, so a box is
// recreated when the provisioning script changes. It used to be read off disk
// via a path relative to `import.meta.dir` with a `'noscript'` catch-all — a
// path that resolves ONLY in a src-layout run. Every production core runs the
// bundle (`bun run dist/index.js`), where `import.meta.dir` is `apps/core/dist`
// and the traversal lands outside the repo: the read always threw, the marker
// was memoized forever, and the spec hash silently stopped tracking the script.
// ---------------------------------------------------------------------------
describe('defaultBoxProvisionVersion', () => {
  const CHECKED_IN_SCRIPT = join(import.meta.dir, '../../../../../../scripts/machine/box-provision.sh')

  test('hashes the checked-in box-provision.sh, and is never the "noscript" blind spot', () => {
    // The pre-change formula, recomputed from the file bytes: sha256 hex,
    // first 16 chars. Pinned so the fix cannot shift every git-mode box's spec
    // hash (which would recreate the fleet's boxes on deploy).
    const expected = createHash('sha256').update(readFileSync(CHECKED_IN_SCRIPT)).digest('hex').slice(0, 16)

    const version = defaultBoxProvisionVersion()
    expect(version()).toBe(expected)
    expect(version()).not.toBe('noscript')
    // Memoized: a second call is the same process-stable string.
    expect(version()).toBe(version())
  })

  test('in an artifact deployment it tracks the RELEASE script, not the bundle-inlined copy', () => {
    const root = mkdtempSync(join(tmpdir(), 'vm-boxprov-'))
    try {
      writeFileSync(join(root, 'artifact.json'), '{}')
      mkdirSync(join(root, 'machine'), { recursive: true })
      const sentinel = '#!/bin/bash\n# SENTINEL-BOX-PROVISION-FROM-ARTIFACT\n'
      writeFileSync(join(root, 'machine', 'box-provision.sh'), sentinel)
      writeFileSync(join(root, 'machine', 'bootstrap.sh'), '#!/bin/bash\n# SENTINEL-BOOTSTRAP\n')

      const expected = createHash('sha256').update(sentinel).digest('hex').slice(0, 16)
      expect(defaultBoxProvisionVersion({ root })()).toBe(expected)
      // The injection actually changed the answer (not the git-checkout value).
      expect(defaultBoxProvisionVersion({ root })()).not.toBe(defaultBoxProvisionVersion()())
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('VmSandboxManager local deployment targets', () => {
  /**
   * The gap this closes: VmSandboxManager had no getLocalDeploymentTarget, so
   * resolveLocalDeploymentTarget threw "not supported by this sandbox runtime".
   * The proxy route had no try/catch, so every tokenized app URL and every
   * /api/health probe returned 500 on hosted tenants, and the health poller —
   * which resolves the same target — marked healthy apps unhealthy.
   */
  test('forwards the app port over the machine SSH tunnel', async () => {
    const forwards: { remotePort: number }[] = []
    const manager = new VmSandboxManager({
      getMachineBox: async () => ({ machineId: 'machine-1', port: 41000 }) as any,
      getMachine: async () => ({ id: 'machine-1' }) as any,
      addForward: async (_machine: any, remotePort: number) => {
        forwards.push({ remotePort })
        return 54321
      },
    } as any)

    const target = await manager.getLocalDeploymentTarget('agent_box', 3000)

    // The app binds the MACHINE's loopback (a VM box is a systemd unit running
    // as a box_<hash> user, not a container), so the forward targets the app
    // port itself — not the box's executor port.
    expect(forwards).toEqual([{ remotePort: 3000 }])
    expect(target).toEqual({ host: '127.0.0.1', port: 54321 })
  })

  test('reports a missing box with the message the proxy retries on', async () => {
    const manager = new VmSandboxManager({ getMachineBox: async () => null } as any)
    // proxyLocalDeploymentRequest retries once through ensureSquadSandbox when
    // it sees "Sandbox not found", which is what brings a cold box up on the
    // first request instead of failing it.
    await manager
      .getLocalDeploymentTarget('agent_box', 3000)
      .then(() => {
        throw new Error('expected a rejection')
      })
      .catch((err: Error) => expect(err.message).toContain('Sandbox not found'))
  })

  test('reports the machine as the port scope, because boxes share its loopback', async () => {
    const manager = new VmSandboxManager({
      getMachineBox: async () => ({ machineId: 'machine-7', port: 41000 }) as any,
    } as any)
    expect(await manager.getSandboxMachineId('agent_box')).toBe('machine-7')
  })
})
