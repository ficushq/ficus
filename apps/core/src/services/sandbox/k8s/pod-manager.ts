/**
 * K8sPodManager
 *
 * Manages pod lifecycle for K8s sandboxes — creation, health checking, idle timeouts.
 * Each squad gets its own pod running the tau-sandbox image with HTTP tools.
 */

import * as k8s from '@kubernetes/client-node'
import { Writable } from 'node:stream'
import { createLogger } from '../../../lib/infra/logger'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { resourceDiagnostics } from '../../../lib/infra/resource-diagnostics'
import { getSecretStore } from '../../secrets/store'
import { loadKubeConfig } from './kubeconfig'
import { terminationIntentRegistry } from '../death/intent-registry'
import type { SandboxDeathSignal, TerminationIntentReason } from '../death/types'
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  EXECUTOR_PORT,
  HEADLESS_SERVICE_NAME,
  IS_LOCAL_DEV,
  SANDBOX_AUTH_SECRET_NAME,
} from './constants'
import { PortForwardManager } from './port-forward'
import {
  buildSandboxPodSpec,
  sandboxPodName,
  sanitizeLabelValue,
  reconcilableSpecHash,
  SANDBOX_MEMORY_LIMIT,
  SPEC_HASH_ANNOTATION,
  type SquadSandboxConfig,
} from './pod-spec'
import { classifyProvisionFailure } from './provision-failure'
import { K8sProvisionAttemptError } from './provision-errors'

const log = createLogger('k8s-pod-manager')

const DEFAULT_NAMESPACE = 'tau-sandboxes'

/** Detect K8s API connection failures (e.g. k3d cluster stopped) */
function isClusterConnectionError(err: unknown): boolean {
  const msg = String((err as any)?.message || '').toLowerCase()
  const code = (err as any)?.code || ''
  return (
    code === 'ConnectionRefused' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    msg.includes('unable to connect') ||
    msg.includes('connection refused') ||
    msg.includes('fetch failed') ||
    msg.includes('econnrefused')
  )
}

function getK8sStatusCode(err: unknown): number | undefined {
  const e = err as any
  return e?.response?.statusCode ?? e?.statusCode ?? e?.code
}

/** Interval for checking idle pods (60 seconds) */
const IDLE_CHECK_INTERVAL_MS = 60 * 1000

/** Default timeout for waiting for pod to be ready (120 seconds) */
const POD_READY_TIMEOUT_MS = 300 * 1000 // 5 minutes — first boot downloads nix packages

/** Poll interval for checking pod readiness (1 second) */
const POD_READY_POLL_INTERVAL_MS = 1000

/** Timeout for waiting for a terminating pod to fully disappear (60 seconds) */
const POD_DELETION_TIMEOUT_MS = 60 * 1000

/** Poll interval for checking pod deletion (500ms) */
const POD_DELETION_POLL_INTERVAL_MS = 500

/** How long streamPodLogs waits for a container to start before giving up. */
const POD_LOG_READY_TIMEOUT_MS = 300 * 1000 // matches POD_READY_TIMEOUT_MS (first boot is slow)

/** Poll interval while waiting for the log container to start. */
const POD_LOG_READY_POLL_MS = 500

/**
 * The kube client throws an `ApiException` whose message is a raw
 * "HTTP-Code: …\nMessage: …\nBody: …\nHeaders: …" block. Never surface that to
 * a user; translate it to a friendly message (the common cause is requesting
 * logs before the container has started).
 */
function friendlyPodLogError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  const looksLikeApiException = message.startsWith('HTTP-Code:') || typeof (err as any)?.code === 'number'
  if (looksLikeApiException) {
    const friendly = new Error('Sandbox logs are not available yet — the container is still starting.')
    ;(friendly as any).cause = err
    return friendly
  }
  return err instanceof Error ? err : new Error(message)
}

/** Human-readable message for pod states that will never produce logs. */
function podLogUnavailableMessage(status: { status: string; reason?: string }): string {
  switch (status.status) {
    case 'not_found':
      return 'Sandbox is not running (no pod found).'
    case 'terminating':
      return 'Sandbox is shutting down.'
    case 'cluster_unavailable':
      return status.reason ?? 'Sandbox cluster is not reachable.'
    default:
      return status.reason ?? 'Sandbox logs are not available.'
  }
}

export interface PodState {
  sandboxId: string
  podName: string
  status: 'pending' | 'starting' | 'ready' | 'unhealthy' | 'terminating'
  lastActivity: Date
  /** Idle timeout in ms. Defaults to DEFAULT_IDLE_TIMEOUT_MS. */
  idleTimeout: number
  /** If true, pod is never terminated due to inactivity. */
  alwaysOn: boolean
  /** Hash of the live pod's reconcilable spec (see reconcilableSpecHash). */
  specHash?: string
}

export function podDeathSignal(phase?: string, reason?: string): SandboxDeathSignal | null {
  if (reason === 'Evicted') return 'evicted'
  if (phase === 'Failed') return 'failed'
  if (phase === 'Succeeded') return 'succeeded'
  return null
}

function resolveSandboxIdForPod(pods: Map<string, PodState>, podName: string): string | null {
  // Pod labels contain a lossy sanitized sandbox ID, so use the tracked in-memory
  // pod state to recover the canonical squad_<uuid> ID. Pods from a previous
  // API process are intentionally ignored because their canonical ID cannot be
  // recovered reliably from the sanitized label.
  for (const [sandboxId, state] of pods) {
    if (state.podName === podName) return sandboxId
  }
  return null
}

export function abortablePodSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      cleanup()
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export class K8sPodManager {
  private kc: k8s.KubeConfig
  private coreApi: k8s.CoreV1Api
  private pods: Map<string, PodState> = new Map()
  private readonly portForwardManager: PortForwardManager
  private idleCheckInterval: ReturnType<typeof setInterval> | null = null
  /**
   * Content hash of the .tau/.bashrc last written into each tracked pod, so the
   * 60s reconcile pass rewrites it only when it actually changed. Dropped
   * wherever a pod's tracked state is created or removed — a fresh pod's
   * filesystem is empty, so it must be written again.
   */
  private readonly bashrcHashes = new Map<string, string>()
  private readonly injectedNow?: () => number
  private readonly injectedSleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  private shouldKeepAlive: (sandboxId: string) => Promise<boolean> = async () => false
  public readonly namespace: string

  constructor(
    namespace: string = DEFAULT_NAMESPACE,
    dependencies: {
      kc?: k8s.KubeConfig
      coreApi?: k8s.CoreV1Api
      now?: () => number
      sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
    } = {}
  ) {
    this.namespace = namespace
    this.portForwardManager = new PortForwardManager(namespace)
    this.kc = dependencies.kc ?? loadKubeConfig()
    this.coreApi = dependencies.coreApi ?? this.kc.makeApiClient(k8s.CoreV1Api)
    this.injectedNow = dependencies.now
    this.injectedSleep = dependencies.sleep

    // Start idle checker. Deliberately NOT gated to one process: it reaps only
    // the pods THIS process tracks in memory (see checkIdlePods), and the api
    // creates pods of its own through the request path (terminals, deployment
    // routes). The two processes therefore sweep disjoint sets — gating it
    // would leave api-created pods running forever.
    this.startIdleChecker()
    log.info(`Initialized with namespace: ${namespace}`)
  }

  getClusterServer(): string {
    return this.kc.getCurrentCluster()?.server ?? 'unknown'
  }

  setIdleKeepAliveChecker(checker: (sandboxId: string) => Promise<boolean>): void {
    this.shouldKeepAlive = checker
  }

  /**
   * Check if the K8s cluster is reachable.
   * Returns true if the API server responds, false otherwise.
   * Logs a clear warning on failure.
   */
  /**
   * Warm the node's image cache for both sandbox images in the background, so the
   * first real squad/agent creation after a rebuild doesn't pay the layer pull.
   * Best-effort and non-fatal — callers should fire-and-forget.
   */
  async prepullImages(): Promise<void> {
    const { prepullSandboxImages } = await import('./image-prepull')
    await prepullSandboxImages({ coreApi: this.coreApi, namespace: this.namespace, isLocalDev: IS_LOCAL_DEV })
  }

  async checkClusterConnectivity(): Promise<boolean> {
    try {
      // Use a namespaced pod read instead of a cluster-scoped namespace list.
      // The tau-core ServiceAccount only needs sandbox-namespace permissions in production.
      await this.coreApi.readNamespacedPod({ name: 'tau-connectivity-check', namespace: this.namespace })
      return true
    } catch (err: unknown) {
      const status = getK8sStatusCode(err)
      if (status === 404) {
        // Expected: the throwaway pod does not exist, which proves API + RBAC for pod reads works.
        return true
      }
      if (isClusterConnectionError(err)) {
        const server = this.kc.getCurrentCluster()?.server ?? 'unknown'
        log.error(
          `K8s cluster is not reachable at ${server}` +
            (IS_LOCAL_DEV ? ' — is your k3d cluster running? Try: k3d cluster start' : '') +
            `. Sandbox features will not work until the cluster is available.`
        )
        return false
      }
      if (status === 401 || status === 403) {
        log.error(
          `K8s cluster is reachable but tau-core is not authorized to manage sandbox pods in namespace ${this.namespace}: ${(err as Error).message}`
        )
        return false
      }
      // Some other error — cluster is reachable but unhappy. Allow startup so the normal sandbox path logs details.
      log.warn(`K8s cluster reachable but returned an error: ${(err as Error).message}`)
      return true
    }
  }

  /**
   * Ensure a pod is running for the given sandboxId.
   * Creates the pod if it doesn't exist, waits for it to be ready.
   * @returns HTTP endpoint string for the pod
   */
  async ensurePod(sandboxId: string, config?: SquadSandboxConfig, signal?: AbortSignal): Promise<string> {
    const existing = this.pods.get(sandboxId)

    if (existing && existing.status === 'ready') {
      log.debug(`Pod already ready for sandbox: ${sandboxId}`)
      this.touchPod(sandboxId)

      // Update config if it changed (e.g., user toggled alwaysOn)
      if (config) {
        existing.alwaysOn = config.alwaysOn ?? false
        existing.idleTimeout = config.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_MS
      }

      // Ensure port-forward is alive in local dev mode
      if (IS_LOCAL_DEV) {
        await this.ensurePortForward(sandboxId, existing.podName)
      }

      return this.getPodEndpoint(existing.podName)
    }

    if (existing && existing.status === 'pending') {
      // Already creating, wait for it
      log.debug(`Pod already pending for sandbox: ${sandboxId}, waiting...`)
      await (signal
        ? this.waitForPodReady(existing.podName, POD_READY_TIMEOUT_MS, signal)
        : this.waitForPodReady(existing.podName))

      // Ensure port-forward in local dev mode
      if (IS_LOCAL_DEV) {
        await this.ensurePortForward(sandboxId, existing.podName)
      }

      return this.getPodEndpoint(existing.podName)
    }

    const podName = this.getPodName(sandboxId)
    log.info(`Creating pod for sandbox: ${sandboxId} (pod: ${podName})`)

    // Mark as pending. A pod reaching creation may be a fresh (or newly
    // adopted) one, so anything we believed about its bashrc no longer holds.
    this.bashrcHashes.delete(sandboxId)
    this.pods.set(sandboxId, {
      sandboxId,
      podName,
      status: 'pending',
      lastActivity: new Date(),
      idleTimeout: config?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_MS,
      alwaysOn: config?.alwaysOn ?? false,
    })

    try {
      // Check if pod already exists in K8s
      let podExists = false
      try {
        await this.coreApi.readNamespacedPod({ name: podName, namespace: this.namespace })
        podExists = true
        log.debug(`Pod ${podName} already exists in cluster`)
      } catch (err: unknown) {
        if (
          (err as any)?.response?.statusCode === 404 ||
          (err as any)?.statusCode === 404 ||
          (err as any)?.code === 404
        ) {
          podExists = false
        } else {
          throw err
        }
      }

      // Hash of the spec actually running once we settle create-vs-adopt below.
      let runningSpecHash: string | undefined

      if (podExists) {
        // Check if the existing pod is in a terminal state — delete and recreate
        try {
          const existingPod = await this.coreApi.readNamespacedPod({ name: podName, namespace: this.namespace })
          const phase = existingPod.status?.phase
          if (existingPod.metadata?.deletionTimestamp) {
            // Pod is mid-graceful-termination (e.g. a restart just deleted it).
            // It still reports phase Running, so adopting it would make us
            // waitForPodReady on a corpse until timeout and never recreate.
            // Drain it fully, then fall through to create a fresh pod below.
            log.info(`Pod ${podName} is terminating; waiting for full deletion before recreating`)
            await (signal
              ? this.waitForPodDeletion(podName, POD_DELETION_TIMEOUT_MS, signal)
              : this.waitForPodDeletion(podName))
            podExists = false
          } else if (phase === 'Failed' || phase === 'Succeeded') {
            log.warn(`Pod ${podName} is in terminal state (${phase}), deleting and recreating...`)
            await this.coreApi.deleteNamespacedPod({ name: podName, namespace: this.namespace })
            podExists = false
          } else {
            // Adopting an existing pod — its annotation is the real running spec.
            runningSpecHash = existingPod.metadata?.annotations?.[SPEC_HASH_ANNOTATION]
          }
        } catch {
          // Ignore — pod may have been deleted between checks
          podExists = false
        }
      }

      if (!podExists) {
        // Ensure auth secret is current before creating the pod
        await this.syncAuthSecret()
        const podSpec = await this.createPodSpec(sandboxId, podName, config)
        try {
          await this.coreApi.createNamespacedPod({ namespace: this.namespace, body: podSpec })
          log.info(`Created pod: ${podName}`)
          runningSpecHash = reconcilableSpecHash(config)
        } catch (error) {
          const status = getK8sStatusCode(error)
          if (status !== 409) throw error
          const adopted = await this.coreApi.readNamespacedPod({ name: podName, namespace: this.namespace })
          if (adopted.metadata?.deletionTimestamp || ['Failed', 'Succeeded'].includes(adopted.status?.phase ?? ''))
            throw error
          runningSpecHash = adopted.metadata?.annotations?.[SPEC_HASH_ANNOTATION]
          log.info(`Adopted concurrently created pod: ${podName}`)
        }
      }

      // Record the running spec hash so drift checks compare against what's
      // actually deployed (desired for new pods, the annotation for adopted ones).
      const trackedState = this.pods.get(sandboxId)
      if (trackedState) {
        trackedState.specHash = runningSpecHash
      }

      // Update to starting state
      this.updatePodState(sandboxId, 'starting')

      // Wait for pod to be ready
      await (signal ? this.waitForPodReady(podName, POD_READY_TIMEOUT_MS, signal) : this.waitForPodReady(podName))

      // Update to ready state
      this.updatePodState(sandboxId, 'ready')
      const { sandboxDeathNotifier } = await import('../death/notifier')
      sandboxDeathNotifier.clear(sandboxId)
      log.info(`Pod ready: ${podName}`)

      // In local dev mode, start port-forward before returning endpoint
      if (IS_LOCAL_DEV) {
        await this.ensurePortForward(sandboxId, podName)
      }

      return this.getPodEndpoint(podName)
    } catch (err) {
      const failure = classifyProvisionFailure(err)
      log.error(`Failed to create/start pod for sandbox ${sandboxId} (${failure.code}): ${failure.publicMessage}`)
      this.updatePodState(sandboxId, 'unhealthy')
      throw err
    }
  }

  async attachReadyPod(
    sandboxId: string,
    podName: string,
    config?: SquadSandboxConfig,
    signal?: AbortSignal
  ): Promise<string> {
    this.bashrcHashes.delete(sandboxId)
    this.pods.set(sandboxId, {
      sandboxId,
      podName,
      status: 'starting',
      lastActivity: new Date(),
      idleTimeout: config?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_MS,
      alwaysOn: config?.alwaysOn ?? false,
    })
    await this.waitForPodReady(podName, POD_READY_TIMEOUT_MS, signal)
    this.updatePodState(sandboxId, 'ready')
    if (IS_LOCAL_DEV) await this.ensurePortForward(sandboxId, podName)
    return this.getPodEndpoint(podName)
  }

  /**
   * Update lastActivity timestamp for a sandbox pod.
   * Call this when the pod is actively being used.
   */
  touchPod(sandboxId: string): void {
    const state = this.pods.get(sandboxId)
    if (state) {
      state.lastActivity = new Date()
    }
  }

  /**
   * Whether the tracked ready pod's spec differs from the spec we'd generate
   * now (in-memory; cheap enough for the ensure hot path). Returns false when
   * the pod isn't tracked/ready or its hash is unknown — never recreate blindly.
   */
  isSpecDrifted(sandboxId: string, config?: SquadSandboxConfig): boolean {
    const state = this.pods.get(sandboxId)
    if (!state || state.status !== 'ready' || !state.specHash) return false
    return state.specHash !== reconcilableSpecHash(config)
  }

  /**
   * Read the reconcilable-spec hash from the live pod (cluster source of truth,
   * used by the periodic reconciler so it works regardless of which process
   * created the pod). Returns null when there's no usable running pod.
   */
  async getRunningPodSpecHash(sandboxId: string): Promise<string | null> {
    const podName = this.pods.get(sandboxId)?.podName ?? this.getPodName(sandboxId)
    try {
      const pod = await this.coreApi.readNamespacedPod({ name: podName, namespace: this.namespace })
      const phase = pod.status?.phase
      if (phase === 'Failed' || phase === 'Succeeded') return null
      return pod.metadata?.annotations?.[SPEC_HASH_ANNOTATION] ?? null
    } catch {
      return null
    }
  }

  /**
   * Stream a pod's container logs (read-only). Does not create the pod.
   *
   * The kube `/pods/{name}/log` endpoint errors (e.g. 204 No Content) while the
   * container is still `ContainerCreating` — and `@kubernetes/client-node`'s
   * `Log.log` throws a raw `ApiException` (an "HTTP-Code: …" block) for any
   * non-200. So we first poll pod status until the container has actually
   * started (or the pod terminated, whose logs still exist) before requesting
   * logs — mirroring how `docker logs -f` simply waits through startup. The
   * wait is cancellable. Any residual kube error is translated to a friendly
   * message rather than forwarded raw.
   */
  streamPodLogs(
    sandboxId: string,
    opts: { tailLines?: number; follow?: boolean; previous?: boolean },
    onData: (chunk: Buffer) => void,
    onError?: (err: Error) => void
  ): { cancel: () => void } {
    const podName = this.pods.get(sandboxId)?.podName ?? this.getPodName(sandboxId)
    // Defense-in-depth: clamp here too so callers that bypass getLogsParams can't exceed the ceiling.
    const tailLines = Math.min(Math.max(Math.floor(opts.tailLines ?? 500), 1), 5000)
    const lease = resourceDiagnostics.begin('pod_log_transport')
    let emitData: ((chunk: Buffer) => void) | null = onData
    const stream = new Writable({
      write(chunk, _enc, cb) {
        try {
          emitData?.(Buffer.from(chunk))
          cb()
        } catch (error) {
          cb(error as Error)
        }
      },
    })

    let aborted = false
    let controller: AbortController | undefined
    const fail = (error: Error): void => {
      if (aborted) return
      aborted = true
      emitData = null
      controller?.abort()
      stream.destroy()
      lease.finish('failed')
      onError?.(error)
    }
    stream.on('finish', () => lease.finish('completed'))
    stream.on('error', fail)

    const startStream = () => {
      new k8s.Log(this.kc)
        .log(this.namespace, podName, 'sandbox', stream, {
          follow: opts.follow ?? true,
          tailLines,
          previous: opts.previous ?? false,
          pretty: false,
          timestamps: false,
        })
        .then((ctrl) => {
          controller = ctrl
          if (aborted) ctrl.abort()
        })
        .catch((err) => {
          if (!aborted) fail(friendlyPodLogError(err))
        })
    }

    // Wait for the container to have started before requesting logs.
    void (async () => {
      const deadline = Date.now() + POD_LOG_READY_TIMEOUT_MS
      for (;;) {
        if (aborted) return
        let status: Awaited<ReturnType<K8sPodManager['queryPodStatus']>>
        try {
          status = await this.queryPodStatus(sandboxId)
        } catch (err) {
          if (!aborted) fail(err as Error)
          return
        }
        if (aborted) return

        // Logs are available once the container has run at all (`startedAt`) or
        // the pod terminated (failed/succeeded — the finished container's logs).
        if (
          status.startedAt ||
          status.status === 'running' ||
          status.status === 'failed' ||
          status.status === 'succeeded'
        ) {
          startStream()
          return
        }
        // States that will never produce logs for this pod:
        if (
          status.status === 'not_found' ||
          status.status === 'terminating' ||
          status.status === 'cluster_unavailable'
        ) {
          if (!aborted) fail(new Error(podLogUnavailableMessage(status)))
          return
        }
        // pending / starting (ContainerCreating, scheduling): wait and retry.
        if (Date.now() >= deadline) {
          if (!aborted) {
            fail(
              new Error(
                `Timed out waiting for the sandbox container to start${status.reason ? ` (${status.reason})` : ''}.`
              )
            )
          }
          return
        }
        await new Promise((r) => setTimeout(r, POD_LOG_READY_POLL_MS))
      }
    })()

    return {
      cancel: () => {
        if (aborted) return
        aborted = true
        emitData = null
        controller?.abort()
        stream.destroy()
        lease.finish('cancelled')
      },
    }
  }

  /**
   * Terminate a pod for the given sandboxId.
   */
  async terminatePod(sandboxId: string, reason: TerminationIntentReason = 'manual'): Promise<void> {
    terminationIntentRegistry.record(sandboxId, reason)
    const state = this.pods.get(sandboxId)

    if (state?.status === 'terminating') {
      log.debug(`Pod already terminating for sandbox: ${sandboxId}`)
      return
    }

    // Use tracked pod name if available, otherwise derive it
    const podName = state?.podName ?? this.getPodName(sandboxId)
    log.info(`Terminating pod for sandbox: ${sandboxId} (pod: ${podName})`)

    if (state) {
      this.updatePodState(sandboxId, 'terminating')
    }

    try {
      // Manual stop/restart force-deletes (gracePeriodSeconds: 0): there is no
      // in-flight work worth draining (the active session is failed alongside
      // this), and a graceful delete leaves the pod Terminating for its whole
      // grace period — long enough that a restart's recreate races the corpse.
      await this.coreApi.deleteNamespacedPod({
        name: podName,
        namespace: this.namespace,
        ...(reason === 'manual' ? { gracePeriodSeconds: 0 } : {}),
      })
      log.info(`Deleted pod: ${podName}`)
    } catch (err: unknown) {
      if (
        (err as any)?.response?.statusCode === 404 ||
        (err as any)?.statusCode === 404 ||
        (err as any)?.code === 404
      ) {
        log.debug(`Pod ${podName} already deleted`)
      } else {
        log.error(`Failed to delete pod ${podName}:`, err)
        throw err
      }
    } finally {
      this.stopPortForward(sandboxId)
      this.pods.delete(sandboxId)
      this.bashrcHashes.delete(sandboxId)
      // The pod is gone; surface the not_found transition to the UI live.
      eventEmitter.emit('sandbox.status', { sandboxId })
    }
  }

  /**
   * Delete terminal sandbox pods so completed/evicted pods release pod-owned
   * ephemeral storage and stop contributing to kubelet disk pressure.
   */
  async cleanupTerminalPods(): Promise<{ deleted: number }> {
    let deleted = 0

    const pods = await this.coreApi.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: 'app=tau-sandbox',
    })

    for (const pod of pods.items ?? []) {
      const name = pod.metadata?.name
      if (!name) continue

      const phase = pod.status?.phase
      const reason = pod.status?.reason
      if (phase !== 'Succeeded' && phase !== 'Failed' && reason !== 'Evicted') continue

      try {
        const sandboxId = resolveSandboxIdForPod(this.pods, name)
        const signal = podDeathSignal(phase, reason)
        if (sandboxId && signal) {
          const terminated = pod.status?.containerStatuses?.find((cs) => cs.name === 'sandbox')?.state?.terminated
          const message =
            [terminated?.reason, terminated?.message, pod.status?.message].filter(Boolean).join('; ') || undefined
          const { sandboxDeathNotifier } = await import('../death/notifier')
          await sandboxDeathNotifier.maybeNotify({
            sandboxId,
            signal,
            reason: reason ?? terminated?.reason ?? pod.status?.message ?? terminated?.message,
            message,
            exitCode: terminated?.exitCode,
            memoryLimit: SANDBOX_MEMORY_LIMIT,
            runtime: 'k8s',
            startedAt: pod.status?.startTime ? new Date(pod.status.startTime).toISOString() : undefined,
          })
        }

        await this.coreApi.deleteNamespacedPod({ name, namespace: this.namespace })
        deleted++
        for (const [sandboxId, state] of this.pods) {
          if (state.podName === name) {
            this.stopPortForward?.(sandboxId)
            this.pods.delete(sandboxId)
            this.bashrcHashes.delete(sandboxId)
          }
        }
      } catch (err: unknown) {
        const status = getK8sStatusCode(err)
        if (status !== 404) {
          log.warn(`Failed to delete terminal sandbox pod ${name}:`, err)
        }
      }
    }

    if (deleted > 0) {
      log.info(`Deleted ${deleted} terminal sandbox pod(s)`)
    }

    return { deleted }
  }

  /**
   * Check if a sandbox has a ready pod.
   */
  hasPod(sandboxId: string): boolean {
    const state = this.pods.get(sandboxId)
    return state?.status === 'ready'
  }

  /**
   * Get the current pod state for a sandbox.
   * Returns null if no pod is tracked for this sandbox.
   */
  getPodState(sandboxId: string): PodState | null {
    return this.pods.get(sandboxId) ?? null
  }

  clearPodState(sandboxId: string): void {
    this.pods.delete(sandboxId)
    this.bashrcHashes.delete(sandboxId)
  }

  /** Content hash of the .tau/.bashrc last written into this sandbox's pod. */
  getBashrcHash(sandboxId: string): string | undefined {
    return this.bashrcHashes.get(sandboxId)
  }

  /** Record the .tau/.bashrc content hash after a successful write. */
  setBashrcHash(sandboxId: string, hash: string): void {
    this.bashrcHashes.set(sandboxId, hash)
  }

  /**
   * Query the actual K8s API for the sandbox pod status.
   * This checks the real cluster state, not just in-memory tracking.
   */
  async queryPodStatus(sandboxId: string): Promise<{
    status:
      | 'not_found'
      | 'pending'
      | 'starting'
      | 'running'
      | 'succeeded'
      | 'failed'
      | 'terminating'
      | 'unknown'
      | 'cluster_unavailable'
    phase?: string
    reason?: string
    exitCode?: number
    containerReady?: boolean
    startedAt?: string
    devboxReady?: boolean
  }> {
    const podName = this.getPodName(sandboxId)
    try {
      const pod = await this.coreApi.readNamespacedPod({ name: podName, namespace: this.namespace })

      // Check if pod is being deleted
      if (pod.metadata?.deletionTimestamp) {
        return { status: 'terminating', phase: pod.status?.phase }
      }

      const phase = pod.status?.phase
      const conditions = pod.status?.conditions || []
      const readyCondition = conditions.find((c) => c.type === 'Ready')
      const containerStatuses = pod.status?.containerStatuses || []
      const initContainerStatuses = pod.status?.initContainerStatuses || []

      // Check init containers
      const initWaiting = initContainerStatuses.find((cs) => cs.state?.waiting)
      const initRunning = initContainerStatuses.find((cs) => cs.state?.running)
      if (initWaiting || initRunning) {
        const reason = initWaiting?.state?.waiting?.reason || 'InitContainer running'
        return { status: 'starting', phase, reason }
      }

      // Check main container
      const mainContainer = containerStatuses.find((cs) => cs.name === 'sandbox')
      const containerReady = readyCondition?.status === 'True'

      if (phase === 'Pending') {
        const waiting = mainContainer?.state?.waiting
        return {
          status: 'pending',
          phase,
          reason: waiting?.reason || 'Scheduling',
          containerReady: false,
        }
      }

      if (phase === 'Running') {
        const waiting = mainContainer?.state?.waiting
        if (waiting) {
          return { status: 'starting', phase, reason: waiting.reason, containerReady: false }
        }

        // Pod is running — query sandbox health for devbox readiness
        let devboxReady = false
        if (containerReady) {
          try {
            // Ensure port-forward exists before health check (local dev only)
            if (IS_LOCAL_DEV) {
              await this.ensurePortForward(sandboxId, podName)
            }
            const endpoint = this.getPodEndpoint(podName)
            const resp = await fetch(`http://${endpoint}/healthz`, {
              signal: AbortSignal.timeout(3000),
            })
            if (resp.ok) {
              const health = await resp.json()
              devboxReady = health.devboxReady ?? false
            }
          } catch {
            // Tool executor not responding yet
          }
        }

        return {
          status: containerReady ? 'running' : 'starting',
          phase,
          containerReady,
          devboxReady,
          startedAt: mainContainer?.state?.running?.startedAt
            ? new Date(mainContainer.state.running.startedAt).toISOString()
            : undefined,
        }
      }

      if (phase === 'Succeeded') return { status: 'succeeded', phase }
      if (phase === 'Failed') {
        const terminated = mainContainer?.state?.terminated
        return {
          status: 'failed',
          phase,
          reason: terminated?.reason || terminated?.message,
          exitCode: terminated?.exitCode,
        }
      }

      return { status: 'unknown', phase }
    } catch (err: unknown) {
      if (
        (err as any)?.response?.statusCode === 404 ||
        (err as any)?.statusCode === 404 ||
        (err as any)?.code === 404
      ) {
        return { status: 'not_found' }
      }
      // Detect cluster connectivity issues (e.g. k3d stopped)
      if (isClusterConnectionError(err)) {
        log.warn(`K8s cluster unreachable when querying pod status for ${sandboxId}`)
        return { status: 'cluster_unavailable', reason: 'K8s cluster is not reachable (is k3d running?)' }
      }
      throw err
    }
  }

  /**
   * Get the HTTP endpoint for a pod.
   *
   * In cluster mode: returns DNS endpoint
   *   <podName>.<headlessService>.<namespace>.svc.cluster.local:50051
   *
   * In local dev mode (FICUS_K8S_LOCAL=true): returns localhost:<port>
   *   using kubectl port-forward to bridge host → pod.
   *   Requires ensurePortForward() to be called first.
   */
  getPodEndpoint(podName: string): string {
    // In local dev mode, use port-forward endpoint
    if (IS_LOCAL_DEV) {
      // Check pods map first (normal flow)
      const state = Array.from(this.pods.values()).find((p) => p.podName === podName)
      if (state) {
        const port = this.portForwardManager.getActiveExecutorPort(state.sandboxId)
        if (port !== null) {
          return `localhost:${port}`
        }
      }
      // Also check forwards directly — after API restart, pods map is empty
      // but ensurePortForward may have re-established the forward
      const port = this.portForwardManager.findActiveExecutorPortByPod(podName)
      if (port !== null) {
        return `localhost:${port}`
      }
      log.warn(`No active port-forward for pod ${podName}, falling back to cluster DNS`)
    }

    return `${podName}.${HEADLESS_SERVICE_NAME}.${this.namespace}.svc.cluster.local:${EXECUTOR_PORT}`
  }

  /**
   * Start a kubectl port-forward for a sandbox pod.
   * Only used in local dev mode (FICUS_K8S_LOCAL=true).
   * Allocates a random free port and forwards it to the pod's executor port.
   */
  async ensurePortForward(sandboxId: string, podName: string): Promise<number> {
    return this.portForwardManager.ensureExecutorForward(sandboxId, podName)
  }

  async ensureAppPortForward(sandboxId: string, podName: string, targetPort: number): Promise<number> {
    return this.portForwardManager.ensureAppForward(sandboxId, podName, targetPort)
  }

  /**
   * Stop port-forward for a sandbox.
   */
  private stopPortForward(sandboxId: string): void {
    this.portForwardManager.stopForSandbox(sandboxId)
  }

  getResourceDiagnostics(): {
    portForward: { tracked: number; live: number; starting: number; admissionOwners: number }
  } {
    return { portForward: this.portForwardManager.getDiagnostics() }
  }

  /**
   * Clean up resources — stop idle checker interval.
   */
  destroy(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval)
      this.idleCheckInterval = null
      log.info('Destroyed idle checker')
    }
    this.portForwardManager.stopAll()
  }

  // --- Private Methods ---

  getPodName(sandboxId: string): string {
    return sandboxPodName(sandboxId)
  }

  getLabelValue(value: string): string {
    return sanitizeLabelValue(value)
  }

  private updatePodState(sandboxId: string, status: PodState['status']): void {
    const state = this.pods.get(sandboxId)
    if (state) {
      const changed = state.status !== status
      state.status = status
      // Push the transition to the UI live (refetch) — only on a real change
      // so no-op updates don't spam the WebSocket.
      if (changed) eventEmitter.emit('sandbox.status', { sandboxId })
    }
  }

  /**
   * Sync the sandbox callback secret from SecretStore into a K8s Secret in the
   * sandbox namespace. K8s auto-propagates mounted secret updates to running pods
   * (~1 min delay). Called before each pod creation to ensure the secret is current.
   *
   * NOTE: the legacy `password` (FICUS_PASSWORD) key is intentionally omitted — agents
   * authenticate via the per-command FICUS_TOKEN, so shipping the shared password into
   * the box is pure exfil surface. Only the callback secret (used by the workspace
   * watcher) is delivered.
   */
  async syncAuthSecret(): Promise<void> {
    const store = getSecretStore()

    const secretBody: k8s.V1Secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: SANDBOX_AUTH_SECRET_NAME,
        namespace: this.namespace,
      },
      stringData: {
        'sandbox-callback-secret': store.get('SANDBOX_CALLBACK_SECRET') || '',
      },
    }

    try {
      await this.coreApi.replaceNamespacedSecret({
        name: SANDBOX_AUTH_SECRET_NAME,
        namespace: this.namespace,
        body: secretBody,
      })
      log.debug('Updated sandbox auth secret')
    } catch (err: unknown) {
      const status = (err as any)?.response?.statusCode ?? (err as any)?.statusCode ?? (err as any)?.code
      if (status === 404) {
        // Secret doesn't exist yet — create it
        await this.coreApi.createNamespacedSecret({
          namespace: this.namespace,
          body: secretBody,
        })
        log.info('Created sandbox auth secret')
      } else {
        log.error('Failed to sync sandbox auth secret:', err)
        throw err
      }
    }
  }

  private createPodSpec(sandboxId: string, podName: string, config?: SquadSandboxConfig): Promise<k8s.V1Pod> {
    return buildSandboxPodSpec({ sandboxId, podName, namespace: this.namespace, config })
  }

  private async waitForPodReady(
    podName: string,
    timeoutMs: number = POD_READY_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<void> {
    const startTime = this.now()
    let timeoutKind: 'unschedulable' | 'storage' | 'image' | 'terminal' | 'executor' | undefined
    let unschedulableSince: number | undefined
    log.debug(`Waiting for pod ${podName} to be ready (timeout: ${timeoutMs}ms)`)

    while (this.now() - startTime < timeoutMs) {
      try {
        const response = await this.coreApi.readNamespacedPod({ name: podName, namespace: this.namespace })
        const pod = response

        // Check for Ready condition
        const conditions = pod.status?.conditions || []
        const readyCondition = conditions.find((c) => c.type === 'Ready')

        if (readyCondition?.status === 'True') {
          log.debug(`Pod ${podName} is ready`)
          return
        }

        // Check for terminal failure states
        const phase = pod.status?.phase
        if (phase === 'Failed' || phase === 'Succeeded') {
          throw new K8sProvisionAttemptError('terminal', 'Sandbox pod terminated before becoming ready.')
        }

        const containerStatuses = pod.status?.containerStatuses || []
        const waitingReasons = containerStatuses
          .map((status) => status.state?.waiting?.reason)
          .filter((reason): reason is string => Boolean(reason))
        if (waitingReasons.some((reason) => reason === 'CrashLoopBackOff')) {
          throw new K8sProvisionAttemptError('terminal', 'The sandbox application failed during startup.')
        }
        // Only the SHARED substrate counts as correlated cluster evidence: the sandbox
        // image is identical for every box, so a pull failure or a stuck volume/sandbox
        // creation is cluster-wide. Everything else a placed container can be waiting on
        // — a bad image name, a container/config error, init containers — is scoped to
        // that one sandbox and must stay out of the cluster breaker, or a typo'd image
        // tag on a healthy cluster would stop all agent work.
        const imageWaiting = waitingReasons.some((reason) =>
          ['ImagePullBackOff', 'ErrImagePull', 'ImageInspectError'].includes(reason)
        )
        const storageWaiting = waitingReasons.includes('ContainerCreating')
        if (imageWaiting) timeoutKind = 'image'
        else if (storageWaiting) timeoutKind = 'storage'
        else if (waitingReasons.length > 0 || phase === 'Running') timeoutKind = 'executor'

        const explicitlyUnschedulable = conditions.some(
          (condition) =>
            condition.type === 'PodScheduled' && condition.status === 'False' && condition.reason === 'Unschedulable'
        )
        const scheduling = explicitlyUnschedulable || (phase === 'Pending' && waitingReasons.length === 0)
        if (scheduling) {
          unschedulableSince ??= this.now()
          timeoutKind = 'unschedulable'
          if (this.now() - unschedulableSince >= 30_000) {
            throw new K8sProvisionAttemptError('unschedulable', 'The cluster cannot currently schedule the sandbox.')
          }
        } else {
          unschedulableSince = undefined
        }
        if (waitingReasons.length > 0) log.debug(`Pod ${podName} waiting: ${waitingReasons.join(', ')}`)
      } catch (err: unknown) {
        if (
          (err as any)?.response?.statusCode === 404 ||
          (err as any)?.statusCode === 404 ||
          (err as any)?.code === 404
        ) {
          log.debug(`Pod ${podName} not found yet, retrying...`)
        } else {
          throw err
        }
      }

      await this.sleep(POD_READY_POLL_INTERVAL_MS, signal)
    }

    if (timeoutKind) {
      const messages = {
        unschedulable: 'The cluster cannot currently schedule the sandbox.',
        storage: 'The sandbox storage substrate is not ready.',
        image: 'The sandbox image could not be pulled.',
        terminal: 'The sandbox application failed during startup.',
        executor: 'The sandbox executor did not become ready.',
      }
      throw new K8sProvisionAttemptError(timeoutKind, messages[timeoutKind])
    }
    // Nothing above identified a scheduling verdict or a substrate problem, so the pod
    // was placed and simply never reported Ready. That is sandbox-scoped; defaulting to
    // `unschedulable` here would feed the cluster breaker on evidence it does not have.
    throw new K8sProvisionAttemptError('executor', 'The sandbox did not become ready before the readiness deadline.')
  }

  /**
   * Wait until a pod with the given name no longer exists in the cluster.
   * Used to drain a Terminating pod before recreating one with the same
   * deterministic name (K8s rejects a create while the old pod lingers).
   */
  private async waitForPodDeletion(
    podName: string,
    timeoutMs: number = POD_DELETION_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<void> {
    const startTime = Date.now()
    log.debug(`Waiting for pod ${podName} to be deleted (timeout: ${timeoutMs}ms)`)

    while (Date.now() - startTime < timeoutMs) {
      try {
        await this.coreApi.readNamespacedPod({ name: podName, namespace: this.namespace })
      } catch (err: unknown) {
        if (
          (err as any)?.response?.statusCode === 404 ||
          (err as any)?.statusCode === 404 ||
          (err as any)?.code === 404
        ) {
          log.debug(`Pod ${podName} fully deleted`)
          return
        }
        throw err
      }

      await this.sleep(POD_DELETION_POLL_INTERVAL_MS, signal)
    }

    throw new Error(`Timeout waiting for pod ${podName} to be deleted after ${timeoutMs}ms`)
  }

  private startIdleChecker(): void {
    this.idleCheckInterval = setInterval(() => {
      this.checkIdlePods().catch((err) => {
        log.error('Idle checker error:', err)
      })
    }, IDLE_CHECK_INTERVAL_MS)

    // Don't keep process alive just for idle checking
    if (this.idleCheckInterval.unref) {
      this.idleCheckInterval.unref()
    }
  }

  private async checkIdlePods(): Promise<void> {
    const now = Date.now()

    for (const [sandboxId, state] of this.pods) {
      if (state.status !== 'ready') continue

      if (state.alwaysOn) continue

      if (await this.shouldKeepAlive(sandboxId)) {
        log.debug(`Pod has active localDeployments; skipping idle termination: ${state.podName}`)
        continue
      }

      const idleTime = now - state.lastActivity.getTime()

      if (idleTime > state.idleTimeout) {
        log.info(`Pod idle for ${Math.round(idleTime / 1000 / 60)}min, terminating: ${state.podName}`)
        try {
          await this.terminatePod(sandboxId, 'idle')
        } catch (err) {
          log.error(`Failed to terminate idle pod ${state.podName}:`, err)
        }
      }
    }
  }

  private now(): number {
    return this.injectedNow?.() ?? Date.now()
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.injectedSleep) return this.injectedSleep(ms, signal)
    return abortablePodSleep(ms, signal)
  }
}
