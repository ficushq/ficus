import { eq } from 'drizzle-orm'
import { withLegacyEnvAliases } from '@ficus/shared/legacy-env'
import { db } from '../../db'
import { monitors } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { Monitor } from '../../entities/Monitor'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { getSandboxManager, type ISandboxManager } from '../sandbox'
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
type SendMessage = (
  agentId: string,
  content: string,
  options: { deliveryMode: 'steer'; metadata: Record<string, unknown> }
) => Promise<unknown>

type State = {
  monitor: Monitor
  pending: string[]
  pendingBytes: number
  timer?: Timer
  pollTimer?: Timer
  timeoutTimer?: Timer
  subscription?: { cancel: () => void }
  lastFlushAt?: number
  droppedLines: number
  droppedTotal: number
  overloadTriggered?: boolean
  squadId: string | null
  finishing?: boolean
  /** Consecutive pollExit exec failures — reset on any successful poll. */
  pollFailureCount?: number
  /** Sum of the exit-poll delays scheduled so far — drives the poll backoff. */
  pollElapsedMs?: number
}

export class MonitorSupervisor {
  private states = new Map<string, State>()
  constructor(
    private managerInstance?: ISandboxManager,
    private sendMessage: SendMessage = async (agentId, content, options) => {
      const agent = await Agent.mustFind(agentId)
      await agent.sendMessage(content, options)
    },
    private maxDroppedLines: number = MAX_DROPPED_LINES
  ) {}

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
      await this.launch(monitor)
      await this.emitMonitorEvent('monitor.created', monitor, 'running')
    } catch (error) {
      await this.markStartFailed(monitor, error)
      throw error
    }
  }

  /**
   * Build the launcher script, start a detached tmux session, mark the monitor
   * running, and attach the log streamer. Shared by start() for newly-created
   * monitors and recoverOnStartup() for persisted monitors whose tmux session
   * disappeared while the sandbox is still alive.
   */
  private async launch(monitor: Monitor): Promise<void> {
    const processId = monitor.processId || sessionNameForMonitor(monitor.id)
    if (!monitor.processId) await monitor.update({ processId })
    const squadId = await this.resolveSquadId(monitor.agentId)
    const workRoot = monitorWorkRoot({ squadId: squadId ?? undefined, sandboxId: monitor.sandboxId })
    const dir = monitorDir(workRoot, monitor.id)
    const script = `${dir}/run.sh`
    const cwd = monitor.cwd?.trim() || workRoot
    // Monitor commands may read these, so for one release (Ficus rename) each
    // also goes out under its TAU_ spelling.
    const monitorEnv = withLegacyEnvAliases({
      FICUS_MONITOR_ID: monitor.id,
      FICUS_MONITOR_CWD: cwd,
      FICUS_MONITOR_DIR: dir,
      FICUS_MONITOR_COMMAND: monitor.command,
    })
    const launchCommand = [
      ...Object.entries(monitorEnv).map(([key, value]) => `${key}=${shellQuote(value)}`),
      `bash ${shellQuote(script)}`,
    ].join(' ')
    const command = [
      'set -e',
      `mkdir -p ${shellQuote(`${dir}/logs`)}`,
      `cat > ${shellQuote(script)} <<'EOF'\n${LAUNCHER_SCRIPT}EOF`,
      `chmod +x ${shellQuote(script)}`,
      `tmux kill-session -t ${shellQuote(processId)} 2>/dev/null || true`,
      `tmux new-session -d -s ${shellQuote(processId)} ${shellQuote(launchCommand)}`,
    ].join('\n')
    await this.manager.exec(monitor.sandboxId, ['bash', '-lc', command])
    await monitor.markRunning()
    await this.attach(monitor)
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
    const reason = error instanceof Error ? error.message : String(error)
    await monitor.markEnded('failed', null, reason, 'infrastructure')
    await this.emitMonitorEvent('monitor.ended', monitor, 'failed')
  }

  private async relaunch(monitor: Monitor): Promise<void> {
    try {
      await this.launch(monitor)
      await this.emitMonitorEvent('monitor.created', monitor, 'running')
      log.info(`Monitor ${monitor.id} relaunched on recovery`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      log.error(`Monitor ${monitor.id} relaunch failed:`, error)
      await monitor.markEnded('failed', null, `relaunch failed: ${reason}`, 'infrastructure').catch(() => {})
      await this.emitMonitorEvent('monitor.ended', monitor, 'failed').catch(() => {})
    }
  }

  async attach(monitor: Monitor): Promise<void> {
    const state: State = {
      monitor,
      pending: [],
      pendingBytes: 0,
      droppedLines: 0,
      droppedTotal: 0,
      squadId: await this.resolveSquadId(monitor.agentId),
    }
    this.states.set(monitor.id, state)
    this.streamLogs(state)
    this.scheduleExitPoll(state)
    state.timeoutTimer = setTimeout(
      () => this.detached('timeout', monitor.id, () => this.timeout(monitor.id)),
      monitor.timeoutMs
    )
  }

  /**
   * Arm the next exit poll and re-arm after it completes.
   *
   * A self-rescheduling timeout rather than a fixed interval: the delay grows
   * with the monitor's age (see {@link monitorExitPollIntervalMs}), and polls
   * can no longer overlap when a sandbox exec is slower than the interval.
   */
  private scheduleExitPoll(state: State): void {
    const monitorId = state.monitor.id
    const delayMs = monitorExitPollIntervalMs(state.pollElapsedMs ?? 0)
    state.pollElapsedMs = (state.pollElapsedMs ?? 0) + delayMs
    state.pollTimer = setTimeout(() => {
      this.detached('pollExit', monitorId, async () => {
        try {
          await this.pollExit(monitorId)
        } finally {
          // Re-arm only while still attached: every terminal path clears the
          // timers and marks the state finishing before dropping it.
          if (this.states.get(monitorId) === state && !state.finishing) this.scheduleExitPoll(state)
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
   * UNHANDLED rejection: fatal noise in tau-worker, and in CI it surfaced as
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
    state.timer = undefined
    state.pollTimer = undefined
    state.timeoutTimer = undefined
  }

  private streamLogs(state: State): void {
    if (!this.manager.streamExec) throw new Error('Sandbox manager does not support streaming exec')
    const workRoot = monitorWorkRoot({
      squadId: state.squadId ?? undefined,
      sandboxId: state.monitor.sandboxId,
    })
    const logFile = `${monitorDir(workRoot, state.monitor.id)}/logs/current.log`
    const command = `mkdir -p ${shellQuote(`${monitorDir(workRoot, state.monitor.id)}/logs`)} && touch ${shellQuote(logFile)} && tail -n 0 -F ${shellQuote(logFile)}`
    let buffer = ''
    state.subscription = this.manager.streamExec(
      state.monitor.sandboxId,
      ['bash', '-lc', command],
      (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) this.onStdoutLine(state.monitor.id, line)
      },
      (chunk) =>
        log.warn('monitor stderr', {
          monitorId: state.monitor.id,
          stderr: chunk.toString(),
        })
    )
  }

  onStdoutChunk(monitorId: string, chunk: Buffer | string): void {
    for (const line of chunk
      .toString()
      .split('\n')
      .filter((line) => line.length > 0))
      this.onStdoutLine(monitorId, line)
  }

  private onStdoutLine(monitorId: string, line: string): void {
    const state = this.states.get(monitorId)
    if (!state) return
    const safeLine = line
    const bytes = Buffer.byteLength(safeLine)
    state.pending.push(safeLine)
    state.pendingBytes += bytes
    while (state.pendingBytes > MAX_PENDING_BYTES && state.pending.length) {
      const dropped = state.pending.shift() || ''
      state.pendingBytes -= Buffer.byteLength(dropped)
      state.droppedLines++
      state.droppedTotal++
    }
    if (state.droppedTotal > this.maxDroppedLines && !state.finishing && !state.overloadTriggered) {
      state.overloadTriggered = true
      this.detached('overload', monitorId, () => this.overload(monitorId))
    }
    if (!state.timer)
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

  /** Send a single batch honoring per-batch line/byte caps. Does not schedule follow-up flushes. */
  private async flushOnce(state: State): Promise<void> {
    if (state.pending.length === 0) return
    const lines: string[] = []
    let bytes = 0
    let byteTruncated = false
    while (state.pending.length && lines.length < state.monitor.maxBatchLines) {
      const next = state.pending[0]
      const nextBytes = Buffer.byteLength(`${next}\n`)
      const remainingBytes = state.monitor.maxBatchBytes - bytes
      if (nextBytes > remainingBytes) {
        if (lines.length > 0 || remainingBytes <= 0) break
        state.pending.shift()
        state.pendingBytes -= Buffer.byteLength(next)
        const marker = '… [line truncated by byte cap]'
        const markerBytes = Buffer.byteLength(marker)
        const lineBudget = Math.max(0, state.monitor.maxBatchBytes - markerBytes - 1)
        const truncatedLine = `${Buffer.from(next).subarray(0, lineBudget).toString()}${marker}`
        lines.push(truncatedLine)
        bytes += Buffer.byteLength(`${truncatedLine}\n`)
        byteTruncated = true
        break
      }
      state.pending.shift()
      state.pendingBytes -= Buffer.byteLength(next)
      lines.push(next)
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
    })
  }

  async cancel(monitorId: string, options: { notifyAgent?: boolean } = {}): Promise<void> {
    const monitor = await Monitor.mustFind(monitorId)
    if (!Monitor.activeStatuses().includes(monitor.status)) return

    await monitor.update({ status: 'canceling' })
    await this.emitMonitorEvent('monitor.updated', monitor, 'canceling')
    try {
      await this.manager.exec(monitor.sandboxId, [
        'bash',
        '-lc',
        `tmux kill-session -t ${shellQuote(monitor.processId)} || true`,
      ])
    } catch (err) {
      // Sandbox may be gone; proceed to terminal transition regardless.
      log.warn(`monitor ${monitorId}: kill-session failed on cancel, proceeding`, err)
    }

    const state = this.states.get(monitorId)
    if (state) {
      state.monitor = monitor
      await this.finish(state, 'canceled', null, undefined, undefined, options.notifyAgent !== false)
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

  /** Consecutive failed polls tolerated before declaring the sandbox
   *  unavailable. A single transient exec failure (tunnel blip, box briefly
   *  saturated, a ~12s recreate window) used to kill the monitor permanently
   *  even though the very next poll would have succeeded — observed live as
   *  monitors dying while sandbox_status reported ready. The tolerated window
   *  is 5 polls: ~10s early in a monitor's life, and up to ~75s once the poll
   *  has backed off to its 15s cap (strictly more forgiving, never less). */
  static readonly POLL_FAILURE_TOLERANCE = 5

  async pollExit(monitorId: string): Promise<void> {
    const state = this.states.get(monitorId)
    if (!state || state.finishing) return
    const workRoot = monitorWorkRoot({
      squadId: state.squadId ?? undefined,
      sandboxId: state.monitor.sandboxId,
    })
    const dir = monitorDir(workRoot, monitorId)
    try {
      // One probe answers both questions: is the run finished (exitCode file),
      // and does the monitor's work dir still exist at all. A recreated box
      // wipes the dir while execs succeed again — without the GONE marker the
      // monitor would hang in 'running' forever with no exitCode ever coming.
      const out = await this.manager.exec(state.monitor.sandboxId, [
        'bash',
        '-lc',
        `if [ ! -d ${shellQuote(dir)} ]; then echo __MONITOR_DIR_GONE__; ` +
          `elif [ -f ${shellQuote(`${dir}/exitCode`)} ]; then cat ${shellQuote(`${dir}/exitCode`)}; fi`,
      ])
      state.pollFailureCount = 0
      const text = out.toString().trim()
      if (text === '__MONITOR_DIR_GONE__') {
        log.error(`monitor ${monitorId}: work dir missing (sandbox restarted); monitor process lost`)
        await this.finish(state, 'failed', null, 'sandbox restarted during run; monitor process lost', 'infrastructure')
        return
      }
      if (text === '') return // still running
      const exitCode = Number.parseInt(text, 10)
      const current = await Monitor.mustFind(monitorId)
      const status = current.status === 'canceling' ? 'canceled' : 'exited'
      await this.finish(state, status, Number.isNaN(exitCode) ? null : exitCode)
    } catch (err) {
      // Transient exec failures are tolerated: skip this round and retry on
      // the next tick. Only SUSTAINED failure (POLL_FAILURE_TOLERANCE
      // consecutive polls, ~10s of continuous unavailability) condemns the
      // monitor — the guard still exists so a genuinely torn-down sandbox
      // cannot leave the monitor hanging in 'running' forever.
      const failures = (state.pollFailureCount ?? 0) + 1
      state.pollFailureCount = failures
      if (failures < MonitorSupervisor.POLL_FAILURE_TOLERANCE) {
        log.warn(
          `monitor ${monitorId}: pollExit exec failed (transient ${failures}/${MonitorSupervisor.POLL_FAILURE_TOLERANCE}); retrying`,
          err
        )
        return
      }
      log.error(`monitor ${monitorId}: pollExit failed ${failures} consecutive times, marking failed`, err)
      await this.finish(state, 'failed', null, 'sandbox became unavailable during run', 'infrastructure')
    }
  }

  private async timeout(monitorId: string): Promise<void> {
    const state = this.states.get(monitorId)
    if (!state || state.finishing) return
    try {
      await this.manager.exec(state.monitor.sandboxId, [
        'bash',
        '-lc',
        `tmux kill-session -t ${shellQuote(state.monitor.processId)} || true`,
      ])
    } catch (err) {
      // Sandbox may already be gone; proceed to terminal transition regardless.
      log.warn(`monitor ${monitorId}: kill-session failed on timeout, proceeding`, err)
    }
    await this.finish(state, 'timed-out', null)
  }

  private async overload(monitorId: string): Promise<void> {
    const state = this.states.get(monitorId)
    if (!state || state.finishing) return
    try {
      await this.manager.exec(state.monitor.sandboxId, [
        'bash',
        '-lc',
        `tmux kill-session -t ${shellQuote(state.monitor.processId)} || true`,
      ])
    } catch (err) {
      log.warn(`monitor ${monitorId}: kill-session failed on overload, proceeding`, err)
    }
    await this.finish(
      state,
      'overload',
      null,
      `auto-stopped: ${this.maxDroppedLines}+ lines dropped (filter too loose)`
    )
  }

  private async finish(
    state: State,
    status: 'exited' | 'canceled' | 'timed-out' | 'overload' | 'failed',
    exitCode: number | null,
    reason?: string,
    failureKind?: string | null,
    notifyAgent = true
  ): Promise<void> {
    // Guard against concurrent terminal paths (poll/timeout/cancel) firing more than once.
    if (state.finishing) return
    state.finishing = true
    // Stop ingesting new lines before draining what is already buffered.
    state.subscription?.cancel()
    if (state.pollTimer) clearTimeout(state.pollTimer)
    if (state.timeoutTimer) clearTimeout(state.timeoutTimer)
    state.pollTimer = undefined
    state.timeoutTimer = undefined
    if (notifyAgent) await this.drain(state)
    else {
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
    this.states.delete(state.monitor.id)
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

  async recoverOnStartup(): Promise<void> {
    for (const monitor of await Monitor.listActive()) {
      try {
        const hasSession =
          (await this.manager.execStatus(monitor.sandboxId, [
            'bash',
            '-lc',
            `tmux has-session -t ${shellQuote(monitor.processId)}`,
          ])) === 0
        if (hasSession) await this.attach(monitor)
        else await this.relaunch(monitor)
      } catch (err) {
        // A monitor whose sandbox no longer exists (e.g. the squad sandbox was
        // torn down) makes execStatus throw. That must not abort recovery for
        // every other monitor and crash the worker on startup — mark it failed
        // and keep going.
        log.error(`Monitor ${monitor.id} recovery failed (sandbox ${monitor.sandboxId}):`, err)
        await this.failRecovery(monitor, 'sandbox unavailable on recovery').catch(() => {})
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
   * Drop every in-memory attachment — timers and log subscription — without
   * touching the database.
   *
   * `cancel()` only reaches monitors still ACTIVE in the database, so anything
   * left in memory (an already-terminal row, or a row deleted underneath us)
   * keeps a poll interval and a timeout timer armed, pointed at a monitor that
   * no longer exists. Nothing awaits those callbacks, so when they eventually
   * fire and `markEnded` throws, the rejection is unhandled.
   */
  detachAll(): void {
    for (const [id, state] of this.states) {
      this.clearTimers(state)
      state.subscription?.cancel()
      this.states.delete(id)
    }
  }

  async shutdownAll(): Promise<void> {
    for (const monitor of await Monitor.listActive()) await this.cancel(monitor.id)
    this.detachAll()
  }
}

export const monitorSupervisor = new MonitorSupervisor()
