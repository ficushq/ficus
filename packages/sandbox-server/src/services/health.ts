/** Executor liveness and non-destructive nested Docker diagnostics. */

const startTime = Date.now()
import { readExecutorCommandIdentity, type ExecutorCommandIdentity } from './command-identity'
import type { SandboxContainers, SandboxRuntimeHealth } from '@ficus/shared'
import { DOCKER_HEALTH_TIMEOUT_MS, probeBoxDocker, boxPressureSampler, staleRuncExecReason } from './processes'

interface RuntimeHealthDependencies {
  now(): number
  probeDocker(): Promise<void>
  staleExecReason(): string | undefined
  scheduleTimeout(callback: () => void, delayMs: number): () => void
}

/**
 * Demand-driven, single-flight checks, at most once per 30s. No background poll
 * loop keeps an idle box awake. Findings never gate native Bash or kill work.
 * Keep the underlying probe until it settles even after our deadline: a kernel
 * stuck Docker client must not accumulate more clients on every status poll.
 */
export class BoxRuntimeHealth {
  private state: SandboxRuntimeHealth = { status: 'ready' }
  private nextCheckAt = -Infinity
  private checking?: Promise<void>
  private probe?: Promise<void>
  private revision = 0
  private readonly deps: RuntimeHealthDependencies

  constructor(overrides: Partial<RuntimeHealthDependencies> = {}) {
    this.deps = {
      now: Date.now,
      probeDocker: async () => {
        if (process.env.FICUS_SANDBOX_ROLE !== 'agent') await probeBoxDocker()
      },
      staleExecReason: staleRuncExecReason,
      scheduleTimeout: (callback, ms) => {
        const timer = setTimeout(callback, ms)
        return () => clearTimeout(timer)
      },
      ...overrides,
    }
  }

  snapshot(): SandboxRuntimeHealth {
    return { ...this.state }
  }

  /** A Processes finding takes effect immediately, even during an older check. */
  observeContainers(containers: SandboxContainers): void {
    if (containers.available || containers.reason === 'This box runs no Docker') return
    this.revision++
    this.state = { status: 'degraded', reason: containers.reason }
    this.nextCheckAt = this.deps.now() + 30_000
  }

  refresh(): Promise<void> {
    if (this.checking) return this.checking
    if (this.deps.now() < this.nextCheckAt) return Promise.resolve()
    this.nextCheckAt = this.deps.now() + 30_000
    const revision = this.revision
    this.checking = this.check(revision).finally(() => {
      this.checking = undefined
    })
    return this.checking
  }

  private async check(revision: number): Promise<void> {
    let cancelDeadline: (() => void) | undefined
    let reason: string | undefined
    try {
      reason = this.deps.staleExecReason()
      if (!reason) {
        if (!this.probe) {
          const probe = this.deps.probeDocker()
          this.probe = probe
          void probe
            .finally(() => {
              if (this.probe === probe) this.probe = undefined
            })
            .catch(() => {})
        }
        await Promise.race([
          this.probe,
          new Promise<never>((_, reject) => {
            cancelDeadline = this.deps.scheduleTimeout(
              () => reject(new Error(`Docker did not answer within ${DOCKER_HEALTH_TIMEOUT_MS / 1_000}s`)),
              DOCKER_HEALTH_TIMEOUT_MS
            )
          }),
        ])
        // A detached exec may have crossed the deadline during the Docker probe.
        reason = this.deps.staleExecReason()
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : 'Sandbox runtime health check failed'
    } finally {
      cancelDeadline?.()
    }
    if (revision === this.revision) this.state = reason ? { status: 'degraded', reason } : { status: 'ready' }
  }
}

export const boxRuntimeHealth = new BoxRuntimeHealth()

const VERSION = process.env.EXECUTOR_VERSION || '0.2.0'

export interface DockerRuntimeHealthContract {
  runtime: 'docker'
  version: 1
  executorProtocol: 1
  capabilities: Array<'bash' | 'bash-cancel' | 'command-identity' | 'socket-proxy'>
  commandIdentity: ExecutorCommandIdentity
}

let devboxReady = false

export function setDevboxReady(ready: boolean) {
  devboxReady = ready
}

export function isDevboxReady() {
  return devboxReady
}

export function getHealthResponse(env: NodeJS.ProcessEnv = process.env, runtime = boxRuntimeHealth) {
  const commandIdentity = readExecutorCommandIdentity(env)
  const runtimeContract: DockerRuntimeHealthContract | undefined = commandIdentity
    ? {
        runtime: 'docker',
        version: 1,
        executorProtocol: 1,
        capabilities: ['bash', 'bash-cancel', 'command-identity', 'socket-proxy'],
        commandIdentity,
      }
    : undefined
  void boxPressureSampler.refresh()
  const pressure = boxPressureSampler.snapshot()
  return {
    // Liveness stays true: runtime degradation is not permission to recycle a
    // box and destroy legitimate foreground work.
    healthy: true,
    runtimeHealth: runtime.snapshot(),
    devboxReady,
    // Host and box pressure only (no process detail): health is unauthenticated.
    ...(pressure ? { pressure } : {}),
    version: VERSION,
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    ...(runtimeContract ? { runtimeContract } : {}),
  }
}
