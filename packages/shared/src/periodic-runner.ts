/** Minimal logger shape PeriodicRunner needs — matches console's error(). */
export interface PeriodicRunnerLogger {
  error: (...args: unknown[]) => void
}

const defaultLogger: PeriodicRunnerLogger = {
  error: (...args: unknown[]) => console.error(...args),
}

export interface PeriodicRunnerOptions {
  name: string
  intervalMs: number
  runImmediately?: boolean // default: true
  /** Logger used for task/stop errors. Defaults to a console-shaped logger. */
  logger?: PeriodicRunnerLogger
}

/**
 * Registry of every started runner, so shutdown can stop them all with one
 * call instead of each service hand-wiring its own stop into the shutdown
 * paths (a list that has historically drifted out of date).
 */
const registry = new Set<PeriodicRunner>()

/** Names of all currently-started runners — for diagnostics and tests. */
export function listPeriodicRunnerNames(): string[] {
  return [...registry].map((runner) => runner.runnerName)
}

/**
 * Every currently-started runner — for diagnostics and tests that need more
 * than the name (e.g. asserting a loop's configured interval).
 */
export function listPeriodicRunners(): PeriodicRunner[] {
  return [...registry]
}

/**
 * Stop every started periodic runner. Catch-all for graceful shutdown —
 * runner stop() is idempotent, so services that stop explicitly (to clear
 * their own module state) are unaffected by the second stop.
 */
export async function stopAllPeriodicRunners(): Promise<void> {
  const runners = [...registry]
  await Promise.all(
    runners.map((runner) =>
      runner.stop().catch((err) => {
        runner.runnerLogger.error(`Failed to stop periodic runner ${runner.runnerName}:`, err)
      })
    )
  )
}

export abstract class PeriodicRunner {
  protected readonly name: string
  protected readonly intervalMs: number
  protected readonly logger: PeriodicRunnerLogger
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private runPromise: Promise<void> | null = null

  private readonly _runImmediately: boolean

  constructor(options: PeriodicRunnerOptions) {
    this.name = options.name
    this.intervalMs = options.intervalMs
    this._runImmediately = options.runImmediately !== false
    this.logger = options.logger ?? defaultLogger
  }

  /** The runner's configured name (exposed for the registry/diagnostics). */
  get runnerName(): string {
    return this.name
  }

  /** The runner's configured interval in ms (exposed for diagnostics/tests). */
  get runnerIntervalMs(): number {
    return this.intervalMs
  }

  /** The runner's logger (exposed for the registry/stopAll diagnostics). */
  get runnerLogger(): PeriodicRunnerLogger {
    return this.logger
  }

  /** Override this with the actual work */
  protected abstract runTask(): Promise<void>

  /** Start the periodic runner */
  start(): void {
    if (this.timer !== null) return // already started

    registry.add(this)

    if (this._runImmediately) {
      this.executeTask()
    }

    this.timer = setInterval(() => {
      this.executeTask()
    }, this.intervalMs)
  }

  /** Stop the periodic runner */
  async stop(): Promise<void> {
    registry.delete(this)
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }

    // Wait for any in-flight task to complete
    if (this.runPromise) {
      await this.runPromise
    }
  }

  /** Check if currently running */
  isRunning(): boolean {
    return this.running
  }

  /** Manually trigger a run (respects running guard) */
  async trigger(): Promise<void> {
    await this.executeTask()
  }

  private async executeTask(): Promise<void> {
    if (this.running) return

    this.running = true
    this.runPromise = this.runTask()
      .catch((err) => {
        this.logger.error(`${this.name}: Task error:`, err)
      })
      .finally(() => {
        this.running = false
        this.runPromise = null
      })

    await this.runPromise
  }
}

/** Factory for simple one-off periodic tasks (no subclassing needed) */
export function createPeriodicRunner(options: PeriodicRunnerOptions & { task: () => Promise<void> }): PeriodicRunner {
  const { task, ...baseOptions } = options

  class SimplePeriodicRunner extends PeriodicRunner {
    protected async runTask(): Promise<void> {
      await task()
    }
  }

  return new SimplePeriodicRunner(baseOptions)
}
