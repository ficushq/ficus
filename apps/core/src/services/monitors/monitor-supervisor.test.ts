import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, monitors } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Monitor } from '../../entities/Monitor'
import {
  MONITOR_SANDBOX_GRACE_MS,
  MONITOR_STABILITY_WINDOW_MS,
  MonitorSupervisor,
  monitorExitPollIntervalMs,
  monitorRestartBackoffMs,
  type MonitorSupervisorOptions,
} from './monitor-supervisor'
import type { ISandboxManager, SpawnHook } from '../sandbox'
import { boxUnixUser } from '../machines/box-paths'

type FakeStream = {
  cmd: string
  onStdout: (chunk: Buffer) => void
  onStderr?: (chunk: Buffer) => void
  onEnd?: () => void
  canceled: boolean
  cancel: () => void
}

const LOG_SIZE_MARKER = '__FICUS_MONITOR_LOG_SIZE__='

class FakeSandbox implements ISandboxManager {
  execs: string[][] = []
  streams: FakeStream[] = []
  statuses = new Map<string, number>()
  outputs = new Map<string, Buffer>()
  execError: Error | null = null
  /** Liveness probe answer: '' = still running, an exit code, or a GONE marker. */
  probe = ''
  /** Log size the launch command reports (null = no marker, e.g. an old box). */
  logSize: number | null = null
  /** What the end-of-run catch-up read returns. */
  catchUp = ''
  /** Awaited inside the launch exec (simulates a slow relaunch). */
  beforeLaunch: (() => Promise<void>) | null = null
  async ensureSandbox(): Promise<string> {
    return 'sandbox'
  }
  async stopSandbox() {
    return { kind: 'stopped' as const }
  }
  async removeSandbox(): Promise<void> {}
  async cleanup(): Promise<void> {}
  getSpawnHook(): SpawnHook | null {
    return null
  }
  async exec(_sandboxId: string, args: string[]): Promise<Buffer> {
    this.execs.push(args)
    if (this.execError) throw this.execError
    const cmd = args.join(' ')
    const mapped = this.outputs.get(cmd)
    if (mapped) return mapped
    if (cmd.includes('tmux new-session') && this.beforeLaunch) await this.beforeLaunch()
    if (cmd.includes('tmux new-session'))
      return Buffer.from(this.logSize === null ? '' : `${LOG_SIZE_MARKER}${this.logSize}\n`)
    if (cmd.includes('tmux has-session')) return Buffer.from(this.probe)
    if (cmd.includes('head -c')) return Buffer.from(this.catchUp)
    return Buffer.from('')
  }
  async execStatus(_sandboxId: string, args: string[]): Promise<number> {
    return this.statuses.get(args.join(' ')) ?? 1
  }
  streamExec(
    _sandboxId: string,
    args: string[],
    onStdout: (chunk: Buffer) => void,
    onStderr?: (chunk: Buffer) => void,
    onEnd?: () => void
  ): { cancel: () => void } {
    const s: FakeStream = {
      cmd: args.join(' '),
      onStdout,
      onStderr,
      onEnd,
      canceled: false,
      cancel: () => {
        s.canceled = true
      },
    }
    this.streams.push(s)
    return s
  }
  spawnShell() {
    return null
  }
  hasSandbox(): boolean {
    return true
  }
  toContainerPath(_sandboxId: string, hostPath: string): string {
    return hostPath
  }
  getWorkspaceLayout(_ctx: { squadId?: string; sandboxId?: string }) {
    return { workspaceMount: '/workspace', memoryMount: '/memory', cwd: '/workspace', privateMount: '/private' }
  }
  getSandboxRuntime() {
    return 'docker-sysbox' as const
  }
  launches(): number {
    return this.execs.filter((args) => args.join(' ').includes('tmux new-session')).length
  }
  probes(): number {
    return this.execs.filter((args) => args.join(' ').includes('tmux has-session')).length
  }
}

const DIR_GONE = '__MONITOR_DIR_GONE__'
const PROCESS_GONE = '__MONITOR_PROCESS_GONE__'
const TIMED_OUT = '__MONITOR_TIMED_OUT__'

/** The in-sandbox watchdog budget (FICUS_MONITOR_TIMEOUT_SECONDS) each launch was given, in order. */
function launchTimeouts(sandbox: FakeSandbox): number[] {
  return sandbox.execs
    .map((args) => args.join(' '))
    .filter((cmd) => cmd.includes('tmux new-session'))
    .map((cmd) => Number(/FICUS_MONITOR_TIMEOUT_SECONDS=\W*(\d+)/.exec(cmd)?.[1]))
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time')
    await Bun.sleep(10)
  }
}

describe('MonitorSupervisor', () => {
  let agentId: string
  let agentTypeId: string
  let sandbox: FakeSandbox
  let sent: string[]
  let prevRuntime: string | undefined
  /** Fake clock for the stability window, deadlines and grace periods (timers stay real). */
  let clock: number
  let ensured: string[]

  // `start()` arms a 2s poll interval and a timeout timer per monitor. Nothing
  // in these tests stops them, so before this teardown existed they outlived
  // the file: the 60s default timeout fired long after the monitor rows were
  // deleted, markEnded threw, and the unhandled rejection was charged to
  // whatever unrelated test bun happened to be running at that moment.
  const supervisors: MonitorSupervisor[] = []
  function makeSupervisor(
    manager: ISandboxManager,
    sendMessage: ConstructorParameters<typeof MonitorSupervisor>[1],
    maxDroppedLines?: number,
    options: MonitorSupervisorOptions = {}
  ): MonitorSupervisor {
    const supervisor = new MonitorSupervisor(manager, sendMessage, maxDroppedLines, {
      now: () => clock,
      ensureSandboxReachable: async (sandboxId) => {
        ensured.push(sandboxId)
        return true
      },
      restartBackoffMs: () => 5,
      restartRetryMs: 5,
      ...options,
    })
    supervisors.push(supervisor)
    return supervisor
  }

  beforeEach(async () => {
    // Monitor roots dispatch on FICUS_SANDBOX_RUNTIME; pin a real container
    // runtime so ambient env never changes what these tests assert (unset is
    // no longer a runtime — it is a boot failure). The vm test below sets 'vm'.
    prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
    process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
    agentTypeId = `monitor-supervisor-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await AgentType.create({
      id: agentTypeId,
      name: 'Supervisor Test',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'test',
    })
    agentId = (await Agent.create({ agentTypeId })).id
    sandbox = new FakeSandbox()
    sent = []
    clock = Date.now()
    ensured = []
  })

  afterEach(async () => {
    // Disarm before the rows go away (detachAll is purely in-memory, so it
    // cannot touch monitors owned by other test files).
    for (const supervisor of supervisors) supervisor.detachAll()
    supervisors.length = 0
    if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
    await db.delete(monitors).where(eq(monitors.agentId, agentId))
    await db.delete(agents).where(eq(agents.id, agentId))
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  })

  async function createMonitor(overrides: Partial<typeof monitors.$inferInsert> = {}) {
    return Monitor.create({
      agentId,
      sandboxId: 'sandbox-1',
      label: 'watch',
      command: 'echo hi',
      processId: 'ficus-monitor-test',
      timeoutMs: 60_000,
      maxBatchLines: 10,
      maxBatchBytes: 4096,
      batchDebounceMs: 10,
      ...overrides,
    })
  }

  it('starts tmux, streams logs, and batches stdout', async () => {
    const monitor = await createMonitor()
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.start(monitor)
    expect(monitor.status).toBe('running')
    expect(sandbox.execs[0].join(' ')).toContain('tmux new-session')
    expect(sandbox.streams).toHaveLength(1)

    supervisor.onStdoutChunk(monitor.id, 'one\ntwo\n')
    await Bun.sleep(30)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('one')
    expect(sent[0]).toContain('two')
  })

  it('marks monitor failed when sandbox launch fails', async () => {
    const monitor = await createMonitor()
    sandbox.execError = new Error('tmux missing')
    const supervisor = makeSupervisor(sandbox, async () => {})

    await expect(supervisor.start(monitor)).rejects.toThrow('tmux missing')
    await monitor.reload()
    expect(monitor.status).toBe('failed')
    expect(monitor.failureReason).toContain('tmux missing')
    expect(monitor.endedAt).toBeInstanceOf(Date)
  })

  it('marks monitor failed when per-agent active cap is exceeded', async () => {
    await createMonitor({ status: 'running', processId: 'ficus-monitor-1' })
    await createMonitor({ status: 'running', processId: 'ficus-monitor-2' })
    await createMonitor({ status: 'running', processId: 'ficus-monitor-3' })
    const monitor = await createMonitor({ status: 'starting', processId: 'ficus-monitor-4' })
    const supervisor = makeSupervisor(sandbox, async () => {})

    await expect(supervisor.start(monitor)).rejects.toThrow('Agent already has 3 active monitors')
    await monitor.reload()
    expect(monitor.status).toBe('failed')
    expect(monitor.failureReason).toContain('Agent already has 3 active monitors')
    expect(monitor.endedAt).toBeInstanceOf(Date)
  })

  it('delivers overflow lines beyond maxBatchLines in a later batch instead of dropping them', async () => {
    const monitor = await createMonitor({ maxBatchLines: 2 })
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.start(monitor)
    supervisor.onStdoutChunk(monitor.id, 'a\nb\nc\nd\n')
    await Bun.sleep(50)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('> a')
    expect(sent[0]).toContain('> b')
    expect(sent[0]).not.toContain('> c')
    // Buffered lines are not yet delivered, so they must not be reported as dropped.
    expect(sent[0]).not.toContain('dropped')
    expect(sent[0]).not.toContain('truncated')

    // The minimum 2s inter-batch interval governs delivery of the remaining buffered lines.
    await Bun.sleep(2100)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toContain('> c')
    expect(sent[1]).toContain('> d')
  })

  it('frames stdout batches as descriptive monitor events with steer delivery', async () => {
    const monitor = await createMonitor()
    const calls: Array<{ content: string; options: { deliveryMode: string; metadata: Record<string, unknown> } }> = []
    const supervisor = makeSupervisor(sandbox, async (_agentId, content, options) => {
      calls.push({ content, options })
    })
    await supervisor.start(monitor)
    supervisor.onStdoutChunk(monitor.id, 'one\ntwo\n')
    await Bun.sleep(30)
    expect(calls[0].content).toContain(`Monitor "${monitor.label}" (${monitor.id.slice(0, 8)})`)
    expect(calls[0].content).toContain('2 new line(s):')
    expect(calls[0].content).toContain('> one')
    expect(calls[0].content).not.toContain('[System')
    expect(calls[0].content).not.toContain('not a message from the user')
    expect(calls[0].options.deliveryMode).toBe('steer')
    expect(calls[0].options.metadata).toMatchObject({
      source: 'monitor',
      monitor: { id: monitor.id, label: monitor.label, kind: 'lines', lineCount: 2 },
    })
  })

  it('frames terminal status as a descriptive monitor event with steer delivery', async () => {
    const monitor = await createMonitor({ status: 'running' })
    const calls: Array<{ content: string; options: { deliveryMode: string; metadata: Record<string, unknown> } }> = []
    const supervisor = makeSupervisor(sandbox, async (_agentId, content, options) => {
      calls.push({ content, options })
    })
    await supervisor.cancel(monitor.id)
    const last = calls.at(-1)!
    expect(last.content).toContain(`Monitor "${monitor.label}" (${monitor.id.slice(0, 8)}) canceled.`)
    expect(last.content).not.toContain('[System')
    expect(last.content).not.toContain('not a message from the user')
    expect(last.options.deliveryMode).toBe('steer')
    expect(last.options.metadata).toMatchObject({ source: 'monitor', monitor: { kind: 'canceled' } })
  })

  it('drops oldest pending lines and reports a dropped count when the 64 KiB buffer overflows', async () => {
    const monitor = await createMonitor({ maxBatchLines: 1000, maxBatchBytes: 1_000_000 })
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.start(monitor)
    // ~100 KiB of input against a 64 KiB pending cap forces oldest lines to be dropped.
    const lines = Array.from({ length: 100 }, (_, i) => `${i}-${'x'.repeat(1000)}`)
    supervisor.onStdoutChunk(monitor.id, `${lines.join('\n')}\n`)
    await Bun.sleep(50)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/\[\+\d+ lines dropped/)
  })

  it('polls fast for the first 30s, then backs off to a 15s cap', () => {
    // Short-lived monitors (the common case) keep the prompt 2s detection.
    expect(monitorExitPollIntervalMs(0)).toBe(2_000)
    expect(monitorExitPollIntervalMs(28_000)).toBe(2_000)
    // Long-running monitors stop costing an exec round trip every 2s.
    expect(monitorExitPollIntervalMs(30_000)).toBe(5_000)
    expect(monitorExitPollIntervalMs(115_000)).toBe(5_000)
    expect(monitorExitPollIntervalMs(120_000)).toBe(15_000)
    expect(monitorExitPollIntervalMs(3_600_000)).toBe(15_000)
  })

  it('re-arms the exit poll after each round', async () => {
    const monitor = await createMonitor()
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.start(monitor)

    // Two 2s rounds: proves the self-rescheduling timer keeps polling rather
    // than firing once and stopping.
    await Bun.sleep(4_600)
    expect(sandbox.probes()).toBeGreaterThanOrEqual(2)
  }, 10_000)

  it('does not finish twice when exit is detected concurrently', async () => {
    const monitor = await createMonitor()
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.start(monitor)
    sandbox.probe = '0'

    await Promise.all([supervisor.pollExit(monitor.id), supervisor.pollExit(monitor.id)])

    await monitor.reload()
    expect(monitor.status).toBe('exited')
    expect(sent.filter((content) => content.includes('exited'))).toHaveLength(1)
  })

  it('caps a single oversized line by bytes with a truncation note', async () => {
    const monitor = await createMonitor({ maxBatchBytes: 256 })
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.start(monitor)
    supervisor.onStdoutChunk(monitor.id, `${'x'.repeat(1000)}\n`)
    await Bun.sleep(30)
    expect(Buffer.byteLength(sent[0])).toBeLessThan(500)
    expect(sent[0]).toContain('[line truncated by byte cap]')
  })

  it('cancels the tmux session and sends a terminal canceled event', async () => {
    const monitor = await createMonitor({ status: 'running' })
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.cancel(monitor.id)
    await monitor.reload()
    expect(monitor.status).toBe('canceled')
    expect(monitor.endedAt).toBeInstanceOf(Date)
    expect(sandbox.execs.at(-1)?.join(' ')).toContain('tmux kill-session')
    expect(sent.at(-1)).toContain('canceled.')
  })

  it('marks monitors timed-out and sends a terminal message', async () => {
    const monitor = await createMonitor({ timeoutMs: 10 })
    let resolveTerminalMessage: () => void
    const terminalMessage = new Promise<void>((resolve) => {
      resolveTerminalMessage = resolve
    })
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => {
      sent.push(content)
      if (content.includes('timed out.')) resolveTerminalMessage()
    })
    await supervisor.start(monitor)
    await terminalMessage
    await monitor.reload()
    expect(monitor.status).toBe('timed-out')
    expect(sent.at(-1)).toContain('timed out.')
  })

  it('still times out when the kill-session exec fails (sandbox gone)', async () => {
    const monitor = await createMonitor({ timeoutMs: 10 })
    sandbox.exec = async (_sandboxId, args) => {
      sandbox.execs.push(args)
      // The start() launch command also contains 'tmux kill-session' (to clean up
      // stale sessions before creating a new one). Only throw for standalone
      // kill-session calls — i.e. NOT the combined launch that also runs new-session.
      const cmd = args.join(' ')
      if (cmd.includes('tmux kill-session') && !cmd.includes('tmux new-session')) throw new Error('Sandbox not found')
      return Buffer.from('0')
    }
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.start(monitor)
    await Bun.sleep(30)
    await monitor.reload()
    expect(monitor.status).toBe('timed-out')
    expect(monitor.endedAt).toBeInstanceOf(Date)
    expect(sandbox.execs.some((args) => args.join(' ').includes('tmux kill-session'))).toBe(true)
    expect(sent.at(-1)).toContain('timed out.')
  })

  it('tolerates transient poll failures and resumes without failing the monitor', async () => {
    const monitor = await createMonitor()
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.start(monitor)
    sandbox.execError = new Error('socket connection closed unexpectedly')

    // Fewer than the tolerance: monitor must survive.
    for (let i = 0; i < MonitorSupervisor.POLL_FAILURE_TOLERANCE - 1; i++) {
      await supervisor.pollExit(monitor.id)
    }
    await monitor.reload()
    expect(monitor.status).toBe('running')

    // Recovery resets the counter; a later single failure is again tolerated.
    sandbox.execError = null
    await supervisor.pollExit(monitor.id)
    sandbox.execError = new Error('blip')
    await supervisor.pollExit(monitor.id)
    await monitor.reload()
    expect(monitor.status).toBe('running')
    await supervisor.cancel(monitor.id)
  })

  it('restart: never — a wiped work dir fails the monitor clearly and never reruns it', async () => {
    const monitor = await createMonitor()
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.start(monitor)
    sandbox.probe = DIR_GONE

    await supervisor.pollExit(monitor.id)

    await monitor.reload()
    expect(monitor.status).toBe('failed')
    expect(monitor.failureReason).toBe('sandbox restarted; command was not restarted (restart: never)')
    expect(monitor.failureKind).toBe('infrastructure')
    expect(sent.at(-1)).toContain('failed: sandbox restarted; command was not restarted (restart: never).')
    expect(sandbox.launches()).toBe(1)
  })

  it('detects a process that vanished without an exit code instead of reporting it as still running', async () => {
    const monitor = await createMonitor()
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.start(monitor)
    sandbox.probe = PROCESS_GONE

    await supervisor.pollExit(monitor.id)

    await monitor.reload()
    expect(monitor.status).toBe('failed')
    expect(monitor.failureReason).toBe(
      'process ended without recording an exit code (sandbox restart or killed); command was not restarted (restart: never)'
    )
    expect(sandbox.launches()).toBe(1)
  })

  it('probes tmux liveness before the exitCode file, so a clean exit is never mistaken for a loss', async () => {
    const monitor = await createMonitor()
    const supervisor = makeSupervisor(sandbox, async () => {})
    await supervisor.start(monitor)
    await supervisor.pollExit(monitor.id)
    const probe = sandbox.execs.map((a) => a.join(' ')).find((cmd) => cmd.includes('tmux has-session'))!
    expect(probe.indexOf('tmux has-session')).toBeLessThan(probe.indexOf('/exitCode'))
    expect(probe).toContain(PROCESS_GONE)
  })

  it('waits for an unreachable sandbox (re-ensuring it) and keeps a run that survived', async () => {
    const monitor = await createMonitor()
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.start(monitor)
    sandbox.execError = new Error('Sandbox not found')

    for (let i = 0; i < MonitorSupervisor.POLL_FAILURE_TOLERANCE + 2; i++) await supervisor.pollExit(monitor.id)
    await monitor.reload()
    expect(monitor.status).toBe('running')
    expect(ensured).toContain(monitor.sandboxId)

    // The box is back and the process is still alive: nothing is lost or rerun.
    sandbox.execError = null
    await supervisor.pollExit(monitor.id)
    await monitor.reload()
    expect(monitor.status).toBe('running')
    expect(sandbox.launches()).toBe(1)
    expect(sent.some((c) => c.includes('failed'))).toBe(false)
  })

  it('fails only after the sandbox stays unreachable for the whole grace period', async () => {
    const monitor = await createMonitor({ timeoutMs: 24 * 60 * 60_000 })
    const calls: Array<{ content: string; options: { metadata: Record<string, unknown> } }> = []
    const supervisor = makeSupervisor(sandbox, async (_agentId, content, options) => {
      calls.push({ content, options })
    })
    await supervisor.start(monitor)
    sandbox.execError = new Error('Sandbox not found')
    for (let i = 0; i < MonitorSupervisor.POLL_FAILURE_TOLERANCE; i++) await supervisor.pollExit(monitor.id)
    clock += MONITOR_SANDBOX_GRACE_MS - 1000
    await supervisor.pollExit(monitor.id)
    await monitor.reload()
    expect(monitor.status).toBe('running')

    clock += 2000
    await supervisor.pollExit(monitor.id)
    await monitor.reload()
    expect(monitor.status).toBe('failed')
    expect(monitor.failureReason).toBe('sandbox unavailable for 15m; gave up waiting for it to come back')
    expect(monitor.failureKind).toBe('infrastructure')
    expect(calls.at(-1)!.options.metadata).toMatchObject({
      source: 'monitor',
      monitor: { kind: 'failed', failureKind: 'infrastructure' },
    })
  })

  it('re-establishes an ended log stream from the received offset without dropping or repeating output', async () => {
    const monitor = await createMonitor()
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.start(monitor)
    expect(sandbox.streams[0].cmd).toContain('tail -c +1 -F')
    const first = sandbox.streams[0]

    // 'one\n' + 'two\n' = 8 bytes received; 'par' is an incomplete line.
    first.onStdout(Buffer.from('one\ntwo\npar'))
    first.onEnd?.()
    await supervisor.pollExit(monitor.id)

    expect(sandbox.streams).toHaveLength(2)
    expect(sandbox.streams[1].cmd).toContain('tail -c +9 -F')
    // A late chunk from the dead stream is ignored; the new stream re-reads it.
    first.onStdout(Buffer.from('tial\nlate\n'))
    sandbox.streams[1].onStdout(Buffer.from('partial\nthree\n'))

    await waitFor(() => sent.join('\n').includes('> three'))
    const delivered = sent
      .join('\n')
      .split('\n')
      .filter((l) => l.startsWith('> '))
    expect(delivered).toEqual(['> one', '> two', '> partial', '> three'])
    await waitFor(async () => (await monitor.reload()).logOffset === 8 + 'partial\nthree\n'.length)
  })

  it('shutdown detaches; recovery reattaches from the delivered offset without rerunning or counting', async () => {
    const monitor = await createMonitor({ restartPolicy: 'on-loss' })
    const first = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await first.start(monitor)
    sandbox.streams[0].onStdout(Buffer.from('a\nbb\n'))
    await waitFor(async () => (await monitor.reload()).logOffset === 5)
    const deadline = monitor.deadlineAt!.getTime()

    first.detachAll()
    expect(sandbox.streams[0].canceled).toBe(true)
    await monitor.reload()
    expect(monitor.status).toBe('running')
    expect(
      sandbox.execs.some((a) => a.join(' ').includes('kill-session -t') && !a.join(' ').includes('new-session'))
    ).toBe(false)

    const second = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await second.recoverOnStartup()
    await waitFor(() => sandbox.probes() >= 1)
    await Bun.sleep(20)
    await monitor.reload()
    expect(monitor.status).toBe('running')
    expect(sandbox.launches()).toBe(1)
    expect(sandbox.streams.at(-1)!.cmd).toContain('tail -c +6 -F')
    expect(monitor.restartCount).toBe(0)
    expect(monitor.rapidRestartCount).toBe(0)
    expect(monitor.deadlineAt!.getTime()).toBe(deadline)
    expect(sent.some((c) => c.includes('restarted'))).toBe(false)
  })

  it('re-reads output that was received but not yet delivered when Core shut down', async () => {
    const monitor = await createMonitor({ batchDebounceMs: 10_000 })
    const first = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await first.start(monitor)
    sandbox.streams[0].onStdout(Buffer.from('pending\n'))
    first.detachAll()
    expect(sent).toHaveLength(0)

    const second = makeSupervisor(sandbox, async () => {})
    await second.recoverOnStartup()
    expect(sandbox.streams.at(-1)!.cmd).toContain('tail -c +1 -F')
  })

  it('restart: never — recovery fails a monitor whose session is gone instead of rerunning it', async () => {
    const monitor = await createMonitor({ status: 'running' })
    sandbox.probe = PROCESS_GONE
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.recoverOnStartup()
    await waitFor(async () => (await monitor.reload()).status === 'failed')
    expect(monitor.failureReason).toContain('command was not restarted (restart: never)')
    expect(sandbox.launches()).toBe(0)
  })

  it('restart: on-loss — recovery relaunches a lost session with its recorded identity', async () => {
    const processId = 'tau-monitor-persisted' // Existing recorded identity, not a new writer.
    const monitor = await createMonitor({ status: 'running', processId, restartPolicy: 'on-loss' })
    sandbox.probe = PROCESS_GONE
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.recoverOnStartup()
    await waitFor(() => sandbox.launches() === 1)
    sandbox.probe = ''
    await waitFor(async () => (await monitor.reload()).restartCount === 1)
    expect(monitor.processId).toBe(processId)
    expect(sandbox.execs.some((args) => args.join(' ').includes(`tmux new-session -d -s '${processId}'`))).toBe(true)
  })

  it('reattaches a monitor whose tmux session is still alive on recovery', async () => {
    const monitor = await createMonitor({ status: 'running', logOffset: 0 })
    const supervisor = makeSupervisor(sandbox, async () => {})
    await supervisor.recoverOnStartup()
    await waitFor(() => sandbox.probes() >= 1)
    await monitor.reload()
    expect(monitor.status).toBe('running')
    expect(sandbox.streams).toHaveLength(1)
    expect(sandbox.launches()).toBe(0)
  })

  it('recovery keeps a monitor whose sandbox is not reachable yet and waits for it', async () => {
    const monitor = await createMonitor({ status: 'running', logOffset: 0 })
    sandbox.execError = new Error(`Sandbox not found: ${monitor.sandboxId}`)
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.recoverOnStartup() // must resolve, not throw
    await waitFor(() => ensured.length > 0)
    await monitor.reload()
    expect(monitor.status).toBe('running')
    expect(sent).toHaveLength(0)
  })

  it('recovery stops a monitor whose deadline passed while Core was down', async () => {
    const monitor = await createMonitor({
      status: 'running',
      logOffset: 0,
      startedAt: new Date(clock - 120_000),
      deadlineAt: new Date(clock - 60_000),
    })
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.recoverOnStartup()
    await waitFor(async () => (await monitor.reload()).status === 'timed-out')
    expect(sandbox.execs.some((a) => a.join(' ').includes(`tmux kill-session -t 'ficus-monitor-test'`))).toBe(true)
    expect(sandbox.launches()).toBe(0)
    expect(sandbox.streams).toHaveLength(0)
  })

  it('recovery does not rerun a monitor interrupted while starting', async () => {
    const monitor = await createMonitor({ status: 'starting' })
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.recoverOnStartup()
    await monitor.reload()
    expect(monitor.status).toBe('failed')
    expect(monitor.failureReason).toContain('command was not restarted')
    expect(sandbox.launches()).toBe(0)
  })

  it('restart: on-loss — relaunches the same monitor, keeps its deadline and tells the agent', async () => {
    const monitor = await createMonitor({ restartPolicy: 'on-loss', timeoutMs: 60 * 60_000 })
    const calls: Array<{ content: string; options: { metadata: Record<string, unknown> } }> = []
    const supervisor = makeSupervisor(sandbox, async (_agentId, content, options) => {
      calls.push({ content, options })
    })
    await supervisor.start(monitor)
    await monitor.reload()
    const deadline = monitor.deadlineAt!.getTime()
    const firstLaunch = monitor.launchedAt!.getTime()
    sandbox.streams[0].onStdout(Buffer.from('before\n'))

    clock += 60_000
    sandbox.probe = DIR_GONE
    sandbox.logSize = 0 // the box was recreated: the log is empty again
    await supervisor.pollExit(monitor.id)
    sandbox.probe = ''
    await waitFor(async () => (await monitor.reload()).restartCount === 1)

    expect(monitor.status).toBe('running')
    expect(sandbox.launches()).toBe(2)
    expect(monitor.deadlineAt!.getTime()).toBe(deadline)
    expect(monitor.launchedAt!.getTime()).toBe(firstLaunch + 60_000)
    expect(monitor.rapidRestartCount).toBe(1)
    expect(monitor.lastRestartReason).toBe('sandbox restarted')
    expect(monitor.nextRestartAt).toBeNull()
    // The wiped log is read from its start; nothing from before is repeated.
    expect(sandbox.streams.at(-1)!.cmd).toContain('tail -c +1 -F')
    await waitFor(() => calls.some((c) => c.content.includes('restarted after sandbox loss')))
    const restarted = calls.find((c) => c.content.includes('restarted after sandbox loss'))!
    expect(restarted.content).toBe(
      `Monitor "watch" (${monitor.id.slice(0, 8)}) restarted after sandbox loss: sandbox restarted (rapid restart 1/5; resets after 5m stable).`
    )
    expect(restarted.options.metadata).toMatchObject({
      source: 'monitor',
      monitor: { id: monitor.id, kind: 'restarted', restartCount: 1, rapidRestartCount: 1 },
    })
    const timeoutLeftMs = deadline - clock
    expect(timeoutLeftMs).toBeLessThan(60 * 60_000)
  })

  it('restart: on-loss — a wiped log is re-read from byte 0 even when nothing was delivered yet', async () => {
    const monitor = await createMonitor({ restartPolicy: 'on-loss', batchDebounceMs: 10_000, timeoutMs: 60 * 60_000 })
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.start(monitor)
    sandbox.streams[0].onStdout(Buffer.from('before\n')) // received, still pending

    clock += 10_000
    sandbox.probe = DIR_GONE
    sandbox.logSize = 0
    await supervisor.pollExit(monitor.id)
    sandbox.probe = ''
    await waitFor(async () => (await monitor.reload()).restartCount === 1)
    expect(sandbox.streams.at(-1)!.cmd).toContain('tail -c +1 -F')
    expect(monitor.logOffset).toBe(0)
  })

  it('restart: on-loss — a cancel during an in-flight relaunch kills the new session', async () => {
    const monitor = await createMonitor({ restartPolicy: 'on-loss', timeoutMs: 60 * 60_000 })
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.start(monitor)
    let canceled: Promise<void> | undefined
    sandbox.beforeLaunch = async () => {
      sandbox.beforeLaunch = null
      canceled = supervisor.cancel(monitor.id)
      await Bun.sleep(30)
    }
    clock += 10_000
    sandbox.probe = PROCESS_GONE
    await supervisor.pollExit(monitor.id)
    await waitFor(() => canceled !== undefined)
    await canceled
    await waitFor(() => {
      const cmds = sandbox.execs.map((a) => a.join(' '))
      const relaunch = cmds.findLastIndex((c) => c.includes('tmux new-session'))
      return cmds.slice(relaunch + 1).some((c) => c.includes('tmux kill-session') && !c.includes('new-session'))
    })
    await monitor.reload()
    expect(monitor.status).toBe('canceled')
    expect(sent.some((c) => c.includes('restarted after sandbox loss'))).toBe(false)
  })

  it('restart: on-loss — rapid losses back off, then fail at the restart limit', async () => {
    const backoffs: number[] = []
    const monitor = await createMonitor({ restartPolicy: 'on-loss', restartLimit: 2, timeoutMs: 60 * 60_000 })
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content), undefined, {
      restartBackoffMs: (count) => {
        backoffs.push(count)
        return 5
      },
    })
    await supervisor.start(monitor)

    for (let restart = 1; restart <= 2; restart++) {
      clock += 10_000
      sandbox.probe = PROCESS_GONE
      await supervisor.pollExit(monitor.id)
      sandbox.probe = ''
      await waitFor(async () => (await monitor.reload()).restartCount === restart)
      expect(monitor.rapidRestartCount).toBe(restart)
    }
    expect(backoffs).toEqual([1, 2])

    clock += 10_000
    sandbox.probe = PROCESS_GONE
    await supervisor.pollExit(monitor.id)
    await monitor.reload()
    expect(monitor.status).toBe('failed')
    expect(monitor.failureReason).toBe(
      'restart limit reached: lost 3 times within 5m of launch (limit 2 rapid restarts); last loss: process ended without recording an exit code (sandbox restart or killed)'
    )
    expect(sandbox.launches()).toBe(3)
  })

  it('backs off exponentially between rapid restarts, capped', () => {
    expect(monitorRestartBackoffMs(0)).toBe(5_000)
    expect(monitorRestartBackoffMs(1)).toBe(5_000)
    expect(monitorRestartBackoffMs(2)).toBe(30_000)
    expect(monitorRestartBackoffMs(3)).toBe(120_000)
    expect(monitorRestartBackoffMs(4)).toBe(300_000)
    expect(monitorRestartBackoffMs(50)).toBe(300_000)
  })

  it('restart: on-loss — a stable launch resets the count and a later loss does not count', async () => {
    const monitor = await createMonitor({ restartPolicy: 'on-loss', timeoutMs: 24 * 60 * 60_000 })
    const backoffs: number[] = []
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content), undefined, {
      restartBackoffMs: (count) => {
        backoffs.push(count)
        return 5
      },
    })
    await supervisor.start(monitor)
    clock += 10_000
    sandbox.probe = PROCESS_GONE
    await supervisor.pollExit(monitor.id)
    sandbox.probe = ''
    await waitFor(async () => (await monitor.reload()).restartCount === 1)
    expect(monitor.rapidRestartCount).toBe(1)

    // The relaunch stays up for the whole stability window.
    clock += MONITOR_STABILITY_WINDOW_MS + 1000
    await supervisor.pollExit(monitor.id)
    await monitor.reload()
    expect(monitor.rapidRestartCount).toBe(0)

    // Hours later the box restarts again: restarted, but not counted.
    clock += 3 * 60 * 60_000
    sandbox.probe = DIR_GONE
    await supervisor.pollExit(monitor.id)
    sandbox.probe = ''
    await waitFor(async () => (await monitor.reload()).restartCount === 2)
    expect(monitor.rapidRestartCount).toBe(0)
    expect(backoffs).toEqual([1, 0])
    await waitFor(() => sent.some((c) => c.includes('not counted toward the rapid-restart limit')))
  })

  it('restart: on-loss — a pending relaunch survives a Core restart without being counted twice', async () => {
    const monitor = await createMonitor({ restartPolicy: 'on-loss', timeoutMs: 60 * 60_000 })
    const first = makeSupervisor(sandbox, async () => {}, undefined, { restartBackoffMs: () => 60_000 })
    await first.start(monitor)
    clock += 10_000
    sandbox.probe = PROCESS_GONE
    await first.pollExit(monitor.id)
    await monitor.reload()
    expect(monitor.nextRestartAt).toBeInstanceOf(Date)
    expect(monitor.rapidRestartCount).toBe(1)
    first.detachAll()

    clock += 60_000
    sandbox.probe = ''
    const second = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await second.recoverOnStartup()
    await waitFor(async () => (await monitor.reload()).restartCount === 1)
    expect(monitor.rapidRestartCount).toBe(1)
    expect(sandbox.launches()).toBe(2)
    expect(monitor.nextRestartAt).toBeNull()
  })

  it('restart: on-loss — exits, cancel, timeout and overload never restart', async () => {
    const exited = await createMonitor({ restartPolicy: 'on-loss', processId: 'ficus-monitor-exit' })
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content), 5)
    await supervisor.start(exited)
    sandbox.probe = '1'
    await supervisor.pollExit(exited.id)
    expect((await exited.reload()).status).toBe('exited')
    sandbox.probe = ''

    const canceled = await createMonitor({ restartPolicy: 'on-loss', processId: 'ficus-monitor-cancel' })
    await supervisor.start(canceled)
    await supervisor.cancel(canceled.id)
    sandbox.probe = PROCESS_GONE
    await supervisor.pollExit(canceled.id)
    sandbox.probe = ''
    expect((await canceled.reload()).status).toBe('canceled')

    const timedOut = await createMonitor({ restartPolicy: 'on-loss', timeoutMs: 10, processId: 'ficus-monitor-time' })
    await supervisor.start(timedOut)
    await waitFor(async () => (await timedOut.reload()).status === 'timed-out')

    const overloaded = await createMonitor({ restartPolicy: 'on-loss', processId: 'ficus-monitor-load' })
    await supervisor.start(overloaded)
    const lines = Array.from({ length: 70 }, (_, i) => `${i}-${'x'.repeat(1020)}`)
    supervisor.onStdoutChunk(overloaded.id, `${lines.join('\n')}\n`)
    await waitFor(async () => (await overloaded.reload()).status === 'overload')

    await Bun.sleep(50)
    expect(sandbox.launches()).toBe(4) // one start each, no relaunches
    for (const m of [exited, canceled, timedOut, overloaded]) expect((await m.reload()).restartCount).toBe(0)
    expect(sent.some((c) => c.includes('restarted'))).toBe(false)
  })

  it('a cancel that lands during the restart backoff wins over the relaunch', async () => {
    const monitor = await createMonitor({ restartPolicy: 'on-loss', timeoutMs: 60 * 60_000 })
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content), undefined, {
      restartBackoffMs: () => 200,
    })
    await supervisor.start(monitor)
    clock += 10_000
    sandbox.probe = PROCESS_GONE
    await supervisor.pollExit(monitor.id)
    // Another Core process (the API) cancels it while the relaunch is pending.
    const elsewhere = makeSupervisor(sandbox, async () => {})
    await elsewhere.cancel(monitor.id)
    await Bun.sleep(300)
    await monitor.reload()
    expect(monitor.status).toBe('canceled')
    expect(sandbox.launches()).toBe(1)
  })

  it('stops (without overwriting) a monitor that was ended by another process', async () => {
    const monitor = await createMonitor()
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.start(monitor)
    await db.update(monitors).set({ status: 'canceled', endedAt: new Date() }).where(eq(monitors.id, monitor.id))

    await supervisor.pollExit(monitor.id)

    await monitor.reload()
    expect(monitor.status).toBe('canceled')
    expect(sandbox.execs.at(-1)!.join(' ')).toContain(`tmux kill-session -t 'ficus-monitor-test'`)
    expect(sent).toHaveLength(0)
  })

  it('delivers output the stream had not caught up on when the command exits', async () => {
    const monitor = await createMonitor()
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.start(monitor)
    sandbox.streams[0].onStdout(Buffer.from('seen\n'))
    sandbox.catchUp = 'tail line\nno newline'
    sandbox.probe = '0'

    await supervisor.pollExit(monitor.id)

    const catchUp = sandbox.execs.map((a) => a.join(' ')).find((cmd) => cmd.includes('head -c'))!
    expect(catchUp).toContain('tail -c +6 ')
    const text = sent.join('\n')
    expect(text).toContain('> seen')
    expect(text).toContain('> tail line')
    expect(text).toContain('> no newline')
    expect(sent.at(-1)).toContain('exited (exit_code=0).')
    expect(text.match(/> seen/g)).toHaveLength(1)
  })

  it('stopAllForAgent finalizes all active monitors for that agent only', async () => {
    const activeMonitor = await createMonitor({ status: 'running', processId: 'ficus-monitor-active' })
    const secondMonitor = await createMonitor({ status: 'starting', processId: 'ficus-monitor-second' })
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))

    await supervisor.stopAllForAgent(agentId)
    await activeMonitor.reload()
    await secondMonitor.reload()

    expect(activeMonitor.status).toBe('canceled')
    expect(secondMonitor.status).toBe('canceled')
    expect(sent.filter((content) => content.includes('canceled.'))).toHaveLength(2)
  })

  it('auto-stops a monitor that drops more than the dropped-line threshold', async () => {
    const monitor = await createMonitor()
    // maxDroppedLines = 5 (test seam); 64 KiB buffer holds ~64 lines of 1 KiB.
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content), 5)
    await supervisor.start(monitor)
    // 70 lines of ~1 KiB overflow the 64 KiB buffer and drop ~6 (> 5).
    const lines = Array.from({ length: 70 }, (_, i) => `${i}-${'x'.repeat(1020)}`)
    supervisor.onStdoutChunk(monitor.id, `${lines.join('\n')}\n`)
    // overload() is async fire-and-forget, so poll for the DB status change
    // instead of relying on a fixed sleep that can be too short under CI load.
    const deadline = Date.now() + 5000
    do {
      await Bun.sleep(20)
      await monitor.reload()
    } while (monitor.status !== 'overload' && Date.now() < deadline)
    expect(monitor.status).toBe('overload')
    expect(sandbox.execs.some((a) => a.join(' ').includes('tmux kill-session'))).toBe(true)
    expect(sent.some((c) => c.includes('output exceeded'))).toBe(true)
    expect(sent.filter((c) => c.includes('output exceeded'))).toHaveLength(1)
  })

  it('does not auto-stop a monitor that stays under the dropped-line threshold', async () => {
    const monitor = await createMonitor()
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content), 5)
    await supervisor.start(monitor)
    supervisor.onStdoutChunk(monitor.id, 'a\nb\nc\n')
    await Bun.sleep(50)
    await monitor.reload()
    expect(monitor.status).toBe('running')
    expect(sent.some((c) => c.includes('output exceeded'))).toBe(false)
  })

  it('uses the squad workspace mount when the monitor agent belongs to a squad', async () => {
    const squadId = 'sq1'
    const spy = spyOn(Agent, 'find').mockResolvedValue({ squadId } as any)
    try {
      const monitor = await createMonitor()
      const supervisor = makeSupervisor(sandbox, async () => {})
      await supervisor.start(monitor)
      expect(sandbox.execs[0].join(' ')).toContain(`/workspace/${squadId}/.ficus/monitors/`)
    } finally {
      spy.mockRestore()
    }
  })

  it("vm runtime: a squad monitor's root is its OWN box work root, never the squad box workspace", async () => {
    // Monitors exec in monitor.sandboxId (a squad member's light box on vm),
    // whose unix user cannot write the squad box's ~/workspace — the root must
    // resolve inside the monitor's own box (its ~/.private, like a solo box).
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    const squadId = 'sq1'
    const spy = spyOn(Agent, 'find').mockResolvedValue({ squadId } as any)
    try {
      const monitor = await createMonitor({ sandboxId: 'agent_a1' })
      const supervisor = makeSupervisor(sandbox, async () => {})
      await supervisor.start(monitor)
      const launch = sandbox.execs[0].join(' ')
      expect(launch).toContain(`/home/${boxUnixUser('agent_a1')}/.private/.ficus/monitors/`)
      expect(launch).not.toContain(boxUnixUser(`squad_${squadId}`))
    } finally {
      spy.mockRestore()
    }
  })

  describe('in-sandbox deadline (watchdog)', () => {
    const timedOutMessages = () => sent.filter((c) => c.includes('timed out.'))

    it('gives the first launch the full timeout and probes the timeout marker before the exit code', async () => {
      const monitor = await createMonitor({ timeoutMs: 60 * 60_000 })
      const supervisor = makeSupervisor(sandbox, async () => {})
      await supervisor.start(monitor)
      expect(launchTimeouts(sandbox)).toEqual([3600])
      // A relaunch must never read a previous run's marker as its own.
      const cleanup = sandbox.execs[0][2].split('\n').find((line) => line.startsWith('rm -f'))!
      expect(cleanup).toContain("/exitCode'")
      expect(cleanup).toContain("/timedOut'")

      await supervisor.pollExit(monitor.id)
      const probe = sandbox.execs.map((a) => a.join(' ')).find((cmd) => cmd.includes('tmux has-session'))!
      expect(probe.indexOf('/timedOut')).toBeGreaterThan(-1)
      expect(probe.indexOf('/timedOut')).toBeLessThan(probe.indexOf('/exitCode'))
    })

    it('a sandbox-side timeout ends the monitor timed-out with its last output, once, and never relaunches', async () => {
      const monitor = await createMonitor({ restartPolicy: 'on-loss', timeoutMs: 60 * 60_000 })
      const calls: Array<{ content: string; options: { metadata: Record<string, unknown> } }> = []
      const supervisor = makeSupervisor(sandbox, async (_agentId, content, options) => {
        sent.push(content)
        calls.push({ content, options })
      })
      await supervisor.start(monitor)
      sandbox.catchUp = 'last words\n'
      sandbox.probe = TIMED_OUT

      await supervisor.pollExit(monitor.id)
      await Bun.sleep(30)

      await monitor.reload()
      expect(monitor.status).toBe('timed-out')
      expect(monitor.exitCode).toBeNull()
      expect(monitor.failureReason).toBeNull()
      expect(monitor.restartCount).toBe(0)
      expect(monitor.nextRestartAt).toBeNull()
      expect(sandbox.launches()).toBe(1)
      expect(sent.some((c) => c.includes('restarted'))).toBe(false)
      // Same terminal message and metadata as a Core-enforced timeout.
      expect(timedOutMessages()).toEqual([`Monitor "watch" (${monitor.id.slice(0, 8)}) timed out.`])
      expect(calls.at(-1)!.options.metadata).toMatchObject({
        source: 'monitor',
        monitor: { id: monitor.id, kind: 'timed-out', exitCode: null },
      })
      expect(sent.join('\n')).toContain('> last words')
      expect(sent.findIndex((c) => c.includes('> last words'))).toBeLessThan(
        sent.findIndex((c) => c.includes('timed out.'))
      )
    })

    it('Core timer and sandbox watchdog firing together notify exactly once', async () => {
      const monitor = await createMonitor({ restartPolicy: 'on-loss', timeoutMs: 40 })
      const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
      await supervisor.start(monitor)
      sandbox.probe = TIMED_OUT
      await Promise.all([supervisor.pollExit(monitor.id), Bun.sleep(40).then(() => supervisor.pollExit(monitor.id))])
      await waitFor(async () => (await monitor.reload()).status === 'timed-out')
      await Bun.sleep(100)
      expect(timedOutMessages()).toHaveLength(1)
      expect(sandbox.launches()).toBe(1)
    })

    it('Core reattach after a sandbox-side timeout records timed-out without restarting, once', async () => {
      // Core was down when the box's watchdog fired. By Core's clock the
      // deadline is still a moment away (the two clocks are independent).
      const monitor = await createMonitor({
        status: 'running',
        restartPolicy: 'on-loss',
        logOffset: 0,
        startedAt: new Date(clock - 10 * 60_000),
        launchedAt: new Date(clock - 10 * 60_000),
        deadlineAt: new Date(clock + 300),
      })
      sandbox.probe = TIMED_OUT
      const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
      await supervisor.recoverOnStartup()
      await waitFor(async () => (await monitor.reload()).status === 'timed-out')
      // Let Core's own deadline timer come due too: it must not notify again.
      await Bun.sleep(400)
      expect(timedOutMessages()).toHaveLength(1)
      expect(sent).toHaveLength(1)
      expect(sandbox.launches()).toBe(0)
      expect(monitor.restartCount).toBe(0)
      expect(monitor.failureReason).toBeNull()
    })

    it('Core reattach past the deadline after a sandbox-side timeout: timed-out, no relaunch, one message', async () => {
      const monitor = await createMonitor({
        status: 'running',
        restartPolicy: 'on-loss',
        logOffset: 0,
        startedAt: new Date(clock - 120_000),
        deadlineAt: new Date(clock - 60_000),
      })
      sandbox.probe = TIMED_OUT
      const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
      await supervisor.recoverOnStartup()
      await waitFor(async () => (await monitor.reload()).status === 'timed-out')
      await Bun.sleep(50)
      expect(timedOutMessages()).toHaveLength(1)
      expect(sandbox.launches()).toBe(0)
      expect(monitor.restartCount).toBe(0)
    })

    it('restart: on-loss — a relaunch gets only the time left to the original deadline', async () => {
      const monitor = await createMonitor({ restartPolicy: 'on-loss', timeoutMs: 60 * 60_000 })
      const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
      await supervisor.start(monitor)
      await monitor.reload()
      const deadline = monitor.deadlineAt!.getTime()

      clock += 25 * 60_000 + 500
      sandbox.probe = PROCESS_GONE
      await supervisor.pollExit(monitor.id)
      sandbox.probe = ''
      await waitFor(async () => (await monitor.reload()).restartCount === 1)

      // 34m59.5s left, rounded up: the box never fires ahead of the deadline.
      expect(deadline - clock).toBe(35 * 60_000 - 500)
      expect(launchTimeouts(sandbox)).toEqual([3600, 2100])
      expect(monitor.deadlineAt!.getTime()).toBe(deadline)
    })

    it('restart: on-loss — a relaunch after a Core restart also gets only the time left', async () => {
      const monitor = await createMonitor({
        status: 'running',
        restartPolicy: 'on-loss',
        logOffset: 0,
        startedAt: new Date(clock - 50 * 60_000),
        launchedAt: new Date(clock - 50 * 60_000),
        deadlineAt: new Date(clock + 10 * 60_000),
      })
      sandbox.probe = PROCESS_GONE
      const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
      await supervisor.recoverOnStartup() // the first probe runs on a 0ms timer
      await waitFor(() => sandbox.launches() === 1)
      sandbox.probe = ''
      await waitFor(async () => (await monitor.reload()).restartCount === 1)
      expect(launchTimeouts(sandbox)).toEqual([600])
    })

    it('restart: on-loss — a loss found past the deadline times out instead of relaunching', async () => {
      const monitor = await createMonitor({ restartPolicy: 'on-loss', timeoutMs: 60 * 60_000 })
      const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
      await supervisor.start(monitor)
      clock += 60 * 60_000
      sandbox.probe = PROCESS_GONE
      await supervisor.pollExit(monitor.id)
      await Bun.sleep(30)
      expect((await monitor.reload()).status).toBe('timed-out')
      expect(sandbox.launches()).toBe(1)
      expect(timedOutMessages()).toHaveLength(1)
    })

    it('restart: on-loss — a deadline that passes during the relaunch backoff times out, no relaunch', async () => {
      const monitor = await createMonitor({ restartPolicy: 'on-loss', timeoutMs: 60 * 60_000 })
      const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content), undefined, {
        restartBackoffMs: () => 100,
      })
      await supervisor.start(monitor)
      clock += 60 * 60_000 - 1_000
      sandbox.probe = PROCESS_GONE
      await supervisor.pollExit(monitor.id)
      expect((await monitor.reload()).nextRestartAt).toBeInstanceOf(Date)
      clock += 2_000 // the deadline passes before the relaunch is due
      await waitFor(async () => (await monitor.reload()).status === 'timed-out')
      await Bun.sleep(150)
      expect(sandbox.launches()).toBe(1)
      expect(monitor.restartCount).toBe(0)
      expect(timedOutMessages()).toHaveLength(1)
    })

    it('a cancel in progress wins over a sandbox-side timeout', async () => {
      const monitor = await createMonitor()
      const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
      await supervisor.start(monitor)
      await monitor.update({ status: 'canceling' })
      sandbox.probe = TIMED_OUT
      await supervisor.pollExit(monitor.id)
      expect((await monitor.reload()).status).toBe('canceled')
      expect(timedOutMessages()).toHaveLength(0)
    })
  })
})
