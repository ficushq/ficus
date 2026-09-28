import { advisoryLock } from '@ficus/shared/advisory-lock'
import { createHash, randomUUID } from 'crypto'
import { access, chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'fs/promises'
import { createConnection, createServer } from 'net'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { machineControlDirectory } from '../../lib/infra/control-directory'
import { getHomeDir } from '../../lib/utils/home'
import { materializePrivateKey } from './keys'
import type { Machine } from './queries'
import { sshConnectionArgs, sshTarget } from './ssh'

/**
 * ControlMaster tunnel manager for machines.
 *
 * A persistent SSH master (`-M -N -f`) per machine multiplexes cheap `-O`
 * control-channel operations (port forwards, health checks, teardown) over one
 * authenticated connection. Local forwards expose a remote box port at
 * `http://127.0.0.1:<localPort>`; the (machineId, remotePort) → localPort map is
 * held in memory.
 *
 * Restart story: active local-forward ownership is journaled beside the control
 * socket before every forward/cancel mutation, while the hot registry remains
 * in memory. Masters are backgrounded (`-f`) processes that reparent to init and
 * therefore survive a core restart as (from core's view) orphans. Three things
 * keep that safe:
 *   1. Masters run with `ControlPersist=no`, so if a master process dies its
 *      control socket dies with it immediately — no lingering half-dead socket
 *      that a later `-O check` would falsely accept.
 *   2. `ensureMaster` treats a pre-existing live socket as adoptable: it runs
 *      `-O check` first and, on success, records the master without spawning a
 *      duplicate.
 *   3. `addForward` adopts durable tuples: dead-owner listeners are exact-
 *      cancelled before replacement, live sibling-process listeners are
 *      preserved, and proven master death retires that master's whole journal.
 */

/**
 * Wall-clock bound for establishing a ControlMaster (`-M -N -f`). The `-f`
 * foreground exits once auth completes, so this only needs to cover connect +
 * auth; a black-holed host can never hang `ensureMaster` past this.
 */
const DEFAULT_MASTER_TIMEOUT_MS = 15_000

/** Wall-clock bound for a single `-O` control operation over the socket. */
const DEFAULT_CONTROL_TIMEOUT_MS = 10_000

/** Distinguishable failure when a spawn/control op blows its wall-clock bound. */
class TunnelTimeoutError extends Error {}
export class TunnelOutcomeUnknownError extends Error {
  readonly code = 'TUNNEL_OUTCOME_UNKNOWN'
}

/**
 * Hard ceiling for a control-socket path. The kernel's `sockaddr_un.sun_path`
 * is ~104 bytes on macOS / 108 on Linux; ssh silently truncates past it and the
 * master then fails cryptically. We reject well under that (90 bytes) with a
 * clear message so a too-long HOME_DIR/controlDir surfaces as an actionable
 * error rather than a mysterious connection failure.
 */
const MAX_SOCKET_PATH_BYTES = 90
const PROCESS_OWNER_GENERATION = randomUUID()
const OWNER_SOCKET_READY = new Map<string, Promise<void>>()

interface MasterRecord {
  host: string
  port: number
  user: string
  socketPath: string
  generation?: string
}

interface FakeableProc {
  stdout: unknown
  stderr: unknown
  exited: Promise<number>
  kill?: (signal?: number | NodeJS.Signals) => void
}

/** Allocate a free local TCP port via the bind-0 trick.
 *
 * A real ephemeral socket is bound on 127.0.0.1:0, its assigned port read, then
 * the socket is closed before the port is handed to ssh. There is a tiny TOCTOU
 * window between close and ssh binding in which another process could claim the
 * port; ssh would then fail to bind and the caller retries. This is the
 * standard, acceptable trade-off for local forward allocation. */
function allocateLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

/**
 * Pinned remote port for the core-callback reverse tunnel, bound on every
 * machine's own sshd. One constant serves the WHOLE fleet — the listener lives
 * per-machine, so there is no cross-machine collision — and, crucially, it
 * survives ControlMaster death: after a core restart (`ControlPersist=no`) the
 * fresh master re-binds the SAME port, so the `FICUS_API_URL` each box baked into
 * its `server.env` stays valid without a full re-provision. Chosen just below the
 * box-port floor (50100) and well above the privileged/ephemeral ranges.
 */
export const MACHINE_REVERSE_PORT = 50080

/**
 * The effective pinned reverse port: {@link MACHINE_REVERSE_PORT} unless
 * `FICUS_MACHINE_REVERSE_PORT` overrides it with a valid TCP port (1–65535). Any
 * malformed/out-of-range value falls back to the default. Read at call time so a
 * process-level override (or a test) takes effect without a rebuild.
 */
export function resolveMachineReversePort(): number {
  const raw = process.env.FICUS_MACHINE_REVERSE_PORT?.trim()
  if (!raw || !/^\d+$/.test(raw)) return MACHINE_REVERSE_PORT
  const parsed = Number(raw)
  return parsed >= 1 && parsed <= 65535 ? parsed : MACHINE_REVERSE_PORT
}

function parseAllocatedRemotePort(stdout: string): number | null {
  // `ssh -R 0:...` on a foreground connection prints "Allocated port N for
  // remote forward to ...", but the MULTIPLEXED `-O forward -R 0:...` control
  // command this manager uses prints ONLY the bare allocated port number on its
  // own line. Accept both so a real dynamic reverse forward is parsed, not just
  // the verbose foreground form.
  const verbose = stdout.match(/Allocated port (\d+) for remote forward/)
  if (verbose) return Number(verbose[1])
  const bare = stdout.trim().match(/^(\d+)$/)
  return bare ? Number(bare[1]) : null
}

export interface ReverseBindingResult {
  remotePort: number
  binding: 'reused' | 'bound'
  allocation: 'pinned' | 'dynamic'
}

type ForwardJournalState = 'forwarding' | 'active' | 'cancelling'

function isForwardJournalState(value: unknown): value is ForwardJournalState {
  return value === 'forwarding' || value === 'active' || value === 'cancelling'
}

export interface ForwardRefreshResult {
  localPort: number
  master: 'preserved' | 'restarted'
  forward: 'rebound'
  reverses: 'preserved' | 'invalidated'
}

export class MachineTunnelManager {
  private readonly spawn: typeof Bun.spawn
  private readonly controlDir: string
  private readonly masterTimeoutMs: number
  private readonly controlTimeoutMs: number
  private readonly ownerId: string
  private readonly ownerPid: number
  private readonly isOwnerAlive: (ownerId: string, ownerPid: number) => Promise<boolean>
  private readonly isLocalPortFree: (port: number) => Promise<boolean>
  private readonly ownerLivenessReady: Promise<void>
  private readonly allocateLocalPort: () => Promise<number>
  private readonly masters = new Map<string, MasterRecord>()
  /** `${machineId}:${remotePort}` → localPort */
  private readonly forwards = new Map<string, number>()
  /** Known-spec listeners whose mux result timed out and must be exact-cancelled before replacement. */
  private readonly uncertainForwards = new Map<string, number>()
  /** A dynamic reverse timed out; no mutation is safe until master death is proved. */
  private readonly taintedMachines = new Set<string>()
  /** `${machineId}:R${localPort}` → remotePort */
  private readonly reverses = new Map<string, number>()
  /** In-flight master establishment per machineId (dedupes concurrent callers). */
  private readonly masterInflight = new Map<string, Promise<void>>()
  /** In-flight forward establishment per `${machineId}:${remotePort}`. */
  private readonly forwardInflight = new Map<string, Promise<number>>()
  /** In-flight exact-key replacement per `${machineId}:${remotePort}`. */
  private readonly forwardRepairInflight = new Map<string, Promise<ForwardRefreshResult>>()
  private readonly forwardCleanupInflight = new Map<string, Promise<void>>()
  /** In-flight reverse establishment per `${machineId}:R${localPort}`. */
  private readonly reverseInflight = new Map<string, Promise<ReverseBindingResult>>()

  constructor(deps?: {
    spawn?: typeof Bun.spawn
    controlDir?: string
    masterTimeoutMs?: number
    controlTimeoutMs?: number
    ownerId?: string
    ownerPid?: number
    isOwnerAlive?: (ownerId: string, ownerPid: number) => Promise<boolean>
    isLocalPortFree?: (port: number) => Promise<boolean>
    allocateLocalPort?: () => Promise<number>
  }) {
    this.spawn = deps?.spawn ?? Bun.spawn
    this.controlDir = deps?.controlDir ?? machineControlDirectory()
    this.masterTimeoutMs = deps?.masterTimeoutMs ?? DEFAULT_MASTER_TIMEOUT_MS
    this.controlTimeoutMs = deps?.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS
    this.ownerId = deps?.ownerId ?? PROCESS_OWNER_GENERATION
    this.ownerPid = deps?.ownerPid ?? process.pid
    const injectedOwner = deps?.ownerId !== undefined
    this.ownerLivenessReady = injectedOwner ? Promise.resolve() : this.ensureOwnerSocket(this.ownerPid, this.ownerId)
    this.isOwnerAlive =
      deps?.isOwnerAlive ??
      (injectedOwner
        ? async (ownerId, ownerPid) => ownerId === this.ownerId && ownerPid === this.ownerPid
        : async (ownerId, ownerPid) => this.canConnectOwnerSocket(ownerPid, ownerId))
    this.allocateLocalPort = deps?.allocateLocalPort ?? allocateLocalPort
    this.isLocalPortFree =
      deps?.isLocalPortFree ??
      ((port) =>
        new Promise<boolean>((resolve) => {
          const server = createServer()
          server.once('error', () => resolve(false))
          server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
        }))
  }

  private ownerSocketPath(ownerPid: number, ownerId: string): string {
    const generation = createHash('sha256').update(ownerId).digest('hex').slice(0, 12)
    return join(this.controlDir, `owner-${ownerPid}-${generation}.sock`)
  }

  private ensureOwnerSocket(ownerPid: number, ownerId: string): Promise<void> {
    const path = this.ownerSocketPath(ownerPid, ownerId)
    const existing = OWNER_SOCKET_READY.get(path)
    if (existing) return existing
    const ready = this.startOwnerSocket(ownerPid, ownerId).catch((error) => {
      OWNER_SOCKET_READY.delete(path)
      throw error
    })
    OWNER_SOCKET_READY.set(path, ready)
    return ready
  }

  private async startOwnerSocket(ownerPid: number, ownerId: string): Promise<void> {
    await mkdir(this.controlDir, { recursive: true, mode: 0o700 })
    const path = this.ownerSocketPath(ownerPid, ownerId)
    // Same guard as socketPathFor, applied here (async, so callers get a
    // rejection): the owner socket name is LONGER than the master's
    // (`owner-<pid>-<12hex>.sock`) and binds first — without this an over-long
    // controlDir surfaces as a raw "Failed to listen at ...sock" instead of
    // the actionable error.
    const pathBytes = Buffer.byteLength(path)
    if (pathBytes > MAX_SOCKET_PATH_BYTES) {
      throw new Error(
        `control socket path too long (${pathBytes} bytes > ${MAX_SOCKET_PATH_BYTES}): ${path}; ` +
          `set a shorter HOME_DIR/controlDir`
      )
    }
    await this.safeUnlink(path)
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => socket.end())
      server.unref()
      server.once('error', reject)
      server.listen(path, () => resolve())
    })
    await chmod(path, 0o600)
  }

  private canConnectOwnerSocket(ownerPid: number, ownerId: string): Promise<boolean> {
    return this.canConnectSocket(this.ownerSocketPath(ownerPid, ownerId))
  }

  private masterLockPath(machineId: string): string {
    return `${this.socketPathFor(machineId)}.lock`
  }

  private async acquireMasterLock(machineId: string): Promise<() => Promise<void>> {
    await this.ownerLivenessReady
    await mkdir(this.controlDir, { recursive: true, mode: 0o700 })
    await chmod(this.controlDir, 0o700)
    const path = this.masterLockPath(machineId)
    const file = await open(path, 'a+', 0o600)
    const deadline = Date.now() + this.masterTimeoutMs
    try {
      while (Date.now() < deadline) {
        if (await advisoryLock(file.fd, 'lock')) {
          return async () => {
            try {
              if (!(await advisoryLock(file.fd, 'unlock'))) throw new Error('ssh master lock release failed')
            } finally {
              await file.close()
            }
          }
        }
        await Bun.sleep(10)
      }
    } catch (error) {
      await file.close()
      throw error
    }
    await file.close()
    throw new TunnelTimeoutError(`ssh master lock timed out after ${this.masterTimeoutMs}ms`)
  }

  private canConnectSocket(path: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket = createConnection(path)
      socket.unref()
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
  }

  private socketPathFor(machineId: string): string {
    // A 36-char UUID under a /var/folders-style HOME_DIR overflows the ~104-byte
    // unix-socket path limit, so use a short digest (mirrors the box_<12hex>
    // convention) instead of the raw id.
    const short = createHash('sha256').update(machineId).digest('hex').slice(0, 12)
    const socketPath = join(this.controlDir, `${short}.sock`)
    const bytes = Buffer.byteLength(socketPath)
    if (bytes > MAX_SOCKET_PATH_BYTES) {
      throw new Error(
        `control socket path too long (${bytes} bytes > ${MAX_SOCKET_PATH_BYTES}): ${socketPath}; ` +
          `set a shorter HOME_DIR/controlDir`
      )
    }
    return socketPath
  }

  /** Per-machine scratch logfile for the master's stderr (`ssh -E`). */
  private masterLogPathFor(machineId: string): string {
    const short = createHash('sha256').update(machineId).digest('hex').slice(0, 12)
    return join(tmpdir(), `tau-machine-master-${short}.log`)
  }

  /** Read the last ~15 lines of the master logfile (empty string if absent). */
  private async readLogTail(logPath: string): Promise<string> {
    try {
      const content = await readFile(logPath, 'utf8')
      return content.split('\n').filter(Boolean).slice(-15).join('\n')
    } catch {
      return ''
    }
  }

  private async safeUnlink(logPath: string): Promise<void> {
    try {
      await unlink(logPath)
    } catch {
      // best-effort — scratch logfile
    }
  }

  /**
   * Build the establishment-failure error: append the master logfile tail (the
   * only diagnostic for why ssh gave up) to `base`, then unlink the logfile.
   */
  private async masterFailure(base: string, logPath: string): Promise<Error> {
    const tail = await this.readLogTail(logPath)
    await this.safeUnlink(logPath)
    return new Error(tail ? `${base}\nssh master log tail:\n${tail}` : base)
  }

  private async collect(proc: FakeableProc): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as BodyInit).text(),
      new Response(proc.stderr as BodyInit).text(),
      proc.exited,
    ])
    return { exitCode, stdout, stderr }
  }

  /**
   * Race `work` against a wall-clock timeout that SIGKILLs the spawned child and
   * rejects with a {@link TunnelTimeoutError} so a hung ssh child can never block
   * a caller indefinitely.
   */
  private async raceTimeout<T>(
    work: Promise<T>,
    proc: FakeableProc,
    timeoutMs: number,
    makeError: () => TunnelTimeoutError
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          proc.kill?.('SIGKILL')
        } catch {
          // best-effort
        }
        reject(makeError())
      }, timeoutMs)
    })
    try {
      return await Promise.race([work, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private forwardDebtPath(record: MasterRecord, remotePort: number, localPort: number): string {
    return `${record.socketPath}.L${remotePort}.${localPort}.uncertain`
  }

  private async persistForwardDebt(
    record: MasterRecord,
    remotePort: number,
    localPort: number,
    state: ForwardJournalState
  ): Promise<void> {
    await this.ownerLivenessReady
    const path = this.forwardDebtPath(record, remotePort, localPort)
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(
      temporary,
      JSON.stringify({
        remotePort,
        localPort,
        state,
        ownerId: this.ownerId,
        ownerPid: this.ownerPid,
        masterGeneration: record.generation ?? 'unknown',
      }),
      { mode: 0o600 }
    )
    await rename(temporary, path)
  }

  private async loadForwardDebts(
    record: MasterRecord,
    remotePort: number
  ): Promise<
    Array<{
      localPort: number
      path: string
      state: ForwardJournalState
      ownerId: string
      ownerPid: number
      masterGeneration: string
    }>
  > {
    const prefix = `${basename(record.socketPath)}.L${remotePort}.`
    const names = (await readdir(this.controlDir))
      .filter((name) => name.startsWith(prefix) && name.endsWith('.uncertain'))
      .sort()
    const debts: Array<{
      localPort: number
      path: string
      state: ForwardJournalState
      ownerId: string
      ownerPid: number
      masterGeneration: string
    }> = []
    for (const name of names) {
      const path = join(this.controlDir, name)
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
        if (
          parsed.remotePort !== remotePort ||
          !Number.isInteger(parsed.localPort) ||
          !isForwardJournalState(parsed.state) ||
          typeof parsed.ownerId !== 'string' ||
          !Number.isInteger(parsed.ownerPid) ||
          typeof parsed.masterGeneration !== 'string'
        )
          throw new Error('malformed')
        debts.push({
          localPort: Number(parsed.localPort),
          path,
          state: parsed.state,
          ownerId: parsed.ownerId,
          ownerPid: Number(parsed.ownerPid),
          masterGeneration: parsed.masterGeneration as string,
        })
      } catch {
        throw new TunnelOutcomeUnknownError(`could not read durable forward cleanup debt for remote ${remotePort}`)
      }
    }
    return debts
  }

  private async clearForwardDebts(record: MasterRecord, generation?: string): Promise<void> {
    const prefix = `${basename(record.socketPath)}.L`
    const names = (await readdir(this.controlDir).catch(() => [])).filter(
      (name) => name.startsWith(prefix) && name.endsWith('.uncertain')
    )
    await Promise.all(
      names.map(async (name) => {
        const path = join(this.controlDir, name)
        if (generation !== undefined) {
          try {
            const parsed = JSON.parse(await readFile(path, 'utf8')) as { masterGeneration?: unknown }
            if (parsed.masterGeneration !== generation) return
          } catch {
            return
          }
        }
        await this.safeUnlink(path)
      })
    )
  }

  private quarantinePath(record: MasterRecord): string {
    return `${record.socketPath}.quarantine`
  }

  private async assertMutationAllowed(record: MasterRecord): Promise<void> {
    try {
      await access(this.quarantinePath(record))
      throw new TunnelOutcomeUnknownError(`ssh master is quarantined for mutation`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  /** Run a `-O <cmd>` control operation over an existing master socket. */
  private async runControl(
    record: MasterRecord,
    oCmd: 'check' | 'forward' | 'cancel' | 'exit',
    extra: string[] = []
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (oCmd === 'forward' || oCmd === 'cancel') await this.assertMutationAllowed(record)
    const args = [
      'ssh',
      '-S',
      record.socketPath,
      '-O',
      oCmd,
      ...extra,
      '-p',
      String(record.port),
      `${record.user}@${record.host}`,
    ]
    const proc = this.spawn(args, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }) as unknown as FakeableProc
    return this.raceTimeout(
      this.collect(proc),
      proc,
      this.controlTimeoutMs,
      () => new TunnelTimeoutError(`ssh control operation ${oCmd} timed out after ${this.controlTimeoutMs}ms`)
    )
  }

  private async isMasterAlive(record: MasterRecord): Promise<boolean> {
    const before = await stat(record.socketPath).catch(() => null)
    const { exitCode, stdout, stderr } = await this.runControl(record, 'check')
    if (exitCode !== 0) return false
    const pid = `${stdout}\n${stderr}`.match(/pid[= ](\d+)/i)?.[1]
    if (!pid) throw new TunnelOutcomeUnknownError('ssh master identity was not reported')
    if (!before) throw new TunnelOutcomeUnknownError('ssh master control-socket identity is unavailable')
    const after = await stat(record.socketPath).catch(() => null)
    const beforeSocket = `${before.dev}:${before.ino}:${before.birthtimeMs}:${before.ctimeMs}`
    const afterSocket = after && `${after.dev}:${after.ino}:${after.birthtimeMs}:${after.ctimeMs}`
    if (beforeSocket !== afterSocket) return false
    const generation = `${pid}:${beforeSocket}`
    if (record.generation && record.generation !== generation) return false
    record.generation = generation
    return true
  }

  /**
   * Ensure a live ControlMaster exists for `machine`. Concurrent callers for the
   * same machine share one in-flight establishment (the memo is cleared on
   * settle) so two parallel calls can never race to spawn two `-M` masters onto
   * the same control socket.
   */
  async ensureMaster(machine: Machine): Promise<void> {
    const inflight = this.masterInflight.get(machine.id)
    if (inflight) return inflight

    const p = this.establishMaster(machine).finally(() => {
      this.masterInflight.delete(machine.id)
    })
    this.masterInflight.set(machine.id, p)
    return p
  }

  private async establishMaster(machine: Machine): Promise<void> {
    const release = await this.acquireMasterLock(machine.id)
    try {
      await this.establishMasterLocked(machine)
    } finally {
      await release()
    }
  }

  private async establishMasterLocked(machine: Machine): Promise<void> {
    await mkdir(this.controlDir, { recursive: true, mode: 0o700 })
    await chmod(this.controlDir, 0o700)

    const record: MasterRecord = {
      host: machine.sshHost,
      port: machine.sshPort,
      user: machine.sshUser,
      socketPath: this.socketPathFor(machine.id),
    }

    // Adopt a pre-existing live socket (survives core restarts) — don't spawn a
    // second master.
    if (await this.isMasterAlive(record)) {
      const prior = this.masters.get(machine.id)
      if (prior?.generation && record.generation !== prior.generation) {
        await this.clearForwardDebts(prior, prior.generation)
        this.purgeForwards(machine.id)
        this.purgeReverses(machine.id)
      }
      this.masters.set(machine.id, record)
      return
    }
    // Proven socket/master death retires every exact listener debt belonging
    // to that master generation before a fresh master is created.
    await this.clearForwardDebts(record)

    // …and reclaims the control-socket PATH. A dead master leaves its socket
    // file behind (a core restart kills the master; nothing unlinks the inode),
    // and `ssh -M` refuses to multiplex onto an existing path: it logs
    // "ControlSocket <path> already exists, disabling multiplexing", then still
    // authenticates and still exits 0 under `-f`. So establishment LOOKS
    // successful while the health probe below can only ever fail against the
    // stale inode — and because nothing removes it, the machine wedges
    // permanently, leaking one idle backgrounded ssh per retry (observed live:
    // 77 orphans, every box start on the host failing, until the socket was
    // removed by hand). isMasterAlive returned false above, so the path is
    // proven dead and safe to unlink here.
    await this.safeUnlink(record.socketPath)

    const identity = await materializePrivateKey(machine)
    const logPath = this.masterLogPathFor(machine.id)
    try {
      await mkdir(join(getHomeDir(), 'machines'), { recursive: true })
      const args = [
        'ssh',
        '-M',
        '-N',
        '-f',
        // Route the master's stderr to a logfile rather than a pipe: the `-f`
        // background master holds the pipe write-ends open for its whole life,
        // so a piped stderr would never EOF. `-E` gives us the diagnostic
        // output for a failed establishment without any read that could hang.
        '-E',
        logPath,
        '-S',
        record.socketPath,
        '-o',
        'ControlMaster=yes',
        '-o',
        'ControlPersist=no',
        ...sshConnectionArgs(machine, identity.path),
        sshTarget(machine),
      ]
      // The `-f` foreground exits after auth, but the backgrounded master
      // inherits the pipe write-ends and holds them open for its whole lifetime.
      // Reading stdout/stderr would therefore never EOF (blocking until the
      // master dies), so ignore both and wait only on `exited`, bounded by a
      // wall-clock timeout that kills the child on expiry.
      const proc = this.spawn(args, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }) as unknown as FakeableProc
      let exitCode: number
      try {
        exitCode = await this.raceTimeout(
          proc.exited,
          proc,
          this.masterTimeoutMs,
          () =>
            new TunnelTimeoutError(
              `ssh master establishment for machine ${machine.id} timed out after ${this.masterTimeoutMs}ms`
            )
        )
      } catch (err) {
        const base = err instanceof Error ? err.message : String(err)
        throw await this.masterFailure(base, logPath)
      }
      if (exitCode !== 0) {
        throw await this.masterFailure(
          `failed to start ssh master for machine ${machine.id} (exit ${exitCode})`,
          logPath
        )
      }
      if (!(await this.isMasterAlive(record))) {
        // Leave nothing that would wedge the NEXT attempt: retire the socket we
        // just failed to validate (best-effort `-O exit` first, in case a master
        // is live but mismatched) so the following establishment starts from a
        // clean path instead of re-entering the "already exists" trap above.
        await this.runControl(record, 'exit').catch(() => undefined)
        await this.safeUnlink(record.socketPath)
        throw await this.masterFailure(`new ssh master did not become healthy for ${machine.id}`, logPath)
      }
      this.masters.set(machine.id, record)
      // Establishment succeeded — the diagnostic log is no longer needed.
      await this.safeUnlink(logPath)
    } finally {
      identity.cleanup()
    }
  }

  /**
   * Local-forward a remote box port; idempotent per (machine, remotePort).
   *
   * Concurrent callers for the same (machine, remotePort) share one in-flight
   * establishment so they can never allocate two local ports and leak one
   * forward. The idempotent early-return first verifies the master is still
   * alive (`-O check`): a master killed by a network blip (ControlPersist=no)
   * would otherwise hand back a cached but dead local port. On a dead master the
   * machine's stale forwards are purged and the forward is re-established fresh.
   */
  async addForward(machine: Machine, remotePort: number): Promise<number> {
    if (this.forwardCleanupInflight.has(machine.id))
      throw new TunnelOutcomeUnknownError(`forward cleanup in progress for ${machine.id}`)
    if (this.taintedMachines.has(machine.id))
      throw new TunnelOutcomeUnknownError(`ssh master outcome unknown for ${machine.id}`)
    const key = `${machine.id}:${remotePort}`
    if (this.uncertainForwards.has(key))
      throw new TunnelOutcomeUnknownError(`exact forward cleanup remains unproven for ${machine.id}`)
    const repair = this.forwardRepairInflight.get(key)
    if (repair) return repair.then((result) => result.localPort)
    const inflight = this.forwardInflight.get(key)
    if (inflight) return inflight

    const p = this.establishForward(machine, remotePort, key).finally(() => {
      this.forwardInflight.delete(key)
    })
    this.forwardInflight.set(key, p)
    return p
  }

  /**
   * Replace exactly one local forward while preserving every other listener on
   * the shared ControlMaster. Concurrent repair/add callers join one operation.
   * An ambiguous or failed cancel retains the old registry entry: forgetting a
   * possibly-live listener could permit an overlapping replacement.
   */
  async refreshForward(machine: Machine, remotePort: number): Promise<number> {
    return (await this.refreshForwardDetailed(machine, remotePort)).localPort
  }

  async refreshForwardDetailed(machine: Machine, remotePort: number): Promise<ForwardRefreshResult> {
    if (this.forwardCleanupInflight.has(machine.id))
      throw new TunnelOutcomeUnknownError(`forward cleanup in progress for ${machine.id}`)
    const key = `${machine.id}:${remotePort}`
    const existingRepair = this.forwardRepairInflight.get(key)
    if (existingRepair) return existingRepair
    const repair = this.repairForward(machine, remotePort, key).finally(() => {
      if (this.forwardRepairInflight.get(key) === repair) this.forwardRepairInflight.delete(key)
    })
    this.forwardRepairInflight.set(key, repair)
    return repair
  }

  private async repairForward(machine: Machine, remotePort: number, key: string): Promise<ForwardRefreshResult> {
    const establishing = this.forwardInflight.get(key)
    if (establishing) await establishing

    const localPort = this.forwards.get(key)
    const record = this.masters.get(machine.id)
    let master: ForwardRefreshResult['master'] = 'preserved'
    if (localPort !== undefined && record) {
      let alive = false
      try {
        alive = await this.isMasterAlive(record)
      } catch {
        // A timed-out check is ambiguous: do not assume the master/listener died.
        throw new Error(`could not prove ssh master state while refreshing ${machine.id} remote ${remotePort}`)
      }
      if (alive) {
        try {
          await this.persistForwardDebt(record, remotePort, localPort, 'cancelling')
          const result = await this.runControl(record, 'cancel', ['-L', `${localPort}:127.0.0.1:${remotePort}`])
          if (result.exitCode !== 0) throw new Error(`exact forward cancellation was not acknowledged`)
        } catch (error) {
          this.uncertainForwards.set(key, localPort)
          throw new TunnelOutcomeUnknownError(`could not prove cleanup for ${machine.id} remote ${remotePort}`, {
            cause: error,
          })
        }
        this.forwards.delete(key)
        this.uncertainForwards.delete(key)
        await this.safeUnlink(this.forwardDebtPath(record, remotePort, localPort))
      } else {
        // A proven-dead master proves all of its listeners are gone.
        await this.clearForwardDebts(record, record.generation)
        this.purgeForwards(machine.id)
        this.purgeReverses(machine.id)
        master = 'restarted'
      }
    }

    return {
      localPort: await this.establishForward(machine, remotePort, key),
      master,
      forward: 'rebound',
      reverses: master === 'restarted' ? 'invalidated' : 'preserved',
    }
  }

  private async establishForward(machine: Machine, remotePort: number, key: string): Promise<number> {
    const existing = this.forwards.get(key)
    if (existing !== undefined) {
      const record = this.masters.get(machine.id)
      if (record && (await this.isMasterAlive(record))) return existing
      // Master died under us — the cached local port is dead. Drop this
      // machine's stale forwards AND reverses and re-establish from scratch
      // below. Purging reverses is required for symmetry with
      // establishReverse: a surviving stale reverse entry would let a later
      // addReverse see "existing + alive fresh master" and hand back the DEAD
      // remote port from the old master.
      if (record) await this.clearForwardDebts(record, record.generation)
      this.purgeForwards(machine.id)
      this.purgeReverses(machine.id)
    }

    const previousRecord = this.masters.get(machine.id)
    if (this.uncertainForwards.has(key) && previousRecord) {
      try {
        if (!(await this.isMasterAlive(previousRecord))) {
          this.uncertainForwards.delete(key)
          this.purgeForwards(machine.id)
          this.purgeReverses(machine.id)
        }
      } catch {
        throw new TunnelOutcomeUnknownError(`could not prove ssh master state for ${machine.id}`)
      }
    }
    await this.ensureMaster(machine)
    await this.ownerLivenessReady
    const record = this.masters.get(machine.id)!
    for (const debt of await this.loadForwardDebts(record, remotePort)) {
      if (record.generation && debt.masterGeneration !== 'unknown' && debt.masterGeneration !== record.generation) {
        await unlink(debt.path)
        continue
      }
      if (debt.ownerId === this.ownerId && debt.state === 'active') {
        this.forwards.set(key, debt.localPort)
        return debt.localPort
      }
      if (debt.ownerId !== this.ownerId && (await this.isOwnerAlive(debt.ownerId, debt.ownerPid))) continue
      await this.persistForwardDebt(record, remotePort, debt.localPort, 'cancelling')
      const cancelled = await this.runControl(record, 'cancel', ['-L', `${debt.localPort}:127.0.0.1:${remotePort}`])
      if (cancelled.exitCode !== 0 && !(debt.state !== 'active' && (await this.isLocalPortFree(debt.localPort))))
        throw new TunnelOutcomeUnknownError(`durable forward cleanup remains unproven for ${machine.id}`)
      await unlink(debt.path)
    }
    const uncertainPort = this.uncertainForwards.get(key)
    if (uncertainPort !== undefined) {
      try {
        const cancelled = await this.runControl(record, 'cancel', ['-L', `${uncertainPort}:127.0.0.1:${remotePort}`])
        if (cancelled.exitCode !== 0) throw new Error('exact forward cancellation was not acknowledged')
        this.uncertainForwards.delete(key)
      } catch (error) {
        throw new TunnelOutcomeUnknownError(`could not prove cleanup for ${machine.id} remote ${remotePort}`, {
          cause: error,
        })
      }
    }

    const localPort = await this.allocateLocalPort()
    let control
    await this.persistForwardDebt(record, remotePort, localPort, 'forwarding')
    try {
      control = await this.runControl(record, 'forward', ['-L', `${localPort}:127.0.0.1:${remotePort}`])
    } catch (error) {
      this.uncertainForwards.set(key, localPort)
      throw error
    }
    const { exitCode, stderr } = control
    if (exitCode !== 0) {
      await this.safeUnlink(this.forwardDebtPath(record, remotePort, localPort))
      throw new Error(`failed to forward ${machine.id} remote ${remotePort} (exit ${exitCode}): ${stderr.trim()}`)
    }

    await this.persistForwardDebt(record, remotePort, localPort, 'active')
    this.forwards.set(key, localPort)
    return localPort
  }

  /** Drop every forward-registry entry for a machine (e.g. its master died). */
  private purgeForwards(machineId: string): void {
    for (const key of [...this.forwards.keys()]) {
      if (key.startsWith(`${machineId}:`)) this.forwards.delete(key)
    }
  }

  /** Drop every reverse-registry entry for a machine (its master died: the
   *  server-side reverse listeners died with the control socket). */
  private purgeReverses(machineId: string): void {
    for (const key of [...this.reverses.keys()]) {
      if (key.startsWith(`${machineId}:`)) this.reverses.delete(key)
    }
  }

  /**
   * Remote-forward a local port onto the machine, preferring the pinned constant
   * {@link MACHINE_REVERSE_PORT} (so a box's baked `FICUS_API_URL` survives master
   * death); idempotent per (machine, localPort). Returns the bound remote port —
   * the pinned port on the normal path, or a dynamically-allocated one if the
   * pinned bind degraded to the `-R 0:` fallback (see {@link bindReverse}).
   *
   * Mirrors {@link addForward}'s semantics exactly: concurrent callers for the
   * same (machine, localPort) share one in-flight establishment so they can never
   * allocate two reverse listeners and leak one; the idempotent early-return first
   * verifies the master is still alive (`-O check`) because a master killed by a
   * network blip (ControlPersist=no) would otherwise hand back a cached but dead
   * remote port. On a dead master the machine's stale reverses are purged and the
   * reverse is re-established fresh.
   */
  async ensureReverseDetailed(machine: Machine, localPort: number): Promise<ReverseBindingResult> {
    if (this.taintedMachines.has(machine.id))
      throw new TunnelOutcomeUnknownError(`ssh master outcome unknown for ${machine.id}`)
    const key = `${machine.id}:R${localPort}`
    const inflight = this.reverseInflight.get(key)
    if (inflight) return inflight
    const binding = this.establishReverse(machine, localPort, key).finally(() => {
      this.reverseInflight.delete(key)
    })
    this.reverseInflight.set(key, binding)
    return binding
  }

  async addReverse(machine: Machine, localPort: number): Promise<number> {
    return (await this.ensureReverseDetailed(machine, localPort)).remotePort
  }

  private async establishReverse(machine: Machine, localPort: number, key: string): Promise<ReverseBindingResult> {
    const existing = this.reverses.get(key)
    if (existing !== undefined) {
      const record = this.masters.get(machine.id)
      if (record && (await this.isMasterAlive(record))) {
        return {
          remotePort: existing,
          binding: 'reused',
          allocation: existing === resolveMachineReversePort() ? 'pinned' : 'dynamic',
        }
      }
      this.purgeForwards(machine.id)
      this.purgeReverses(machine.id)
    }
    await this.ensureMaster(machine)
    const record = this.masters.get(machine.id)!
    const remotePort = await this.bindReverse(machine, localPort, record)
    this.reverses.set(key, remotePort)
    return {
      remotePort,
      binding: 'bound',
      allocation: remotePort === resolveMachineReversePort() ? 'pinned' : 'dynamic',
    }
  }

  /**
   * Bind the core-callback reverse listener for `localPort`, preferring the
   * pinned constant port ({@link resolveMachineReversePort}). Returns the remote
   * port actually bound.
   *
   * The ControlMaster is shared across core processes (api + worker adopt one
   * socket). A duplicate SAME-spec pinned request on a live mux master is not an
   * error: ssh DEDUPES it (exit 0, empty stderr), so the sibling-process case
   * never surfaces a failure here. The only thing that makes a pinned bind FAIL
   * ("address already in use" / "remote port forwarding failed") is a DIFFERENT
   * owner holding the port — a rogue process on the machine, or a stale
   * different-spec forward. That must NOT be treated as success: baking
   * `http://127.0.0.1:<pinned>` callbacks would silently route boxes to the
   * squatter. So on ANY nonzero pinned bind we warn and fall back to the legacy
   * dynamic `-R 0:` allocation (parsed). The tunnel still works, but its remote
   * port will change on master death, so a baked `FICUS_API_URL` then goes stale —
   * hence the warning.
   */
  private async bindReverse(machine: Machine, localPort: number, record: MasterRecord): Promise<number> {
    const pinned = resolveMachineReversePort()
    let pinnedResult
    try {
      pinnedResult = await this.runControl(record, 'forward', ['-R', `${pinned}:127.0.0.1:${localPort}`])
    } catch (error) {
      if (!(error instanceof TunnelTimeoutError)) throw error
      try {
        const cancelled = await this.runControl(record, 'cancel', ['-R', `${pinned}:127.0.0.1:${localPort}`])
        if (cancelled.exitCode !== 0) throw new Error('exact reverse cancellation was not acknowledged')
      } catch (cancelError) {
        this.taintedMachines.add(machine.id)
        this.purgeForwards(machine.id)
        this.purgeReverses(machine.id)
        throw new TunnelOutcomeUnknownError(`pinned reverse outcome unknown for ${machine.id}`, { cause: cancelError })
      }
      throw error
    }
    const { exitCode } = pinnedResult
    if (exitCode === 0) return pinned

    console.warn(
      `pinned reverse binding unavailable for ${machine.id}; using dynamic allocation that must be rebound after master loss`
    )
    let dynamic
    try {
      dynamic = await this.runControl(record, 'forward', ['-R', `0:127.0.0.1:${localPort}`])
    } catch (error) {
      if (error instanceof TunnelTimeoutError) {
        await writeFile(this.quarantinePath(record), 'dynamic-reverse-outcome-unknown\n', { mode: 0o600 })
        this.taintedMachines.add(machine.id)
        this.purgeForwards(machine.id)
        this.purgeReverses(machine.id)
        let dead = false
        try {
          const exited = await this.runControl(record, 'exit')
          dead = exited.exitCode === 0 && !(await this.isMasterAlive(record))
        } catch {
          dead = false
        }
        if (dead) {
          await unlink(this.quarantinePath(record))
          this.taintedMachines.delete(machine.id)
          this.masters.delete(machine.id)
          this.purgeForwards(machine.id)
          this.purgeReverses(machine.id)
          throw error
        }
        throw new TunnelOutcomeUnknownError(`dynamic reverse outcome unknown for ${machine.id}`, { cause: error })
      }
      throw error
    }
    const { exitCode: dynExit, stdout: dynOut, stderr: dynErr } = dynamic
    if (dynExit !== 0) {
      throw new Error(`failed to reverse-forward ${machine.id} local ${localPort} (exit ${dynExit}): ${dynErr.trim()}`)
    }
    const remotePort = parseAllocatedRemotePort(dynOut)
    if (remotePort === null) {
      await writeFile(this.quarantinePath(record), 'dynamic-reverse-port-unknown\n', { mode: 0o600 })
      this.taintedMachines.add(machine.id)
      this.purgeForwards(machine.id)
      this.purgeReverses(machine.id)
      throw new TunnelOutcomeUnknownError(`dynamic reverse allocated an unknown port for ${machine.id}`)
    }
    return remotePort
  }

  /**
   * The remote port a reverse forward is bound to, or null if none is live.
   * Normally this equals {@link resolveMachineReversePort} (the pinned constant),
   * so it can also be derived without a lookup; it differs only when a box's
   * forward degraded to the dynamic `-R 0:` fallback, where the server picked the
   * port. Kept as the source of truth so callers need not know which path bound.
   */
  reverseFor(machineId: string, localPort: number): number | null {
    const remotePort = this.reverses.get(`${machineId}:R${localPort}`)
    return remotePort === undefined ? null : remotePort
  }

  async removeForward(machine: Machine, remotePort: number): Promise<void> {
    return this.removeForwardById(machine.id, remotePort)
  }

  /**
   * {@link removeForward} keyed by machineId alone. The control operation only
   * needs the master record (held per machineId), so a caller that learns of a
   * teardown second-hand — e.g. a `box.status` event from the OTHER core
   * process, which carries ids but no hydrated `Machine` row — can drop its
   * stale forward without a DB read.
   */
  async removeForwardById(machineId: string, remotePort: number): Promise<void> {
    const key = `${machineId}:${remotePort}`
    const localPort = this.forwards.get(key)
    if (localPort === undefined) return

    const record = this.masters.get(machineId)
    if (!record) throw new TunnelOutcomeUnknownError(`missing ssh master record for ${machineId}`)
    try {
      await this.persistForwardDebt(record, remotePort, localPort, 'cancelling')
      const result = await this.runControl(record, 'cancel', ['-L', `${localPort}:127.0.0.1:${remotePort}`])
      if (result.exitCode !== 0) throw new Error('exact forward cancellation was not acknowledged')
    } catch (error) {
      this.uncertainForwards.set(key, localPort)
      const outcome = error instanceof TunnelTimeoutError ? 'timed out' : 'was not acknowledged'
      throw new TunnelOutcomeUnknownError(`exact forward cancellation ${outcome} for ${machineId}`, { cause: error })
    }
    this.forwards.delete(key)
    this.uncertainForwards.delete(key)
    await this.safeUnlink(this.forwardDebtPath(record, remotePort, localPort))
  }

  /**
   * Cancel every local forward THIS process registered for a machine without
   * touching the shared master — the shutdown-safe counterpart to
   * {@link closeMachine}.
   *
   * The ControlMaster is a per-machine singleton SHARED across core processes
   * (api + worker adopt the same control socket), and it also carries the
   * reverse forwards whose allocated remote ports boxes baked into their
   * `FICUS_API_URL`. An `-O exit` from one process's ROUTINE shutdown would
   * therefore kill the other process's live forwards and every box's callback
   * port in one stroke. This instead `-O cancel`s only the local forwards this
   * process's registry holds (per-process ephemeral ports nobody else uses) and
   * leaves the master and its reverse forwards running for adoption after
   * restart. Reserve {@link closeMachine} for genuine machine teardown
   * (delete/park), where the master itself must die.
   */
  async cancelMachineForwards(machineId: string): Promise<void> {
    const existing = this.forwardCleanupInflight.get(machineId)
    if (existing) return existing
    const cleanup = this.performCancelMachineForwards(machineId).finally(() => {
      if (this.forwardCleanupInflight.get(machineId) === cleanup) this.forwardCleanupInflight.delete(machineId)
    })
    this.forwardCleanupInflight.set(machineId, cleanup)
    return cleanup
  }

  private async performCancelMachineForwards(machineId: string): Promise<void> {
    const prefix = `${machineId}:`
    // Drain this machine's in-flight forward establishes FIRST: an establish
    // that completed AFTER the registry sweep below would insert a listener
    // into the shared master that nothing ever cancels — the same permanent
    // strand this method exists to prevent. Awaiting settle (failures ignored)
    // makes the sweep see every forward that will ever exist. Each establish is
    // already wall-clock-bounded (master + control timeouts), so this cannot
    // hang shutdown indefinitely.
    for (const [key, inflight] of [...this.forwardInflight]) {
      if (!key.startsWith(prefix)) continue
      await inflight.then(
        () => {},
        () => {}
      )
    }
    for (const [key, inflight] of [...this.forwardRepairInflight]) {
      if (!key.startsWith(prefix)) continue
      await inflight.then(
        () => {},
        () => {}
      )
    }

    for (const key of [...this.forwards.keys()]) {
      if (!key.startsWith(prefix)) continue
      const remotePort = Number(key.slice(prefix.length))
      try {
        await this.removeForwardById(machineId, remotePort)
      } catch {
        // Routine shutdown must not hang or forget a possibly-live listener.
        // The retained registry/uncertainty fence permits a later exact cleanup
        // or proven master death to settle the outcome safely.
      }
    }
  }

  endpointFor(machineId: string, remotePort: number): string | null {
    const localPort = this.forwards.get(`${machineId}:${remotePort}`)
    return localPort === undefined ? null : `http://127.0.0.1:${localPort}`
  }

  async checkHealth(machineId: string): Promise<boolean> {
    const record = this.masters.get(machineId)
    if (!record) return false
    const alive = await this.isMasterAlive(record)
    // A dead master's forwards point at dead local ports and its reverses at dead
    // server-side listeners — purge both so `endpointFor`/`reverseFor` correctly
    // report the machine as having no live tunnels.
    if (!alive) {
      this.purgeForwards(machineId)
      this.purgeReverses(machineId)
    }
    return alive
  }

  /**
   * Genuine machine teardown (delete/park): `-O exit` the machine's shared
   * ControlMaster and forget every registry entry for it.
   *
   * Deliberately does NOT depend on this process holding an in-memory master
   * record — that's the UNcommon case for a delete: the api process serves
   * DELETE while the worker establishes most masters, and after any restart the
   * map is empty even though the orphan master (and its `-R` reverse listener
   * from the now-untrusted host into core's API port) survives on disk. The
   * ControlPath is deterministic, so with no record one is built from the
   * `Machine` row and the `-O exit` is issued unconditionally; an absent/stale
   * socket just makes it fail harmlessly (best-effort, as ever).
   */
  async closeMachine(machine: Machine): Promise<void> {
    let record = this.masters.get(machine.id)
    if (!record) {
      try {
        record = {
          host: machine.sshHost,
          port: machine.sshPort,
          user: machine.sshUser,
          socketPath: this.socketPathFor(machine.id),
        }
      } catch {
        // Socket path over the byte limit → no master can ever have bound it;
        // nothing to exit, but still forget any registry remnants below.
      }
    }
    await this.exitAndForget(machine.id, record)
  }

  /** `-O exit` (best-effort) a master record and drop all registry state for the machine. */
  private async exitAndForget(machineId: string, record: MasterRecord | undefined): Promise<void> {
    let quarantined = false
    if (record) {
      quarantined = await access(this.quarantinePath(record)).then(
        () => true,
        () => false
      )
      if (quarantined) {
        await this.runControl(record, 'exit')
        if (await this.isMasterAlive(record).catch(() => true)) {
          throw new TunnelOutcomeUnknownError(`could not prove quarantined ssh master death for ${machineId}`)
        }
        await unlink(this.quarantinePath(record))
      } else {
        try {
          const exited = await this.runControl(record, 'exit')
          if (exited.exitCode === 0 && !(await this.isMasterAlive(record))) await this.clearForwardDebts(record)
        } catch {
          // Without proof of death, durable exact-listener debt must survive.
        }
      }
    }
    this.masters.delete(machineId)
    this.taintedMachines.delete(machineId)
    for (const key of [...this.uncertainForwards.keys()])
      if (key.startsWith(`${machineId}:`)) this.uncertainForwards.delete(key)
    this.purgeForwards(machineId)
    this.purgeReverses(machineId)
  }

  /**
   * TEST-TEARDOWN ONLY: `-O exit` every master this manager knows about.
   * Production code must NEVER call this — routine process shutdown goes
   * through {@link cancelMachineForwards} (the master is shared across core
   * processes and carries the boxes' reverse-tunnel callbacks), and genuine
   * per-machine teardown (delete/park) uses {@link closeMachine}. Kept solely
   * so tests that spin up real/fake masters can tear them down.
   */
  async stop(): Promise<void> {
    for (const [machineId, record] of [...this.masters]) {
      await this.exitAndForget(machineId, record)
    }
  }
}

/** Process singleton, like other per-process managers in this repo. */
export const machineTunnels = new MachineTunnelManager()
