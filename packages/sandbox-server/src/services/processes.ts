/**
 * What a box is running, and a narrowly scoped way to stop it.
 *
 * The server runs as the box's own user, so everything here is confined to
 * that user by construction: it can list and signal only processes that user
 * owns, and it reaches only the box's own Docker daemon. On a vm box several
 * boxes share one machine, and a runaway job in one (a detached full
 * typecheck, a forgotten test database) can starve its own agents until every
 * turn fails; these views let an operator or the box's owner find and stop it
 * without machine access.
 */

import { execFile, execSync } from 'child_process'
import { basename } from 'path'
import { readdirSync, readFileSync } from 'fs'
// Type-only: the server bundle must not pull in @ficus/shared's runtime.
import type {
  SandboxContainer,
  SandboxContainers,
  SandboxPressure,
  SandboxBoxPressure,
  SandboxPressureAverages,
  SandboxProcess,
  SandboxProcessSignal,
} from '@ficus/shared'

export type BoxPressure = SandboxPressure
export type BoxProcess = SandboxProcess
export type BoxContainer = SandboxContainer
export type BoxContainers = SandboxContainers
export const BOX_PROCESS_SIGNALS = ['TERM', 'INT', 'KILL'] as const satisfies readonly SandboxProcessSignal[]
export type BoxProcessSignal = SandboxProcessSignal

/** A request the box refuses; `status` is the HTTP status to answer with. */
export class BoxProcessError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 504
  ) {
    super(message)
    this.name = 'BoxProcessError'
  }
}

export interface ProcOptions {
  procRoot?: string
  uid?: number
  selfPid?: number
  clockTicks?: number
  cgroupRoot?: string
  now?: () => number
}

export const DOCKER_HEALTH_TIMEOUT_MS = 2_000
const DOCKER_TIMEOUT_MS = 15_000
const CONTAINER_STOP_TIMEOUT_MS = 40_000

let cachedClockTicks: number | undefined
function clockTicks(): number {
  if (cachedClockTicks === undefined) {
    try {
      cachedClockTicks = Number(execSync('getconf CLK_TCK', { encoding: 'utf-8', timeout: 2_000 }).trim()) || 100
    } catch {
      cachedClockTicks = 100
    }
  }
  return cachedClockTicks
}

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

/** Host load/memory and local PSI. CPU usage requires two samples. Null off Linux. */
export function readPressure(procRoot = '/proc', opts: ProcOptions = {}): BoxPressure | null {
  const loadavg = read(`${procRoot}/loadavg`)
  const meminfo = read(`${procRoot}/meminfo`)
  const cpuinfo = read(`${procRoot}/cpuinfo`)
  if (!loadavg || !meminfo) return null
  const [one, five, fifteen] = loadavg.split(/\s+/).map(Number)
  const kb = (key: string) => Number(meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0)
  const cpus = cpuinfo ? (cpuinfo.match(/^processor\s*:/gm)?.length ?? 0) : 0
  return {
    box: readBoxPressure(opts),
    cpus: cpus || 1,
    load: [one ?? 0, five ?? 0, fifteen ?? 0],
    memTotalMb: Math.round(kb('MemTotal') / 1024),
    memAvailableMb: Math.round(kb('MemAvailable') / 1024),
  }
}

/** Read only the box user's aggregate, never the host root or another user's slice. */
function slicePath(opts: ProcOptions): string {
  const uid = opts.uid ?? process.getuid?.() ?? -1
  return `${opts.cgroupRoot ?? '/sys/fs/cgroup'}/user.slice/user-${uid}.slice`
}

function pressureSome(path: string): SandboxPressureAverages | null {
  const line = read(path)
    ?.split('\n')
    .find((line) => line.startsWith('some '))
  if (!line) return null
  const average = (key: string) => {
    const raw = line.match(new RegExp(`(?:^| )${key}=([0-9]+(?:\\.[0-9]+)?)(?: |$)`))?.[1]
    return raw === undefined ? NaN : Number(raw)
  }
  const [avg10, avg60, avg300] = ['avg10', 'avg60', 'avg300'].map(average)
  if (![avg10, avg60, avg300].every((n) => n !== undefined && Number.isFinite(n) && n >= 0 && n <= 100)) return null
  return { avg10: avg10!, avg60: avg60!, avg300: avg300! }
}

function readBoxPressure(opts: ProcOptions): SandboxBoxPressure {
  const slice = slicePath(opts)
  return {
    cpuPercent: null,
    sampleMs: null,
    cpuPressureSome: pressureSome(`${slice}/cpu.pressure`),
    memoryPressureSome: pressureSome(`${slice}/memory.pressure`),
  }
}

function cpuUsage(opts: ProcOptions): number | null {
  const value = read(`${slicePath(opts)}/cpu.stat`)?.match(/^usage_usec (\d+)$/m)?.[1]
  const usage = value === undefined ? NaN : Number(value)
  return Number.isSafeInteger(usage) && usage >= 0 ? usage : null
}

function sampledPressure(opts: ProcOptions, before: number | null, elapsedMs: number): BoxPressure | null {
  const pressure = readPressure(opts.procRoot, opts)
  const after = cpuUsage(opts)
  if (pressure?.box && before !== null && after !== null && after >= before && elapsedMs > 0 && elapsedMs <= 30_000) {
    const cpuPercent = (after - before) / (elapsedMs * 10)
    pressure.box.cpuPercent = Math.round(cpuPercent * 10) / 10
    pressure.box.sampleMs = elapsedMs
  }
  return pressure
}

/** Demand-driven sampling never delays health/liveness or creates a poll loop.
 * Cache for 5s; a CPU sample older than 30s is explicitly unavailable.
 */
export class BoxPressureSampler {
  private checking?: Promise<void>
  private cached?: BoxPressure | null
  private sampledAt = -Infinity
  private readonly now: () => number

  constructor(private readonly opts: ProcOptions & { sampleMs?: number } = {}) {
    this.now = opts.now ?? (() => performance.now())
  }

  snapshot(): BoxPressure | null {
    return this.cached && this.now() - this.sampledAt <= 30_000
      ? this.cached
      : readPressure(this.opts.procRoot, this.opts)
  }

  refresh(): Promise<void> {
    if (this.checking) return this.checking
    if (this.now() - this.sampledAt < 5_000) return Promise.resolve()
    const start = this.now()
    const usage = cpuUsage(this.opts)
    this.checking = new Promise<void>((resolve) => setTimeout(resolve, this.opts.sampleMs ?? 1_000))
      .then(() => {
        this.cached = sampledPressure(this.opts, usage, this.now() - start)
        this.sampledAt = this.now()
      })
      .finally(() => {
        this.checking = undefined
      })
    return this.checking
  }
}

export const boxPressureSampler = new BoxPressureSampler()

interface StatSample {
  pid: number
  ppid: number
  state: string
  comm: string
  ticks: number
  startTicks: number
}

function readStat(procRoot: string, pid: number): StatSample | null {
  const stat = read(`${procRoot}/${pid}/stat`)
  if (!stat) return null
  // `comm` is parenthesized and may itself contain spaces or parentheses.
  const open = stat.indexOf('(')
  const close = stat.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const rest = stat.slice(close + 2).split(' ')
  return {
    pid,
    comm: stat.slice(open + 1, close),
    state: rest[0] ?? '?',
    ppid: Number(rest[1]),
    ticks: Number(rest[11]) + Number(rest[12]),
    startTicks: Number(rest[19]),
  }
}

function ownerUid(procRoot: string, pid: number): number | null {
  const status = read(`${procRoot}/${pid}/status`)
  const uid = status?.match(/^Uid:\s+(\d+)/m)?.[1]
  return uid === undefined ? null : Number(uid)
}

function rssMb(procRoot: string, pid: number): number {
  const kb = read(`${procRoot}/${pid}/status`)?.match(/^VmRSS:\s+(\d+)/m)?.[1]
  return kb ? Math.round(Number(kb) / 1024) : 0
}

function commandLine(procRoot: string, sample: StatSample): string {
  const cmdline = read(`${procRoot}/${sample.pid}/cmdline`)
  const joined = cmdline?.split('\0').filter(Boolean).join(' ')
  return (joined || `[${sample.comm}]`).slice(0, 500)
}

function ownedPids(procRoot: string, uid: number): number[] {
  let entries: string[]
  try {
    entries = readdirSync(procRoot)
  } catch {
    return []
  }
  return entries
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .filter((pid) => ownerUid(procRoot, pid) === uid)
}

type ProtectionReason = NonNullable<BoxProcess['protectionReason']>

function cgroupPaths(procRoot: string, pid: number): string[] {
  return (read(`${procRoot}/${pid}/cgroup`) ?? '').split('\n').flatMap((line) => {
    const match = line.match(/^\d+:[^:]*:(\/.*)$/)
    return match ? [match[1]!] : []
  })
}

function unitProtection(procRoot: string, pid: number): ProtectionReason | undefined {
  const units = cgroupPaths(procRoot, pid).flatMap((path) => path.split('/'))
  if (units.includes('docker.service')) return 'Docker runtime'
  if (units.includes('dbus.service')) return 'Session bus'
  if (units.some((unit) => /^(?:ficus-sandbox-server|ficus-box-[\w-]+)(?:-proxy\.service|\.socket)$/.test(unit)))
    return 'Box listener'
  // Server service membership alone is insufficient: bash/test/build inherit it.
  const argv = read(`${procRoot}/${pid}/cmdline`)?.split('\0').filter(Boolean) ?? []
  if (
    basename(argv[0] ?? '') === 'systemd-socket-proxyd' &&
    units.some((unit) => /^(?:ficus-sandbox-server|ficus-box-[\w-]+)\.service$/.test(unit))
  )
    return 'Box listener'
  return undefined
}

/** Fresh role/cgroup proof, not process display names or all descendants. */
function protectionReason(
  procRoot: string,
  uid: number,
  selfPid: number,
  sample: StatSample
): ProtectionReason | undefined {
  if (sample.pid === selfPid) return 'Runs the sandbox'
  let ancestor = readStat(procRoot, selfPid)
  for (let depth = 0; ancestor && ancestor.ppid > 1 && depth < 64; depth++) {
    if (ancestor.ppid === sample.pid) return 'Runs the sandbox'
    ancestor = readStat(procRoot, ancestor.ppid)
  }
  const direct = unitProtection(procRoot, sample.pid)
  if (direct) return direct
  const argv = read(`${procRoot}/${sample.pid}/cmdline`)?.split('\0').filter(Boolean) ?? []
  const executable = basename(argv[0] ?? '')
  const managerCgroup = (pid: number) =>
    cgroupPaths(procRoot, pid).some((path) => path.endsWith(`/user@${uid}.service/init.scope`))
  if (executable === 'systemd' && argv.includes('--user') && managerCgroup(sample.pid)) return 'Runs the sandbox'
  if (sample.comm === '(sd-pam)' && ownerUid(procRoot, sample.ppid) === uid) {
    const parentArgv = read(`${procRoot}/${sample.ppid}/cmdline`)?.split('\0') ?? []
    if (basename(parentArgv[0] ?? '') === 'systemd' && parentArgv.includes('--user') && managerCgroup(sample.ppid))
      return 'Runs the sandbox'
  }
  // Helpers may escape docker.service into sibling scopes. Require both a
  // helper role and a same-owner ancestry anchored in the runtime unit.
  if (!/^(?:dockerd|rootlesskit|slirp4netns|docker-proxy|containerd|containerd-shim(?:-[\w-]+)?)$/.test(executable))
    return undefined
  let parent = sample.ppid
  const seen = new Set<number>([sample.pid])
  for (let depth = 0; parent > 1 && !seen.has(parent) && depth < 64; depth++) {
    seen.add(parent)
    if (ownerUid(procRoot, parent) !== uid) break
    if (unitProtection(procRoot, parent) === 'Docker runtime') return 'Docker runtime'
    const stat = readStat(procRoot, parent)
    if (!stat) break
    parent = stat.ppid
  }
  return undefined
}

/**
 * The box user's processes by current CPU. Two samples `sampleMs` apart give
 * current use; the cumulative figure `ps` reports is a lifetime average, which
 * makes an idle long-running process look busy and hides a fresh runaway.
 */
export async function listBoxProcessSnapshot(
  opts: ProcOptions & { sampleMs?: number; limit?: number } = {}
): Promise<{ processes: BoxProcess[]; pressure: BoxPressure | null }> {
  const procRoot = opts.procRoot ?? '/proc'
  const uid = opts.uid ?? process.getuid?.() ?? -1
  const selfPid = opts.selfPid ?? process.pid
  const ticksPerSecond = opts.clockTicks ?? clockTicks()
  const sampleMs = opts.sampleMs ?? 1_000

  const sample = () => {
    const samples = new Map<number, StatSample>()
    for (const pid of ownedPids(procRoot, uid)) {
      const stat = readStat(procRoot, pid)
      if (stat) samples.set(pid, stat)
    }
    return samples
  }
  const now = opts.now ?? (() => performance.now())
  const started = now()
  const usage = cpuUsage(opts)
  const first = sample()
  if (sampleMs > 0) await new Promise((resolve) => setTimeout(resolve, sampleMs))
  const elapsedMs = now() - started
  const pressure = sampledPressure(opts, usage, elapsedMs)
  const second = sample()
  const uptimeSeconds = Number(read(`${procRoot}/uptime`)?.split(' ')[0] ?? 0)

  const processes: BoxProcess[] = []
  for (const current of second.values()) {
    const before = first.get(current.pid)
    const deltaTicks = before && before.startTicks === current.startTicks ? current.ticks - before.ticks : 0
    const cpuPercent = elapsedMs > 0 ? (deltaTicks / ticksPerSecond / (elapsedMs / 1_000)) * 100 : 0
    const reason = protectionReason(procRoot, uid, selfPid, current)
    processes.push({
      pid: current.pid,
      ppid: current.ppid,
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      memRssMb: rssMb(procRoot, current.pid),
      ageSeconds: Math.max(0, Math.round(uptimeSeconds - current.startTicks / ticksPerSecond)),
      state: current.state,
      command: commandLine(procRoot, current),
      protected: !!reason,
      ...(reason ? { protectionReason: reason } : {}),
    })
  }
  processes.sort((a, b) => b.cpuPercent - a.cpuPercent || b.memRssMb - a.memRssMb || a.pid - b.pid)
  return { processes: processes.slice(0, opts.limit ?? 200), pressure }
}

export async function listBoxProcesses(
  opts: ProcOptions & { sampleMs?: number; limit?: number } = {}
): Promise<BoxProcess[]> {
  return (await listBoxProcessSnapshot(opts)).processes
}

/** Detached runc exec only starts the container process; it must not take five minutes. */
export const STALE_RUNC_EXEC_SECONDS = 5 * 60

/**
 * Only detached exec is a control-path deadline. A foreground `runc exec` waits
 * for its workload and may legitimately run for hours. Never signal either.
 * Use argv, not the truncated display command, and never inspect another UID.
 */
export function staleRuncExecReason(opts: ProcOptions = {}): string | undefined {
  const procRoot = opts.procRoot ?? '/proc'
  const uid = opts.uid ?? process.getuid?.() ?? -1
  const uptime = Number(read(`${procRoot}/uptime`)?.split(' ')[0])
  if (!Number.isFinite(uptime)) return undefined
  const hz = opts.clockTicks ?? clockTicks()
  for (const pid of ownedPids(procRoot, uid)) {
    const sample = readStat(procRoot, pid)
    if (!sample || !Number.isFinite(sample.startTicks) || uptime - sample.startTicks / hz < STALE_RUNC_EXEC_SECONDS)
      continue
    const argv = read(`${procRoot}/${pid}/cmdline`)?.split('\0').filter(Boolean) ?? []
    if (!['runc', 'docker-runc'].includes(basename(argv[0] ?? ''))) continue
    // Find the subcommand after global options, not a container named "exec".
    let exec = 1
    while (argv[exec]?.startsWith('-')) {
      if (['--root', '--log', '--log-format', '--rootless', '--criu'].includes(argv[exec]!)) exec++
      exec++
    }
    if (argv[exec] !== 'exec') continue
    // Stop at the container positional argument: workload flags are not runc flags.
    for (let i = exec + 1; i < argv.length; i++) {
      const arg = argv[i]!
      if (arg === '-d' || arg === '--detach' || arg === '--detach=true') {
        return `Detached runc exec has been stuck for at least ${STALE_RUNC_EXEC_SECONDS}s`
      }
      if (!arg.startsWith('-')) break
      if (
        [
          '--console-socket',
          '--cwd',
          '--env',
          '-e',
          '--user',
          '-u',
          '--additional-gids',
          '-g',
          '--process',
          '-p',
          '--pid-file',
          '--apparmor',
          '--cap',
          '-c',
          '--process-label',
          '--preserve-fds',
        ].includes(arg)
      )
        i++
    }
  }
  return undefined
}

/** Signal one process the box user owns. Refuses anything else. */
export function signalBoxProcess(
  pid: unknown,
  signal: unknown,
  opts: ProcOptions & { kill?: (pid: number, signal: NodeJS.Signals) => void } = {}
): { pid: number; signal: BoxProcessSignal; command: string } {
  const procRoot = opts.procRoot ?? '/proc'
  const uid = opts.uid ?? process.getuid?.() ?? -1
  const selfPid = opts.selfPid ?? process.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) {
    throw new BoxProcessError('pid must be a process id greater than 1', 400)
  }
  const name = typeof signal === 'string' ? signal.toUpperCase() : 'TERM'
  if (!BOX_PROCESS_SIGNALS.includes(name as BoxProcessSignal)) {
    throw new BoxProcessError(`signal must be one of ${BOX_PROCESS_SIGNALS.join(', ')}`, 400)
  }
  const stat = readStat(procRoot, pid)
  const owner = ownerUid(procRoot, pid)
  if (!stat || owner === null) throw new BoxProcessError(`No process ${pid}`, 404)
  if (owner !== uid) throw new BoxProcessError(`Process ${pid} is not owned by this box`, 403)
  const reason = protectionReason(procRoot, uid, selfPid, stat)
  if (reason) throw new BoxProcessError(`Process ${pid}: ${reason}; cannot be signalled`, 403)
  const command = commandLine(procRoot, stat)
  // Revalidate identity/ownership after classification; never act on a recycled PID.
  const fresh = readStat(procRoot, pid)
  if (!fresh || fresh.startTicks !== stat.startTicks || ownerUid(procRoot, pid) !== uid) {
    throw new BoxProcessError(`Process ${pid} changed or exited; refresh the process list`, 404)
  }
  const freshReason = protectionReason(procRoot, uid, selfPid, fresh)
  if (freshReason) throw new BoxProcessError(`Process ${pid}: ${freshReason}; cannot be signalled`, 403)
  ;(opts.kill ?? process.kill)(pid, `SIG${name}` as NodeJS.Signals)
  return { pid, signal: name as BoxProcessSignal, command }
}

type DockerRunner = (args: string[], timeoutMs: number) => Promise<string>

const runDocker: DockerRunner = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      'docker',
      args,
      { encoding: 'utf-8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  })

function parseJsonLines(output: string): Record<string, string>[] {
  return output
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, string>]
      } catch {
        return []
      }
    })
}

function timedOut(error: unknown): boolean {
  const value = error as { killed?: boolean; signal?: string; code?: string }
  return value?.killed === true || value?.signal === 'SIGTERM' || value?.code === 'ETIMEDOUT'
}

/** Cheap async daemon probe; never blocks the executor's event loop. */
export async function probeBoxDocker(docker: DockerRunner = runDocker): Promise<void> {
  try {
    await docker(['info', '--format', '{{.ServerVersion}}'], DOCKER_HEALTH_TIMEOUT_MS)
  } catch (error) {
    throw new Error(
      timedOut(error)
        ? `Docker did not answer within ${DOCKER_HEALTH_TIMEOUT_MS / 1_000}s`
        : 'Docker is not available in this box'
    )
  }
}

/**
 * The box's containers with current CPU where Docker reports it. An agent box
 * runs no Docker; an unresponsive daemon is reported, not waited on.
 */
export async function listBoxContainers(docker: DockerRunner = runDocker): Promise<BoxContainers> {
  if (process.env.FICUS_SANDBOX_ROLE === 'agent') return { available: false, reason: 'This box runs no Docker' }
  try {
    const [ps, stats] = await Promise.all([
      docker(['ps', '-a', '--format', '{{json .}}'], DOCKER_TIMEOUT_MS),
      docker(['stats', '--no-stream', '--format', '{{json .}}'], DOCKER_TIMEOUT_MS).catch(() => ''),
    ])
    const usage = new Map(parseJsonLines(stats).map((row) => [row.ID?.slice(0, 12), row]))
    const containers = parseJsonLines(ps).map((row): BoxContainer => {
      const id = (row.ID ?? '').slice(0, 12)
      const stat = usage.get(id)
      const cpu = stat?.CPUPerc ? Number.parseFloat(stat.CPUPerc) : Number.NaN
      return {
        id,
        name: row.Names ?? '',
        image: row.Image ?? '',
        state: row.State ?? '',
        status: row.Status ?? '',
        ...(Number.isFinite(cpu) ? { cpuPercent: cpu } : {}),
        ...(stat?.MemUsage ? { memUsage: stat.MemUsage } : {}),
      }
    })
    return { available: true, containers }
  } catch (error) {
    return {
      available: false,
      reason: timedOut(error)
        ? `Docker did not answer within ${DOCKER_TIMEOUT_MS / 1_000}s`
        : 'Docker is not available in this box',
    }
  }
}

/** Stop one of the box's containers (graceful, then killed by Docker after 10s). */
export async function stopBoxContainer(id: unknown, docker: DockerRunner = runDocker): Promise<{ id: string }> {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)) {
    throw new BoxProcessError('id must be a container id or name', 400)
  }
  try {
    await docker(['stop', '-t', '10', id], CONTAINER_STOP_TIMEOUT_MS)
    return { id }
  } catch (error) {
    if (timedOut(error)) throw new BoxProcessError('Docker did not stop the container in time', 504)
    const stderr = String((error as { stderr?: unknown }).stderr ?? '')
    if (/no such container/i.test(stderr)) throw new BoxProcessError(`No container ${id}`, 404)
    throw error
  }
}
