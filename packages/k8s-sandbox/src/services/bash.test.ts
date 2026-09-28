import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'fs'
import { join } from 'path'
import { spawn } from 'node:child_process'
import { tmpdir } from 'os'
import {
  admitStoppedProcess,
  handleBash,
  commandUsesDocker,
  reconcileBashRecord,
  stoppedBashArguments,
  buildPreamble,
  MAX_BASH_TIMEOUT_SECONDS,
  normalizeBashTimeoutSeconds,
} from './bash'
import {
  BashInvocationRegistry,
  type BashInvocationLease,
  type StartingProcessRecord,
} from './bash-invocation-registry'
import { processSessionDriver, type ProcessIdentity, type ProcessSessionDriver } from './process-session'
import { exemptLongLivedStreamFromIdleTimeout } from './streaming-routes'
import { IdleExitCoordinator } from './idle-exit'

let testDir: string
const ISOLATION_SAFETY_MS = 2_000
const ISOLATION_OPERATION_BOUND_MS = 1_500
const ISOLATION_OWNER_JOINS_MS = 2 * (500 + 500)
const ISOLATION_SCHEDULER_MARGIN_MS = 1_500
const ISOLATION_TEST_BUDGET_MS =
  ISOLATION_SAFETY_MS + 3 * ISOLATION_OPERATION_BOUND_MS + ISOLATION_OWNER_JOINS_MS + ISOLATION_SCHEDULER_MARGIN_MS

beforeEach(() => {
  const raw = join(tmpdir(), `sandbox-bash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(raw, { recursive: true })
  testDir = realpathSync(raw) // macOS: /tmp → /private/tmp
  process.env.WORKSPACE_PATH = testDir
})

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true })
  }
  delete process.env.WORKSPACE_PATH
})

/**
 * Consume an SSE Response and collect all parsed events.
 */
async function consumeSSE(resp: Response): Promise<any[]> {
  const events: any[] = []
  const reader = resp.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        events.push(JSON.parse(line.slice(6)))
      }
    }
  }
  return events
}

function collectOutput(events: any[]): { stdout: string; stderr: string; exitCode: number; errors: string[] } {
  let stdout = ''
  let stderr = ''
  let exitCode = -1
  const errors: string[] = []
  for (const e of events) {
    if (e.stdout) stdout += Buffer.from(e.stdout, 'base64').toString()
    if (e.stderr) stderr += Buffer.from(e.stderr, 'base64').toString()
    if (e.exitCode !== undefined) exitCode = e.exitCode
    if (e.error) errors.push(e.error)
  }
  return { stdout, stderr, exitCode, errors }
}

function admissionDriver(
  observations: Array<ProcessIdentity | undefined>,
  signals: Array<[number, NodeJS.Signals | 0]>
): ProcessSessionDriver {
  return {
    readIdentity: async () => observations.shift(),
    scanSessionIdentities: async () => [],
    signal: (target, signal) => signals.push([target, signal]),
    scanSession: async () => [],
    waitForExit: async () => true,
  }
}

function admissionLease(events: string[], starting: StartingProcessRecord[] = []): BashInvocationLease {
  return {
    generation: 0,
    markStarting: async (process) => {
      events.push('starting')
      starting.push(process)
    },
    markRunning: async () => {
      events.push('running')
    },
    complete: async () => {},
  }
}

describe('stopped bash admission', () => {
  const observed = (overrides: Partial<ProcessIdentity> = {}): ProcessIdentity => ({
    pid: 50,
    pgid: 50,
    sid: 50,
    state: 'T',
    startToken: 'linux:9',
    ...overrides,
  })

  it('launches a same-PID self-stopping wrapper before the user command', () => {
    expect(stoppedBashArguments('echo ok')).toEqual(['-c', 'kill -STOP $$; exec "$@"', '--', 'bash', '-c', 'echo ok'])
    expect(stoppedBashArguments('echo ok')).not.toContain('setsid')
  })

  it('waits through unsafe and running transitions before the sole CONT', async () => {
    const signals: Array<[number, NodeJS.Signals | 0]> = []
    const events: string[] = []
    const starting: StartingProcessRecord[] = []
    const observations = [observed({ pgid: 2, sid: 3, state: 'R' }), observed({ state: 'R' }), observed(), observed()]
    const identity = await admitStoppedProcess(
      { pid: 50 },
      admissionLease(events, starting),
      {
        processDriver: admissionDriver(observations, signals),
        admissionTimeoutMs: 100,
        waitForAdmissionPoll: async () => {},
      },
      new Promise<number | null>(() => {})
    )
    expect(identity.state).toBe('T')
    expect(observations).toHaveLength(0)
    expect(events).toEqual(['starting', 'running'])
    expect(starting).toEqual([{ pid: 50, startToken: 'linux:9' }])
    expect(signals).toEqual([[-50, 'SIGCONT']])
  })

  it('reconciles a restart at the partial starting-owner barrier before retry', async () => {
    const runtimeDir = join(testDir, 'restart-registry')
    const first = new BashInvocationRegistry({ runtimeDir, reconcile: async () => {} })
    const lease = await first.acquire('restart', 'digest')
    await lease.markStarting({ pid: 50, startToken: 'linux:9' })
    const signals: Array<[number, NodeJS.Signals | 0]> = []
    const stopped = observed({ pgid: 2, sid: 3 })
    const driver = admissionDriver([stopped], signals)
    const restarted = new BashInvocationRegistry({
      runtimeDir,
      reconcile: (record) => reconcileBashRecord(record, driver),
    })
    const retry = await restarted.acquire('restart', 'digest')
    expect(signals).toEqual([[50, 'SIGKILL']])
    expect(retry.generation).toBe(1)
    const terminalFile = (await Array.fromAsync(new Bun.Glob('*.json').scan({ cwd: join(runtimeDir, 'terminal') })))[0]!
    const terminal = JSON.parse(readFileSync(join(runtimeDir, 'terminal', terminalFile), 'utf8'))
    expect(terminal).toMatchObject({
      generation: 0,
      state: 'terminated',
      priorState: 'starting',
      pid: 50,
      startToken: 'linux:9',
    })
    expect(terminal).not.toHaveProperty('pgid')
    expect(terminal).not.toHaveProperty('sid')
    expect(await Array.fromAsync(new Bun.Glob('*.json').scan({ cwd: runtimeDir }))).toEqual([])
    const activeFile = (await Array.fromAsync(new Bun.Glob('*.json').scan({ cwd: join(runtimeDir, 'active') })))[0]!
    expect(JSON.parse(readFileSync(join(runtimeDir, 'active', activeFile), 'utf8'))).toMatchObject({
      generation: 1,
      state: 'starting',
    })
  })

  it('rejects PID reuse before CONT', async () => {
    const signals: Array<[number, NodeJS.Signals | 0]> = []
    await expect(
      admitStoppedProcess(
        { pid: 50 },
        admissionLease([]),
        {
          processDriver: admissionDriver([observed({ state: 'R' }), observed({ startToken: 'linux:10' })], signals),
          admissionTimeoutMs: 100,
          waitForAdmissionPoll: async () => {},
        },
        new Promise<number | null>(() => {})
      )
    ).rejects.toThrow('start token changed')
    expect(signals).toEqual([])
  })

  it('revalidates the complete stopped tuple after markRunning and before CONT', async () => {
    const signals: Array<[number, NodeJS.Signals | 0]> = []
    const events: string[] = []
    await expect(
      admitStoppedProcess(
        { pid: 50 },
        admissionLease(events),
        {
          processDriver: admissionDriver([observed(), observed({ startToken: 'linux:reused' })], signals),
          admissionTimeoutMs: 100,
          waitForAdmissionPoll: async () => {},
        },
        new Promise<number | null>(() => {})
      )
    ).rejects.toThrow('identity changed before CONT')
    expect(events).toEqual(['starting', 'running'])
    expect(signals).toEqual([])
  })

  it('fails closed when the wrapper exits before stopped admission', async () => {
    const signals: Array<[number, NodeJS.Signals | 0]> = []
    await expect(
      admitStoppedProcess(
        { pid: 50 },
        admissionLease([]),
        {
          processDriver: admissionDriver([undefined], signals),
          admissionTimeoutMs: 100,
          waitForAdmissionPoll: async () => {},
        },
        Promise.resolve(17)
      )
    ).rejects.toThrow('exited before stopped-session admission')
    expect(signals).toEqual([])
  })
})

describe('foreground timeout contract', () => {
  it('defaults invalid values, preserves internal omission, and caps at one hour', () => {
    expect(MAX_BASH_TIMEOUT_SECONDS).toBe(3_600)
    expect(normalizeBashTimeoutSeconds(undefined)).toBeUndefined()
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalizeBashTimeoutSeconds(value)).toBe(180)
    }
    expect(normalizeBashTimeoutSeconds(42)).toBe(42)
    expect(normalizeBashTimeoutSeconds(7_200)).toBe(3_600)
  })
})

describe('handleBash', () => {
  it('executes a simple command', async () => {
    const resp = handleBash({ command: 'echo hello', cwd: testDir, sourceEnv: false, activateDevbox: false })
    const { stdout, exitCode } = collectOutput(await consumeSSE(resp))
    expect(stdout.trim()).toBe('hello')
    expect(exitCode).toBe(0)
  })

  it('reports the actual generated invocation ID and preserves a supplied ID', async () => {
    const generatedEvents = await consumeSSE(
      handleBash({ command: 'true', cwd: testDir, sourceEnv: false, activateDevbox: false })
    )
    const generated = generatedEvents.find((event) => event.invocation)?.invocation.id
    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/)
    expect(generated).not.toBe('server-fallback')

    const suppliedId = `caller-owned-${crypto.randomUUID()}`
    const suppliedEvents = await consumeSSE(
      handleBash({
        invocationId: suppliedId,
        command: 'true',
        cwd: testDir,
        sourceEnv: false,
        activateDevbox: false,
      })
    )
    expect(suppliedEvents.find((event) => event.invocation)?.invocation.id).toBe(suppliedId)
  })

  it('captures stderr', async () => {
    const resp = handleBash({ command: 'echo error >&2', cwd: testDir, sourceEnv: false, activateDevbox: false })
    const { stderr, exitCode } = collectOutput(await consumeSSE(resp))
    expect(stderr.trim()).toBe('error')
    expect(exitCode).toBe(0)
  })

  it('returns non-zero exit code on failure', async () => {
    const resp = handleBash({ command: 'exit 42', cwd: testDir, sourceEnv: false, activateDevbox: false })
    const { exitCode } = collectOutput(await consumeSSE(resp))
    expect(exitCode).toBe(42)
  })

  it('uses the specified working directory', async () => {
    const subdir = join(testDir, 'mydir')
    mkdirSync(subdir)
    const resp = handleBash({ command: 'pwd', cwd: subdir, sourceEnv: false, activateDevbox: false })
    const { stdout } = collectOutput(await consumeSSE(resp))
    expect(stdout.trim()).toBe(subdir)
  })

  it('passes additional environment variables', async () => {
    const resp = handleBash({
      command: 'echo $MY_VAR',
      cwd: testDir,
      env: { MY_VAR: 'test-value' },
      sourceEnv: false,
      activateDevbox: false,
    })
    const { stdout } = collectOutput(await consumeSSE(resp))
    expect(stdout.trim()).toBe('test-value')
  })

  it('sources .tau/.env when sourceEnv is true', async () => {
    const tauDir = join(testDir, '.tau')
    mkdirSync(tauDir, { recursive: true })
    writeFileSync(join(tauDir, '.env'), 'FICUS_SECRET=from-env-file\n')

    const resp = handleBash({ command: 'echo $FICUS_SECRET', cwd: testDir, sourceEnv: true, activateDevbox: false })
    const { stdout } = collectOutput(await consumeSSE(resp))
    expect(stdout.trim()).toBe('from-env-file')
  })

  it('does not source .tau/.env when sourceEnv is false', async () => {
    const tauDir = join(testDir, '.tau')
    mkdirSync(tauDir, { recursive: true })
    writeFileSync(join(tauDir, '.env'), 'FICUS_SECRET=should-not-appear\n')

    const resp = handleBash({
      command: 'echo "${FICUS_SECRET:-empty}"',
      cwd: testDir,
      sourceEnv: false,
      activateDevbox: false,
    })
    const { stdout } = collectOutput(await consumeSSE(resp))
    expect(stdout.trim()).toBe('empty')
  })

  it('handles timeout', async () => {
    const resp = handleBash({
      command: 'sleep 30',
      cwd: testDir,
      timeoutSeconds: 1,
      sourceEnv: false,
      activateDevbox: false,
    })
    const { errors, exitCode } = collectOutput(await consumeSSE(resp))
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toContain('timed out')
    // A timed-out command MUST report a non-zero exit (124, timeout convention),
    // not default to success. The timeout branch closes the SSE stream, so it must
    // carry the exit code itself — the later close-handler send is a no-op by then.
    expect(exitCode).toBe(124)
  })

  it(
    'removes descendants before reporting a timeout',
    async () => {
      const pidFile = join(testDir, 'child.pid')
      const bounded = async <T>(promise: Promise<T>, label: string, ms = ISOLATION_OPERATION_BOUND_MS): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
              timer = setTimeout(() => reject(new Error(label)), ms)
            }),
          ])
        } finally {
          if (timer) clearTimeout(timer)
        }
      }
      const cleanupOne = async (identity: ProcessIdentity | undefined, label: string) => {
        if (!identity) return
        const current = await processSessionDriver.readIdentity(identity.pid)
        if (!current || current.startToken !== identity.startToken) return
        try {
          processSessionDriver.signal(identity.pid, 'SIGTERM')
        } catch {
          // Exact owner may already have exited during response settlement.
        }
        let exited = await bounded(processSessionDriver.waitForExit(identity.pid, 500), `${label}-term-join-failed`)
        if (!exited) {
          try {
            processSessionDriver.signal(identity.pid, 'SIGKILL')
          } catch {
            // Exact owner may exit between the join proof and escalation.
          }
          exited = await bounded(processSessionDriver.waitForExit(identity.pid, 500), `${label}-kill-join-failed`)
        }
        const survivor = await processSessionDriver.readIdentity(identity.pid)
        if (!exited || survivor?.startToken === identity.startToken) throw new Error(`${label}-exact-owner-survived`)
      }
      const neighbor = spawn('sleep', ['30'], { detached: true })
      const neighborIdentity = await processSessionDriver.readIdentity(neighbor.pid!)
      const neighborClosed = Promise.withResolvers<void>()
      neighbor.once('close', () => neighborClosed.resolve())
      if (!neighborIdentity) {
        neighbor.kill('SIGKILL')
        await bounded(neighborClosed.promise, 'isolation-neighbor-identity-missing-join-failed')
        throw new Error('isolation-neighbor-identity-missing')
      }
      const cleanupNeighbor = async () => {
        if ((await processSessionDriver.readIdentity(neighborIdentity.pid))?.startToken === neighborIdentity.startToken)
          processSessionDriver.signal(neighborIdentity.pid, 'SIGKILL')
        await bounded(neighborClosed.promise, 'isolation-neighbor-join-failed')
        if ((await processSessionDriver.readIdentity(neighborIdentity.pid))?.startToken === neighborIdentity.startToken)
          throw new Error('isolation-neighbor-exact-owner-survived')
      }
      let wrapperPid: number | undefined
      let wrapperIdentity: ProcessIdentity | undefined
      let childIdentity: ProcessIdentity | undefined
      let releasedUnisolated = false
      const driver: ProcessSessionDriver = {
        ...processSessionDriver,
        readIdentity: async (pid) => {
          const identity = await processSessionDriver.readIdentity(pid)
          if (pid !== wrapperPid || !identity) return identity
          wrapperIdentity ??= identity
          if (
            !releasedUnisolated &&
            identity.startToken === wrapperIdentity.startToken &&
            (identity.state === 'T' || identity.state === 't') &&
            (identity.pgid !== identity.pid || identity.sid !== identity.pid)
          ) {
            releasedUnisolated = true
            processSessionDriver.signal(identity.pid, 'SIGCONT')
          }
          return identity
        },
      }
      const registry = new BashInvocationRegistry({
        runtimeDir: join(testDir, 'descendant-registry'),
        reconcile: (record) => reconcileBashRecord(record, driver),
      })
      let fireDeadline!: () => void
      const safety = Promise.withResolvers<never>()
      const safetyControl = Promise.withResolvers<void>()
      const safetyTimer = setTimeout(() => {
        safety.reject(new Error('isolation-fixture-did-not-settle'))
        safetyControl.resolve()
      }, ISOLATION_SAFETY_MS)
      const resp = handleBash(
        {
          command: `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; echo READY; wait`,
          cwd: testDir,
          timeoutSeconds: 30,
          sourceEnv: false,
          activateDevbox: false,
        },
        registry,
        {
          processDriver: driver,
          spawn: (command, args, options) => {
            const proc = spawn(command, args, options)
            wrapperPid = proc.pid
            return proc
          },
          scheduleTimeout: (callback) => {
            fireDeadline = callback
            return () => {}
          },
        }
      )
      const reader = resp.body!.getReader()
      const events: any[] = []
      let pendingRead: ReturnType<typeof reader.read> | undefined
      let streamDone = false
      let primaryError: unknown
      const cleanupErrors: unknown[] = []
      try {
        while (true) {
          const read = reader.read()
          pendingRead = read
          const { done, value } = await Promise.race([read, safety.promise])
          if (done) {
            streamDone = true
            break
          }
          for (const line of new TextDecoder().decode(value).split('\n')) {
            if (!line.startsWith('data: ')) continue
            const event = JSON.parse(line.slice(6))
            events.push(event)
            if (!event.stdout || !Buffer.from(event.stdout, 'base64').toString().includes('READY')) continue
            const childPid = Number(readFileSync(pidFile, 'utf8').trim())
            childIdentity = await processSessionDriver.readIdentity(childPid)
            expect(process.kill(neighbor.pid!, 0)).toBe(true)
            expect(releasedUnisolated).toBe(false)
            fireDeadline()
          }
        }
        const { exitCode } = collectOutput(events)
        expect(exitCode).toBe(124)
        expect(childIdentity).toBeDefined()
        // Darwin can retain the already-dead descendant as a zombie until its
        // parent is reaped. The existing isolation bound owns that OS lifecycle.
        expect(await processSessionDriver.waitForExit(childIdentity!.pid, ISOLATION_OPERATION_BOUND_MS)).toBe(true)
        expect(() => process.kill(childIdentity!.pid, 0)).toThrow()
      } catch (error) {
        primaryError = error
      } finally {
        clearTimeout(safetyTimer)
        safetyControl.resolve()
        await safetyControl.promise
        try {
          await cleanupOne(childIdentity, 'isolation-child')
        } catch (error) {
          cleanupErrors.push(error)
        }
        if (!streamDone) {
          try {
            await bounded(reader.cancel('test-settled'), 'isolation-response-cancel-did-not-settle')
          } catch (error) {
            cleanupErrors.push(error)
          }
        }
        try {
          await cleanupOne(wrapperIdentity, 'isolation-wrapper')
        } catch (error) {
          cleanupErrors.push(error)
        }
        if (pendingRead) {
          try {
            await bounded(
              pendingRead.then(() => undefined),
              'isolation-response-read-did-not-settle'
            )
          } catch (error) {
            cleanupErrors.push(error)
          }
        }
        try {
          await cleanupNeighbor()
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      if (cleanupErrors.length)
        throw new AggregateError(
          primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
          'isolation fixture cleanup failed'
        )
      if (primaryError !== undefined) throw primaryError
    },
    ISOLATION_TEST_BUDGET_MS
  )

  it('cancellation during Docker readiness prevents a later spawn', async () => {
    const ready = Promise.withResolvers<void>()
    const spawnDecision = Promise.withResolvers<'cancelled' | 'spawn'>()
    const waitForDockerReadyMock = mock(() => ready.promise.then(() => true))
    const spawnMock = mock(() => {
      throw new Error('spawn must not run')
    })
    const idle = new IdleExitCoordinator({ bootedAt: 0, lastActivityAt: 0, windowMs: 600_000 })
    const requestReservation = idle.beginRequest(0)!
    const admissionFenced = mock(requestReservation.release)
    const resp = handleBash(
      { command: 'docker ps', cwd: testDir, sourceEnv: false, activateDevbox: false },
      undefined,
      {
        waitForDockerReady: waitForDockerReadyMock,
        spawn: spawnMock,
        onSpawnDecision: spawnDecision.resolve,
        onAdmissionFenced: admissionFenced,
      }
    )
    expect(waitForDockerReadyMock).toHaveBeenCalledTimes(1)
    expect(admissionFenced).not.toHaveBeenCalled()
    const reader = resp.body!.getReader()
    let settled = false
    const cancelled = reader.cancel('transport-loss').finally(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(admissionFenced).toHaveBeenCalledTimes(1)
    expect(
      idle.tryBeginExit({
        now: 600_000,
        activeInvocations: false,
        openShells: 0,
        watcherActive: false,
        reconciliationSettled: true,
      })
    ).toBeDefined()
    ready.resolve()
    expect(await spawnDecision.promise).toBe('cancelled')
    await cancelled
    expect(spawnMock).not.toHaveBeenCalled()
    expect(admissionFenced).toHaveBeenCalledTimes(1)
  })

  it('settles idle admission after registry ownership and before spawn', async () => {
    const events: string[] = []
    const lease: BashInvocationLease = {
      generation: 0,
      markStarting: async () => {},
      markRunning: async () => {},
      complete: async () => {},
    }
    const response = handleBash(
      { command: 'echo never', cwd: testDir, sourceEnv: false, activateDevbox: false },
      { acquire: async () => (events.push('active'), lease), terminate: async () => ({ remainingPids: [] }) },
      {
        onAdmissionFenced: () => events.push('admission-fenced'),
        spawn: () => {
          events.push('spawn')
          throw new Error('expected fixture failure')
        },
      }
    )
    await response.text()
    expect(events).toEqual(['active', 'admission-fenced', 'spawn'])
  })

  it('cancellation racing invocation acquisition releases the fence without spawning', async () => {
    const acquisition = Promise.withResolvers<BashInvocationLease>()
    const acquire = mock(() => acquisition.promise)
    const complete = mock(async () => {})
    const terminate = mock(async (): Promise<{ remainingPids: [] }> => ({ remainingPids: [] }))
    const spawnMock = mock(() => {
      throw new Error('spawn must not run')
    })
    const admissionFenced = mock(() => {})
    const resp = handleBash(
      { command: 'echo never', cwd: testDir, sourceEnv: false, activateDevbox: false },
      { acquire, terminate },
      { spawn: spawnMock, onAdmissionFenced: admissionFenced }
    )
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(admissionFenced).not.toHaveBeenCalled()
    const reader = resp.body!.getReader()
    const cancelled = reader.cancel('transport-loss')
    acquisition.resolve({ generation: 0, markStarting: async () => {}, markRunning: async () => {}, complete })
    await cancelled
    expect(spawnMock).not.toHaveBeenCalled()
    expect(complete).toHaveBeenCalledWith('failed')
    expect(admissionFenced).toHaveBeenCalledTimes(1)
  })

  it('KILL-es a ready TERM-ignoring child and grandchild without touching a neighbor session', async () => {
    const pidFile = join(testDir, 'tree.pids')
    const neighbor = spawn('sleep', ['30'], { detached: true })
    let killed = false
    const driver: ProcessSessionDriver = {
      ...processSessionDriver,
      signal: (target, signal) => {
        if (signal === 'SIGKILL') killed = true
        processSessionDriver.signal(target, signal)
      },
      waitForExit: (pid, grace) => (killed ? processSessionDriver.waitForExit(pid, grace) : Promise.resolve(false)),
      waitForSessionEmpty: (sid, grace) =>
        killed ? processSessionDriver.waitForSessionEmpty!(sid, grace) : processSessionDriver.scanSession(sid),
    }
    const registry = new BashInvocationRegistry({
      runtimeDir: join(testDir, 'kill-registry'),
      reconcile: (record) => reconcileBashRecord(record, driver),
    })
    let fireDeadline!: () => void
    try {
      const resp = handleBash(
        {
          command: `bash -c 'trap "" TERM; sleep 30 & echo "$$ $!" > ${JSON.stringify(pidFile)}; echo READY; wait' & wait`,
          cwd: testDir,
          timeoutSeconds: 30,
          sourceEnv: false,
          activateDevbox: false,
        },
        registry,
        {
          processDriver: driver,
          scheduleTimeout: (callback) => {
            fireDeadline = callback
            return () => {}
          },
        }
      )
      const reader = resp.body!.getReader()
      const events: any[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        for (const line of new TextDecoder().decode(value).split('\n')) {
          if (!line.startsWith('data: ')) continue
          const event = JSON.parse(line.slice(6))
          events.push(event)
          if (event.stdout && Buffer.from(event.stdout, 'base64').toString().includes('READY')) fireDeadline()
        }
      }
      const { exitCode, errors } = collectOutput(events)
      expect(errors).toEqual([`Command timed out after 30s`])
      const owned = readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number)
      expect(exitCode).toBe(124)
      for (const pid of owned) {
        // Darwin may retain a killed orphan as a zombie until launchd reaps it.
        // Join that observable exit before asserting PID absence.
        expect(await processSessionDriver.waitForExit(pid, ISOLATION_OPERATION_BOUND_MS)).toBe(true)
        expect(() => process.kill(pid, 0)).toThrow()
      }
      expect(process.kill(neighbor.pid!, 0)).toBe(true)
    } finally {
      if (existsSync(pidFile)) {
        for (const pid of readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number)) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // The owned process was already reaped by the production cleanup.
          }
        }
      }
      try {
        process.kill(-neighbor.pid!, 'SIGKILL')
      } catch {
        // The neighbor may already have exited during test teardown.
      }
    }
  })

  it('response cancellation removes the owned session before settling', async () => {
    const resp = handleBash({
      command: 'sleep 30 & wait',
      cwd: testDir,
      sourceEnv: false,
      activateDevbox: false,
    })
    const reader = resp.body!.getReader()
    const first = await reader.read()
    const event = JSON.parse(new TextDecoder().decode(first.value).split('data: ')[1])
    const pid = event.invocation.pid as number
    await reader.cancel('transport-loss')
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('serial timeout retry stress never overlaps generations or port ownership', async () => {
    const invocationId = `stress-${crypto.randomUUID()}`
    const port = 20_000 + Math.floor(Math.random() * 10_000)
    const sessions: number[] = []
    for (let generation = 0; generation < 25; generation++) {
      const resp = handleBash({
        invocationId,
        command: `node -e "require('net').createServer().listen(${port}, '127.0.0.1')"`,
        cwd: testDir,
        timeoutSeconds: 0.03,
        sourceEnv: false,
        activateDevbox: false,
      })
      const events = await consumeSSE(resp)
      const diagnostic = events.find((event) => event.invocation)?.invocation
      expect(diagnostic.id).toBe(invocationId)
      expect(diagnostic.generation).toBe(generation)
      expect(collectOutput(events).exitCode).toBe(124)
      sessions.push(diagnostic.sid)
      expect(() => process.kill(diagnostic.pid, 0)).toThrow()
    }
    expect(new Set(sessions).size).toBe(25)
  }, 10_000)

  it('handles multi-line output', async () => {
    const resp = handleBash({
      command: 'echo "line1"; echo "line2"; echo "line3"',
      cwd: testDir,
      sourceEnv: false,
      activateDevbox: false,
    })
    const { stdout, exitCode } = collectOutput(await consumeSSE(resp))
    expect(stdout.trim()).toBe('line1\nline2\nline3')
    expect(exitCode).toBe(0)
  })

  describe('VM box: logical cwd is rebased onto the box HOME', () => {
    const originalBoxHome = process.env.FICUS_BOX_HOME
    const originalDevboxDir = process.env.FICUS_DEVBOX_DIR
    const originalDevboxLog = process.env.DEVBOX_LOG
    const originalPath = process.env.PATH
    afterEach(() => {
      if (originalBoxHome !== undefined) process.env.FICUS_BOX_HOME = originalBoxHome
      else delete process.env.FICUS_BOX_HOME
      if (originalDevboxDir !== undefined) process.env.FICUS_DEVBOX_DIR = originalDevboxDir
      else delete process.env.FICUS_DEVBOX_DIR
      if (originalDevboxLog !== undefined) process.env.DEVBOX_LOG = originalDevboxLog
      else delete process.env.DEVBOX_LOG
      if (originalPath !== undefined) process.env.PATH = originalPath
      else delete process.env.PATH
    })

    it('routes bare devbox add to the VM devbox directory', async () => {
      const bin = join(testDir, 'bin')
      const devboxDir = join(testDir, '.tau', 'devbox')
      const log = join(testDir, 'devbox-calls')
      mkdirSync(bin, { recursive: true })
      mkdirSync(devboxDir, { recursive: true })
      writeFileSync(join(devboxDir, 'devbox.json'), '{"packages":[]}')
      writeFileSync(
        join(bin, 'devbox'),
        '#!/usr/bin/env bash\nprintf "%s|%s\\n" "$PWD" "$*" >> "$DEVBOX_LOG"\nexit 0\n'
      )
      chmodSync(join(bin, 'devbox'), 0o755)
      process.env.FICUS_BOX_HOME = testDir
      process.env.FICUS_DEVBOX_DIR = devboxDir
      process.env.DEVBOX_LOG = log
      process.env.PATH = `${bin}:${process.env.PATH}`

      const resp = handleBash({
        command: 'devbox add cowsay',
        cwd: testDir,
        // Pass the fixture-owned executable path explicitly to the child.
        env: { DEVBOX_LOG: log, PATH: `${bin}:/usr/bin:/bin` },
        sourceEnv: false,
      })
      const { stdout, stderr, errors, exitCode } = collectOutput(await consumeSSE(resp))
      expect(exitCode, `${stderr}\n${errors.join('\n')}`).toBe(0)
      expect(stdout).toBe('')
      expect(readFileSync(log, 'utf8').split('\n')[0]).toBe(`${devboxDir}|add cowsay`)
    })

    it('rebases a logical /private cwd to ~/.private before spawning', async () => {
      // The vm coding tools send a LOGICAL cwd (/private); box-provision lays the
      // real dir out under HOME. With FICUS_BOX_HOME set the server must rebase it,
      // else `bash` cd's into a non-existent (or root-owned) path and every op fails.
      const privateDir = join(testDir, '.private')
      mkdirSync(privateDir, { recursive: true })
      process.env.FICUS_BOX_HOME = testDir

      const resp = handleBash({ command: 'pwd', cwd: '/private', sourceEnv: false, activateDevbox: false })
      const { stdout, exitCode } = collectOutput(await consumeSSE(resp))
      expect(exitCode).toBe(0)
      expect(stdout.trim()).toBe(privateDir)
    })
  })
})

describe('commandUsesDocker', () => {
  it('detects docker as a command token', () => {
    expect(commandUsesDocker('docker ps')).toBe(true)
    expect(commandUsesDocker('docker')).toBe(true)
    expect(commandUsesDocker('sudo docker build .')).toBe(true)
    expect(commandUsesDocker('cd /app && docker compose up -d')).toBe(true)
    expect(commandUsesDocker('docker-compose up')).toBe(true)
    expect(commandUsesDocker('(docker run --rm img)')).toBe(true)
  })

  it('does not match docker as a substring of another token', () => {
    expect(commandUsesDocker('echo dockerfile')).toBe(false)
    expect(commandUsesDocker('cat Dockerfile')).toBe(false)
    expect(commandUsesDocker('mydocker run')).toBe(false)
    expect(commandUsesDocker('echo "no containers here"')).toBe(false)
  })
})

describe('buildPreamble workload deprioritization', () => {
  it('leads with a self-renice and an oom_score_adj raise so the workload loses to the server', () => {
    const preamble = buildPreamble({ sourceEnv: false, activateDevbox: false })
    // Must be FIRST — before env sourcing — so the whole command + children inherit it.
    const lines = preamble.split('\n')
    expect(lines[0]).toBe('renice 19 $$ >/dev/null 2>&1 || true')
    expect(lines[1]).toBe('[ -w /proc/$$/oom_score_adj ] && echo 500 >/proc/$$/oom_score_adj 2>/dev/null || true')
  })

  it('is fail-open: both deprioritization ops tolerate a box without renice or a writable oom_score_adj', () => {
    const preamble = buildPreamble({ sourceEnv: true, activateDevbox: false })
    expect(preamble).toContain('renice 19 $$ >/dev/null 2>&1 || true')
    expect(preamble).toContain('[ -w /proc/$$/oom_score_adj ] && echo 500 >/proc/$$/oom_score_adj 2>/dev/null || true')
    // env sourcing still present and AFTER the deprioritization
    expect(preamble.indexOf('renice 19')).toBeLessThan(preamble.indexOf('set -a'))
  })
})

describe('long-lived bash streams under the server idle timeout', () => {
  // Bun.serve's idleTimeout is not reset by response writes: a streaming
  // response is severed that many seconds after the request, output or not
  // (evaluated on a coarse tick — ~4s after the first byte even at
  // idleTimeout: 1). Production is the same shape at 255s: `$ tsc --noEmit`,
  // then minutes of silence, then a severed stream and a re-issued command.
  const PRINTS_THEN_OUTLIVES_THE_TICK = 'echo started; sleep 6'

  async function runUnderIdleTimeout(exempt: boolean): Promise<any[]> {
    const server = Bun.serve({
      port: 0,
      idleTimeout: 1,
      fetch(req, srv) {
        if (exempt) exemptLongLivedStreamFromIdleTimeout(srv, req, new URL(req.url).pathname)
        return handleBash({
          command: PRINTS_THEN_OUTLIVES_THE_TICK,
          cwd: testDir,
          sourceEnv: false,
          activateDevbox: false,
        })
      },
    })
    try {
      const resp = await fetch(`http://127.0.0.1:${server.port}/bash`, { method: 'POST' })
      return await consumeSSE(resp)
    } finally {
      server.stop(true)
    }
  }

  it('control: an unexempted stream is severed before its exit frame', async () => {
    let events: any[] = []
    let transportError: Error | undefined
    try {
      events = await runUnderIdleTimeout(false)
    } catch (error) {
      transportError = error as Error
    }
    // Either the read fails outright or the stream ends with no terminal frame —
    // both surface in core as BashOutcomeUnknownError.
    const terminal = events.find((event) => typeof event.exitCode === 'number')
    expect(transportError !== undefined || terminal === undefined).toBe(true)
  }, 20_000)

  it('an exempted /bash stream outlives the idle timeout and delivers its exit frame', async () => {
    const events = await runUnderIdleTimeout(true)
    expect(events.at(-1)).toMatchObject({ exitCode: 0 })
  }, 20_000)

  it('only long-lived stream routes are exempted', () => {
    const calls: Array<[string, number]> = []
    const server = { timeout: (req: Request, seconds: number) => calls.push([new URL(req.url).pathname, seconds]) }
    expect(exemptLongLivedStreamFromIdleTimeout(server, new Request('http://box/bash'), '/bash')).toBe(true)
    expect(exemptLongLivedStreamFromIdleTimeout(server, new Request('http://box/healthz'), '/healthz')).toBe(false)
    expect(calls).toEqual([['/bash', 0]])
  })
})
