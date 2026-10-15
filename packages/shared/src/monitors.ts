export type MonitorStatus =
  | 'starting'
  | 'running'
  | 'canceling'
  | 'exited'
  | 'canceled'
  | 'timed-out'
  | 'failed'
  | 'overload'
/**
 * What the supervisor does when a monitor's process is LOST (sandbox restart
 * or unavailability, or the process vanished without recording an exit code).
 * Normal exits, cancel, timeout and overload never restart.
 * - `never`: fail the monitor with a clear reason (default).
 * - `on-loss`: relaunch the same command once the sandbox is reachable again.
 */
export type MonitorRestartPolicy = 'never' | 'on-loss'

export interface Monitor {
  id: string
  agentId: string
  sandboxId: string
  label: string
  description: string | null
  command: string
  cwd: string | null
  status: MonitorStatus
  processId: string
  timeoutMs: number
  maxBatchLines: number
  maxBatchBytes: number
  batchDebounceMs: number
  exitCode: number | null
  failureReason: string | null
  failureKind: string | null
  linesEmitted: number
  bytesEmitted: number
  createdAt: string
  startedAt: string | null
  endedAt: string | null
  lastBatchAt: string | null
  restartPolicy: MonitorRestartPolicy
  /** Consecutive rapid restarts allowed before the monitor fails. */
  restartLimit: number
  /** Relaunches after a loss over the monitor's whole life. */
  restartCount: number
  /** Consecutive losses within the stability window of a launch; resets once a launch stays up. */
  rapidRestartCount: number
  /** Most recent (re)launch of the command. */
  launchedAt: string | null
  /** Absolute timeout deadline, preserved across relaunches. */
  deadlineAt: string | null
  /** Set while a relaunch is pending (restart backoff). */
  nextRestartAt: string | null
  lastRestartAt: string | null
  lastRestartReason: string | null
}

export interface MonitorLogs {
  lines: string[]
  note?: string
}
