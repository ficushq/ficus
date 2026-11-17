import { describe, expect, it } from 'bun:test'
import type { ProcessIdentity } from './process-session'
import {
  KEEP_RUNNING_ENV,
  LeftoverProcesses,
  MAX_TRACKED,
  LeftoverSelectorError,
  parseLeftoverSelector,
  parseLeftoverStopReason,
  requestOwnership,
  type LeftoverBackend,
} from './leftover-processes'

interface FakeProcess {
  identity: ProcessIdentity
  environ?: string | undefined
  /** Exits on SIGTERM (default) or only on SIGKILL. */
  ignoresTerm?: boolean
  /** Survives even SIGKILL (a stuck process). */
  unkillable?: boolean
}

function identity(pid: number, sid: number, startTicks: number, state = 'S'): ProcessIdentity {
  return { pid, pgid: sid, sid, state, startToken: `linux:${startTicks}` }
}

/** An in-memory /proc and cgroupfs: processes, sessions and invocation leaves. */
function fakeBackend(options: { leaves?: Map<string, number[]>; protectedPids?: number[] } = {}) {
  const processes = new Map<number, FakeProcess>()
  const signals: Array<{ pid: number; signal: string }> = []
  const leaves = options.leaves ?? new Map<string, number[]>()
  const backend: LeftoverBackend = {
    readIdentity: async (pid) => processes.get(pid)?.identity,
    scanSession: async (sid) => [...processes.values()].map((p) => p.identity).filter((i) => i.sid === sid),
    leafPids: async (invocationId) => leaves.get(invocationId)?.filter((pid) => processes.has(pid)),
    readEnviron: async (pid) => {
      const process = processes.get(pid)
      if (!process) return null
      return 'environ' in process ? process.environ : 'PATH=/usr/bin\0HOME=/home/box'
    },
    signal: (pid, signal) => {
      signals.push({ pid, signal })
      const process = processes.get(pid)
      if (!process || process.unkillable) return
      if (signal === 'SIGKILL' || !process.ignoresTerm) processes.delete(pid)
    },
    sleep: async () => {},
    protectedPids: async () => new Set(options.protectedPids ?? []),
  }
  const add = (process: FakeProcess) => processes.set(process.identity.pid, process)
  return { backend, processes, signals, add, leaves }
}

const AGENT = 'agent-a'
const OTHER = 'agent-b'
const STREAM = 'stream-1'
const logs: string[] = []
const log = (message: string) => logs.push(message)

describe('requestOwnership', () => {
  it('attributes a command to its agent, stream and attempt', () => {
    expect(requestOwnership({ owner: AGENT, workStreamId: STREAM, attemptId: 3 })).toEqual({
      agentId: AGENT,
      workStreamId: STREAM,
      attemptId: 3,
    })
  })

  it('records nothing for a command without an owner (Core housekeeping)', () => {
    expect(requestOwnership({ workStreamId: STREAM, attemptId: 3 })).toBeUndefined()
    expect(requestOwnership({ owner: 'not an id!' })).toBeUndefined()
  })

  it('drops malformed stream and attempt fields but keeps the agent', () => {
    expect(requestOwnership({ owner: AGENT, workStreamId: 'a b', attemptId: -1 })).toEqual({ agentId: AGENT })
  })
})

describe('parseLeftoverSelector', () => {
  it('requires an agent or a stream, so an empty selector never matches everything', () => {
    expect(() => parseLeftoverSelector({})).toThrow(LeftoverSelectorError)
    expect(() => parseLeftoverSelector({ attemptId: 2 })).toThrow(LeftoverSelectorError)
    expect(parseLeftoverSelector({ workStreamId: STREAM, attemptId: 2 })).toEqual({
      workStreamId: STREAM,
      attemptId: 2,
    })
    expect(() => parseLeftoverSelector({ agentId: 3 })).toThrow(LeftoverSelectorError)
  })

  it('accepts only the known reasons', () => {
    expect(parseLeftoverStopReason('agent-dormant')).toBe('agent-dormant')
    expect(() => parseLeftoverStopReason('whatever')).toThrow(LeftoverSelectorError)
  })
})

describe('LeftoverProcesses', () => {
  it('never treats a command that is still running as a leftover', async () => {
    const fake = fakeBackend()
    fake.add({ identity: identity(100, 100, 10) })
    const leftovers = new LeftoverProcesses(fake.backend, log)
    leftovers.record('inv-1', { agentId: AGENT }, 'sleep 100', identity(100, 100, 10), false)
    expect(await leftovers.list()).toEqual([])
    const result = await leftovers.stop({ agentId: AGENT }, 'agent-dormant')
    expect(result.stopped).toEqual([])
    expect(fake.signals).toEqual([])
  })

  it('attributes a background process in the session of a finished command to its agent, stream and attempt', async () => {
    const fake = fakeBackend()
    // The shell (pid 100) exited; the dev server it started (pid 101) was reparented but kept its session.
    fake.add({ identity: identity(101, 100, 11) })
    const leftovers = new LeftoverProcesses(fake.backend, log)
    leftovers.record(
      'inv-1',
      { agentId: AGENT, workStreamId: STREAM, attemptId: 2 },
      'npm run dev &',
      identity(100, 100, 10),
      false
    )
    await leftovers.detach('inv-1')
    expect(await leftovers.list()).toEqual([
      expect.objectContaining({
        invocationId: 'inv-1',
        agentId: AGENT,
        workStreamId: STREAM,
        attemptId: 2,
        command: 'npm run dev &',
        pids: [101],
        keptPids: [],
      }),
    ])
    expect((await leftovers.attribution()).get(101)?.agentId).toBe(AGENT)
  })

  it('uses the workload leaf on cgroup boxes, which also holds processes that left the session', async () => {
    const leaves = new Map([['inv-1', [201, 202]]])
    const fake = fakeBackend({ leaves })
    fake.add({ identity: identity(201, 200, 11) })
    fake.add({ identity: identity(202, 202, 12) }) // called setsid: a new session, same leaf
    const leftovers = new LeftoverProcesses(fake.backend, log)
    leftovers.record('inv-1', { agentId: AGENT }, 'docker compose up -d', identity(200, 200, 10), true)
    await leftovers.detach('inv-1')
    const [group] = await leftovers.list()
    expect(group?.pids).toEqual([201, 202])
  })

  it('stops only what the selector names: an attempt, an agent, or a stream', async () => {
    const fake = fakeBackend()
    fake.add({ identity: identity(101, 100, 11) }) // agent A, attempt 1
    fake.add({ identity: identity(301, 300, 31) }) // agent A, attempt 2
    fake.add({ identity: identity(401, 400, 41) }) // agent B, same stream, attempt 3
    fake.add({ identity: identity(501, 500, 51) }) // agent A, another stream
    const leftovers = new LeftoverProcesses(fake.backend, log)
    const record = async (
      id: string,
      sid: number,
      ticks: number,
      ownership: Parameters<LeftoverProcesses['record']>[1]
    ) => {
      leftovers.record(id, ownership, `cmd ${id}`, identity(sid, sid, ticks), false)
      await leftovers.detach(id)
    }
    await record('a1', 100, 10, { agentId: AGENT, workStreamId: STREAM, attemptId: 1 })
    await record('a2', 300, 30, { agentId: AGENT, workStreamId: STREAM, attemptId: 2 })
    await record('b3', 400, 40, { agentId: OTHER, workStreamId: STREAM, attemptId: 3 })
    await record('a-other', 500, 50, { agentId: AGENT, workStreamId: 'stream-2', attemptId: 1 })

    const attempt = await leftovers.stop({ workStreamId: STREAM, attemptId: 1 }, 'attempt-ended')
    expect(attempt.stopped.map((group) => group.invocationId)).toEqual(['a1'])
    expect([...fake.processes.keys()].sort()).toEqual([301, 401, 501])

    const stream = await leftovers.stop({ workStreamId: STREAM }, 'stream-finished')
    expect(stream.stopped.map((group) => group.invocationId).sort()).toEqual(['a2', 'b3'])
    expect([...fake.processes.keys()]).toEqual([501])

    const dormant = await leftovers.stop({ agentId: OTHER }, 'agent-dormant')
    expect(dormant.stopped).toEqual([])
    expect([...fake.processes.keys()]).toEqual([501])

    const agent = await leftovers.stop({ agentId: AGENT }, 'agent-dormant')
    expect(agent.stopped.map((group) => group.invocationId)).toEqual(['a-other'])
    expect(fake.processes.size).toBe(0)
  })

  it('sends SIGTERM first and SIGKILL only to what is still running after the grace period', async () => {
    const fake = fakeBackend()
    fake.add({ identity: identity(101, 100, 11) })
    fake.add({ identity: identity(102, 100, 12), ignoresTerm: true })
    const leftovers = new LeftoverProcesses(fake.backend, log, 0)
    leftovers.record('inv-1', { agentId: AGENT }, 'serve', identity(100, 100, 10), false)
    await leftovers.detach('inv-1')
    const { stopped } = await leftovers.stop({ agentId: AGENT }, 'agent-dormant')
    expect(fake.signals).toEqual([
      { pid: 101, signal: 'SIGTERM' },
      { pid: 102, signal: 'SIGTERM' },
      { pid: 102, signal: 'SIGKILL' },
    ])
    expect(stopped[0]).toMatchObject({ pids: [101, 102], killedPids: [102], survivingPids: [] })
    expect(logs.at(-1)).toContain('Stopped leftover processes (agent-dormant) of agent agent-a')
  })

  it('reports a process that survives SIGKILL instead of hiding it', async () => {
    const fake = fakeBackend()
    fake.add({ identity: identity(101, 100, 11), unkillable: true })
    const leftovers = new LeftoverProcesses(fake.backend, log, 0)
    leftovers.record('inv-1', { agentId: AGENT }, 'stuck', identity(100, 100, 10), false)
    await leftovers.detach('inv-1')
    const { stopped } = await leftovers.stop({ agentId: AGENT }, 'agent-dormant')
    expect(stopped[0]?.survivingPids).toEqual([101])
    // Still tracked, so a later stop or the process list can see it.
    expect((await leftovers.list()).map((group) => group.pids)).toEqual([[101]])
  })

  it('keeps a process started with FICUS_KEEP_RUNNING=1, and one whose environment cannot be read', async () => {
    const fake = fakeBackend()
    fake.add({ identity: identity(101, 100, 11), environ: `PATH=/bin\0${KEEP_RUNNING_ENV}=1\0` })
    fake.add({ identity: identity(102, 100, 12), environ: undefined })
    fake.add({ identity: identity(103, 100, 13) })
    const leftovers = new LeftoverProcesses(fake.backend, log)
    leftovers.record('inv-1', { agentId: AGENT }, 'serve', identity(100, 100, 10), false)
    await leftovers.detach('inv-1')
    const { stopped } = await leftovers.stop({ agentId: AGENT }, 'stream-finished')
    expect(stopped[0]).toMatchObject({ pids: [103], keptPids: [101, 102] })
    expect([...fake.processes.keys()].sort()).toEqual([101, 102])
    expect(fake.signals.map((signal) => signal.pid)).toEqual([103])
    // A group with only kept processes is reported as kept, never signalled.
    const again = await leftovers.stop({ agentId: AGENT }, 'stream-finished')
    expect(again.stopped).toEqual([])
    expect(again.kept[0]?.keptPids).toEqual([101, 102])
  })

  it('never touches the server, its ancestors or zombies', async () => {
    const fake = fakeBackend({ protectedPids: [101] })
    fake.add({ identity: identity(101, 100, 11) })
    fake.add({ identity: identity(102, 100, 12, 'Z') })
    const leftovers = new LeftoverProcesses(fake.backend, log)
    leftovers.record('inv-1', { agentId: AGENT }, 'x', identity(100, 100, 10), false)
    await leftovers.detach('inv-1')
    expect((await leftovers.stop({ agentId: AGENT }, 'agent-dormant')).stopped).toEqual([])
    expect(fake.signals).toEqual([])
  })

  it('leaves a session alone once its leader pid names a different process (pid reuse)', async () => {
    const fake = fakeBackend()
    fake.add({ identity: identity(100, 100, 99) }) // pid 100 reused by a new session leader
    fake.add({ identity: identity(101, 100, 100) })
    const leftovers = new LeftoverProcesses(fake.backend, log)
    leftovers.record('inv-1', { agentId: AGENT }, 'x', identity(100, 100, 10), false)
    await leftovers.detach('inv-1')
    expect(await leftovers.list()).toEqual([])
    expect(fake.signals).toEqual([])
  })

  it('ignores processes in the session that predate the command', async () => {
    const fake = fakeBackend()
    fake.add({ identity: identity(101, 100, 5) })
    const leftovers = new LeftoverProcesses(fake.backend, log)
    leftovers.record('inv-1', { agentId: AGENT }, 'x', identity(100, 100, 10), false)
    await leftovers.detach('inv-1')
    expect(await leftovers.list()).toEqual([])
  })

  it('never records commands without an owner, so they are never stopped', async () => {
    const fake = fakeBackend()
    fake.add({ identity: identity(101, 100, 11) })
    const leftovers = new LeftoverProcesses(fake.backend, log)
    leftovers.record('inv-1', undefined, 'ficus_tmux_new app', identity(100, 100, 10), false)
    await leftovers.detach('inv-1')
    expect(await leftovers.list()).toEqual([])
  })

  it('forgets groups that are gone once stopped, and queues nothing in the box (Core tells the owner)', async () => {
    const fake = fakeBackend()
    fake.add({ identity: identity(101, 100, 11) })
    const leftovers = new LeftoverProcesses(fake.backend, log)
    leftovers.record('inv-1', { agentId: AGENT, workStreamId: STREAM }, 'astro dev', identity(100, 100, 10), false)
    await leftovers.detach('inv-1')
    const { stopped } = await leftovers.stop({ workStreamId: STREAM }, 'stream-finished')
    expect(stopped[0]).toMatchObject({ agentId: AGENT, command: 'astro dev', pids: [101] })
    expect('takeNotices' in leftovers).toBe(false)
    expect(await leftovers.list()).toEqual([])
  })

  it('forgets a finished command that left nothing running as soon as it returns', async () => {
    const fake = fakeBackend()
    fake.add({ identity: identity(101, 100, 11) })
    const leftovers = new LeftoverProcesses(fake.backend, log)
    leftovers.record('left', { agentId: AGENT }, 'npm run dev &', identity(100, 100, 10), false)
    leftovers.record('empty', { agentId: AGENT }, 'ls', identity(200, 200, 20), false)
    await leftovers.detach('left')
    await leftovers.detach('empty')
    expect(leftovers.trackedCount).toBe(1)
    expect((await leftovers.list()).map((group) => group.invocationId)).toEqual(['left'])
  })

  it('never forgets a live leftover for space, however many commands run after it', async () => {
    const fake = fakeBackend()
    // An early dev server of a long attempt, still running.
    fake.add({ identity: identity(101, 100, 11) })
    const leftovers = new LeftoverProcesses(fake.backend, log, 0)
    leftovers.record(
      'dev',
      { agentId: AGENT, workStreamId: STREAM, attemptId: 1 },
      'astro dev &',
      identity(100, 100, 10),
      false
    )
    await leftovers.detach('dev')
    // More than MAX_TRACKED later commands. Their detach checks have not run
    // yet when capacity is exceeded, so only the verified prune can make room.
    for (let i = 0; i < MAX_TRACKED + 50; i++)
      leftovers.record(
        `later-${i}`,
        { agentId: i % 2 ? AGENT : OTHER, workStreamId: `s-${i}`, attemptId: 2 },
        'ls',
        identity(1_000 + i, 1_000 + i, 20),
        false
      )
    for (let i = 0; i < MAX_TRACKED + 50; i++) await leftovers.detach(`later-${i}`)
    expect(leftovers.trackedCount).toBe(1)
    expect((await leftovers.list()).map((group) => group.invocationId)).toEqual(['dev'])
    const { stopped } = await leftovers.stop({ workStreamId: STREAM, attemptId: 1 }, 'attempt-ended')
    expect(stopped.map((group) => group.pids)).toEqual([[101]])
    expect(fake.processes.size).toBe(0)
  })

  it('over capacity evicts only finished commands verified empty, never live ones', async () => {
    const fake = fakeBackend()
    const leftovers = new LeftoverProcesses(fake.backend, log)
    // Every remembered command still has a live process: none may be evicted.
    for (let i = 0; i <= MAX_TRACKED; i++) {
      fake.add({ identity: identity(10_001 + i * 2, 10_000 + i * 2, 20) })
      leftovers.record(`live-${i}`, { agentId: AGENT }, 'serve', identity(10_000 + i * 2, 10_000 + i * 2, 10), false)
    }
    for (let i = 0; i <= MAX_TRACKED; i++) await leftovers.detach(`live-${i}`)
    leftovers.record('one-more', { agentId: AGENT }, 'ls', identity(5, 5, 10), false)
    await Bun.sleep(0)
    expect(leftovers.trackedCount).toBe(MAX_TRACKED + 2)
    expect((await leftovers.list({ agentId: AGENT })).some((group) => group.invocationId === 'live-0')).toBe(true)
  })

  it('keeps tracking a command whose child was forked during the stop grace period', async () => {
    const fake = fakeBackend()
    fake.add({ identity: identity(101, 100, 11) })
    const backend: LeftoverBackend = {
      ...fake.backend,
      signal: (pid, signal) => {
        fake.backend.signal(pid, signal)
        // The dying process forks a child into the same session.
        if (pid === 101) fake.add({ identity: identity(102, 100, 12) })
      },
    }
    const leftovers = new LeftoverProcesses(backend, log, 0)
    leftovers.record('inv-1', { agentId: AGENT }, 'serve', identity(100, 100, 10), false)
    await leftovers.detach('inv-1')
    await leftovers.stop({ agentId: AGENT }, 'agent-dormant')
    expect((await leftovers.list()).map((group) => group.pids)).toEqual([[102]])
  })
})

describe.skipIf(process.platform !== 'linux')('LeftoverProcesses on real processes', () => {
  it('stops a reparented background child of a finished command, keeps the opted-out one, and spares others', async () => {
    const { spawn } = await import('node:child_process')
    const { linuxLeftoverBackend } = await import('./leftover-processes')
    const { processSessionDriver } = await import('./process-session')
    // Like a bash invocation: its own session, two background children, then the shell exits.
    const shell = spawn(
      'bash',
      ['-c', `sleep 300 >/dev/null & echo $!; ${KEEP_RUNNING_ENV}=1 sleep 301 >/dev/null & echo $!; sleep 0.3`],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const unrelated = spawn('sleep', ['302'], { detached: true, stdio: 'ignore' })
    let output = ''
    shell.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    const leader = await processSessionDriver.readIdentity(shell.pid!)
    await new Promise((resolve) => shell.once('exit', resolve))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const [stopPid, keepPid] = output.trim().split('\n').map(Number)
    try {
      expect(leader?.sid).toBe(shell.pid!)
      const leftovers = new LeftoverProcesses(
        linuxLeftoverBackend(() => null),
        () => {},
        2_000
      )
      leftovers.record('inv-real', { agentId: AGENT, workStreamId: STREAM, attemptId: 1 }, 'sleep &', leader!, false)
      await leftovers.detach('inv-real')
      const result = await leftovers.stop({ workStreamId: STREAM, attemptId: 1 }, 'attempt-ended')
      expect(result.stopped[0]).toMatchObject({ pids: [stopPid], keptPids: [keepPid], survivingPids: [] })
      expect(await processSessionDriver.readIdentity(stopPid!)).toBeUndefined()
      expect(await processSessionDriver.readIdentity(keepPid!)).toBeDefined()
      expect(await processSessionDriver.readIdentity(unrelated.pid!)).toBeDefined()
    } finally {
      for (const pid of [stopPid, keepPid, unrelated.pid])
        try {
          process.kill(pid!, 'SIGKILL')
        } catch {
          // already gone
        }
    }
  })
})
