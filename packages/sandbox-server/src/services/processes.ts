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
import { readdirSync, readFileSync } from 'fs'
// Type-only: the server bundle must not pull in @ficus/shared's runtime.
import type {
  SandboxContainer,
  SandboxContainers,
  SandboxPressure,
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
}

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

/** Load and memory for health checks. Cheap: three small /proc reads. Null off Linux. */
export function readPressure(procRoot = '/proc'): BoxPressure | null {
  const loadavg = read(`${procRoot}/loadavg`)
  const meminfo = read(`${procRoot}/meminfo`)
  const cpuinfo = read(`${procRoot}/cpuinfo`)
  if (!loadavg || !meminfo) return null
  const [one, five, fifteen] = loadavg.split(/\s+/).map(Number)
  const kb = (key: string) => Number(meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0)
  const cpus = cpuinfo ? (cpuinfo.match(/^processor\s*:/gm)?.length ?? 0) : 0
  return {
    cpus: cpus || 1,
    load: [one ?? 0, five ?? 0, fifteen ?? 0],
    memTotalMb: Math.round(kb('MemTotal') / 1024),
    memAvailableMb: Math.round(kb('MemAvailable') / 1024),
  }
}

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

/** The server, the processes above it, and the user manager must never be signalled. */
function protectedPids(procRoot: string, selfPid: number, samples: Map<number, StatSample>): Set<number> {
  const pids = new Set<number>([selfPid])
  let current = readStat(procRoot, selfPid)
  for (let depth = 0; current && current.ppid > 1 && depth < 64; depth++) {
    pids.add(current.ppid)
    current = readStat(procRoot, current.ppid)
  }
  for (const sample of samples.values())
    if (sample.comm === 'systemd' || sample.comm === '(sd-pam)') pids.add(sample.pid)
  return pids
}

/**
 * The box user's processes by current CPU. Two samples `sampleMs` apart give
 * current use; the cumulative figure `ps` reports is a lifetime average, which
 * makes an idle long-running process look busy and hides a fresh runaway.
 */
export async function listBoxProcesses(
  opts: ProcOptions & { sampleMs?: number; limit?: number } = {}
): Promise<BoxProcess[]> {
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
  const first = sample()
  if (sampleMs > 0) await new Promise((resolve) => setTimeout(resolve, sampleMs))
  const second = sample()
  const uptimeSeconds = Number(read(`${procRoot}/uptime`)?.split(' ')[0] ?? 0)
  const guarded = protectedPids(procRoot, selfPid, second)

  const processes: BoxProcess[] = []
  for (const current of second.values()) {
    const before = first.get(current.pid)
    const deltaTicks = before && before.startTicks === current.startTicks ? current.ticks - before.ticks : 0
    const cpuPercent = sampleMs > 0 ? (deltaTicks / ticksPerSecond / (sampleMs / 1_000)) * 100 : 0
    processes.push({
      pid: current.pid,
      ppid: current.ppid,
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      memRssMb: rssMb(procRoot, current.pid),
      ageSeconds: Math.max(0, Math.round(uptimeSeconds - current.startTicks / ticksPerSecond)),
      state: current.state,
      command: commandLine(procRoot, current),
      protected: guarded.has(current.pid),
    })
  }
  processes.sort((a, b) => b.cpuPercent - a.cpuPercent || b.memRssMb - a.memRssMb || a.pid - b.pid)
  return processes.slice(0, opts.limit ?? 200)
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
  if (protectedPids(procRoot, selfPid, new Map([[pid, stat]])).has(pid)) {
    throw new BoxProcessError(`Process ${pid} runs this box and cannot be signalled`, 403)
  }
  const command = commandLine(procRoot, stat)
  ;(opts.kill ?? process.kill)(pid, `SIG${name}` as NodeJS.Signals)
  return { pid, signal: name as BoxProcessSignal, command }
}

type DockerRunner = (args: string[], timeoutMs: number) => Promise<string>

const runDocker: DockerRunner = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile('docker', args, { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
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
