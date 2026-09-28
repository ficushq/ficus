import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, monitors } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Monitor } from '../../entities/Monitor'
import { MonitorSupervisor, monitorExitPollIntervalMs } from './monitor-supervisor'
import type { ISandboxManager, SpawnHook } from '../sandbox'
import { boxUnixUser } from '../machines/box-paths'

class FakeSandbox implements ISandboxManager {
  execs: string[][] = []
  streams: Array<{
    onStdout: (chunk: Buffer) => void
    onStderr?: (chunk: Buffer) => void
    cancel: () => void
  }> = []
  statuses = new Map<string, number>()
  outputs = new Map<string, Buffer>()
  execError: Error | null = null
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
    // Default '' = the combined poll probe's still-running answer (dir exists,
    // no exitCode yet). Tests map explicit outputs for exit/gone cases.
    return this.outputs.get(args.join(' ')) ?? Buffer.from('')
  }
  async execStatus(_sandboxId: string, args: string[]): Promise<number> {
    return this.statuses.get(args.join(' ')) ?? 1
  }
  streamExec(
    _sandboxId: string,
    _args: string[],
    onStdout: (chunk: Buffer) => void,
    onStderr?: (chunk: Buffer) => void
  ): { cancel: () => void } {
    const s = { onStdout, onStderr, cancel: () => {} }
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
}

function pollProbeCommand(dir: string): string {
  return (
    `bash -lc if [ ! -d '${dir}' ]; then echo __MONITOR_DIR_GONE__; ` +
    `elif [ -f '${dir}/exitCode' ]; then cat '${dir}/exitCode'; fi`
  )
}

describe('MonitorSupervisor', () => {
  let agentId: string
  let agentTypeId: string
  let sandbox: FakeSandbox
  let sent: string[]
  let prevRuntime: string | undefined

  // `start()` arms a 2s poll interval and a timeout timer per monitor. Nothing
  // in these tests stops them, so before this teardown existed they outlived
  // the file: the 60s default timeout fired long after the monitor rows were
  // deleted, markEnded threw, and the unhandled rejection was charged to
  // whatever unrelated test bun happened to be running at that moment.
  const supervisors: MonitorSupervisor[] = []
  function makeSupervisor(...args: ConstructorParameters<typeof MonitorSupervisor>): MonitorSupervisor {
    const supervisor = new MonitorSupervisor(...args)
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
      processId: 'tau-monitor-test',
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
    await createMonitor({ status: 'running', processId: 'tau-monitor-1' })
    await createMonitor({ status: 'running', processId: 'tau-monitor-2' })
    await createMonitor({ status: 'running', processId: 'tau-monitor-3' })
    const monitor = await createMonitor({ status: 'starting', processId: 'tau-monitor-4' })
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
    const probe = pollProbeCommand(`/workspace/.tau/monitors/${monitor.id}`)

    // Two 2s rounds: proves the self-rescheduling timer keeps polling rather
    // than firing once and stopping.
    await Bun.sleep(4_600)
    expect(sandbox.execs.filter((args) => args.join(' ') === probe).length).toBeGreaterThanOrEqual(2)
  }, 10_000)

  it('does not finish twice when exit is detected concurrently', async () => {
    const monitor = await createMonitor()
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.start(monitor)
    const dir = `/workspace/.tau/monitors/${monitor.id}`
    sandbox.outputs.set(pollProbeCommand(dir), Buffer.from('0'))

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

  it('fails the monitor with a process-lost reason when the work dir vanished (sandbox restarted)', async () => {
    const monitor = await createMonitor()
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.start(monitor)
    const dir = `/workspace/.tau/monitors/${monitor.id}`
    sandbox.outputs.set(pollProbeCommand(dir), Buffer.from('__MONITOR_DIR_GONE__'))

    await supervisor.pollExit(monitor.id)

    await monitor.reload()
    expect(monitor.status).toBe('failed')
    expect(monitor.failureReason).toBe('sandbox restarted during run; monitor process lost')
    expect(monitor.failureKind).toBe('infrastructure')
  })

  it('transitions to failed only after sustained consecutive poll failures', async () => {
    const monitor = await createMonitor()
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.start(monitor)
    sandbox.execError = new Error('Sandbox not found')

    for (let i = 0; i < MonitorSupervisor.POLL_FAILURE_TOLERANCE; i++) {
      await supervisor.pollExit(monitor.id)
    }

    await monitor.reload()
    expect(monitor.status).toBe('failed')
    expect(monitor.failureReason).toBe('sandbox became unavailable during run')
    expect(monitor.endedAt).toBeInstanceOf(Date)
    expect(monitor.failureKind).toBe('infrastructure')
    expect(sent.at(-1)).toContain('failed: sandbox became unavailable during run')
  })

  it('includes failureKind in the metadata of a failed terminal message', async () => {
    const monitor = await createMonitor()
    const calls: Array<{ content: string; options: { deliveryMode: string; metadata: Record<string, unknown> } }> = []
    const supervisor = makeSupervisor(sandbox, async (_agentId, content, options) => {
      calls.push({ content, options })
    })
    await supervisor.start(monitor)
    sandbox.execError = new Error('Sandbox not found')

    for (let i = 0; i < MonitorSupervisor.POLL_FAILURE_TOLERANCE; i++) {
      await supervisor.pollExit(monitor.id)
    }

    const last = calls.at(-1)!
    expect(last.content).toContain('failed: sandbox became unavailable during run')
    expect(last.options.metadata).toMatchObject({
      source: 'monitor',
      monitor: { kind: 'failed', failureKind: 'infrastructure' },
    })
  })

  it('relaunches a monitor whose tmux session is gone but whose sandbox is alive', async () => {
    const monitor = await createMonitor({ status: 'running' })
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.recoverOnStartup()
    await monitor.reload()
    expect(monitor.status).toBe('running')
    expect(sandbox.execs.some((a) => a.join(' ').includes('tmux new-session'))).toBe(true)
    expect(sandbox.streams).toHaveLength(1)
  })

  it('re-attaches a monitor whose tmux session is still alive on recovery', async () => {
    const monitor = await createMonitor({ status: 'running' })
    const supervisor = makeSupervisor(sandbox, async () => {})
    sandbox.statuses.set(`bash -lc tmux has-session -t 'tau-monitor-test'`, 0)
    await supervisor.recoverOnStartup()
    await monitor.reload()
    expect(monitor.status).toBe('running')
    expect(sandbox.streams).toHaveLength(1)
    expect(sandbox.execs.some((a) => a.join(' ').includes('tmux new-session'))).toBe(false)
  })

  it('marks a monitor failed without throwing when relaunch fails during recovery', async () => {
    const monitor = await createMonitor({ status: 'running' })
    sandbox.execError = new Error('tmux broken')
    const supervisor = makeSupervisor(sandbox, async () => {})
    await supervisor.recoverOnStartup()
    await monitor.reload()
    expect(monitor.status).toBe('failed')
    expect(monitor.failureReason).toContain('relaunch failed: tmux broken')
    expect(monitor.failureKind).toBe('infrastructure')
  })

  it('does not crash recovery when a monitor sandbox is gone (marks it failed)', async () => {
    const monitor = await createMonitor({ status: 'running' })
    // A torn-down squad sandbox makes execStatus throw "Sandbox not found".
    // Recovery must not let that abort startup for the whole worker.
    sandbox.execStatus = async () => {
      throw new Error(`Sandbox not found: ${monitor.sandboxId}`)
    }
    const supervisor = makeSupervisor(sandbox, async (_agentId, content) => sent.push(content))
    await supervisor.recoverOnStartup() // must resolve, not throw
    await monitor.reload()
    expect(monitor.status).toBe('failed')
    expect(monitor.failureReason).toBe('sandbox unavailable on recovery')
    expect(monitor.failureKind).toBe('infrastructure')
    expect(sent.at(-1)).toContain('failed: sandbox unavailable on recovery')
  })

  it('stopAllForAgent finalizes all active monitors for that agent only', async () => {
    const activeMonitor = await createMonitor({ status: 'running', processId: 'tau-monitor-active' })
    const secondMonitor = await createMonitor({ status: 'starting', processId: 'tau-monitor-second' })
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
      expect(sandbox.execs[0].join(' ')).toContain(`/workspace/${squadId}/.tau/monitors/`)
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
      expect(launch).toContain(`/home/${boxUnixUser('agent_a1')}/.private/.tau/monitors/`)
      expect(launch).not.toContain(boxUnixUser(`squad_${squadId}`))
    } finally {
      spy.mockRestore()
    }
  })
})
