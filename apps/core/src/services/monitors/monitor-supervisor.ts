import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { monitors } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { Monitor } from '../../entities/Monitor'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { getSandboxManager, type ISandboxManager } from '../sandbox'
import { recordLaunchPathCommand } from '../sandbox/launch-path'
import { LAUNCHER_SCRIPT, monitorDir, monitorWorkRoot, sessionNameForMonitor, shellQuote } from './launcher'

const log = createLogger('monitor-supervisor')
const MIN_BATCH_INTERVAL_MS = 2000
const MAX_PENDING_BYTES = 64 * 1024
const ACTIVE_CAP_PER_AGENT = 3
const MAX_DROPPED_LINES = 500

// Exit-poll backoff. Every poll is a sandbox exec round trip per ACTIVE
// monitor, so a flat 2s tick charged the same price to a 3-second build and to
// a log tail that runs for an hour. Stay at 2s while a monitor is young (short
// commands, the common case, still report their exit within ~2s), then step
// down: 5s after the first 30s, 15s after two minutes.
const POLL_FAST_INTERVAL_MS = 2_000
const POLL_FAST_WINDOW_MS = 30_000
const POLL_MID_INTERVAL_MS = 5_000
const POLL_MID_WINDOW_MS = 120_000
const POLL_MAX_INTERVAL_MS = 15_000

/**
 * A loss within this long of the most recent (re)launch is RAPID and counts
 * toward the restart limit; a launch that stays up this long resets the count.
 */
export const MONITOR_STABILITY_WINDOW_MS = 5 * 60_000
/** Delay before relaunching, indexed by the consecutive rapid-restart count (capped at the last entry). */
export const MONITOR_RESTART_BACKOFF_MS = [5_000, 30_000, 120_000, 300_000] as const
/**
 * How long an unreachable sandbox is waited for (after the poll failure
 * tolerance) before the monitor is failed. The process may well still be alive
 * when the box comes back, so unavailability alone is not a loss.
 */
export const MONITOR_SANDBOX_GRACE_MS = 15 * 60_000
/** Retry interval for a relaunch whose sandbox is not reachable yet. */
const RESTART_RETRY_MS = 15_000
/** At most one sandbox re-ensure per monitor per minute while it is unreachable. */
const ENSURE_THROTTLE_MS = 60_000
/** Output read at the end of a run that the live stream had not delivered yet. */
const CATCH_UP_MAX_BYTES = 256 * 1024

const DIR_GONE = '__MONITOR_DIR_GONE__'
const PROCESS_GONE = '__MONITOR_PROCESS_GONE__'
const LOG_SIZE_MARKER = '__FICUS_MONITOR_LOG_SIZE__='

/**
 * Delay before the next exit poll, given how long the monitor has been polled.
 * Exported for the schedule test — the supervisor tracks `elapsedMs` as the sum
 * of the delays it has already scheduled, so the schedule is deterministic and
 * does not depend on wall-clock drift between rounds.
 */
export function monitorExitPollIntervalMs(elapsedMs: number): number {
  if (elapsedMs < POLL_FAST_WINDOW_MS) return POLL_FAST_INTERVAL_MS
  if (elapsedMs < POLL_MID_WINDOW_MS) return POLL_MID_INTERVAL_MS
  return POLL_MAX_INTERVAL_MS
}

/** Backoff before a relaunch: 5s, 30s, 2m, then 5m for every further rapid restart. */
export function monitorRestartBackoffMs(rapidRestartCount: number): number {
  const index = Math.min(Math.max(rapidRestartCount - 1, 0), MONITOR_RESTART_BACKOFF_MS.length - 1)
  return MONITOR_RESTART_BACKOFF_MS[index]
}

function formatMinutes(ms: number): string {
  return `${Math.round(ms / 60_000)}m`
}

/** One-line restart summary for agent-facing tool output. */
export function describeMonitorRestart(monitor: Monitor): string {
  if (monitor.restartPolicy !== 'on-loss') return 'restart: never'
  const parts = [`restart: on-loss (limit ${monitor.restartLimit} rapid restarts)`]
  if (monitor.restartCount > 0) parts.push(`restarted ${monitor.restartCount}x`)
  if (monitor.rapidRestartCount > 0) parts.push(`rapid ${monitor.rapidRestartCount}/${monitor.restartLimit}`)
  if (monitor.lastRestartReason) parts.push(`last loss: ${monitor.lastRestartReason}`)
  if (monitor.nextRestartAt) parts.push(`relaunch pending at ${monitor.nextRestartAt.toISOString()}`)
  return parts.join('; ')
}

type SendMessage = (
  agentId: string,
  content: string,
  options: { deliveryMode: 'steer'; metadata: Record<string, unknown> }
) => Promise<unknown>

type LossKind = 'sandbox-restarted' | 'process-lost'
const LOSS_REASON: Record<LossKind, string> = {
  'sandbox-restarted': 'sandbox restarted',
  'process-lost': 'process ended without recording an exit code (sandbox restart or killed)',
}

type TerminalStatus = 'exited' | 'canceled' | 'timed-out' | 'overload' | 'failed'

export interface MonitorSupervisorOptions {
  /** Clock seam for the stability window, deadlines and backoff bookkeeping. */
  now?: () => number
  /**
   * Re-ensure an unreachable sandbox (e.g. a box this Core process has not
   * attached since it restarted). Resolves true when it is back.
   */
  ensureSandboxReachable?: (sandboxId: string) => Promise<boolean>
  /** Test seam: the relaunch backoff for a given consecutive rapid-restart count. */
  restartBackoffMs?: (rapidRestartCount: number) => number
  /** Test seam: the retry interval while a relaunch cannot reach its sandbox. */
  restartRetryMs?: number
}

type PendingLine = {
  line: string
  /** Log byte offset just past this line; null when it belongs to a log that was replaced. */
  end: number | null
}

type State = {
  monitor: Monitor
  squadId: string | null
  pending: PendingLine[]
  pendingBytes: number
  timer?: Timer
  pollTimer?: Timer
  timeoutTimer?: Timer
  restartTimer?: Timer
  subscription?: { cancel: () => void }
  /** Bumped whenever the stream is replaced or stopped; stale callbacks compare against it. */
  streamGeneration: number
  /** The log stream ended while the monitor is active; re-established on the next good poll. */
  streamDown: boolean
  /**
   * Byte offset in logs/current.log just past the last COMPLETE line received
   * (delivered or still pending). A re-established stream resumes here, so
   * nothing is dropped or duplicated. null = unknown (a pre-tracking row).
   */
  receivedOffset: number | null
  /** Trailing bytes of an incomplete line; never counted in receivedOffset. */
  lineBuffer: Buffer
  /** Bumped when the log is replaced and offsets restart at 0; a batch from an older epoch never persists its offset. */
  logEpoch: number
  lastFlushAt?: number
  droppedLines: number
  droppedTotal: number
  overloadTriggered?: boolean
  /** A terminal transition is in progress. */
  finishing?: boolean
  /** A deliberate stop (cancel/timeout/overload) is killing the session: never a loss. */
  stopping?: boolean
  /** Consecutive pollExit exec failures — reset on any successful poll. */
  pollFailureCount?: number
  /** Sum of the exit-poll delays scheduled so far — drives the poll backoff. */
  pollElapsedMs?: number
  /** When the sandbox was first considered unreachable (after the failure tolerance). */
  unreachableSince?: number
  lastEnsureAt?: number
}

async function defaultEnsureSandboxReachable(sandboxId: string): Promise<boolean> {
  // Re-ensures through the same owner-aware path the outage recovery watch
  // uses (squad box / agent box), so a box this process has not attached since
  // a Core restart becomes reachable without waiting for the agent to wake.
  const { defaultIsSandboxReady } = await import('../sandbox/recovery-watch')
  return defaultIsSandboxReady(sandboxId)
}

/**
 * Supervises agent background monitors: a tmux session in the monitor's
 * sandbox runs the command (see LAUNCHER_SCRIPT), a live `tail -F` stream
 * delivers its log, and an exit poll watches for completion or loss.
 *
 * Lifecycle guarantees (docs/wiki/agent-background-monitors.md):
 * - Core shutdown DETACHES (in-memory only); `recoverOnStartup` reattaches to
 *   still-running sessions without rerunning or counting anything.
 * - A LOSS (sandbox restarted, or the process vanished without an exit code)
 *   follows the monitor's restart policy: `never` fails with a clear reason,
 *   `on-loss` relaunches with backoff and a rapid-restart limit. Exits,
 *   cancel, timeout and overload never restart.
 * - The deadline is absolute and survives relaunches and Core restarts.
 */
export class MonitorSupervisor {
  private states = new Map<string, State>()
  private readonly now: () => number
  private readonly ensureSandboxReachable: (sandboxId: string) => Promise<boolean>
  private readonly restartBackoffMs: (rapidRestartCount: number) => number
  private readonly restartRetryMs: number

  constructor(
    private managerInstance?: ISandboxManager,
    private sendMessage: SendMessage = async (agentId, content, options) => {
      const agent = await Agent.mustFind(agentId)
      await agent.sendMessage(content, options)
    },
    private maxDroppedLines: number = MAX_DROPPED_LINES,
    options: MonitorSupervisorOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.ensureSandboxReachable = options.ensureSandboxReachable ?? defaultEnsureSandboxReachable
    this.restartBackoffMs = options.restartBackoffMs ?? monitorRestartBackoffMs
    this.restartRetryMs = options.restartRetryMs ?? RESTART_RETRY_MS
  }

  // Lazily resolve the sandbox manager so this class can be instantiated
  // at module load time without triggering the factory circular-dep TDZ.
  private get manager(): ISandboxManager {
    this.managerInstance ??= getSandboxManager()
    return this.managerInstance
  }

  async start(monitor: Monitor): Promise<void> {
    const activeCount = (await Monitor.listForAgent(monitor.agentId, { status: Monitor.activeStatuses() })).length
    if (activeCount > ACTIVE_CAP_PER_AGENT) {
      const error = new Error(`Agent already has ${ACTIVE_CAP_PER_AGENT} active monitors`)
      await this.markStartFailed(monitor, error)
      throw error
    }

    try {
      const launched = await this.launch(monitor)
      if (!launched.running) {
        await this.killSession(monitor, 'cancel during start')
        throw new Error('monitor was canceled while starting')
      }
      await this.attach(monitor)
      await this.emitMonitorEvent('monitor.created', monitor, 'running')
    } catch (error) {
      await this.markStartFailed(monitor, error)
      throw error
    }
  }

  private workPaths(monitor: Monitor, squadId: string | null) {
    const workRoot = monitorWorkRoot({ squadId: squadId ?? undefined, sandboxId: monitor.sandboxId })
    const dir = monitorDir(workRoot, monitor.id)
    return { workRoot, dir, logFile: `${dir}/logs/current.log` }
  }

  /**
   * Write the launcher script and start a detached tmux session for the
   * command. The ONLY place a command is (re)started: `start()` for a new
   * monitor and `performRestart()` for an `on-loss` relaunch.
   *
   * The log is appended to, never truncated, so output a lost run wrote but
   * the stream had not delivered is still read on relaunch. Only when the log
   * is shorter than the delivered offset (the box was recreated and the file
   * wiped) does the offset reset to 0. `running` is false when the monitor was
   * canceled concurrently (the guarded transition missed).
   */
  private async launch(monitor: Monitor, state?: State): Promise<{ running: boolean }> {
    const processId = monitor.processId || sessionNameForMonitor(monitor.id)
    if (!monitor.processId) await monitor.update({ processId })
    const squadId = await this.resolveSquadId(monitor.agentId)
    const { workRoot, dir, logFile } = this.workPaths(monitor, squadId)
    const script = `${dir}/run.sh`
    const cwd = monitor.cwd?.trim() || workRoot
    const monitorEnv: Record<string, string> = {
      FICUS_MONITOR_ID: monitor.id,
      FICUS_MONITOR_CWD: cwd,
      FICUS_MONITOR_DIR: dir,
      FICUS_MONITOR_COMMAND: monitor.command,
    }
    const launchCommand = [
      ...Object.entries(monitorEnv).map(([key, value]) => `${key}=${shellQuote(value)}`),
      `bash ${shellQuote(script)}`,
    ].join(' ')
    const command = [
      'set -e',
      `mkdir -p ${shellQuote(`${dir}/logs`)}`,
      `cat > ${shellQuote(script)} <<'EOF'\n${LAUNCHER_SCRIPT}EOF`,
      `chmod +x ${shellQuote(script)}`,
      // The tmux session gets the tmux server's PATH, not ours (see launch-path.ts).
      recordLaunchPathCommand(dir),
      // A stale exitCode from a lost run must not read as this run's exit.
      `rm -f ${shellQuote(`${dir}/exitCode`)} ${shellQuote(`${dir}/exitedAt`)}`,
      `touch ${shellQuote(logFile)}`,
      // Measured BEFORE the new run can append to it.
      `log_size=$(wc -c < ${shellQuote(logFile)} | tr -d ' ')`,
      `tmux kill-session -t ${shellQuote(processId)} 2>/dev/null || true`,
      `tmux new-session -d -s ${shellQuote(processId)} ${shellQuote(launchCommand)}`,
      `echo "${LOG_SIZE_MARKER}$log_size"`,
    ].join('\n')
    const out = await this.manager.exec(monitor.sandboxId, ['bash', '-lc', command])
    const size = parseLogSize(out.toString())
    const previous = monitor.logOffset
    // Everything this process has read, delivered or not.
    const received = state?.receivedOffset ?? previous
    let logOffset = previous
    if (received === null) {
      logOffset = size ?? 0
      if (state) state.receivedOffset = logOffset
    } else if (size !== null && size < received) {
      // The log is shorter than what was already read: it was replaced.
      // Applied synchronously, before any await, so a batch already in flight
      // for the old log can no longer persist its (now meaningless) offset.
      logOffset = 0
      if (state) {
        state.logEpoch++
        for (const line of state.pending) line.end = null
        state.receivedOffset = 0
      }
    }
    if (logOffset !== previous) await monitor.update({ logOffset })
    const running = await monitor.markRunning(new Date(this.now()))
    return { running }
  }

  private async resolveSquadId(agentId: string): Promise<string | null> {
    return (await Agent.find(agentId))?.squadId ?? null
  }

  private async emitMonitorEvent(
    event: 'monitor.created' | 'monitor.updated' | 'monitor.ended',
    monitor: Monitor,
    status: string
  ): Promise<void> {
    eventEmitter.emit(event, {
      monitorId: monitor.id,
      agentId: monitor.agentId,
      squadId: await this.resolveSquadId(monitor.agentId),
      status,
    })
  }

  private async markStartFailed(monitor: Monitor, error: unknown): Promise<void> {
    // start() is only ever called synchronously from the monitor tool, which surfaces this
    // failure directly to the agent — so we record state and emit for the UI without sending a
    // duplicate agent message.
    const state = this.states.get(monitor.id)
    if (state) this.release(state)
    const reason = error instanceof Error ? error.message : String(error)
    await monitor.markEnded('failed', null, reason, 'infrastructure')
    await this.emitMonitorEvent('monitor.ended', monitor, 'failed')
  }

  /**
   * Take ownership of a running (or restart-pending) monitor in this process:
   * arm its absolute deadline, open the log stream from the persisted offset
   * and start the exit poll. Never launches anything. `pollNow` runs the first
   * liveness probe immediately (recovery after a Core restart).
   */
  async attach(monitor: Monitor, options: { pollNow?: boolean } = {}): Promise<void> {
    const existing = this.states.get(monitor.id)
    if (existing) this.release(existing)
    const state: State = {
      monitor,
      squadId: await this.resolveSquadId(monitor.agentId),
      pending: [],
      pendingBytes: 0,
      streamGeneration: 0,
      streamDown: false,
      receivedOffset: monitor.logOffset,
      lineBuffer: Buffer.alloc(0),
      logEpoch: 0,
      droppedLines: 0,
      droppedTotal: 0,
    }
    this.states.set(monitor.id, state)
    const remainingMs = monitor.effectiveDeadline().getTime() - this.now()
    state.timeoutTimer = setTimeout(
      () => this.detached('timeout', monitor.id, () => this.timeout(monitor.id)),
      Math.max(0, remainingMs)
    )
    // Past its deadline (Core was down when it expired): the timeout above
    // stops it; there is nothing to stream or poll.
    if (remainingMs <= 0) return
    if (monitor.nextRestartAt) {
      // A relaunch was pending when Core stopped; it was already counted.
      this.scheduleRestart(state, monitor.nextRestartAt.getTime() - this.now())
      return
    }
    await this.openStream(state)
    this.scheduleExitPoll(state, options.pollNow ? 0 : undefined)
  }

  /**
   * Arm the next exit poll and re-arm after it completes.
   *
   * A self-rescheduling timeout rather than a fixed interval: the delay grows
   * with the monitor's age (see {@link monitorExitPollIntervalMs}), and polls
   * can no longer overlap when a sandbox exec is slower than the interval.
   */
  private scheduleExitPoll(state: State, delayOverrideMs?: number): void {
    const monitorId = state.monitor.id
    const delayMs = delayOverrideMs ?? monitorExitPollIntervalMs(state.pollElapsedMs ?? 0)
    state.pollElapsedMs = (state.pollElapsedMs ?? 0) + delayMs
    state.pollTimer = setTimeout(() => {
      state.pollTimer = undefined
      this.detached('pollExit', monitorId, async () => {
        try {
          await this.pollExit(monitorId)
        } finally {
          // Re-arm only while still attached and actually running: terminal
          // paths mark the state finishing, and a pending relaunch owns its own
          // timer until the new run starts polling again.
          if (this.states.get(monitorId) === state && !state.finishing && !state.restartTimer && !state.pollTimer)
            this.scheduleExitPoll(state)
        }
      })
    }, delayMs)
  }

  /**
   * Run a timer callback that nothing awaits, absorbing its rejection.
   *
   * Every terminal path here ends in `markEnded`, which throws when the
   * monitor row is gone — the monitor was deleted while its timeout was still
   * pending. A bare `void this.timeout(id)` turns that into a process-level
   * UNHANDLED rejection: fatal noise in ficus-worker, and in CI it surfaced as
   * "Unhandled error between tests" charged to whichever unrelated test
   * happened to be running when a 60s monitor timer finally fired.
   */
  private detached(what: string, monitorId: string, work: () => Promise<void>): void {
    void work().catch((err) => log.error(`monitor ${monitorId}: ${what} failed`, err))
  }

  /** Drop every timer a state owns. Idempotent. */
  private clearTimers(state: State): void {
    if (state.timer) clearTimeout(state.timer)
    if (state.pollTimer) clearTimeout(state.pollTimer)
    if (state.timeoutTimer) clearTimeout(state.timeoutTimer)
    if (state.restartTimer) clearTimeout(state.restartTimer)
    state.timer = undefined
    state.pollTimer = undefined
    state.timeoutTimer = undefined
    state.restartTimer = undefined
  }

  /** Stop the live log stream; callbacks from it are ignored from here on. */
  private stopStream(state: State): void {
    state.streamGeneration++
    state.subscription?.cancel()
    state.subscription = undefined
    state.streamDown = false
    // A partial line is re-read from receivedOffset by the next reader.
    state.lineBuffer = Buffer.alloc(0)
  }

  /** Forget a monitor in this process without touching its row or session. */
  private release(state: State): void {
    this.clearTimers(state)
    this.stopStream(state)
    if (this.states.get(state.monitor.id) === state) this.states.delete(state.monitor.id)
  }

  /**
   * (Re)open the live log stream from `receivedOffset` (`tail -c +N -F`), so
   * a stream re-established after an error, a sandbox gap or a Core restart
   * neither drops nor repeats output. A stream that ends while the monitor is
   * active is marked down and re-opened by the next successful exit poll.
   */
  private async openStream(state: State): Promise<void> {
    if (!this.manager.streamExec) throw new Error('Sandbox manager does not support streaming exec')
    this.stopStream(state)
    const generation = state.streamGeneration
    const { dir, logFile } = this.workPaths(state.monitor, state.squadId)
    if (state.receivedOffset === null) {
      // A row from before offsets were tracked: start at the log's current end
      // (the pre-tracking behavior) rather than replaying delivered output.
      try {
        const out = await this.manager.exec(state.monitor.sandboxId, [
          'bash',
          '-lc',
          `wc -c < ${shellQuote(logFile)} 2>/dev/null | tr -d ' ' || true`,
        ])
        const size = Number.parseInt(out.toString().trim(), 10)
        state.receivedOffset = Number.isNaN(size) ? 0 : size
        await state.monitor.update({ logOffset: state.receivedOffset })
      } catch (err) {
        log.warn(`monitor ${state.monitor.id}: could not size its log; stream deferred`, err)
        state.streamDown = true
        return
      }
      if (generation !== state.streamGeneration || state.finishing) return
    }
    const startByte = (state.receivedOffset ?? 0) + 1
    const command =
      `mkdir -p ${shellQuote(`${dir}/logs`)} && touch ${shellQuote(logFile)} && ` +
      `exec tail -c +${startByte} -F ${shellQuote(logFile)}`
    try {
      state.subscription = this.manager.streamExec(
        state.monitor.sandboxId,
        ['bash', '-lc', command],
        (chunk) => {
          if (generation === state.streamGeneration && !state.finishing) this.ingest(state, chunk)
        },
        (chunk) =>
          log.warn('monitor stderr', {
            monitorId: state.monitor.id,
            stderr: chunk.toString(),
          }),
        () => {
          if (generation !== state.streamGeneration || state.finishing) return
          // Keep the partial-line buffer: a runtime may still deliver trailing
          // chunks of this stream after signalling its end, and they continue
          // that line. Reopening (stopStream) discards it and re-reads it.
          log.info(`monitor ${state.monitor.id}: log stream ended; re-establishing after the next successful poll`)
          state.subscription = undefined
          state.streamDown = true
        }
      )
    } catch (err) {
      // The sandbox is not reachable from this process right now; the exit
      // poll's recovery path re-opens the stream once it is.
      log.warn(`monitor ${state.monitor.id}: could not open log stream`, err)
      state.streamDown = true
    }
  }

  /** Split raw log bytes into complete lines, advancing receivedOffset by exactly the bytes consumed. */
  private ingest(state: State, chunk: Buffer): void {
    let buffer = state.lineBuffer.length ? Buffer.concat([state.lineBuffer, chunk]) : chunk
    let newline = buffer.indexOf(0x0a)
    while (newline !== -1) {
      this.consumeLine(state, buffer.subarray(0, newline), 1)
      buffer = buffer.subarray(newline + 1)
      newline = buffer.indexOf(0x0a)
    }
    // An unterminated line longer than the pending cap is delivered as-is
    // rather than buffered without bound.
    if (buffer.length > MAX_PENDING_BYTES) {
      this.consumeLine(state, buffer, 0)
      buffer = Buffer.alloc(0)
    }
    state.lineBuffer = Buffer.from(buffer)
  }

  private consumeLine(state: State, bytes: Buffer, terminatorBytes: number): void {
    if (state.receivedOffset !== null) state.receivedOffset += bytes.length + terminatorBytes
    if (bytes.length > 0) this.pushLine(state, bytes.toString(), state.receivedOffset)
  }

  /** Test/compat seam: feed raw stdout as if it came from the live stream. */
  onStdoutChunk(monitorId: string, chunk: Buffer | string): void {
    const state = this.states.get(monitorId)
    if (!state || state.finishing) return
    this.ingest(state, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  private pushLine(state: State, line: string, end: number | null): void {
    const monitorId = state.monitor.id
    state.pending.push({ line, end })
    state.pendingBytes += Buffer.byteLength(line)
    while (state.pendingBytes > MAX_PENDING_BYTES && state.pending.length) {
      const dropped = state.pending.shift()!
      state.pendingBytes -= Buffer.byteLength(dropped.line)
      state.droppedLines++
      state.droppedTotal++
    }
    if (state.droppedTotal > this.maxDroppedLines && !state.finishing && !state.overloadTriggered) {
      state.overloadTriggered = true
      this.detached('overload', monitorId, () => this.overload(monitorId))
    }
    if (!state.timer && !state.finishing)
      state.timer = setTimeout(
        () => this.detached('flush', monitorId, () => this.flush(monitorId)),
        state.monitor.batchDebounceMs
      )
  }

  async flush(monitorId: string): Promise<void> {
    const state = this.states.get(monitorId)
    if (!state || state.pending.length === 0) return
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
    const elapsed = Date.now() - (state.lastFlushAt ?? 0)
    if (state.lastFlushAt && elapsed < MIN_BATCH_INTERVAL_MS) {
      state.timer = setTimeout(
        () => this.detached('flush', monitorId, () => this.flush(monitorId)),
        MIN_BATCH_INTERVAL_MS - elapsed
      )
      return
    }
    await this.flushOnce(state)
    // Lines beyond the per-batch caps remain buffered; schedule the next batch so they are
    // delivered (paced by the minimum inter-batch interval) rather than silently retained.
    if (state.pending.length > 0 && !state.finishing && !state.timer) {
      state.timer = setTimeout(
        () => this.detached('flush', monitorId, () => this.flush(monitorId)),
        MIN_BATCH_INTERVAL_MS
      )
    }
  }

  /** Deliver remaining buffered output immediately, ignoring the inter-batch interval. */
  private async drain(state: State): Promise<void> {
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    while (state.pending.length > 0) await this.flushOnce(state)
  }

  /**
   * Send a single batch honoring per-batch line/byte caps, then persist the
   * delivered log offset with the batch counters. Does not schedule follow-up
   * flushes.
   */
  private async flushOnce(state: State): Promise<void> {
    if (state.pending.length === 0) return
    const epoch = state.logEpoch
    const lines: string[] = []
    let bytes = 0
    let byteTruncated = false
    let deliveredThrough: number | null = null
    while (state.pending.length && lines.length < state.monitor.maxBatchLines) {
      const next = state.pending[0]
      const nextBytes = Buffer.byteLength(`${next.line}\n`)
      const remainingBytes = state.monitor.maxBatchBytes - bytes
      if (nextBytes > remainingBytes) {
        if (lines.length > 0 || remainingBytes <= 0) break
        state.pending.shift()
        state.pendingBytes -= Buffer.byteLength(next.line)
        if (next.end !== null) deliveredThrough = next.end
        const marker = '… [line truncated by byte cap]'
        const markerBytes = Buffer.byteLength(marker)
        const lineBudget = Math.max(0, state.monitor.maxBatchBytes - markerBytes - 1)
        const truncatedLine = `${Buffer.from(next.line).subarray(0, lineBudget).toString()}${marker}`
        lines.push(truncatedLine)
        bytes += Buffer.byteLength(`${truncatedLine}\n`)
        byteTruncated = true
        break
      }
      state.pending.shift()
      state.pendingBytes -= Buffer.byteLength(next.line)
      if (next.end !== null) deliveredThrough = next.end
      lines.push(next.line)
      bytes += nextBytes
    }
    // Only lines genuinely lost to the pending-buffer cap are "dropped"; lines still in the
    // pending buffer are delivered in a later batch, so they must not be reported as lost.
    const dropped = state.droppedLines
    state.droppedLines = 0
    const suffix = `${byteTruncated ? '\n[line truncated by byte cap]' : ''}${dropped > 0 ? `\n[+${dropped} lines dropped (buffer full)]` : ''}`
    const shortId = state.monitor.id.slice(0, 8)
    const content = `Monitor "${state.monitor.label}" (${shortId}) — ${lines.length} new line(s):\n${lines.map((l) => `> ${l}`).join('\n')}${suffix}`
    await this.sendMessage(state.monitor.agentId, content, {
      deliveryMode: 'steer',
      metadata: {
        source: 'monitor',
        wakeEligible: false,
        monitor: { id: state.monitor.id, label: state.monitor.label, kind: 'lines', lineCount: lines.length },
      },
    })
    state.lastFlushAt = Date.now()
    await state.monitor.update({
      linesEmitted: state.monitor.linesEmitted + lines.length,
      bytesEmitted: state.monitor.bytesEmitted + bytes,
      lastBatchAt: new Date(),
      // What a reattach after a Core restart resumes from: everything up to
      // here has reached the agent; anything after it is re-read, not lost.
      ...(deliveredThrough !== null && epoch === state.logEpoch ? { logOffset: deliveredThrough } : {}),
    })
  }

  async cancel(monitorId: string, options: { notifyAgent?: boolean } = {}): Promise<void> {
    const monitor = await Monitor.mustFind(monitorId)
    if (!Monitor.activeStatuses().includes(monitor.status)) return

    // Mark the in-process run as deliberately stopping BEFORE the kill, so a
    // concurrent poll cannot mistake the vanished session for a loss.
    const state = this.states.get(monitorId)
    if (state) state.stopping = true
    await monitor.update({ status: 'canceling' })
    await this.emitMonitorEvent('monitor.updated', monitor, 'canceling')
    await this.killSession(monitor, 'cancel')

    if (state && this.states.get(monitorId) === state) {
      state.monitor = monitor
      await this.finish(state, 'canceled', null, { notifyAgent: options.notifyAgent !== false })
      return
    }

    await monitor.markEnded('canceled', null)
    if (options.notifyAgent !== false) {
      const shortId = monitor.id.slice(0, 8)
      await this.sendMessage(monitor.agentId, `Monitor "${monitor.label}" (${shortId}) canceled.`, {
        deliveryMode: 'steer',
        metadata: {
          source: 'monitor',
          wakeEligible: false,
          monitor: { id: monitor.id, label: monitor.label, kind: 'canceled', exitCode: null },
        },
      })
    }
    await this.emitMonitorEvent('monitor.ended', monitor, 'canceled')
  }

  private async killSession(monitor: Monitor, why: string): Promise<void> {
    if (!monitor.processId) return
    try {
      await this.manager.exec(monitor.sandboxId, [
        'bash',
        '-lc',
        `tmux kill-session -t ${shellQuote(monitor.processId)} || true`,
      ])
    } catch (err) {
      // Sandbox may be gone; proceed to the terminal transition regardless.
      log.warn(`monitor ${monitor.id}: kill-session failed on ${why}, proceeding`, err)
    }
  }

  /** Consecutive failed polls tolerated before treating the sandbox as
   *  unreachable. A single transient exec failure (tunnel blip, box briefly
   *  saturated, a ~12s recreate window) must not change anything. Past the
   *  tolerance the monitor WAITS for the sandbox (re-ensuring it) for up to
   *  {@link MONITOR_SANDBOX_GRACE_MS}: whether the run survived is decided by
   *  the first successful probe, not by the outage itself. */
  static readonly POLL_FAILURE_TOLERANCE = 5

  /**
   * One liveness probe. Order matters: tmux liveness is sampled BEFORE the
   * exitCode file, and the launcher writes exitCode before its session ends,
   * so "no session and no exitCode" can only mean the process was lost.
   */
  private probeCommand(state: State): string {
    const { dir } = this.workPaths(state.monitor, state.squadId)
    return (
      `if [ ! -d ${shellQuote(dir)} ]; then echo ${DIR_GONE}; ` +
      `else alive=0; tmux has-session -t ${shellQuote(state.monitor.processId)} 2>/dev/null && alive=1; ` +
      `if [ -f ${shellQuote(`${dir}/exitCode`)} ]; then cat ${shellQuote(`${dir}/exitCode`)}; ` +
      `elif [ "$alive" = 0 ]; then echo ${PROCESS_GONE}; fi; fi`
    )
  }

  async pollExit(monitorId: string): Promise<void> {
    const state = this.states.get(monitorId)
    if (!state || state.finishing || state.stopping || state.restartTimer) return
    let text: string
    try {
      text = (await this.manager.exec(state.monitor.sandboxId, ['bash', '-lc', this.probeCommand(state)]))
        .toString()
        .trim()
    } catch (err) {
      await this.onPollFailure(state, err)
      return
    }
    if (this.states.get(monitorId) !== state || state.finishing || state.stopping) return
    if (state.unreachableSince !== undefined) log.info(`monitor ${monitorId}: sandbox reachable again`)
    state.pollFailureCount = 0
    state.unreachableSince = undefined

    // The row is authoritative across processes: a cancel from the API (or
    // agent cleanup) may have ended it, possibly without reaching tmux.
    const current = await Monitor.find(monitorId)
    if (!current || !Monitor.activeStatuses().includes(current.status)) {
      log.info(`monitor ${monitorId}: ended elsewhere (${current?.status ?? 'deleted'}); stopping its session`)
      await this.killSession(state.monitor, 'external end')
      this.release(state)
      return
    }
    const canceling = current.status === 'canceling'
    const result = text.split('\n').at(-1)?.trim() ?? ''

    if (result === DIR_GONE || result === PROCESS_GONE) {
      if (canceling) {
        await this.finish(state, 'canceled', null)
        return
      }
      log.warn(`monitor ${monitorId}: ${result === DIR_GONE ? 'work dir missing' : 'session gone without exitCode'}`)
      await this.handleLoss(state, result === DIR_GONE ? 'sandbox-restarted' : 'process-lost')
      return
    }
    if (result !== '') {
      const exitCode = Number.parseInt(result, 10)
      await this.finish(state, canceling ? 'canceled' : 'exited', Number.isNaN(exitCode) ? null : exitCode, {
        catchUp: !canceling,
      })
      return
    }

    // Still running.
    if (canceling) return // the canceller is stopping it
    if (state.streamDown) await this.openStream(state)
    await this.resetRapidCountIfStable(state)
  }

  private async onPollFailure(state: State, err: unknown): Promise<void> {
    const monitorId = state.monitor.id
    const failures = (state.pollFailureCount ?? 0) + 1
    state.pollFailureCount = failures
    if (failures < MonitorSupervisor.POLL_FAILURE_TOLERANCE) {
      log.warn(
        `monitor ${monitorId}: pollExit exec failed (transient ${failures}/${MonitorSupervisor.POLL_FAILURE_TOLERANCE}); retrying`,
        err
      )
      // A sandbox this process has not attached yet (e.g. right after a Core
      // restart) only becomes reachable by re-ensuring it.
      await this.tryEnsureReachable(state)
      return
    }
    const now = this.now()
    if (state.unreachableSince === undefined) {
      state.unreachableSince = now
      log.warn(
        `monitor ${monitorId}: sandbox unreachable; waiting up to ${formatMinutes(MONITOR_SANDBOX_GRACE_MS)}`,
        err
      )
    }
    if (now - state.unreachableSince >= MONITOR_SANDBOX_GRACE_MS) {
      log.error(
        `monitor ${monitorId}: sandbox unreachable for ${formatMinutes(MONITOR_SANDBOX_GRACE_MS)}, failing`,
        err
      )
      await this.finish(state, 'failed', null, {
        reason: `sandbox unavailable for ${formatMinutes(MONITOR_SANDBOX_GRACE_MS)}; gave up waiting for it to come back`,
        failureKind: 'infrastructure',
      })
      return
    }
    await this.tryEnsureReachable(state)
  }

  private async tryEnsureReachable(state: State): Promise<void> {
    const now = this.now()
    if (state.lastEnsureAt !== undefined && now - state.lastEnsureAt < ENSURE_THROTTLE_MS) return
    state.lastEnsureAt = now
    try {
      await this.ensureSandboxReachable(state.monitor.sandboxId)
    } catch (err) {
      log.warn(`monitor ${state.monitor.id}: sandbox re-ensure failed`, err)
    }
  }

  /** A launch that stayed up for the stability window clears the rapid-restart count. */
  private async resetRapidCountIfStable(state: State): Promise<void> {
    const monitor = state.monitor
    if (monitor.rapidRestartCount === 0 || !monitor.launchedAt) return
    if (this.now() - monitor.launchedAt.getTime() < MONITOR_STABILITY_WINDOW_MS) return
    await monitor.update({ rapidRestartCount: 0 })
    log.info(
      `monitor ${monitor.id}: stable for ${formatMinutes(MONITOR_STABILITY_WINDOW_MS)}; rapid-restart count reset`
    )
  }

  /**
   * The run was LOST (not exited). `never` fails with a clear reason; `on-loss`
   * schedules a relaunch with backoff, counting only rapid losses.
   */
  private async handleLoss(state: State, kind: LossKind): Promise<void> {
    if (state.finishing || state.stopping) return
    const monitor = state.monitor
    const reason = LOSS_REASON[kind]
    if (monitor.restartPolicy !== 'on-loss') {
      await this.finish(state, 'failed', null, {
        reason: `${reason}; command was not restarted (restart: never)`,
        failureKind: 'infrastructure',
        catchUp: true,
      })
      return
    }
    const now = this.now()
    if (now >= monitor.effectiveDeadline().getTime()) {
      await this.timeout(monitor.id)
      return
    }
    const launchedAt = (monitor.launchedAt ?? monitor.startedAt)?.getTime()
    const rapid = launchedAt !== undefined && now - launchedAt < MONITOR_STABILITY_WINDOW_MS
    const rapidRestartCount = rapid ? monitor.rapidRestartCount + 1 : 0
    if (rapidRestartCount > monitor.restartLimit) {
      await this.finish(state, 'failed', null, {
        reason:
          `restart limit reached: lost ${rapidRestartCount} times within ${formatMinutes(MONITOR_STABILITY_WINDOW_MS)} ` +
          `of launch (limit ${monitor.restartLimit} rapid restarts); last loss: ${reason}`,
        failureKind: 'infrastructure',
        catchUp: true,
      })
      return
    }
    // Tear down this run's stream and poll; the deadline and any pending
    // batch stay armed. Output the old run wrote is read after the relaunch
    // (the log is appended to and the stream resumes from receivedOffset).
    this.stopStream(state)
    if (state.pollTimer) clearTimeout(state.pollTimer)
    state.pollTimer = undefined
    const delayMs = this.restartBackoffMs(rapidRestartCount)
    await monitor.update({
      rapidRestartCount,
      nextRestartAt: new Date(now + delayMs),
      lastRestartReason: reason,
    })
    log.warn(
      `monitor ${monitor.id}: ${reason}; relaunching in ${Math.round(delayMs / 1000)}s (rapid ${rapidRestartCount})`
    )
    await this.emitMonitorEvent('monitor.updated', monitor, 'running')
    this.scheduleRestart(state, delayMs)
  }

  private scheduleRestart(state: State, delayMs: number): void {
    if (state.restartTimer) clearTimeout(state.restartTimer)
    state.restartTimer = setTimeout(
      () => this.detached('restart', state.monitor.id, () => this.performRestart(state)),
      Math.max(0, delayMs)
    )
  }

  /** Relaunch an `on-loss` monitor once its sandbox is reachable. Counted at loss time, never here. */
  private async performRestart(state: State): Promise<void> {
    state.restartTimer = undefined
    const monitorId = state.monitor.id
    if (this.states.get(monitorId) !== state || state.finishing || state.stopping) return
    const monitor = state.monitor
    const current = await Monitor.find(monitorId)
    if (!current || !Monitor.activeStatuses().includes(current.status) || current.status === 'canceling') {
      // Ended or being canceled elsewhere; whoever did that owns the outcome.
      this.release(state)
      return
    }
    if (monitor.restartPolicy !== 'on-loss') {
      // Defensive: a `never` monitor is never rerun on any path.
      await this.finish(state, 'failed', null, {
        reason: 'command was not restarted (restart: never)',
        failureKind: 'infrastructure',
      })
      return
    }
    const now = this.now()
    if (now >= monitor.effectiveDeadline().getTime()) {
      await this.timeout(monitorId)
      return
    }

    let launched: { running: boolean }
    try {
      launched = await this.launch(monitor, state)
    } catch (err) {
      state.unreachableSince ??= now
      if (now - state.unreachableSince >= MONITOR_SANDBOX_GRACE_MS) {
        await this.finish(state, 'failed', null, {
          reason: `sandbox unavailable for ${formatMinutes(MONITOR_SANDBOX_GRACE_MS)}; command could not be restarted`,
          failureKind: 'infrastructure',
        })
        return
      }
      log.warn(`monitor ${monitorId}: relaunch could not reach the sandbox; retrying`, err)
      await this.tryEnsureReachable(state)
      if (this.states.get(monitorId) === state && !state.finishing && !state.stopping)
        this.scheduleRestart(state, this.restartRetryMs)
      return
    }
    // Record the relaunch first: it happened even if this process is now
    // detaching, and the next Core must not count or rerun it again.
    if (launched.running) await monitor.update({ restartCount: monitor.restartCount + 1, lastRestartAt: new Date(now) })
    const superseded = this.states.get(monitorId) !== state
    if (!launched.running || state.finishing || state.stopping || superseded) {
      // Canceled, timed out or stopped while relaunching: do not leave the new
      // session behind. (Detached by shutdown: leave it for recovery.)
      if (!launched.running || state.finishing || state.stopping)
        await this.killSession(monitor, 'stop during relaunch')
      if (!superseded && !state.finishing && !state.stopping) this.release(state)
      return
    }
    state.unreachableSince = undefined
    state.pollFailureCount = 0
    state.pollElapsedMs = 0
    await this.openStream(state)
    this.scheduleExitPoll(state)
    await this.sendRestartedMessage(monitor)
    await this.emitMonitorEvent('monitor.updated', monitor, 'running')
  }

  private async sendRestartedMessage(monitor: Monitor): Promise<void> {
    const shortId = monitor.id.slice(0, 8)
    const window = formatMinutes(MONITOR_STABILITY_WINDOW_MS)
    const counting =
      monitor.rapidRestartCount > 0
        ? `rapid restart ${monitor.rapidRestartCount}/${monitor.restartLimit}; resets after ${window} stable`
        : `not counted toward the rapid-restart limit: it had run ${window}+ since its last launch`
    await this.sendMessage(
      monitor.agentId,
      `Monitor "${monitor.label}" (${shortId}) restarted after sandbox loss: ${monitor.lastRestartReason ?? 'process lost'} (${counting}).`,
      {
        deliveryMode: 'steer',
        metadata: {
          source: 'monitor',
          wakeEligible: false,
          monitor: {
            id: monitor.id,
            label: monitor.label,
            kind: 'restarted',
            restartCount: monitor.restartCount,
            rapidRestartCount: monitor.rapidRestartCount,
          },
        },
      }
    )
  }

  private async timeout(monitorId: string): Promise<void> {
    const state = this.states.get(monitorId)
    if (!state || state.finishing) return
    state.stopping = true
    await this.killSession(state.monitor, 'timeout')
    const current = await Monitor.find(monitorId)
    if (!current || !Monitor.activeStatuses().includes(current.status)) {
      // Already ended elsewhere: never overwrite that outcome.
      this.release(state)
      return
    }
    await this.finish(state, 'timed-out', null)
  }

  private async overload(monitorId: string): Promise<void> {
    const state = this.states.get(monitorId)
    if (!state || state.finishing) return
    state.stopping = true
    await this.killSession(state.monitor, 'overload')
    await this.finish(state, 'overload', null, {
      reason: `auto-stopped: ${this.maxDroppedLines}+ lines dropped (filter too loose)`,
    })
  }

  /**
   * Read output the live stream had not delivered when the run ended (the
   * stream lags the exit poll, and nothing streams while Core is restarting),
   * including a final unterminated line. Best effort: skipped when unreachable.
   */
  private async catchUpLog(state: State): Promise<void> {
    if (state.receivedOffset === null) return
    const { logFile } = this.workPaths(state.monitor, state.squadId)
    let out: Buffer
    try {
      out = await this.manager.exec(state.monitor.sandboxId, [
        'bash',
        '-lc',
        `if [ -f ${shellQuote(logFile)} ]; then tail -c +${state.receivedOffset + 1} ${shellQuote(logFile)} 2>/dev/null | head -c ${CATCH_UP_MAX_BYTES}; fi`,
      ])
    } catch (err) {
      log.warn(`monitor ${state.monitor.id}: final log read failed`, err)
      return
    }
    if (out.length === 0) return
    this.ingest(state, out)
    if (state.lineBuffer.length > 0) {
      this.consumeLine(state, state.lineBuffer, 0)
      state.lineBuffer = Buffer.alloc(0)
    }
    if (out.length >= CATCH_UP_MAX_BYTES)
      this.pushLine(state, '[more output not shown; read the full log with action "get"]', null)
  }

  private async finish(
    state: State,
    status: TerminalStatus,
    exitCode: number | null,
    options: { reason?: string; failureKind?: string | null; notifyAgent?: boolean; catchUp?: boolean } = {}
  ): Promise<void> {
    // Guard against concurrent terminal paths (poll/timeout/cancel) firing more than once.
    if (state.finishing) return
    state.finishing = true
    const { reason, failureKind, catchUp = false } = options
    const notifyAgent = options.notifyAgent !== false
    // Stop ingesting new lines before draining what is already buffered.
    this.stopStream(state)
    if (state.pollTimer) clearTimeout(state.pollTimer)
    if (state.timeoutTimer) clearTimeout(state.timeoutTimer)
    if (state.restartTimer) clearTimeout(state.restartTimer)
    state.pollTimer = undefined
    state.timeoutTimer = undefined
    state.restartTimer = undefined
    if (notifyAgent) {
      if (catchUp) await this.catchUpLog(state)
      await this.drain(state)
    } else {
      state.pending = []
      state.pendingBytes = 0
    }
    await state.monitor.markEnded(status, exitCode, reason, failureKind)
    const shortId = state.monitor.id.slice(0, 8)
    const terminalBody =
      status === 'failed'
        ? `failed: ${reason}.`
        : status === 'overload'
          ? `stopped — output exceeded the limit (${this.maxDroppedLines}+ lines dropped). The command is too noisy; recreate it with a tighter filter (e.g. pipe through grep --line-buffered for only the lines you need).`
          : status === 'exited'
            ? `exited${exitCode === null ? '' : ` (exit_code=${exitCode})`}.`
            : status === 'timed-out'
              ? 'timed out.'
              : `${status}.`
    if (notifyAgent) {
      await this.sendMessage(state.monitor.agentId, `Monitor "${state.monitor.label}" (${shortId}) ${terminalBody}`, {
        deliveryMode: 'steer',
        metadata: {
          source: 'monitor',
          wakeEligible: false,
          monitor: {
            id: state.monitor.id,
            label: state.monitor.label,
            kind: status,
            ...(failureKind ? { failureKind } : {}),
            exitCode,
          },
        },
      })
    }
    eventEmitter.emit('monitor.ended', {
      monitorId: state.monitor.id,
      agentId: state.monitor.agentId,
      squadId: state.squadId,
      status,
    })
    if (this.states.get(state.monitor.id) === state) this.states.delete(state.monitor.id)
  }

  /** Send a terminal 'failed' message for a monitor not in the live states map (recovery path). */
  private async sendFailureMessage(monitor: Monitor, reason: string): Promise<void> {
    const shortId = monitor.id.slice(0, 8)
    await this.sendMessage(monitor.agentId, `Monitor "${monitor.label}" (${shortId}) failed: ${reason}.`, {
      deliveryMode: 'steer',
      metadata: {
        source: 'monitor',
        wakeEligible: false,
        monitor: {
          id: monitor.id,
          label: monitor.label,
          kind: 'failed',
          failureKind: 'infrastructure',
          exitCode: null,
        },
      },
    })
  }

  /** Mark a recovered monitor failed and notify the agent with the infrastructure reason. */
  private async failRecovery(monitor: Monitor, reason: string): Promise<void> {
    await monitor.markEnded('failed', null, reason, 'infrastructure')
    await this.sendFailureMessage(monitor, reason)
    await this.emitMonitorEvent('monitor.ended', monitor, 'failed')
  }

  /**
   * Take back every active monitor after a Core (worker) restart. Nothing is
   * relaunched here: each monitor is reattached and probed immediately, and
   * the probe decides — still running (resume streaming from the persisted
   * offset, not a restart), exited (deliver the rest and finish), or lost
   * (restart policy: `never` fails, `on-loss` relaunches and counts it).
   */
  async recoverOnStartup(): Promise<void> {
    for (const monitor of await Monitor.listActive()) {
      if (this.states.has(monitor.id)) continue
      try {
        if (monitor.status === 'canceling') {
          // Core stopped mid-cancel; finish it.
          await this.cancel(monitor.id)
        } else if (monitor.status === 'starting') {
          // Core stopped before the start was recorded, so the agent never got
          // a monitor id. Stop whatever may have launched rather than rerun it.
          await this.killSession(monitor, 'interrupted start')
          await this.failRecovery(monitor, 'Core restarted while the monitor was starting; command was not restarted')
        } else {
          await this.attach(monitor, { pollNow: true })
        }
      } catch (err) {
        log.error(`Monitor ${monitor.id} recovery failed (sandbox ${monitor.sandboxId}):`, err)
        const state = this.states.get(monitor.id)
        if (state) this.release(state)
        const reason = err instanceof Error ? err.message : String(err)
        await this.failRecovery(monitor, `recovery failed: ${reason}`).catch(() => {})
      }
    }
  }

  async stopAllForAgent(agentId: string, options: { notifyAgent?: boolean; createdBefore?: Date } = {}): Promise<void> {
    for (const monitor of await Monitor.listForAgent(agentId, { status: Monitor.activeStatuses() })) {
      if (options.createdBefore && monitor.createdAt > options.createdBefore) continue
      await this.cancel(monitor.id, options)
    }
  }

  async stopAllForSandbox(sandboxId: string): Promise<void> {
    const rows = await db.select().from(monitors).where(eq(monitors.sandboxId, sandboxId))
    for (const row of rows.filter((m) => Monitor.activeStatuses().includes(m.status))) await this.cancel(row.id)
  }

  /**
   * Drop every in-memory attachment — timers, pending relaunches and log
   * streams — without touching the database or the tmux sessions.
   *
   * This is the worker SHUTDOWN path: monitors keep running in their sandbox
   * and `recoverOnStartup` reattaches them (resuming the stream from the
   * persisted offset and keeping the original deadline). Output still pending
   * in memory was not delivered, so its offset was not persisted and it is
   * re-read after the restart. Explicit stops (cancel, agent cleanup, sandbox
   * teardown) go through `cancel()` instead.
   */
  detachAll(): void {
    for (const state of [...this.states.values()]) this.release(state)
  }
}

function parseLogSize(output: string): number | null {
  const line = output
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(LOG_SIZE_MARKER))
  if (!line) return null
  const size = Number.parseInt(line.slice(LOG_SIZE_MARKER.length).trim(), 10)
  return Number.isNaN(size) ? null : size
}

export const monitorSupervisor = new MonitorSupervisor()
