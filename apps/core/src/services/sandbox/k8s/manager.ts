/**
 * K8sSandboxManager
 *
 * Implements ISandboxManager for Kubernetes-based sandboxes.
 * Uses HTTP to communicate with sandbox pods running in K8s.
 */

import type { IPty } from 'bun-pty'
import {
  getSquadIdFromSandbox,
  type ISandboxManager,
  type SandboxOptions,
  type SpawnHook,
  type SandboxRuntime,
  type ManagedToolchainRequest,
} from '../types'
import { SandboxClient, type BashResponse } from './http-client'
import { HttpPtyWrapper } from './pty-wrapper'
import { K8sPodManager } from './pod-manager'
import { reconcilableSpecHash, resolveSandboxApiUrl, type SquadSandboxConfig } from './pod-spec'
import { createLogger } from '../../../lib/infra/logger'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { createHash, randomUUID } from 'crypto'
import { ProvisionCoordinator } from './provision-coordinator'
import { provisionConfig } from './provision-config'
import { PostgresProvisionStore, provisionScope, type ProvisionTransition } from './provision-store'
import { getSecretStore } from '../../secrets'
import { hasActiveLocalDeployments } from '../../deploy/local-deployment-service'
import { hasRecentWorkStreamActivityForSandbox } from '../work-stream-activity'
import { buildBashrcContent } from '../bashrc'
import { containerWorkspaceLayout, type WorkspaceLayout, type WorkspaceLayoutContext } from '../workspace-layout'
import { isLocalK8sMode } from '../runtime'
import { listActiveSessions, removeSession } from '../../execution/session-state'
import { Agent } from '../../../entities/Agent'
import { Squad } from '../../../entities/Squad'
import { sandboxRecoveryWatch } from '../recovery-watch'
import { trackSandboxSetupWork } from '../setup-progress'
import { reconcileRemoteToolchain } from '../toolchain/remote-adapter'

const log = createLogger('k8s-sandbox')

/** Timeout for HTTP client to become ready (10 seconds) */
const CLIENT_READY_TIMEOUT_MS = 10_000

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export function abortableManagerSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    timer.unref?.()
    const abort = () => {
      clearTimeout(timer)
      cleanup()
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function shellCommandFromArgs(args: string[]): string {
  return args.map(shellQuote).join(' ')
}

/**
 * State tracked for each active sandbox.
 */
interface K8sSandboxState {
  sandboxId: string
  podName: string
  endpoint: string
  client: SandboxClient
  workspacePath: string
  workspaceMount: string
  memoryMount?: string
  devboxReady: boolean
  bashrcWritten: boolean
  lifecycleGeneration?: string
}

/**
 * The idle keep-alive predicate for sandbox pods: a pod is kept alive while it
 * has an active local deployment OR (for personal agent boxes) while its work
 * stream has a recently-active member. Exported for unit testing.
 */
export function buildIdleKeepAliveChecker(
  deps: {
    hasActiveLocalDeployments?: (sandboxId: string) => Promise<boolean>
    hasRecentWorkStreamActivity?: (sandboxId: string) => Promise<boolean>
  } = {}
): (sandboxId: string) => Promise<boolean> {
  const localDeploys = deps.hasActiveLocalDeployments ?? hasActiveLocalDeployments
  const workStream = deps.hasRecentWorkStreamActivity ?? hasRecentWorkStreamActivityForSandbox
  return async (sandboxId: string) => (await localDeploys(sandboxId)) || (await workStream(sandboxId))
}

export function emitProvisionTransition(scopeHash: string, event: ProvisionTransition): void {
  eventEmitter.emit('sandbox.provision-transition', {
    scopeHash,
    from: event.from,
    to: event.to,
    version: event.version,
    reasonCode: event.reasonCode,
    retryAfterMs: event.retryAfterMs,
  })
}

export interface K8sSandboxManagerOptions {
  /**
   * Arm the 60s squad-pod reconcile pass. It is fleet-wide maintenance driven
   * off the DB (active squads, active sessions, work-stream warmup), identical
   * in every process, so exactly one process may own it — see
   * claimPeriodicSandboxMaintenance in ../factory. Defaults to true so a
   * directly-constructed manager keeps the historical behavior.
   *
   * NOTE: the pod manager's idle sweep is deliberately not covered by this
   * flag. It reaps only the pods its own process tracks in memory, and the api
   * creates pods through the request path, so both processes must keep sweeping.
   */
  runPeriodicLoops?: boolean
}

/**
 * K8s sandbox manager implementing ISandboxManager.
 * Manages sandbox lifecycle using K8s pods with sandbox services.
 */
export class K8sSandboxManager implements ISandboxManager {
  private sandboxes = new Map<string, K8sSandboxState>()
  private readonly provisionCoordinator: ProvisionCoordinator
  private readonly provisionScope: string
  private readonly recreateOnNextEnsure = new Map<string, number>()
  private readonly clientReady = new Map<
    string,
    { promise: Promise<SandboxClient>; resolve: (client: SandboxClient) => void; reject: (error: unknown) => void }
  >()
  readonly podManager: K8sPodManager

  constructor(namespace?: string, options: K8sSandboxManagerOptions = {}) {
    const runPeriodicLoops = options.runPeriodicLoops ?? true
    const ns = namespace || process.env.FICUS_K8S_NAMESPACE || 'tau-sandboxes'
    this.podManager = new K8sPodManager(ns)
    this.provisionScope = provisionScope(this.podManager.getClusterServer(), ns)
    this.provisionCoordinator = new ProvisionCoordinator({
      store: new PostgresProvisionStore(),
      config: provisionConfig,
      ownerId: `k8s-manager-${process.pid}-${randomUUID()}`,
      onTransition: (event) => {
        log.warn('Kubernetes provisioning breaker transition', event)
        emitProvisionTransition(this.provisionScope, event)
      },
    })
    this.podManager.setIdleKeepAliveChecker(buildIdleKeepAliveChecker())

    // Sync sandbox auth K8s Secret whenever FICUS_PASSWORD changes
    getSecretStore().onChange(async (key) => {
      if (key === 'FICUS_PASSWORD') {
        await this.podManager.syncAuthSecret()
      }
    })

    // Start reconciliation loop — ensures squad pods are recreated if killed.
    // Only in the process that owns periodic sandbox maintenance (the worker):
    // the api builds a manager for the request path but must not duplicate the
    // fleet-wide sweep.
    if (runPeriodicLoops) this.startReconciliationLoop()

    log.info(`Initialized K8sSandboxManager (namespace: ${ns}, periodicLoops: ${runPeriodicLoops})`)
  }

  /**
   * Ensure a sandbox is running for the given sandboxId.
   * Creates PVCs and pod if they don't exist, waits for HTTP client to be ready.
   * @returns Container ID (pod name in K8s context)
   */
  async ensureSandbox(sandboxId: string, opts: SandboxOptions): Promise<string> {
    const recreateDeadline = this.recreateOnNextEnsure.get(sandboxId)
    this.recreateOnNextEnsure.delete(sandboxId)
    if (recreateDeadline && recreateDeadline > Date.now()) return this.recreateSandbox(sandboxId, opts)
    const existing = this.sandboxes.get(sandboxId)
    if (existing?.devboxReady && this.podManager.hasPod(sandboxId)) {
      existing.lifecycleGeneration = opts.lifecycleGeneration
      this.podManager.touchPod(sandboxId)
      return existing.podName
    }
    const desiredSpecHash = reconcilableSpecHash(this.toPodConfig(opts))
    try {
      return await trackSandboxSetupWork(this, sandboxId, existing ? 'runtime_reconnect' : 'runtime_start', () =>
        this.provisionCoordinator.run({
          scope: this.provisionScope,
          sandboxKey: sandboxId,
          operationKind: 'ensure',
          desiredSpecHash,
          signal: opts.signal,
          provision: async (signal) => {
            const podName = await this._ensureSandbox(sandboxId, opts, signal)
            return { podName, resultSpecHash: desiredSpecHash, value: podName }
          },
          attach: async (podName, signal) => this.attachProvisionedSandbox(sandboxId, podName, opts, signal),
        })
      )
    } catch (error) {
      this.rejectClientReady(sandboxId, error)
      throw error
    }
  }

  private async _ensureSandbox(sandboxId: string, opts: SandboxOptions, signal?: AbortSignal): Promise<string> {
    // Check if sandbox already exists in memory
    const existing = this.sandboxes.get(sandboxId)
    if (existing) {
      existing.lifecycleGeneration = opts.lifecycleGeneration
      if (!this.podManager.hasPod(sandboxId)) {
        log.warn(`Sandbox ${sandboxId} is tracked but its pod is not ready/tracked; clearing stale state`)
        existing.client.close()
        this.sandboxes.delete(sandboxId)
        this.podManager.clearPodState(sandboxId)
      } else {
        // Hot path: trust in-memory state while the pod manager still tracks a ready pod.
        // If the pod was idled out or killed, clear stale state above and recreate it.
        log.debug(`Sandbox already tracked: ${sandboxId}`)
        this.podManager.touchPod(sandboxId)

        // If devbox wasn't ready before, wait for it now
        if (!existing.devboxReady) {
          await this.waitForDevbox(existing.client, sandboxId, 300_000, signal)
          this.markDevboxReady(existing)
        }

        return existing.podName
      }
    }

    log.info(`Creating sandbox: ${sandboxId}`)

    // Ensure pod is running and get endpoint
    const endpoint = await this.podManager.ensurePod(sandboxId, this.toPodConfig(opts), signal)

    // Create HTTP client and wait for it to be ready
    const client = new SandboxClient(endpoint)
    try {
      await abortable(client.waitForReady(CLIENT_READY_TIMEOUT_MS), signal)
      log.info(`HTTP client ready for sandbox: ${sandboxId}`)
    } catch (err) {
      client.close()
      throw new Error(`Failed to connect to sandbox ${sandboxId}: ${err}`)
    }

    // Prefer pod manager state for pod name. In local dev, endpoint is localhost:<port>
    // because it points at the executor port-forward, not the actual pod name.
    const podName = this.podManager.getPodState(sandboxId)?.podName ?? endpoint.split('.')[0]

    // Cache state immediately so file ops can use the client
    const layout = containerWorkspaceLayout({ squadId: opts.squadId ?? getSquadIdFromSandbox(sandboxId) ?? undefined })
    const state: K8sSandboxState = {
      sandboxId,
      podName,
      endpoint,
      client,
      workspacePath: opts.workspacePath,
      workspaceMount: layout.workspaceMount,
      memoryMount: layout.memoryMount,
      devboxReady: false,
      bashrcWritten: false,
      lifecycleGeneration: opts.lifecycleGeneration,
    }
    this.sandboxes.set(sandboxId, state)
    this.resolveClientReady(sandboxId, client)

    // Wait for devbox packages to be installed (background process in entrypoint)
    await this.waitForDevbox(client, sandboxId, 300_000, signal)
    this.markDevboxReady(state)

    // Create bashrc for terminal sessions to load .env and activate devbox
    await abortable(this.ensureBashrc(sandboxId, client, opts.workspacePath, layout.workspaceMount), signal)

    log.info(`Sandbox ready: ${sandboxId} (pod: ${podName})`)
    return podName
  }

  private async attachProvisionedSandbox(
    sandboxId: string,
    podName: string,
    opts: SandboxOptions,
    signal: AbortSignal
  ): Promise<string> {
    const endpoint = await this.podManager.attachReadyPod(sandboxId, podName, this.toPodConfig(opts), signal)
    const client = new SandboxClient(endpoint)
    try {
      await abortable(client.waitForReady(CLIENT_READY_TIMEOUT_MS), signal)
      const layout = containerWorkspaceLayout({
        squadId: opts.squadId ?? getSquadIdFromSandbox(sandboxId) ?? undefined,
      })
      const state: K8sSandboxState = {
        sandboxId,
        podName,
        endpoint,
        client,
        workspacePath: opts.workspacePath,
        workspaceMount: layout.workspaceMount,
        memoryMount: layout.memoryMount,
        devboxReady: false,
        bashrcWritten: false,
        lifecycleGeneration: opts.lifecycleGeneration,
      }
      this.sandboxes.set(sandboxId, state)
      this.resolveClientReady(sandboxId, client)
      await this.waitForDevbox(client, sandboxId, 300_000, signal)
      this.markDevboxReady(state)
      await abortable(this.ensureBashrc(sandboxId, client, opts.workspacePath, layout.workspaceMount), signal)
      return podName
    } catch (error) {
      client.close()
      this.sandboxes.delete(sandboxId)
      this.podManager.clearPodState(sandboxId)
      throw error
    }
  }

  /**
   * Mark a sandbox's devbox as ready and push the transition to the UI live.
   * The "running but installing packages" → fully-ready flip is the moment the
   * box becomes usable, so the status badge should refetch immediately.
   */
  private markDevboxReady(state: K8sSandboxState): void {
    state.devboxReady = true
    eventEmitter.emit('sandbox.status', { sandboxId: state.sandboxId })
  }

  async attachExistingSandbox(sandboxId: string, opts: SandboxOptions): Promise<boolean> {
    if (this.sandboxes.has(sandboxId)) return true
    const status = await this.podManager.queryPodStatus(sandboxId)
    if (status.status !== 'running' || status.containerReady !== true) return false
    await this.attachProvisionedSandbox(
      sandboxId,
      this.podManager.getPodName(sandboxId),
      opts,
      AbortSignal.timeout(300_000)
    )
    return true
  }

  async reconcileToolchain(
    sandboxId: string,
    opts: SandboxOptions,
    request: ManagedToolchainRequest
  ): Promise<'unchanged' | 'applied' | 'cleared'> {
    const state = this.sandboxes.get(sandboxId)
    if (!state) throw new Error('Sandbox is not connected')
    const workRoot = opts.k8s?.sandboxType === 'agent' ? '/private' : state.workspaceMount
    return reconcileRemoteToolchain(state.client, `${workRoot}/.tau/toolchain`, workRoot, request, (operation) =>
      trackSandboxSetupWork(this, sandboxId, 'toolchain_reconcile', operation)
    )
  }

  /**
   * Stop a sandbox (close HTTP client but keep pod running).
   * The pod may continue running for other connections or be cleaned up by idle timeout.
   */
  async stopSandbox(sandboxId: string, options: { lifecycleGeneration?: string | null } = {}) {
    const state = this.sandboxes.get(sandboxId)
    if (!state) {
      log.debug(`No sandbox to stop: ${sandboxId}`)
      return { kind: 'not-found' } as const
    }
    const actualLifecycleGeneration = state.lifecycleGeneration ?? null
    if (options.lifecycleGeneration !== undefined && actualLifecycleGeneration !== options.lifecycleGeneration) {
      log.warn(
        `Refusing stale sandbox stop for ${sandboxId}: expected generation ${options.lifecycleGeneration ?? 'legacy'}, actual ${actualLifecycleGeneration ?? 'legacy'}`
      )
      return { kind: 'generation-mismatch', actualLifecycleGeneration } as const
    }

    log.info(`Stopping sandbox: ${sandboxId}`)
    state.client.close()
    this.sandboxes.delete(sandboxId)
    return { kind: 'stopped' } as const
  }

  /**
   * Remove a sandbox completely (close client and terminate pod).
   */
  async removeSandbox(sandboxId: string): Promise<void> {
    const state = this.sandboxes.get(sandboxId)
    if (state) {
      log.info(`Removing sandbox: ${sandboxId}`)
      state.client.close()
      this.sandboxes.delete(sandboxId)
    }

    // Terminate the pod
    await this.podManager.terminatePod(sandboxId)
  }

  getResourceDiagnostics(): {
    portForward: { tracked: number; live: number; starting: number; admissionOwners: number }
  } {
    return this.podManager.getResourceDiagnostics()
  }

  /**
   * Clean up all resources (close all clients, destroy pod manager).
   */
  async cleanup(): Promise<void> {
    log.info(`Cleaning up ${this.sandboxes.size} sandboxes`)

    if (this.reconcileInterval) {
      clearInterval(this.reconcileInterval)
      this.reconcileInterval = null
    }
    // Abort admission/owners synchronously before draining clients. shutdown() executes through
    // its first await immediately, so no new coordinated owner can be admitted after this point.
    const shutdown = this.provisionCoordinator.shutdown()
    for (const [sandboxId, state] of this.sandboxes) {
      log.debug(`Closing client for sandbox: ${sandboxId}`)
      state.client.close()
    }
    this.sandboxes.clear()
    await shutdown

    // Drain once more for a client cached by an abort continuation between the first clear and settlement.
    for (const [sandboxId, state] of this.sandboxes) {
      log.debug(`Closing late client for sandbox: ${sandboxId}`)
      state.client.close()
    }
    this.sandboxes.clear()
    for (const [sandboxId, pending] of this.clientReady) {
      pending.reject(new DOMException(`Sandbox ${sandboxId} manager shut down`, 'AbortError'))
    }
    this.clientReady.clear()

    // Destroy pod manager (stops idle checker)
    this.podManager.destroy()

    log.info('Cleanup complete')
  }

  /**
   * Get spawn hook for a sandbox.
   * K8s sandboxes use HTTP tools instead of docker exec spawn hooks, so this always returns null.
   */
  getSpawnHook(_sandboxId: string, _workspacePath: string): SpawnHook | null {
    // K8s sandboxes use HTTP-based tools, not spawn hooks
    return null
  }

  /**
   * Execute a command in the sandbox and collect output.
   * @throws Error if command fails (non-zero exit code or error)
   */
  async exec(sandboxId: string, args: string[]): Promise<Buffer> {
    const state = this.sandboxes.get(sandboxId)
    if (!state) {
      throw new Error(`Sandbox not found: ${sandboxId}`)
    }

    this.podManager.touchPod(sandboxId)

    const command = shellCommandFromArgs(args)
    log.debug(`Executing in sandbox ${sandboxId}: ${command}`)

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      const stream = state.client.bash({ command, cwd: state.workspaceMount })

      stream.on('data', (response: BashResponse) => {
        if (response.stdout) {
          chunks.push(Buffer.from(response.stdout, 'base64'))
        }
        if (response.stderr) {
          chunks.push(Buffer.from(response.stderr, 'base64'))
        }
        if (response.error) {
          reject(new Error(response.error))
        }
        if (response.exitCode !== undefined && response.exitCode !== 0) {
          const output = Buffer.concat(chunks).toString()
          reject(new Error(`Command failed with exit code ${response.exitCode}: ${output}`))
        }
      })

      stream.on('error', (err: Error) => {
        reject(err)
      })

      stream.on('end', () => {
        resolve(Buffer.concat(chunks))
      })
    })
  }

  streamLogs(
    sandboxId: string,
    opts: { tailLines?: number; follow?: boolean; previous?: boolean },
    onData: (chunk: Buffer) => void,
    onError?: (err: Error) => void
  ): { cancel: () => void } {
    // Read-only: stream from the existing pod; do not ensure/recreate.
    return this.podManager.streamPodLogs(sandboxId, opts, onData, onError)
  }

  streamExec(
    sandboxId: string,
    args: string[],
    onStdout: (chunk: Buffer) => void,
    onStderr: (chunk: Buffer) => void = () => {}
  ): { cancel: () => void } {
    const state = this.sandboxes.get(sandboxId)
    if (!state) {
      throw new Error(`Sandbox not found: ${sandboxId}`)
    }

    this.podManager.touchPod(sandboxId)

    const command = shellCommandFromArgs(args)
    log.debug(`Streaming in sandbox ${sandboxId}: ${command}`)
    const stream = state.client.bash({ command, cwd: state.workspaceMount })
    stream.on('data', (response: BashResponse) => {
      if (response.stdout) onStdout(Buffer.from(response.stdout, 'base64'))
      if (response.stderr) onStderr(Buffer.from(response.stderr, 'base64'))
    })
    stream.on('error', (err: Error) => {
      onStderr(Buffer.from(err.message))
    })

    return { cancel: () => stream.cancel() }
  }

  /**
   * Execute a command and return the exit status code.
   * Unlike exec(), this doesn't throw on non-zero exit codes.
   */
  async execStatus(sandboxId: string, args: string[]): Promise<number> {
    const state = this.sandboxes.get(sandboxId)
    if (!state) {
      throw new Error(`Sandbox not found: ${sandboxId}`)
    }

    this.podManager.touchPod(sandboxId)

    const command = shellCommandFromArgs(args)
    log.debug(`Executing (status) in sandbox ${sandboxId}: ${command}`)

    return new Promise((resolve, reject) => {
      let exitCode = 0
      const stream = state.client.bash({ command, cwd: state.workspaceMount })

      stream.on('data', (response: BashResponse) => {
        if (response.error) {
          // Treat errors as exit code 1
          exitCode = 1
        }
        if (response.exitCode !== undefined) {
          exitCode = response.exitCode
        }
      })

      stream.on('error', (err: Error) => {
        reject(err)
      })

      stream.on('end', () => {
        resolve(exitCode)
      })
    })
  }

  /**
   * Spawn an interactive shell in the sandbox.
   * Returns an IPty-compatible wrapper around the WebSocket shell stream.
   */
  spawnShell(sandboxId: string, cols: number, rows: number, _workspacePath?: string): IPty | null {
    const state = this.sandboxes.get(sandboxId)
    if (!state) {
      log.warn(`Cannot spawn shell - sandbox not found: ${sandboxId}`)
      return null
    }

    this.podManager.touchPod(sandboxId)

    log.debug(`Spawning shell in sandbox ${sandboxId} (${cols}x${rows})`)

    // Open shell stream
    const stream = state.client.shell()

    // Send spawn message — always use container path for K8s.
    // Inject the live Core URL so the terminal's `tau` CLI reaches the current Core
    // even if the pod baked a now-stale port at creation. No token/password is sent:
    // the warm box is shared with squad agents, so it stays a token-free environment.
    stream.write({
      spawn: {
        cols,
        rows,
        cwd: state.workspaceMount,
        useDevboxRc: true,
        env: { FICUS_API_URL: resolveSandboxApiUrl(this.podManager.namespace) },
      },
    })

    // Return IPty wrapper
    return new HttpPtyWrapper(stream, cols, rows)
  }

  /**
   * Check if a sandbox exists.
   */
  hasSandbox(sandboxId: string): boolean {
    return this.sandboxes.has(sandboxId)
  }

  /**
   * The pod-spec config `createPod` actually receives: `opts.squadId` is folded
   * into `opts.k8s` (which never carries it) so the squad-scoped mounts are
   * provisioned. Spec-hash/drift checks MUST hash this same merged config —
   * hashing bare `opts.k8s` omits the squadId and makes every reconcile pass see
   * a permanent drift (annotation has `squadIds:[id]`, desired has `[]`),
   * recreating the pod forever.
   */
  private toPodConfig(opts: SandboxOptions): SquadSandboxConfig | undefined {
    return opts.squadId ? { ...opts.k8s, squadId: opts.squadId } : opts.k8s
  }

  /** Hash of the spec these options would produce — for comparing against a running pod. */
  computeSpecHash(opts: SandboxOptions): string {
    return reconcilableSpecHash(this.toPodConfig(opts))
  }

  /** Whether the tracked ready pod's spec is stale relative to `opts` (in-memory; ensure hot path). */
  isSandboxSpecDrifted(sandboxId: string, opts: SandboxOptions): boolean {
    return this.podManager.isSpecDrifted(sandboxId, this.toPodConfig(opts))
  }

  async assertProvisionInspectionAllowed(): Promise<void> {
    await this.provisionCoordinator.assertInspectionAllowed(this.provisionScope)
  }

  /** Reconcilable-spec hash of the live pod (cluster read), or null when there's no usable pod. */
  async getRunningSandboxSpecHash(sandboxId: string): Promise<string | null> {
    return this.podManager.getRunningPodSpecHash(sandboxId)
  }

  /**
   * Recreate a sandbox so a changed (otherwise-immutable) spec takes effect —
   * e.g. an ephemeral-storage limit change. Drops the tracked client/pod and
   * ensures a fresh one. Callers must gate this on the sandbox being idle.
   */
  requestRecreateOnNextEnsure(sandboxId: string): void {
    const now = Date.now()
    for (const [key, deadline] of this.recreateOnNextEnsure) {
      if (deadline <= now) this.recreateOnNextEnsure.delete(key)
    }
    if (!this.recreateOnNextEnsure.has(sandboxId) && this.recreateOnNextEnsure.size >= 128) {
      this.recreateOnNextEnsure.delete(this.recreateOnNextEnsure.keys().next().value!)
    }
    this.recreateOnNextEnsure.set(sandboxId, now + 30_000)
  }

  async recreateSandbox(sandboxId: string, opts: SandboxOptions): Promise<string> {
    const desiredSpecHash = reconcilableSpecHash(this.toPodConfig(opts))
    return trackSandboxSetupWork(this, sandboxId, 'spec_reconcile', () =>
      this.provisionCoordinator.run({
        scope: this.provisionScope,
        sandboxKey: sandboxId,
        operationKind: 'recreate',
        desiredSpecHash,
        signal: opts.signal,
        provision: async (signal) => {
          log.info(`Recreating sandbox to apply spec change: ${sandboxId}`)
          const existing = this.sandboxes.get(sandboxId)
          if (existing) {
            existing.client.close()
            this.sandboxes.delete(sandboxId)
          }
          await this.podManager.terminatePod(sandboxId, 'manual')
          const podName = await this._ensureSandbox(sandboxId, opts, signal)
          return { podName, resultSpecHash: desiredSpecHash, value: podName }
        },
        attach: async (podName, signal) => this.attachProvisionedSandbox(sandboxId, podName, opts, signal),
      })
    )
  }

  /**
   * Convert a host path to a container path.
   * For K8s sandboxes, we return the workspace-relative path.
   */
  toContainerPath(sandboxId: string, hostPath: string): string {
    const state = this.sandboxes.get(sandboxId)
    if (!state) {
      // Best effort: just return the host path
      return hostPath
    }

    // If the host path starts with the workspace path, make it relative to container workspace
    if (hostPath.startsWith(state.workspacePath)) {
      const relativePath = hostPath.slice(state.workspacePath.length)
      return state.workspaceMount + relativePath
    }

    // Otherwise return as-is (might not be accessible in container)
    return hostPath
  }

  /**
   * The fixed k8s container layout (`/workspace[/<squadId>]`, `/private`,
   * `/memory[/<squadId>]`) — env-independent.
   */
  getWorkspaceLayout(ctx: WorkspaceLayoutContext): WorkspaceLayout {
    return containerWorkspaceLayout(ctx)
  }

  /**
   * Get the sandbox client for a sandbox.
   * Returns null if the sandbox doesn't exist or isn't connected.
   */
  waitForClientReady(sandboxId: string): Promise<SandboxClient> {
    const existing = this.sandboxes.get(sandboxId)?.client
    if (existing) return Promise.resolve(existing)
    const pending = this.clientReady.get(sandboxId)
    if (pending) return pending.promise
    let resolve!: (client: SandboxClient) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<SandboxClient>((accept, decline) => {
      resolve = accept
      reject = decline
    })
    this.clientReady.set(sandboxId, { promise, resolve, reject })
    return promise
  }

  private resolveClientReady(sandboxId: string, client: SandboxClient): void {
    const pending = this.clientReady.get(sandboxId)
    if (!pending) return
    this.clientReady.delete(sandboxId)
    pending.resolve(client)
  }

  private rejectClientReady(sandboxId: string, error: unknown): void {
    const pending = this.clientReady.get(sandboxId)
    if (!pending) return
    this.clientReady.delete(sandboxId)
    pending.reject(error)
  }

  getClient(sandboxId: string): SandboxClient | null {
    return this.sandboxes.get(sandboxId)?.client ?? null
  }

  /**
   * Get the sandbox runtime type.
   */
  getSandboxRuntime(sandboxId: string): SandboxRuntime | null {
    if (!this.sandboxes.has(sandboxId)) {
      return null
    }
    return 'k8s'
  }

  async getLocalDeploymentTarget(sandboxId: string, port: number): Promise<{ host: string; port: number }> {
    const state = this.sandboxes.get(sandboxId)
    const podState = this.podManager.getPodState(sandboxId)
    const podName = podState?.podName ?? state?.podName
    if (!podName) {
      throw new Error(`Sandbox not found: ${sandboxId}`)
    }

    if (isLocalK8sMode()) {
      const localPort = await this.podManager.ensureAppPortForward(sandboxId, podName, port)
      return { host: 'localhost', port: localPort }
    }

    return { host: `${podName}.tau-sandboxes.${this.podManager.namespace}.svc.cluster.local`, port }
  }

  /**
   * Ensure the .tau/.bashrc file exists for terminal sessions.
   * This sources .tau/.env and activates devbox if available.
   * Mirrors DockerSandboxManager.ensureBashrc() but writes via HTTP client.
   *
   * The reconcile pass calls this for every tracked squad pod every 60s. The
   * content only changes when the workspace layout does, so write only when the
   * content hash differs from what this pod was last given — an unchanged pod
   * costs zero network round trips. The hash lives on the pod's tracked state
   * (see K8sPodManager), so a pod recreate or removal forces the next write.
   */
  private async ensureBashrc(
    sandboxId: string,
    client: SandboxClient,
    workspacePath: string,
    workspaceMount: string
  ): Promise<void> {
    const content = buildBashrcContent(workspacePath, workspaceMount)
    const hash = createHash('sha256').update(content).digest('hex')
    if (this.podManager.getBashrcHash(sandboxId) === hash) return

    try {
      await client.write({
        path: `${workspaceMount}/.tau/.bashrc`,
        content: Buffer.from(content).toString('base64'),
        createDirs: true,
      })
      // Only after a successful write — a failed write must be retried.
      this.podManager.setBashrcHash(sandboxId, hash)
    } catch (err) {
      log.warn('Failed to write .tau/.bashrc:', err)
    }
  }

  /**
   * Wait for devbox packages to finish installing in the sandbox.
   * Polls the sandbox health endpoint until devboxReady is true.
   */
  private async waitForDevbox(
    client: SandboxClient,
    sandboxId: string,
    timeoutMs: number = 300_000,
    signal?: AbortSignal
  ): Promise<void> {
    const start = Date.now()
    const pollInterval = 3000
    while (Date.now() - start < timeoutMs) {
      try {
        const health = await abortable(client.health(), signal)
        if (health.devboxReady) {
          log.info(`Devbox ready for sandbox: ${sandboxId}`)
          return
        }
      } catch {
        // Pod may not be responding yet
      }
      await abortableManagerSleep(pollInterval, signal)
    }
    log.warn(`Devbox not ready after ${timeoutMs}ms for sandbox: ${sandboxId}, proceeding anyway`)
  }

  /**
   * Get the live sandbox pod status from the K8s API.
   */
  async getProvisionDiagnostics() {
    const [provisioning, recovery] = await Promise.all([
      this.provisionCoordinator.getDiagnostics(this.provisionScope),
      import('./provision-recovery').then(({ getSandboxProvisionRecoveryDiagnostics }) =>
        getSandboxProvisionRecoveryDiagnostics()
      ),
    ])
    return { ...provisioning, ...recovery }
  }

  async getSandboxStatus(sandboxId: string) {
    return this.podManager.queryPodStatus(sandboxId)
  }

  /**
   * Get the HTTP client for a sandbox.
   * Used by K8s tool factories to create tools that communicate via HTTP.
   */
  getClientForSandbox(sandboxId: string): SandboxClient | null {
    const state = this.sandboxes.get(sandboxId)
    return state?.client ?? null
  }

  /**
   * Ensure all active squads have running sandbox pods.
   * Called on startup and periodically to reconcile desired state.
   */
  async reconcileSquadPods(): Promise<void> {
    try {
      await this.reconcileActiveSessionSandboxes()
      await this.podManager.cleanupTerminalPods()

      // Lazy import to avoid circular dependency (Squad → sandbox → Squad)
      const { Squad } = await import('../../../entities/Squad')
      const { ensureSquadSandbox } = await import('../ensure')
      const activeSquads = await Squad.list({ status: 'active' })

      log.info(`Reconciling sandbox pods for ${activeSquads.length} active squad(s)`)

      for (const squad of activeSquads) {
        // Only reconcile always-on squads, or squads that already have a running pod
        // (non-always-on squads start on demand, not proactively)
        const sandboxId = Squad.getSandboxId(squad.id)
        if (!squad.isSandboxAlwaysOn && !this.sandboxes.has(sandboxId)) {
          continue
        }

        try {
          await ensureSquadSandbox(squad)
        } catch (err) {
          log.error(`Failed to reconcile sandbox for squad ${squad.id}:`, err)
        }

        // Health check and bashrc update for tracked sandboxes
        const state = this.sandboxes.get(sandboxId)
        if (state) {
          try {
            await state.client.health()
            // Refresh bashrc when its content changed (a no-op write otherwise)
            await this.ensureBashrc(sandboxId, state.client, state.workspacePath, state.workspaceMount)
            state.bashrcWritten = true
          } catch {
            log.warn(`Sandbox ${sandboxId} failed health check during reconciliation, clearing state`)
            state.client.close()
            this.sandboxes.delete(sandboxId)
            this.podManager.clearPodState(sandboxId)
          }
        }
      }

      // Recreate pods whose immutable spec drifted from the squad's config
      // (e.g. an ephemeral-storage limit change). Cluster-read based, so it
      // also catches running pods this process doesn't track. Recreates only
      // idle squads. Lazy import to avoid a manager → ensure → factory cycle.
      const { reconcileSquadSandboxSpecs } = await import('../squad-sandbox-reconcile')
      await reconcileSquadSandboxSpecs(log, { manager: this })

      // Keep work-stream agents' personal boxes warm while their streams are
      // active, so a handoff lands on a running pod (no cascading cold-starts).
      try {
        const { warmupWorkStreamAgentSandboxes } = await import('../work-stream-warmup')
        await warmupWorkStreamAgentSandboxes(log)
      } catch (err) {
        log.warn('Work-stream agent sandbox warmup failed during reconcile:', err)
      }

      log.info('Sandbox pod reconciliation complete')
    } catch (err) {
      log.error('Failed to reconcile squad pods:', err)
    }
  }

  private async reconcileActiveSessionSandboxes(): Promise<void> {
    const sessions = listActiveSessions()
    if (sessions.length === 0) return

    for (const [agentId] of sessions) {
      try {
        const agent = await Agent.find(agentId)
        if (!agent) {
          removeSession(agentId)
          continue
        }

        const sandboxId = await agent.getSandboxId()

        // Never halt a live session over a dead box. The agent keeps its turn
        // (bash/file calls fail fast with a structured outage error); we
        // register a watch so it gets notified — and its box re-ensured by
        // the watch sweep — once everything it depends on is back. Squad
        // members also depend on the shared squad box.
        const boxIds = [sandboxId]
        if (agent.squadId) boxIds.push(Squad.getSandboxId(agent.squadId))

        for (const boxId of boxIds) {
          const status = await this.getSandboxStatus(boxId)
          if (status.status === 'running' || status.status === 'starting' || status.status === 'pending') {
            continue
          }

          log.warn(
            `Active session for agent ${agentId} lost sandbox ${boxId} (status: ${status.status}); registering recovery watch`
          )
          await sandboxRecoveryWatch.register({
            agentId,
            sandboxIds: [boxId],
            reason: status.reason,
            crash: status.status === 'failed',
            observedAt: status.startedAt ? new Date(status.startedAt) : undefined,
          })
        }
      } catch (err) {
        log.error(`Failed to reconcile active session sandbox for agent ${agentId}:`, err)
      }
    }
  }

  private reconcileInterval: ReturnType<typeof setInterval> | null = null
  private reconciling = false

  /**
   * Arm this process's periodic sandbox maintenance (the reconcile pass).
   * Idempotent: a second call never double-arms the timer.
   */
  startPeriodicMaintenance(): void {
    this.startReconciliationLoop()
  }

  private startReconciliationLoop(): void {
    if (this.reconcileInterval) return

    // Reconcile every 60 seconds — detects and recreates killed pods
    const RECONCILE_INTERVAL_MS = 60_000

    this.reconcileInterval = setInterval(() => {
      if (this.reconciling) {
        log.debug('Skipping reconciliation — previous run still in progress')
        return
      }
      this.reconciling = true
      this.reconcileSquadPods()
        .catch((err) => {
          log.error('Reconciliation loop error:', err)
        })
        .finally(() => {
          this.reconciling = false
        })
    }, RECONCILE_INTERVAL_MS)

    if (this.reconcileInterval.unref) {
      this.reconcileInterval.unref()
    }
  }
}
