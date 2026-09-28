/**
 * PortForwardManager
 *
 * Owns the kubectl port-forward lifecycle for K8s sandbox pods: spawning,
 * readiness probing, retry-with-fresh-port, and teardown. Only used in local
 * dev mode (FICUS_K8S_LOCAL=true), where the host cannot reach pod IPs directly.
 *
 * Forwards are keyed by sandbox ID for the executor port and by
 * `<sandboxId>:<targetPort>` for app ports, so one sandbox can hold several
 * forwards at once.
 */

import { Subprocess } from 'bun'
import { createLogger } from '../../../lib/infra/logger'
import { InflightDeduper, KeyedSerialQueue } from '../../../lib/infra/inflight'
import { resourceDiagnostics, type ResourceLease } from '../../../lib/infra/resource-diagnostics'
import { EXECUTOR_PORT, IS_LOCAL_DEV, LOCAL_KUBECTL_CONTEXT } from './constants'

export { EXECUTOR_PORT } from './constants'

const log = createLogger('k8s-pod-manager')

/** How many times to (re)spawn a kubectl port-forward before giving up. */
const PORT_FORWARD_MAX_ATTEMPTS = 3
/** Backoff between port-forward attempts — lets a freshly-Ready pod's netns settle. */
const PORT_FORWARD_RETRY_DELAY_MS = 250

export function buildKubectlPortForwardArgs(
  namespace: string,
  podName: string,
  localPort: number,
  kubeContext: string | null | undefined = IS_LOCAL_DEV ? LOCAL_KUBECTL_CONTEXT : undefined,
  targetPort: number = EXECUTOR_PORT
): string[] {
  const args = ['kubectl']
  if (kubeContext) args.push('--context', kubeContext)
  args.push('port-forward', '-n', namespace, `pod/${podName}`, `${localPort}:${targetPort}`)
  return args
}

/** State for a kubectl port-forward process */
interface PortForwardState {
  process: Subprocess
  localPort: number
  podName: string
  targetPort: number
  sandboxId: string
  lease: ResourceLease
}

export interface PortForwardManagerDeps {
  spawn?: (args: string[]) => Subprocess
  findFreePort?: () => Promise<number>
  /** Probe whether the forwarded local port answers; defaults to GET /healthz. */
  probeReady?: (port: number) => Promise<boolean>
  retryDelayMs?: number
  readyTimeoutMs?: number
  probeIntervalMs?: number
}

export class PortForwardManager {
  private readonly forwards = new Map<string, PortForwardState>()
  private readonly inflight = new InflightDeduper<number>()
  private readonly startQueue = new KeyedSerialQueue()
  private readonly admissionTokens = new Map<string, { stopped: boolean; admissions: number }>()
  private readonly spawn: (args: string[]) => Subprocess
  private readonly findFreePort: () => Promise<number>
  private readonly probeReady: (port: number) => Promise<boolean>
  private readonly retryDelayMs: number
  private readonly readyTimeoutMs: number
  private readonly probeIntervalMs: number

  constructor(
    private readonly namespace: string,
    deps: PortForwardManagerDeps = {}
  ) {
    this.spawn = deps.spawn ?? ((args) => Bun.spawn(args, { stdout: 'ignore', stderr: 'pipe' }))
    this.findFreePort = deps.findFreePort ?? defaultFindFreePort
    this.probeReady = deps.probeReady ?? defaultProbeReady
    this.retryDelayMs = deps.retryDelayMs ?? PORT_FORWARD_RETRY_DELAY_MS
    this.readyTimeoutMs = deps.readyTimeoutMs ?? 10_000
    this.probeIntervalMs = deps.probeIntervalMs ?? 200
  }

  /**
   * Ensure a forward to the pod's executor port, allocating a random free
   * local port. Reuses a live forward when one exists.
   */
  async ensureExecutorForward(sandboxId: string, podName: string): Promise<number> {
    return this.ensureForKey(sandboxId, sandboxId, podName, EXECUTOR_PORT)
  }

  /** Ensure a forward to an arbitrary app port inside the pod. */
  async ensureAppForward(sandboxId: string, podName: string, targetPort: number): Promise<number> {
    return this.ensureForKey(`${sandboxId}:${targetPort}`, sandboxId, podName, targetPort)
  }

  /** Local port of the sandbox's live executor forward, or null. */
  getActiveExecutorPort(sandboxId: string): number | null {
    const pf = this.forwards.get(sandboxId)
    return pf && pf.process.exitCode === null ? pf.localPort : null
  }

  /**
   * Local port of a live executor forward for the given pod, or null. Used
   * after an API restart, when the sandbox-id keyed state may be gone but the
   * forward has been re-established.
   */
  findActiveExecutorPortByPod(podName: string): number | null {
    for (const pf of this.forwards.values()) {
      if (pf.podName === podName && pf.targetPort === EXECUTOR_PORT && pf.process.exitCode === null) {
        return pf.localPort
      }
    }
    return null
  }

  getDiagnostics(): { tracked: number; live: number; starting: number; admissionOwners: number } {
    let live = 0
    for (const forward of this.forwards.values()) if (forward.process.exitCode === null) live++
    return {
      tracked: this.forwards.size,
      live,
      starting: this.inflight.size,
      admissionOwners: this.admissionTokens.size,
    }
  }

  /** Stop every forward (executor and app ports) belonging to a sandbox. */
  stopForSandbox(sandboxId: string): void {
    const stopToken = { stopped: true, admissions: 0 }
    this.admissionTokens.set(sandboxId, stopToken)
    void this.inflight.settled().then(() => {
      if (this.admissionTokens.get(sandboxId) === stopToken) this.admissionTokens.delete(sandboxId)
    })
    for (const [key, pf] of this.forwards) {
      if (key !== sandboxId && !key.startsWith(`${sandboxId}:`)) continue
      if (pf.process.exitCode === null) {
        pf.lease.finish('cancelled')
        pf.process.kill()
        log.debug(`Killed port-forward for ${key} (port ${pf.localPort})`)
      }
      this.forwards.delete(key)
    }
  }

  /** Stop all published forwards and invalidate every in-flight admission. */
  stopAll(): void {
    const sandboxIds = new Set(this.admissionTokens.keys())
    for (const forward of this.forwards.values()) sandboxIds.add(forward.sandboxId)
    for (const sandboxId of sandboxIds) this.stopForSandbox(sandboxId)
  }

  private ensureForKey(key: string, sandboxId: string, podName: string, targetPort: number): Promise<number> {
    let admissionToken = this.admissionTokens.get(sandboxId)
    if (!admissionToken || admissionToken.stopped) {
      admissionToken = { stopped: false, admissions: 0 }
      this.admissionTokens.set(sandboxId, admissionToken)
    }
    admissionToken.admissions++
    const destinationKey = `${key}\0${podName}\0${targetPort}`
    return this.inflight
      .run(destinationKey, () =>
        this.startQueue.run(key, () => this.startForKey(key, sandboxId, podName, targetPort, admissionToken))
      )
      .finally(() => {
        admissionToken.admissions--
        if (admissionToken.admissions === 0 && this.admissionTokens.get(sandboxId) === admissionToken) {
          this.admissionTokens.delete(sandboxId)
        }
      })
  }

  private async startForKey(
    key: string,
    sandboxId: string,
    podName: string,
    targetPort: number,
    admissionToken: { stopped: boolean; admissions: number }
  ): Promise<number> {
    const assertNotStopped = (): void => {
      if (this.admissionTokens.get(sandboxId) !== admissionToken)
        throw new Error(`Port-forward for ${sandboxId} was stopped`)
    }
    assertNotStopped()
    // Reuse only the live forward to the same destination. A pod replacement
    // must not inherit the old pod's tunnel under the same sandbox key.
    const existing = this.forwards.get(key)
    if (
      existing &&
      existing.process.exitCode === null &&
      existing.podName === podName &&
      existing.targetPort === targetPort
    ) {
      return existing.localPort
    }
    if (existing) {
      existing.lease.finish('cancelled')
      if (existing.process.exitCode === null) existing.process.kill()
      this.forwards.delete(key)
    }

    // A freshly-Ready pod's host port-forward can briefly fail to establish in
    // local k3d — the SPDY tunnel races the pod's network namespace settling
    // (seen as "network namespace ... is closed" or a 10s readiness timeout).
    // That's transient, so retry with a fresh port rather than hard-failing the
    // whole execution on the first miss.
    let lastErr: unknown
    for (let attempt = 1; attempt <= PORT_FORWARD_MAX_ATTEMPTS; attempt++) {
      const localPort = await this.findFreePort()
      assertNotStopped()

      const suffix = attempt > 1 ? ` (attempt ${attempt}/${PORT_FORWARD_MAX_ATTEMPTS})` : ''
      log.info(`Starting port-forward for ${sandboxId}: localhost:${localPort} → ${podName}:${targetPort}${suffix}`)

      const proc = this.spawn(buildKubectlPortForwardArgs(this.namespace, podName, localPort, undefined, targetPort))
      const lease = resourceDiagnostics.begin('port_forward')
      const state = { process: proc, localPort, podName, targetPort, sandboxId, lease }
      this.forwards.set(key, state)
      void proc.exited.finally(() => {
        lease.finish('completed')
        if (this.forwards.get(key) === state) this.forwards.delete(key)
      })

      try {
        // Wait for port-forward to be ready (or fail)
        await this.waitForReady(localPort, proc)
        assertNotStopped()
        log.info(`Port-forward ready for ${sandboxId}: localhost:${localPort}`)
        return localPort
      } catch (err) {
        lastErr = err
        // Tear down the failed forward before retrying so we don't leak the
        // kubectl process or stick a dead entry in the map.
        lease.finish('failed')
        if (proc.exitCode === null) proc.kill()
        if (this.forwards.get(key) === state) this.forwards.delete(key)
        log.warn(
          `Port-forward attempt ${attempt}/${PORT_FORWARD_MAX_ATTEMPTS} for ${sandboxId} failed: ${
            (err as Error).message
          }`
        )
        if (attempt < PORT_FORWARD_MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, this.retryDelayMs))
          assertNotStopped()
        }
      }
    }

    throw lastErr
  }

  /**
   * Wait for a port-forward to become reachable, or detect failure.
   */
  private async waitForReady(port: number, proc: Subprocess): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < this.readyTimeoutMs) {
      // Check if process died
      if (proc.exitCode !== null) {
        let stderr = ''
        if (proc.stderr && typeof (proc.stderr as any).text === 'function') {
          stderr = await new Response(proc.stderr as ReadableStream).text()
        }
        throw new Error(`Port-forward process exited with code ${proc.exitCode}: ${stderr}`)
      }

      if (await this.probeReady(port)) return

      await new Promise((r) => setTimeout(r, this.probeIntervalMs))
    }
    throw new Error(`Port-forward to localhost:${port} did not become ready within ${this.readyTimeoutMs}ms`)
  }
}

/**
 * Find a free TCP port by binding to port 0.
 */
function defaultFindFreePort(): Promise<number> {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response()
    },
  })
  const port = server.port!
  server.stop(true)
  return Promise.resolve(port)
}

async function defaultProbeReady(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://localhost:${port}/healthz`, {
      signal: AbortSignal.timeout(1000),
    })
    return resp.ok
  } catch {
    return false
  }
}
