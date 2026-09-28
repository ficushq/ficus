import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { createHash } from 'crypto'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir as osTmpdir } from 'os'

// On macOS, os.tmpdir() is the ~45-char /var/folders/... path; the control
// socket names this suite derives (nested/ctl/owner-<pid>-<hash>.sock) push
// past the 104-byte sun_path limit and listen() fails with "Failed to listen
// at ...sock" — flaking by pid length. /tmp keeps every derived path short.
// (Same fix as test-setup.ts's test HOME.)
const tmpdir = () => (process.platform === 'darwin' ? '/tmp' : osTmpdir())
import { join } from 'path'
import { getSecretStore, resetSecretStore } from '../secrets'
import type { Machine } from './queries'
import { MACHINE_REVERSE_PORT, MachineTunnelManager, resolveMachineReversePort } from './tunnel-manager'

const SECRET_KEY = 'machine-ssh:tunnel-test'
const MACHINE_ID = '22222222-2222-2222-2222-222222222222'
// The manager derives the control-socket filename from a short sha256 digest of
// the machine id (not the raw 36-char UUID), so tests that kill a socket must
// target the same derived name.
const SOCKET_NAME = `${createHash('sha256').update(MACHINE_ID).digest('hex').slice(0, 12)}.sock`

function makeMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: MACHINE_ID,
    name: 'tunnel-test',
    provider: 'ssh',
    providerRef: null,
    sshHost: '10.0.0.5',
    sshPort: 22,
    sshUser: 'tau',
    sshKeyId: SECRET_KEY,
    sshPublicKey: 'ssh-ed25519 AAAA test',
    status: 'ready',
    capabilities: {},
    scope: 'shared',
    bootstrapVersion: null,
    lastSeenAt: null,
    createdAt: new Date(),
    ...overrides,
  } as Machine
}

/**
 * Stateful fake `Bun.spawn` that models ControlMaster socket liveness so
 * `-O check` reflects whether a master is running.
 */
class FakeSsh {
  calls: string[][] = []
  private alive = new Set<string>()
  masterPid = 100
  /** Remote port the DYNAMIC `-R 0:` fallback path reports as allocated. */
  reverseRemotePort = 40001
  dynamicOutput: string | null = null
  /**
   * When set, a PINNED `-R <port>:` bind (port != 0) fails with this stderr —
   * modelling the port being held by a DIFFERENT owner (a rogue process on the
   * machine, or a stale different-spec forward). A duplicate SAME-spec request on
   * a live mux master is instead DEDUPED by real ssh (exit 0, empty stderr), so
   * it is not modelled as a failure. null → pinned bind succeeds.
   */
  pinnedBindStderr: string | null = null
  cancelExitCode = 0
  hangCancel = false
  hangLocalForwardOnce = false
  hangDynamicForwardOnce = false

  spawn = ((args: string[]) => {
    this.calls.push(args)
    const sockIdx = args.indexOf('-S')
    const socketPath = sockIdx >= 0 ? args[sockIdx + 1] : ''
    let exitCode = 0
    let stdout = ''
    let stderr = ''

    if (args.includes('-M')) {
      // Real `ssh -M` REFUSES to multiplex onto an existing socket path: it
      // logs "ControlSocket <path> already exists, disabling multiplexing",
      // then still authenticates and still exits 0 under `-f` — leaving NO live
      // master behind. Modelling that faithfully is what makes the orphaned-
      // socket regression below reproduce the production wedge.
      if (existsSync(socketPath)) {
        const logIdx = args.indexOf('-E')
        if (logIdx >= 0 && args[logIdx + 1]) {
          appendFileSync(args[logIdx + 1]!, `ControlSocket ${socketPath} already exists, disabling multiplexing\n`)
        }
        return { stdout: '', stderr: '', exited: Promise.resolve(0) }
      }
      this.alive.add(socketPath)
      this.masterPid++
      writeFileSync(socketPath, String(this.masterPid))
    } else if (args.includes('-O')) {
      const cmd = args[args.indexOf('-O') + 1]
      if (cmd === 'check') {
        exitCode = this.alive.has(socketPath) ? 0 : 255
        if (exitCode === 0) stdout = `Master running (pid=${this.masterPid})\n`
      } else if (cmd === 'exit') {
        this.alive.delete(socketPath)
        try {
          unlinkSync(socketPath)
        } catch {
          /* already absent */
        }
      } else if (cmd === 'cancel') {
        if (this.hangCancel)
          return { stdout: '', stderr: '', exited: new Promise<number>(() => {}), kill: () => {} } as any
        exitCode = this.cancelExitCode
      } else if (cmd === 'forward' && args.includes('-L') && this.hangLocalForwardOnce) {
        this.hangLocalForwardOnce = false
        return { stdout: '', stderr: '', exited: new Promise<number>(() => {}), kill: () => {} } as any
      } else if (cmd === 'forward' && args.includes('-R')) {
        const spec = args[args.indexOf('-R') + 1] ?? ''
        const isDynamic = spec.startsWith('0:')
        if (isDynamic) {
          if (this.hangDynamicForwardOnce) {
            this.hangDynamicForwardOnce = false
            return { stdout: '', stderr: '', exited: new Promise<number>(() => {}), kill: () => {} } as any
          }
          // Real multiplexed `ssh -O forward -R 0:` prints ONLY the bare allocated
          // port number on its own line — the shape the fallback path parses.
          stdout = this.dynamicOutput ?? `${this.reverseRemotePort}\n`
        } else if (this.pinnedBindStderr !== null) {
          // Pinned bind rejected: the pinned port is already held.
          exitCode = 1
          stderr = this.pinnedBindStderr
        }
        // Pinned bind success prints NOTHING — the manager must not parse output.
      }
    }

    return { stdout, stderr, exited: Promise.resolve(exitCode) }
  }) as unknown as typeof Bun.spawn

  /** Master process died but its socket file survives — what a core restart leaves. */
  orphanSocket(socketPath: string): void {
    this.alive.delete(socketPath)
  }

  isAlive(socketPath: string): boolean {
    return this.alive.has(socketPath)
  }

  killSocket(socketPath: string): void {
    this.alive.delete(socketPath)
    try {
      unlinkSync(socketPath)
    } catch {
      /* already absent */
    }
  }

  /**
   * Replace the socket with a genuinely DIFFERENT generation.
   *
   * The manager identifies a master by `dev:ino:birthtimeMs:ctimeMs`, so this
   * helper must produce an identity that actually differs — otherwise the test
   * asserting "restarted" is really asserting that the filesystem happened to
   * cooperate. `unlink` + immediate `write` does not guarantee that: the kernel
   * commonly hands back the just-freed inode, and both timestamps can land in
   * the same millisecond (far likelier on Linux CI than on a dev machine),
   * leaving the "new" socket indistinguishable from the old one. That surfaced
   * as a recurring CI failure on code that was behaving correctly.
   *
   * So verify the identity changed, and retry briefly until it does.
   */
  replaceSocketGeneration(socketPath: string): void {
    const identity = (): string | null => {
      try {
        const s = statSync(socketPath)
        return `${s.dev}:${s.ino}:${s.birthtimeMs}:${s.ctimeMs}`
      } catch {
        return null
      }
    }
    const before = identity()
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        unlinkSync(socketPath)
      } catch {
        /* already absent */
      }
      writeFileSync(socketPath, `replacement-${Date.now()}-${attempt}`)
      if (identity() !== before) {
        this.alive.add(socketPath)
        return
      }
      Bun.sleepSync(1)
    }
    throw new Error('could not produce a distinguishable control-socket generation')
  }

  masterSpawns(): number {
    return this.calls.filter((c) => c.includes('-M')).length
  }

  private oCalls(cmd: string, flag?: string): string[][] {
    return this.calls.filter((c) => {
      const i = c.indexOf('-O')
      return i >= 0 && c[i + 1] === cmd && (flag === undefined || c.includes(flag))
    })
  }

  checkCalls() {
    return this.oCalls('check')
  }
  forwardLocalCalls() {
    return this.oCalls('forward', '-L')
  }
  reverseCalls() {
    return this.oCalls('forward', '-R')
  }
  cancelCalls() {
    return this.oCalls('cancel')
  }
  exitCalls() {
    return this.oCalls('exit')
  }
}

describe('MachineTunnelManager', () => {
  let priorKey: string | undefined
  let priorHome: string | undefined
  let controlDir: string
  let testHome: string
  const controlDirs: string[] = []

  beforeAll(async () => {
    priorHome = process.env.HOME_DIR
    testHome = mkdtempSync(join(tmpdir(), 'tau-tunnel-home-'))
    process.env.HOME_DIR = testHome
    priorKey = process.env.FICUS_ENCRYPTION_KEY
    process.env.FICUS_ENCRYPTION_KEY = priorKey ?? '0'.repeat(64)
    resetSecretStore()
    await getSecretStore().initialize()
    await getSecretStore().set(SECRET_KEY, 'FAKE PRIVATE KEY MATERIAL', 'system')
  })

  afterAll(async () => {
    await getSecretStore().delete(SECRET_KEY)
    if (priorKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = priorKey
    if (priorHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = priorHome
    resetSecretStore()
    rmSync(testHome, { recursive: true, force: true })
    for (const dir of controlDirs) rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    controlDir = mkdtempSync(join(tmpdir(), 'tau-tunnel-ctl-'))
    controlDirs.push(controlDir)
  })

  function manager(fake: FakeSsh, overrides: { controlTimeoutMs?: number } = {}): MachineTunnelManager {
    return new MachineTunnelManager({ spawn: fake.spawn, controlDir, ...overrides })
  }

  it('creates a fresh nonexistent control directory before acquiring its master lock', async () => {
    const fake = new FakeSsh()
    const parent = controlDir
    controlDir = join(parent, 'nested', 'ctl')
    const mgr = manager(fake)
    await mgr.ensureMaster(makeMachine())
    expect(fake.masterSpawns()).toBe(1)
    controlDir = parent
  })

  it('starts the master once per machine; a second ensureMaster only checks', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)

    await mgr.ensureMaster(makeMachine())
    await mgr.ensureMaster(makeMachine())

    expect(fake.masterSpawns()).toBe(1)
    // First check fails (no socket) → spawn; second check succeeds → adopt.
    expect(fake.checkCalls().length).toBe(3)
  })

  it('respawns the master when the control socket is dead', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)

    await mgr.ensureMaster(makeMachine())
    expect(fake.masterSpawns()).toBe(1)

    // Simulate the master process dying (socket goes away).
    fake.killSocket(join(controlDir, SOCKET_NAME))

    await mgr.ensureMaster(makeMachine())
    expect(fake.masterSpawns()).toBe(2)
  })

  it('reclaims an orphaned control socket from a dead master instead of wedging forever', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)
    const socketPath = join(controlDir, SOCKET_NAME)

    await mgr.ensureMaster(makeMachine())
    expect(fake.masterSpawns()).toBe(1)

    // The core restarts (a tenant upgrade did exactly this in production): the
    // master process dies, but NOTHING unlinks its control socket.
    fake.orphanSocket(socketPath)
    expect(existsSync(socketPath)).toBe(true)

    // Recovery must reclaim the stale path. Without the unlink, `ssh -M` refuses
    // to multiplex onto it, exits 0 anyway, and the health probe can only ever
    // fail against the dead inode — a PERMANENT wedge that leaks one idle
    // backgrounded ssh per retry (observed live: 77 orphans, every box start on
    // the host failing until the socket was removed by hand).
    await mgr.ensureMaster(makeMachine())

    expect(fake.masterSpawns()).toBe(2)
    expect(fake.isAlive(socketPath)).toBe(true)
  })

  it('addForward allocates a local port, is idempotent, and exposes an endpoint', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)

    expect(mgr.endpointFor(MACHINE_ID, 50100)).toBeNull()

    const local = await mgr.addForward(makeMachine(), 50100)
    expect(local).toBeGreaterThan(0)
    expect(mgr.endpointFor(MACHINE_ID, 50100)).toBe(`http://127.0.0.1:${local}`)
    expect(fake.forwardLocalCalls().length).toBe(1)

    // Idempotent: same local port, no second `-O forward`, no second master.
    const again = await mgr.addForward(makeMachine(), 50100)
    expect(again).toBe(local)
    expect(fake.forwardLocalCalls().length).toBe(1)
    expect(fake.masterSpawns()).toBe(1)
  })

  it('removeForward cancels the forward and clears the endpoint', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)

    await mgr.addForward(makeMachine(), 50100)
    await mgr.removeForward(makeMachine(), 50100)

    expect(fake.cancelCalls().length).toBe(1)
    expect(mgr.endpointFor(MACHINE_ID, 50100)).toBeNull()
  })

  it('removeForward retains the endpoint when exact cancellation is not acknowledged', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)
    await mgr.addForward(makeMachine(), 50100)
    fake.cancelExitCode = 1

    await expect(mgr.removeForward(makeMachine(), 50100)).rejects.toThrow('cancel')
    expect(mgr.endpointFor(MACHINE_ID, 50100)).not.toBeNull()
  })

  it('removeForward retains the endpoint when exact cancellation times out', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake, { controlTimeoutMs: 5 })
    await mgr.addForward(makeMachine(), 50100)
    fake.hangCancel = true

    await expect(mgr.removeForward(makeMachine(), 50100)).rejects.toThrow('timed out')
    expect(mgr.endpointFor(MACHINE_ID, 50100)).not.toBeNull()
  })

  it('clears durable quarantine only after dynamic timeout proves master death', async () => {
    const fake = new FakeSsh()
    fake.pinnedBindStderr = 'remote port forwarding failed'
    fake.hangDynamicForwardOnce = true
    const first = manager(fake, { controlTimeoutMs: 5 })
    await expect(first.addReverse(makeMachine(), 9000)).rejects.toThrow('timed out')

    fake.pinnedBindStderr = null
    const sibling = manager(fake, { controlTimeoutMs: 5 })
    await expect(sibling.addForward(makeMachine(), 50100)).resolves.toBeNumber()
  })

  it('a durable quarantine blocks sibling-process master mutations', async () => {
    const fake = new FakeSsh()
    const first = manager(fake)
    await first.ensureMaster(makeMachine())
    writeFileSync(join(controlDir, `${SOCKET_NAME}.quarantine`), 'unknown')
    const sibling = manager(fake)

    await expect(sibling.addForward(makeMachine(), 50100)).rejects.toMatchObject({ code: 'TUNNEL_OUTCOME_UNKNOWN' })
    expect(fake.forwardLocalCalls()).toHaveLength(0)
  })

  it('addReverse binds the PINNED reverse port and is idempotent (no output parsing)', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)

    // Primary path pins the constant port and returns it WITHOUT parsing ssh
    // output — the fake's pinned bind prints nothing, yet a port comes back.
    const remote = await mgr.addReverse(makeMachine(), 9000)
    expect(remote).toBe(MACHINE_REVERSE_PORT)
    expect(fake.reverseCalls().length).toBe(1)
    // The request pins the port explicitly: `-R 50080:127.0.0.1:9000`.
    expect(fake.reverseCalls()[0]).toContain(`${MACHINE_REVERSE_PORT}:127.0.0.1:9000`)

    const again = await mgr.addReverse(makeMachine(), 9000)
    expect(again).toBe(MACHINE_REVERSE_PORT)
    expect(fake.reverseCalls().length).toBe(1)
  })

  it('addReverse falls back to dynamic -R 0: (with a warn) when the pinned bind reports "remote port forwarding failed"', async () => {
    // A "remote port forwarding failed" stderr does NOT mean "already bound by
    // us" — real ssh dedupes a duplicate SAME-spec request on a live mux master
    // (exit 0, empty stderr). This stderr therefore means a DIFFERENT owner (a
    // rogue process on the machine) holds the pinned port, so treating it as
    // success would silently route callbacks to the squatter. The manager must
    // warn and fall back to the dynamic `-R 0:` allocation.
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fake = new FakeSsh()
      fake.pinnedBindStderr = 'Warning: remote port forwarding failed for listen port 50080'
      fake.reverseRemotePort = 33077
      const mgr = manager(fake)

      const remote = await mgr.addReverse(makeMachine(), 9000)
      expect(remote).toBe(33077)
      expect(mgr.reverseFor(MACHINE_ID, 9000)).toBe(33077)

      // Both a pinned attempt AND a dynamic fallback were issued, in that order.
      const reverses = fake.reverseCalls()
      expect(reverses.length).toBe(2)
      expect(reverses[0]).toContain(`${MACHINE_REVERSE_PORT}:127.0.0.1:9000`)
      expect(reverses[1]).toContain('0:127.0.0.1:9000')

      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toMatch(/pinned reverse binding unavailable/)
      expect(String(warn.mock.calls[0][0])).toMatch(/must be rebound after master loss/)
    } finally {
      warn.mockRestore()
    }
  })

  it('addReverse falls back to dynamic -R 0: (and parses the bare port) on a non-duplicate pinned failure', async () => {
    // The pinned bind fails for a reason that is NOT the shared-master duplicate
    // ("already bound by us") case — e.g. a rogue process holds the port. The
    // manager warns (naming the staleness consequence) and falls back to the
    // legacy dynamic `-R 0:` allocation, parsing the bare port real ssh prints.
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fake = new FakeSsh()
      fake.pinnedBindStderr = 'kex_exchange_identification: connection closed'
      fake.reverseRemotePort = 33061
      const mgr = manager(fake)

      const remote = await mgr.addReverse(makeMachine(), 9000)
      expect(remote).toBe(33061)
      expect(mgr.reverseFor(MACHINE_ID, 9000)).toBe(33061)

      // Both a pinned attempt AND a dynamic fallback were issued, in that order.
      const reverses = fake.reverseCalls()
      expect(reverses.length).toBe(2)
      expect(reverses[0]).toContain(`${MACHINE_REVERSE_PORT}:127.0.0.1:9000`)
      expect(reverses[1]).toContain('0:127.0.0.1:9000')

      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toMatch(/must be rebound after master loss/)
    } finally {
      warn.mockRestore()
    }
  })

  it('quarantines malformed dynamic allocation output and performs no second allocation on a live master', async () => {
    const fake = new FakeSsh()
    fake.pinnedBindStderr = 'unavailable'
    fake.dynamicOutput = 'malformed-output'
    const mgr = manager(fake)
    await expect(mgr.addReverse(makeMachine(), 9000)).rejects.toThrow('unknown port')
    await expect(mgr.addReverse(makeMachine(), 9000)).rejects.toThrow('outcome unknown')
    expect(fake.reverseCalls().filter((args) => (args[args.indexOf('-R') + 1] ?? '').startsWith('0:'))).toHaveLength(1)
  })

  it('reports a bound reverse after dead-master re-establishment rather than reused', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)
    expect(await mgr.ensureReverseDetailed(makeMachine(), 9000)).toMatchObject({ binding: 'bound' })
    fake.killSocket(join(controlDir, SOCKET_NAME))
    expect(await mgr.ensureReverseDetailed(makeMachine(), 9000)).toMatchObject({ binding: 'bound' })
  })

  it('resolveMachineReversePort honours a valid override and rejects invalid values', () => {
    const prior = process.env.FICUS_MACHINE_REVERSE_PORT
    try {
      delete process.env.FICUS_MACHINE_REVERSE_PORT
      expect(resolveMachineReversePort()).toBe(MACHINE_REVERSE_PORT)
      process.env.FICUS_MACHINE_REVERSE_PORT = '51234'
      expect(resolveMachineReversePort()).toBe(51234)
      process.env.FICUS_MACHINE_REVERSE_PORT = 'not-a-port'
      expect(resolveMachineReversePort()).toBe(MACHINE_REVERSE_PORT)
      process.env.FICUS_MACHINE_REVERSE_PORT = '70000' // out of range
      expect(resolveMachineReversePort()).toBe(MACHINE_REVERSE_PORT)
    } finally {
      if (prior === undefined) delete process.env.FICUS_MACHINE_REVERSE_PORT
      else process.env.FICUS_MACHINE_REVERSE_PORT = prior
    }
  })

  it('addReverse binds the overridden pinned port when FICUS_MACHINE_REVERSE_PORT is set', async () => {
    const prior = process.env.FICUS_MACHINE_REVERSE_PORT
    process.env.FICUS_MACHINE_REVERSE_PORT = '51234'
    try {
      const fake = new FakeSsh()
      const mgr = manager(fake)
      const remote = await mgr.addReverse(makeMachine(), 9000)
      expect(remote).toBe(51234)
      expect(fake.reverseCalls()[0]).toContain('51234:127.0.0.1:9000')
    } finally {
      if (prior === undefined) delete process.env.FICUS_MACHINE_REVERSE_PORT
      else process.env.FICUS_MACHINE_REVERSE_PORT = prior
    }
  })

  it('addReverse verifies the master is alive on the idempotent hit (reverse parity)', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)

    await mgr.addReverse(makeMachine(), 9000)
    const checksAfterFirst = fake.checkCalls().length

    const again = await mgr.addReverse(makeMachine(), 9000)
    expect(again).toBe(MACHINE_REVERSE_PORT)
    // Idempotent: no second reverse forward, no second master.
    expect(fake.reverseCalls().length).toBe(1)
    expect(fake.masterSpawns()).toBe(1)
    // ...but the idempotent hit re-checks master liveness, exactly like addForward.
    expect(fake.checkCalls().length).toBeGreaterThan(checksAfterFirst)
  })

  it('reverseFor exposes the allocated remote port and clears on teardown (reverse parity)', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)

    expect(mgr.reverseFor(MACHINE_ID, 9000)).toBeNull()
    const remote = await mgr.addReverse(makeMachine(), 9000)
    expect(mgr.reverseFor(MACHINE_ID, 9000)).toBe(remote)

    await mgr.closeMachine(makeMachine())
    expect(mgr.reverseFor(MACHINE_ID, 9000)).toBeNull()
  })

  it('concurrent addReverse for the same port issues exactly one reverse (I3 parity)', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)

    const [a, b] = await Promise.all([mgr.addReverse(makeMachine(), 9000), mgr.addReverse(makeMachine(), 9000)])

    expect(a).toBe(b)
    expect(fake.reverseCalls().length).toBe(1)
    expect(fake.masterSpawns()).toBe(1)
  })

  it('addReverse re-establishes a fresh reverse after the master dies (I4 parity)', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)

    await mgr.addReverse(makeMachine(), 9000)
    expect(fake.masterSpawns()).toBe(1)
    expect(fake.reverseCalls().length).toBe(1)

    // Master dies (e.g. a >60s network blip with ControlPersist=no).
    fake.killSocket(join(controlDir, SOCKET_NAME))

    const second = await mgr.addReverse(makeMachine(), 9000)
    expect(fake.masterSpawns()).toBe(2)
    expect(fake.reverseCalls().length).toBe(2)
    expect(mgr.reverseFor(MACHINE_ID, 9000)).toBe(second)
  })

  it('checkHealth purges the reverse registry when it observes a dead master (I4 parity)', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)

    await mgr.addReverse(makeMachine(), 9000)
    expect(mgr.reverseFor(MACHINE_ID, 9000)).not.toBeNull()

    fake.killSocket(join(controlDir, SOCKET_NAME))

    expect(await mgr.checkHealth(MACHINE_ID)).toBe(false)
    expect(mgr.reverseFor(MACHINE_ID, 9000)).toBeNull()
  })

  it("cancelMachineForwards cancels only this process's local forwards — never -O exit — leaving the shared master and its reverses live", async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)

    // A machine that still has boxes: a local forward to a box port AND the
    // reverse forward whose remote port boxes baked into FICUS_API_URL.
    await mgr.addForward(makeMachine(), 50100)
    await mgr.addReverse(makeMachine(), 3000)

    await mgr.cancelMachineForwards(MACHINE_ID)

    // Routine shutdown: the local forward was `-O cancel`ed and forgotten...
    expect(fake.cancelCalls().length).toBe(1)
    expect(mgr.endpointFor(MACHINE_ID, 50100)).toBeNull()
    // ...but the SHARED master got no `-O exit` (the other core process's
    // forwards and every box's callback port ride on it) and the reverse
    // forward's allocated remote port survives for the boxes that baked it.
    expect(fake.exitCalls().length).toBe(0)
    expect(await mgr.checkHealth(MACHINE_ID)).toBe(true)
    expect(mgr.reverseFor(MACHINE_ID, 3000)).toBe(MACHINE_REVERSE_PORT)
  })

  it('cancelMachineForwards is scoped to the machine and no-ops with nothing forwarded', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)

    // Nothing forwarded at all → no control traffic.
    await mgr.cancelMachineForwards(MACHINE_ID)
    expect(fake.cancelCalls().length).toBe(0)

    // A forward for a DIFFERENT machine must survive this machine's release.
    const otherId = '33333333-3333-3333-3333-333333333333'
    const otherLocal = await mgr.addForward(makeMachine({ id: otherId }), 50200)
    await mgr.cancelMachineForwards(MACHINE_ID)
    expect(fake.cancelCalls().length).toBe(0)
    expect(mgr.endpointFor(otherId, 50200)).toBe(`http://127.0.0.1:${otherLocal}`)
  })

  it('cancelMachineForwards drains an in-flight establish first, so a late-completing forward is cancelled, not stranded', async () => {
    const fake = new FakeSsh()
    // Gate the `-O forward -L` control call so the establish is still in flight
    // when the release runs — the window where an establish completing AFTER
    // the registry sweep would register a listener that nothing ever cancels,
    // stranding it in the (shared, process-surviving) master forever.
    let releaseForward!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseForward = resolve
    })
    const gatedSpawn = ((args: string[]) => {
      const res = (
        fake.spawn as unknown as (a: string[]) => { stdout: string; stderr: string; exited: Promise<number> }
      )(args)
      const i = args.indexOf('-O')
      if (i >= 0 && args[i + 1] === 'forward' && args.includes('-L')) {
        return { ...res, exited: gate.then(() => res.exited) }
      }
      return res
    }) as unknown as typeof Bun.spawn
    const mgr = new MachineTunnelManager({ spawn: gatedSpawn, controlDir })

    const pending = mgr.addForward(makeMachine(), 50100)
    const release = mgr.cancelMachineForwards(MACHINE_ID)
    releaseForward()
    await Promise.all([pending, release])

    // The late forward was seen by the sweep: `-O cancel`ed and forgotten —
    // and still no `-O exit` on the shared master.
    expect(fake.cancelCalls().length).toBe(1)
    expect(mgr.endpointFor(MACHINE_ID, 50100)).toBeNull()
    expect(fake.exitCalls().length).toBe(0)
  })

  it('cancelMachineForwards drains an in-flight repair before sweeping its replacement', async () => {
    const fake = new FakeSsh()
    let releaseRepair!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseRepair = resolve
    })
    let forwards = 0
    const gatedSpawn = ((args: string[]) => {
      const result = (fake.spawn as any)(args)
      if (args.includes('-O') && args.includes('forward') && args.includes('-L') && ++forwards === 2)
        return { ...result, exited: gate.then(() => result.exited) }
      return result
    }) as unknown as typeof Bun.spawn
    const mgr = new MachineTunnelManager({ spawn: gatedSpawn, controlDir, controlTimeoutMs: 50 })
    await mgr.addForward(makeMachine(), 50100)
    const repair = mgr.refreshForward(makeMachine(), 50100)
    const cleanup = mgr.cancelMachineForwards(MACHINE_ID)
    releaseRepair()
    await Promise.all([repair, cleanup])
    expect(mgr.endpointFor(MACHINE_ID, 50100)).toBeNull()
    expect(fake.cancelCalls()).toHaveLength(2)
  })

  it('retains an exact listener when routine cancellation times out until cleanup is proven', async () => {
    const fake = new FakeSsh()
    const mgr = new MachineTunnelManager({ spawn: fake.spawn, controlDir, controlTimeoutMs: 10 })
    const localPort = await mgr.addForward(makeMachine(), 50100)
    fake.hangCancel = true
    await mgr.cancelMachineForwards(MACHINE_ID)
    expect(mgr.endpointFor(MACHINE_ID, 50100)).toBe(`http://127.0.0.1:${localPort}`)
    fake.hangCancel = false
    await mgr.cancelMachineForwards(MACHINE_ID)
    expect(mgr.endpointFor(MACHINE_ID, 50100)).toBeNull()
  })

  it('a successor manager adopts and settles durable exact-forward cleanup debt', async () => {
    const fake = new FakeSsh()
    const first = new MachineTunnelManager({ spawn: fake.spawn, controlDir, controlTimeoutMs: 10 })
    await first.addForward(makeMachine(), 50100)
    fake.hangCancel = true
    await first.cancelMachineForwards(MACHINE_ID)
    fake.hangCancel = false
    const successor = new MachineTunnelManager({
      spawn: fake.spawn,
      controlDir,
      controlTimeoutMs: 50,
      ownerId: 'successor',
      isOwnerAlive: async () => false,
    })
    await successor.addForward(makeMachine(), 50100)
    expect(fake.cancelCalls()).toHaveLength(2)
    expect(fake.forwardLocalCalls()).toHaveLength(2)
  })

  it('persists independent debt tuples from two managers and a successor cancels both', async () => {
    const fake = new FakeSsh()
    const first = new MachineTunnelManager({
      spawn: fake.spawn,
      controlDir,
      controlTimeoutMs: 10,
      ownerId: 'first',
      ownerPid: 101,
      allocateLocalPort: async () => 62101,
    })
    const second = new MachineTunnelManager({
      spawn: fake.spawn,
      controlDir,
      controlTimeoutMs: 10,
      ownerId: 'second',
      ownerPid: 102,
      isOwnerAlive: async (ownerId) => ownerId === 'first',
      allocateLocalPort: async () => 62102,
    })
    await first.addForward(makeMachine(), 50100)
    await second.addForward(makeMachine(), 50100)
    fake.hangCancel = true
    await Promise.all([first.cancelMachineForwards(MACHINE_ID), second.cancelMachineForwards(MACHINE_ID)])
    fake.hangCancel = false
    const successor = new MachineTunnelManager({
      spawn: fake.spawn,
      controlDir,
      controlTimeoutMs: 50,
      ownerId: 'successor',
      isOwnerAlive: async () => false,
    })
    await successor.addForward(makeMachine(), 50100)
    expect(fake.cancelCalls()).toHaveLength(4)
    expect(fake.forwardLocalCalls()).toHaveLength(3)
  })

  it('persists an ambiguous forward candidate so a successor exact-cancels it before rebinding', async () => {
    const fake = new FakeSsh()
    fake.hangLocalForwardOnce = true
    const first = new MachineTunnelManager({ spawn: fake.spawn, controlDir, controlTimeoutMs: 10 })
    await expect(first.addForward(makeMachine(), 50100)).rejects.toThrow('timed out')
    const successor = new MachineTunnelManager({
      spawn: fake.spawn,
      controlDir,
      controlTimeoutMs: 50,
      ownerId: 'successor',
      isOwnerAlive: async () => false,
    })
    await successor.addForward(makeMachine(), 50100)
    expect(fake.cancelCalls()).toHaveLength(1)
    expect(fake.forwardLocalCalls()).toHaveLength(2)
  })

  it('retires durable forward debt after proving the old master dead', async () => {
    const fake = new FakeSsh()
    const first = new MachineTunnelManager({ spawn: fake.spawn, controlDir, controlTimeoutMs: 10 })
    await first.addForward(makeMachine(), 50100)
    fake.hangCancel = true
    await first.cancelMachineForwards(MACHINE_ID)
    fake.hangCancel = false
    fake.killSocket(join(controlDir, SOCKET_NAME))
    const successor = new MachineTunnelManager({
      spawn: fake.spawn,
      controlDir,
      controlTimeoutMs: 50,
      ownerId: 'successor',
      isOwnerAlive: async () => false,
    })
    await successor.addForward(makeMachine(), 50100)
    expect(fake.cancelCalls()).toHaveLength(1)
    expect(fake.forwardLocalCalls()).toHaveLength(2)
  })

  it('preserves a live sibling owner while replacing one crashed owner listener', async () => {
    const fake = new FakeSsh()
    const dead = new MachineTunnelManager({ spawn: fake.spawn, controlDir, ownerId: 'dead', ownerPid: 101 })
    const live = new MachineTunnelManager({ spawn: fake.spawn, controlDir, ownerId: 'live', ownerPid: 202 })
    await dead.addForward(makeMachine(), 50100)
    await live.addForward(makeMachine(), 50100)
    const successor = new MachineTunnelManager({
      spawn: fake.spawn,
      controlDir,
      ownerId: 'successor',
      ownerPid: 303,
      isOwnerAlive: async (ownerId) => ownerId === 'live',
    })
    await successor.addForward(makeMachine(), 50100)
    expect(fake.cancelCalls()).toHaveLength(1)
    expect(fake.forwardLocalCalls()).toHaveLength(3)
    expect(live.endpointFor(MACHINE_ID, 50100)).not.toBeNull()
  })

  it('journals forwarding and cancelling intent before SSH result handling', async () => {
    const fake = new FakeSsh()
    let releaseForward!: () => void
    const forwardGate = new Promise<void>((resolve) => {
      releaseForward = resolve
    })
    let releaseCancel!: () => void
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve
    })
    let gateForward = true
    let gateCancel = false
    let enteredForward!: () => void
    const forwardEntered = new Promise<void>((resolve) => {
      enteredForward = resolve
    })
    const spawn = ((args: string[]) => {
      const result = (fake.spawn as any)(args)
      const command = args.includes('-O') ? args[args.indexOf('-O') + 1] : ''
      if (command === 'forward' && args.includes('-L') && gateForward) {
        gateForward = false
        enteredForward()
        return { ...result, exited: forwardGate.then(() => result.exited) }
      }
      if (command === 'cancel' && gateCancel) {
        gateCancel = false
        return { ...result, exited: cancelGate.then(() => result.exited) }
      }
      return result
    }) as unknown as typeof Bun.spawn
    const mgr = new MachineTunnelManager({ spawn, controlDir, ownerId: 'owner', ownerPid: 404, controlTimeoutMs: 500 })
    const adding = mgr.addForward(makeMachine(), 50100)
    await forwardEntered
    const marker = readdirSync(controlDir).find((name) => name.includes('.L50100.') && name.endsWith('.uncertain'))!
    expect(JSON.parse(readFileSync(join(controlDir, marker), 'utf8')).state).toBe('forwarding')
    releaseForward()
    await adding
    expect(JSON.parse(readFileSync(join(controlDir, marker), 'utf8')).state).toBe('active')
    gateCancel = true
    const removing = mgr.removeForward(makeMachine(), 50100)
    await Bun.sleep(5)
    expect(JSON.parse(readFileSync(join(controlDir, marker), 'utf8')).state).toBe('cancelling')
    releaseCancel()
    await removing
    expect(existsSync(join(controlDir, marker))).toBe(false)
  })

  it('settles a crash-after-cancel marker when the exact local listener is proven absent', async () => {
    const fake = new FakeSsh()
    const owner = new MachineTunnelManager({
      spawn: fake.spawn,
      controlDir,
      ownerId: 'dead',
      ownerPid: 101,
      controlTimeoutMs: 10,
    })
    await owner.addForward(makeMachine(), 50100)
    fake.hangCancel = true
    await expect(owner.removeForward(makeMachine(), 50100)).rejects.toThrow('timed out')
    fake.hangCancel = false
    fake.cancelExitCode = 1 // old cancel may already have succeeded before the crash
    const successor = new MachineTunnelManager({
      spawn: fake.spawn,
      controlDir,
      ownerId: 'successor',
      ownerPid: 202,
      isOwnerAlive: async () => false,
      isLocalPortFree: async () => true,
    })
    await successor.addForward(makeMachine(), 50100)
    expect(fake.cancelCalls()).toHaveLength(2)
    expect(fake.forwardLocalCalls()).toHaveLength(2)
  })

  it('same successor retries its own ambiguous adopted cancellation before forwarding', async () => {
    const fake = new FakeSsh()
    const dead = new MachineTunnelManager({ spawn: fake.spawn, controlDir, ownerId: 'dead', ownerPid: 101 })
    await dead.addForward(makeMachine(), 50100)
    fake.hangCancel = true
    const successor = new MachineTunnelManager({
      spawn: fake.spawn,
      controlDir,
      ownerId: 'successor',
      ownerPid: 202,
      isOwnerAlive: async () => false,
      controlTimeoutMs: 10,
    })
    await expect(successor.addForward(makeMachine(), 50100)).rejects.toThrow('timed out')
    expect(fake.forwardLocalCalls()).toHaveLength(1)
    fake.hangCancel = false
    await successor.addForward(makeMachine(), 50100)
    expect(fake.cancelCalls()).toHaveLength(2)
    expect(fake.forwardLocalCalls()).toHaveLength(2)
  })

  it('reclaims a reused PID with another owner generation while preserving the exact live generation', async () => {
    const fake = new FakeSsh()
    const stale = new MachineTunnelManager({
      spawn: fake.spawn,
      controlDir,
      ownerId: 'old-generation',
      ownerPid: 777,
      allocateLocalPort: async () => 62001,
    })
    const live = new MachineTunnelManager({
      spawn: fake.spawn,
      controlDir,
      ownerId: 'current-generation',
      ownerPid: 777,
      allocateLocalPort: async () => 62002,
    })
    await stale.addForward(makeMachine(), 50100)
    await live.addForward(makeMachine(), 50100)
    const checkedOwners: string[] = []
    const successor = new MachineTunnelManager({
      spawn: fake.spawn,
      controlDir,
      ownerId: 'successor',
      ownerPid: 777,
      isOwnerAlive: async (ownerId, ownerPid) => {
        checkedOwners.push(ownerId)
        return ownerPid === 777 && ownerId === 'current-generation'
      },
      allocateLocalPort: async () => 62003,
    })
    await successor.addForward(makeMachine(), 50100)
    expect(checkedOwners).toEqual(['current-generation'])
    expect(fake.cancelCalls()).toHaveLength(1)
    expect(fake.forwardLocalCalls()).toHaveLength(3)
  })

  it('invalidates cached endpoints and reports restart when the live socket master generation changes', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)
    const first = await mgr.addForward(makeMachine(), 50100)
    fake.masterPid++ // sibling replaced the master at the same continuously-live socket path
    const repaired = await mgr.refreshForwardDetailed(makeMachine(), 50100)
    expect(repaired).toMatchObject({ master: 'restarted', reverses: 'invalidated' })
    expect(repaired.localPort).not.toBe(first)
    expect(fake.forwardLocalCalls()).toHaveLength(2)
  })

  it('preserves replacement-master sibling journals when retiring the cached old generation', async () => {
    const fake = new FakeSsh()
    const first = new MachineTunnelManager({
      spawn: fake.spawn,
      controlDir,
      ownerId: 'first',
      ownerPid: 101,
      isOwnerAlive: async (ownerId) => ownerId === 'second',
      allocateLocalPort: async () => 62201,
    })
    await first.addForward(makeMachine(), 50100)
    fake.masterPid++
    const second = new MachineTunnelManager({
      spawn: fake.spawn,
      controlDir,
      ownerId: 'second',
      ownerPid: 202,
      isOwnerAlive: async (ownerId) => ownerId === 'first',
      allocateLocalPort: async () => 62202,
    })
    await second.addForward(makeMachine(), 50100)
    const siblingMarker = readdirSync(controlDir).find((name) => name.includes('.L50100.62202.'))!
    expect(
      String(JSON.parse(readFileSync(join(controlDir, siblingMarker), 'utf8')).masterGeneration).startsWith(
        `${fake.masterPid}:`
      )
    ).toBe(true)
    const repaired = await first.refreshForwardDetailed(makeMachine(), 50100)
    expect(repaired.master).toBe('restarted')
    expect(existsSync(join(controlDir, siblingMarker))).toBe(true)
    expect(second.endpointFor(MACHINE_ID, 50100)).toBe('http://127.0.0.1:62202')
  })

  it('proves owner generation by a held socket rather than a reused live PID and stale file', async () => {
    const fake = new FakeSsh()
    const mgr = new MachineTunnelManager({ spawn: fake.spawn, controlDir })
    await (mgr as any).ownerLivenessReady
    const ownerId = (mgr as any).ownerId as string
    const ownerPid = (mgr as any).ownerPid as number
    expect(await (mgr as any).canConnectOwnerSocket(ownerPid, ownerId)).toBe(true)
    // The PID is live, but no process holds the stale generation's exact socket.
    expect(await (mgr as any).canConnectOwnerSocket(ownerPid, 'stale-owner-generation')).toBe(false)
  })

  it('serializes absent-check through spawn so another process cannot publish into a retirement gap', async () => {
    const fake = new FakeSsh()
    let enteredCheck!: () => void
    const checkEntered = new Promise<void>((resolve) => {
      enteredCheck = resolve
    })
    let releaseCheck!: () => void
    const checkGate = new Promise<void>((resolve) => {
      releaseCheck = resolve
    })
    let gateFirstCheck = true
    const spawn = ((args: string[]) => {
      const result = (fake.spawn as any)(args)
      if (args.includes('-O') && args[args.indexOf('-O') + 1] === 'check' && gateFirstCheck) {
        gateFirstCheck = false
        enteredCheck()
        return { ...result, exited: checkGate.then(() => result.exited) }
      }
      return result
    }) as unknown as typeof Bun.spawn
    const first = new MachineTunnelManager({ spawn, controlDir, masterTimeoutMs: 500 })
    const second = new MachineTunnelManager({ spawn, controlDir, masterTimeoutMs: 500 })
    const third = new MachineTunnelManager({ spawn, controlDir, masterTimeoutMs: 500 })
    const establishing = first.ensureMaster(makeMachine())
    await checkEntered
    const forwarding = second.addForward(makeMachine(), 50100)
    const thirdEstablishing = third.ensureMaster(makeMachine())
    await Bun.sleep(20)
    expect(fake.masterSpawns()).toBe(0)
    expect(fake.checkCalls()).toHaveLength(1)
    releaseCheck()
    await Promise.all([establishing, forwarding, thirdEstablishing])
    expect(fake.masterSpawns()).toBe(1)
    expect(fake.forwardLocalCalls()).toHaveLength(1)
  })

  it('detects same reported PID with a replaced control socket inode as a new master', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)
    const first = await mgr.addForward(makeMachine(), 50100)
    fake.replaceSocketGeneration(join(controlDir, SOCKET_NAME))
    const repaired = await mgr.refreshForwardDetailed(makeMachine(), 50100)
    expect(repaired.master).toBe('restarted')
    expect(repaired.localPort).not.toBe(first)
    expect(fake.forwardLocalCalls()).toHaveLength(2)
  })

  it('rejects a hybrid PID/inode sample when the master changes after check', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)
    const first = await mgr.addForward(makeMachine(), 50100)
    let replaceAfterCheck = true
    const spawn = ((args: string[]) => {
      const result = (fake.spawn as any)(args)
      if (replaceAfterCheck && args.includes('-O') && args[args.indexOf('-O') + 1] === 'check') {
        replaceAfterCheck = false
        return {
          ...result,
          exited: Promise.resolve(result.exited).then((code) => {
            fake.replaceSocketGeneration(join(controlDir, SOCKET_NAME))
            return code
          }),
        }
      }
      return result
    }) as unknown as typeof Bun.spawn
    ;(mgr as any).spawn = spawn

    const replacement = await mgr.addForward(makeMachine(), 50100)
    expect(replacement).not.toBe(first)
    const records = readdirSync(controlDir)
      .filter((name) => name.endsWith('.uncertain'))
      .map((name) => JSON.parse(readFileSync(join(controlDir, name), 'utf8')))
    expect(records).toHaveLength(1)
    expect(records[0].masterGeneration).toBe((mgr as any).masters.get(MACHINE_ID).generation)
  })

  it('closeMachine issues -O exit and forgets endpoints', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)

    await mgr.addForward(makeMachine(), 50100)
    expect(await mgr.checkHealth(MACHINE_ID)).toBe(true)

    await mgr.closeMachine(makeMachine())

    expect(fake.exitCalls().length).toBe(1)
    expect(mgr.endpointFor(MACHINE_ID, 50100)).toBeNull()
    // Master forgotten → health is false without a record.
    expect(await mgr.checkHealth(MACHINE_ID)).toBe(false)
  })

  it('closeMachine issues -O exit at the deterministic socket path even with NO in-memory master record', async () => {
    // The recordless map is the COMMON delete case: DELETE is served by the api
    // process while the worker establishes most masters, and after any restart
    // the map is empty while the orphan master survives on disk. The close must
    // therefore build the record from the Machine row and fire unconditionally
    // (an absent/stale socket just makes the best-effort `-O exit` fail
    // harmlessly).
    const fake = new FakeSsh()
    const mgr = manager(fake)

    await mgr.closeMachine(makeMachine())

    expect(fake.exitCalls().length).toBe(1)
    expect(fake.exitCalls()[0]).toContain(join(controlDir, SOCKET_NAME))
  })

  it('stop() closes every open machine', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)

    await mgr.addForward(makeMachine(), 50100)
    await mgr.stop()

    expect(fake.exitCalls().length).toBe(1)
    expect(mgr.endpointFor(MACHINE_ID, 50100)).toBeNull()
  })

  // A ReadableStream that is never closed — `new Response(stream).text()` on it
  // never resolves, modelling a backgrounded `-f` master that inherits the pipe
  // write-ends and keeps them open for its whole lifetime.
  function hangingStream(): ReadableStream {
    return new ReadableStream({ start() {} })
  }

  it('ensureMaster returns promptly even when the master stdout/stderr never EOF (C1)', async () => {
    // The `-f` foreground exits immediately (auth done) but the backgrounded
    // master holds the pipes open. The old `Promise.all([stdout.text(),
    // stderr.text(), exited])` would block on the never-EOF reads; the master
    // spawn must instead await only `exited`.
    const calls: string[][] = []
    let master = false
    const spawn = ((args: string[]) => {
      calls.push(args)
      if (args.includes('-M')) {
        master = true
        writeFileSync(args[args.indexOf('-S') + 1], 'master-900')
        return { stdout: hangingStream(), stderr: hangingStream(), exited: Promise.resolve(0), kill() {} }
      }
      // First check fails; the post-spawn generation check succeeds.
      return {
        stdout: master ? 'Master running (pid=900)' : '',
        stderr: '',
        exited: Promise.resolve(master ? 0 : 255),
        kill() {},
      }
    }) as unknown as typeof Bun.spawn

    const mgr = new MachineTunnelManager({ spawn, controlDir })
    const start = Date.now()
    await mgr.ensureMaster(makeMachine())
    expect(Date.now() - start).toBeLessThan(1000)
    expect(calls.filter((c) => c.includes('-M')).length).toBe(1)
  })

  it('ensureMaster times out and kills the master that never establishes (C1)', async () => {
    let killed = false
    const spawn = ((args: string[]) => {
      if (args.includes('-M')) {
        return {
          stdout: '',
          stderr: '',
          exited: new Promise<number>(() => {}),
          kill() {
            killed = true
          },
        }
      }
      return { stdout: '', stderr: '', exited: Promise.resolve(255), kill() {} }
    }) as unknown as typeof Bun.spawn

    const mgr = new MachineTunnelManager({ spawn, controlDir, masterTimeoutMs: 50 })
    await expect(mgr.ensureMaster(makeMachine())).rejects.toThrow(/timed out/)
    expect(killed).toBe(true)
  })

  it('concurrent ensureMaster spawns the master exactly once (I2)', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)

    await Promise.all([mgr.ensureMaster(makeMachine()), mgr.ensureMaster(makeMachine())])

    expect(fake.masterSpawns()).toBe(1)
  })

  it('concurrent addForward for the same port issues exactly one forward (I3)', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)

    const [a, b] = await Promise.all([mgr.addForward(makeMachine(), 50100), mgr.addForward(makeMachine(), 50100)])

    expect(a).toBe(b)
    expect(fake.forwardLocalCalls().length).toBe(1)
    expect(fake.masterSpawns()).toBe(1)
  })

  it('refreshForward atomically replaces only the exact live forward', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)

    const first = await mgr.addForward(makeMachine(), 50100)
    const repaired = await mgr.refreshForward(makeMachine(), 50100)

    expect(repaired).not.toBe(first)
    expect(fake.cancelCalls()).toHaveLength(1)
    expect(fake.forwardLocalCalls()).toHaveLength(2)
    expect(mgr.endpointFor(MACHINE_ID, 50100)).toBe(`http://127.0.0.1:${repaired}`)
  })

  it('reports preserved versus restarted master in exact-forward repair diagnostics', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)
    await mgr.addForward(makeMachine(), 50100)
    expect(await mgr.refreshForwardDetailed(makeMachine(), 50100)).toMatchObject({
      master: 'preserved',
      forward: 'rebound',
      reverses: 'preserved',
    })
    fake.killSocket(join(controlDir, SOCKET_NAME))
    expect(await mgr.refreshForwardDetailed(makeMachine(), 50100)).toMatchObject({
      master: 'restarted',
      forward: 'rebound',
      reverses: 'invalidated',
    })
  })

  it('deduplicates concurrent exact-forward refreshes and makes addForward join the repair', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)
    await mgr.addForward(makeMachine(), 50100)

    const [a, b, added] = await Promise.all([
      mgr.refreshForward(makeMachine(), 50100),
      mgr.refreshForward(makeMachine(), 50100),
      mgr.addForward(makeMachine(), 50100),
    ])

    expect(a).toBe(b)
    expect(added).toBe(a)
    expect(fake.cancelCalls()).toHaveLength(1)
    expect(fake.forwardLocalCalls()).toHaveLength(2)
  })

  it('addForward re-establishes a fresh forward after the master dies (I4)', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)

    const first = await mgr.addForward(makeMachine(), 50100)
    expect(fake.masterSpawns()).toBe(1)
    expect(fake.forwardLocalCalls().length).toBe(1)

    // Master dies (e.g. a >60s network blip with ControlPersist=no).
    fake.killSocket(join(controlDir, SOCKET_NAME))

    const second = await mgr.addForward(makeMachine(), 50100)
    expect(fake.masterSpawns()).toBe(2)
    expect(fake.forwardLocalCalls().length).toBe(2)
    expect(mgr.endpointFor(MACHINE_ID, 50100)).toBe(`http://127.0.0.1:${second}`)
    void first
  })

  it('addForward re-establish purges stale reverses so a later addReverse re-establishes (Fix A)', async () => {
    // A box holds BOTH a forward and a reverse on one master. The master dies.
    // addForward observes the death first → purges + re-establishes onto M2.
    // The stale reverse entry must be purged too, otherwise a later addReverse
    // sees "existing + alive M2" and hands back the DEAD remote port from M1.
    const fake = new FakeSsh()
    const mgr = manager(fake)

    await mgr.addForward(makeMachine(), 50100)
    await mgr.addReverse(makeMachine(), 9000)
    expect(fake.masterSpawns()).toBe(1)
    expect(fake.reverseCalls().length).toBe(1)

    // Master dies (e.g. a >60s network blip with ControlPersist=no).
    fake.killSocket(join(controlDir, SOCKET_NAME))

    // addForward detects the death, purges, and re-establishes onto a fresh master.
    await mgr.addForward(makeMachine(), 50100)
    expect(fake.masterSpawns()).toBe(2)

    // The pinned bind re-runs on the fresh master. A STALE reverse entry would
    // short-circuit (existing + alive M2) and skip the second bind entirely, so
    // the SECOND `-R` call is the proof the stale entry was purged. (The pinned
    // port is constant, so the returned value can't prove re-establishment.)
    const remote = await mgr.addReverse(makeMachine(), 9000)
    expect(fake.reverseCalls().length).toBe(2)
    expect(remote).toBe(MACHINE_REVERSE_PORT)
    expect(mgr.reverseFor(MACHINE_ID, 9000)).toBe(MACHINE_REVERSE_PORT)
  })

  it('checkHealth purges the forward registry when it observes a dead master (I4)', async () => {
    const fake = new FakeSsh()
    const mgr = manager(fake)

    await mgr.addForward(makeMachine(), 50100)
    expect(mgr.endpointFor(MACHINE_ID, 50100)).not.toBeNull()

    fake.killSocket(join(controlDir, SOCKET_NAME))

    expect(await mgr.checkHealth(MACHINE_ID)).toBe(false)
    expect(mgr.endpointFor(MACHINE_ID, 50100)).toBeNull()
  })

  it('control operations are bounded and kill the child on timeout (M5)', async () => {
    let killed = false
    const spawn = ((args: string[]) => {
      if (args.includes('-O')) {
        return {
          stdout: hangingStream(),
          stderr: hangingStream(),
          exited: new Promise<number>(() => {}),
          kill() {
            killed = true
          },
        }
      }
      return { stdout: '', stderr: '', exited: Promise.resolve(0), kill() {} }
    }) as unknown as typeof Bun.spawn

    // The first thing ensureMaster does is an `-O check`; make it hang.
    const mgr = new MachineTunnelManager({ spawn, controlDir, controlTimeoutMs: 50 })
    await expect(mgr.ensureMaster(makeMachine())).rejects.toThrow(/timed out/)
    expect(killed).toBe(true)
  })

  it('throws a clear error when the control socket path exceeds the byte limit (C2)', async () => {
    // A pathologically long controlDir pushes the derived socket path past the
    // 90-byte guard — the manager must reject loudly, not silently truncate.
    const longDir = join(controlDir, 'x'.repeat(90))
    const fake = new FakeSsh()
    const mgr = new MachineTunnelManager({ spawn: fake.spawn, controlDir: longDir })
    await expect(mgr.ensureMaster(makeMachine())).rejects.toThrow(/control socket path too long/)
  })

  it('includes the master logfile tail in the establishment error and unlinks it (I4)', async () => {
    // The master spawn routes stderr to the `-E <logfile>` path; on failure that
    // file's tail must surface in the error, and the file must be cleaned up.
    let logPath: string | undefined
    const spawn = ((args: string[]) => {
      if (args.includes('-M')) {
        const eIdx = args.indexOf('-E')
        logPath = args[eIdx + 1]
        writeFileSync(logPath, 'debug1: Connecting...\nPermission denied (publickey).\n')
        return { stdout: '', stderr: '', exited: Promise.resolve(255), kill() {} }
      }
      // `-O check`: no live socket yet → fail so a master is spawned.
      return { stdout: '', stderr: '', exited: Promise.resolve(255), kill() {} }
    }) as unknown as typeof Bun.spawn

    const mgr = new MachineTunnelManager({ spawn, controlDir })
    await expect(mgr.ensureMaster(makeMachine())).rejects.toThrow(/Permission denied \(publickey\)/)
    expect(logPath).toBeDefined()
    expect(existsSync(logPath!)).toBe(false)
  })
})

/**
 * Integration: real ssh against a live host. Skipped unless FICUS_TEST_SSH_HOST is
 * set. To run locally against a reachable box you can SSH into with a key:
 *
 *   # On the remote host, serve something on a port (e.g. 8000):
 *   #   python3 -m http.server 8000
 *   FICUS_TEST_SSH_HOST=1.2.3.4 \
 *   FICUS_TEST_SSH_USER=youruser \
 *   FICUS_TEST_SSH_KEY_PATH=$HOME/.ssh/id_ed25519 \
 *   FICUS_TEST_SSH_REMOTE_PORT=8000 \
 *   FICUS_TEST_SSH_PORT=22 \
 *   FICUS_ENCRYPTION_KEY=$(printf '0%.0s' {1..64}) \
 *   bun test src/services/machines/tunnel-manager.test.ts
 */
describe.skipIf(!process.env.FICUS_TEST_SSH_HOST)('MachineTunnelManager (integration, real ssh)', () => {
  const REAL_SECRET_KEY = 'machine-ssh:tunnel-integration'
  let priorKey: string | undefined
  let priorHome: string | undefined
  let mgr: MachineTunnelManager
  let realMachine: Machine

  beforeAll(async () => {
    priorHome = process.env.HOME_DIR
    process.env.HOME_DIR = mkdtempSync(join(tmpdir(), 'tau-tunnel-int-'))
    priorKey = process.env.FICUS_ENCRYPTION_KEY
    process.env.FICUS_ENCRYPTION_KEY = priorKey ?? '0'.repeat(64)
    resetSecretStore()
    await getSecretStore().initialize()

    const keyPath = process.env.FICUS_TEST_SSH_KEY_PATH
    if (!keyPath) throw new Error('integration test requires FICUS_TEST_SSH_KEY_PATH')
    const privateKey = await Bun.file(keyPath).text()
    await getSecretStore().set(REAL_SECRET_KEY, privateKey, 'system')

    realMachine = makeMachine({
      id: crypto.randomUUID(),
      sshHost: process.env.FICUS_TEST_SSH_HOST!,
      sshPort: Number(process.env.FICUS_TEST_SSH_PORT ?? 22),
      sshUser: process.env.FICUS_TEST_SSH_USER!,
      sshKeyId: REAL_SECRET_KEY,
    })
    mgr = new MachineTunnelManager({ controlDir: join(process.env.HOME_DIR!, 'machines', 'ctl') })
  })

  afterAll(async () => {
    if (mgr) await mgr.stop()
    await getSecretStore().delete(REAL_SECRET_KEY)
    if (priorKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = priorKey
    if (priorHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = priorHome
    resetSecretStore()
  })

  it('ensures a master and forwards a remote port reachable over the endpoint', async () => {
    await mgr.ensureMaster(realMachine)
    expect(await mgr.checkHealth(realMachine.id)).toBe(true)

    const remotePort = Number(process.env.FICUS_TEST_SSH_REMOTE_PORT ?? 8000)
    const local = await mgr.addForward(realMachine, remotePort)
    expect(local).toBeGreaterThan(0)

    const endpoint = mgr.endpointFor(realMachine.id, remotePort)
    expect(endpoint).toBe(`http://127.0.0.1:${local}`)

    const res = await fetch(endpoint!)
    expect(res.status).toBeGreaterThanOrEqual(200)
  })
})
