/**
 * Workload cgroups: keep the commands a box runs apart from the box's own
 * sandbox server, so systemd-oomd can end a runaway command without ending
 * the server, and so the agent hears which command was killed and why.
 *
 * box-provision.sh delegates the server unit (`Delegate=yes`) and has systemd
 * start the server in the `supervisor` subgroup (`DelegateSubgroup=supervisor`).
 * The unit carries `ManagedOOMMemoryPressure=kill`, so under sustained memory
 * pressure systemd-oomd SIGKILLs the leaf cgroup below the unit that is
 * reclaiming the most. This module, at server start:
 *   1. enables the memory and pids controllers below the unit (oomd ignores a
 *      candidate without memory accounting),
 *   2. marks `supervisor` with the `user.oomd_omit` xattr, which oomd honors for
 *      a cgroup owned by the same user as the monitored unit (both are the box
 *      user's under delegation), so the server itself is never a candidate,
 *   3. creates `workload/`, into which every bash invocation is moved, each in
 *      its own `inv-<invocation id>` leaf, while it is still stopped in
 *      admission (bash.ts), before it runs anything.
 *
 * Layout under the server unit's cgroup:
 *   supervisor/          the server (user.oomd_omit=1)
 *   workload/inv-<id>/   one bash invocation and everything it starts,
 *                        including background dev servers
 *
 * oomd counts every kill in the `user.oomd_ooms` xattr of the cgroup it
 * killed, and the kernel counts its own OOM kills (the box reaching MemoryMax)
 * in `memory.events`. Those counters name the kill: as the invocation's
 * terminal error when it is still attached, otherwise as a notice prepended to
 * the next command's output.
 *
 * Everything is fail-open: off Linux, on k8s/docker sandboxes, and on units
 * provisioned before delegation the server runs commands in its own cgroup
 * exactly as before.
 */

import { mkdir, open, readdir, rmdir, writeFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { parseUnifiedCgroupPath, resolveCgroupProcsPath } from './service-cgroup'

const MAX_CONTROL_FILE_BYTES = 64 * 1024

/** The subgroup box-provision.sh's `DelegateSubgroup=` starts the server in. */
export const SUPERVISOR_SUBGROUP = 'supervisor'
export const WORKLOAD_SUBGROUP = 'workload'
/** The xattr systemd-oomd reads to skip a candidate entirely. */
export const OOMD_OMIT_XATTR = 'user.oomd_omit'
/** The xattr systemd-oomd increments on every cgroup it kills. */
export const OOMD_KILL_COUNT_XATTR = 'user.oomd_ooms'
const WORKLOAD_CONTROLLERS = ['memory', 'pids'] as const
/** Longest command excerpt carried into a kill notice. */
const COMMAND_SUMMARY_LENGTH = 120

export interface WorkloadCgroupBackend {
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  mkdir(path: string): Promise<void>
  rmdir(path: string): Promise<void>
  readdir(path: string): Promise<string[]>
  setXattr(path: string, name: string, value: string): void
  /** The xattr value, or undefined when it is not set. */
  getXattr(path: string, name: string): string | undefined
}

/** How a workload leaf's processes were killed for memory, if they were. */
export interface WorkloadKills {
  /** Times systemd-oomd killed this leaf (sustained memory pressure). */
  oomd: number
  /** Processes the kernel OOM killer took from it (the box reached its MemoryMax). */
  kernel: number
}

const NO_KILLS: WorkloadKills = { oomd: 0, kernel: 0 }

/** The terminal error for an invocation whose own processes were killed for memory. */
export function workloadKillMessage(kills: WorkloadKills): string | undefined {
  if (kills.oomd > 0)
    return (
      'Killed by systemd-oomd: this box was under sustained memory pressure and this command was using ' +
      'the most memory, so its processes were stopped to protect the box and its neighbors. ' +
      'Run it again with less memory (fewer parallel jobs, a smaller build or test scope), and stop dev ' +
      'servers and test databases you no longer need.'
    )
  if (kills.kernel > 0)
    return (
      `Killed by the kernel OOM killer: this box reached its memory limit and ${kills.kernel} ` +
      `${kills.kernel === 1 ? 'process' : 'processes'} of this command were stopped. ` +
      'Run it again with less memory, and stop dev servers and test databases you no longer need.'
    )
  return undefined
}

/** A single-line, bounded excerpt of a command for kill notices. */
export function summarizeCommand(command: string): string {
  const line = command.trim().split('\n', 1)[0]!.replace(/\s+/g, ' ')
  return line.length > COMMAND_SUMMARY_LENGTH ? `${line.slice(0, COMMAND_SUMMARY_LENGTH - 1)}…` : line
}

function parseKernelOomKills(events: string): number {
  const match = /^oom_kill (\d+)$/m.exec(events)
  return match ? Number(match[1]) : 0
}

function parseCount(value: string | undefined): number {
  if (!value) return 0
  const count = Number(value.replace(/\0+$/, '').trim())
  return Number.isSafeInteger(count) && count > 0 ? count : 0
}

function leafName(invocationId: string): string | undefined {
  return /^[A-Za-z0-9_-]{1,128}$/.test(invocationId) ? `inv-${invocationId}` : undefined
}

interface TrackedLeaf {
  command: string
  reported: WorkloadKills
  /** Its invocation is still streaming: its kills are reported as its own error, not as a notice. */
  attached: boolean
}

export class WorkloadCgroups {
  private readonly tracked = new Map<string, TrackedLeaf>()
  private readonly pendingNotices: string[] = []

  private constructor(
    private readonly backend: WorkloadCgroupBackend,
    /** The workload subgroup's directory on the cgroup2 mount. */
    readonly workloadDir: string,
    private readonly log: (message: string) => void
  ) {}

  /**
   * Set up the layout when this server runs in a delegated `supervisor`
   * subgroup. Returns null (commands stay in the server's cgroup) otherwise.
   */
  static async initialize(
    options: {
      backend?: WorkloadCgroupBackend
      platform?: NodeJS.Platform
      log?: (message: string) => void
    } = {}
  ): Promise<WorkloadCgroups | null> {
    const log = options.log ?? ((message: string) => console.log(`[sandbox] ${message}`))
    if ((options.platform ?? process.platform) !== 'linux') return null
    try {
      const backend = options.backend ?? (await linuxCgroupBackend())
      const own = parseUnifiedCgroupPath(await backend.readFile('/proc/self/cgroup'))
      if (posix.basename(own) !== SUPERVISOR_SUBGROUP) {
        log('Workload cgroups: off (the server unit is not delegated; commands share its cgroup)')
        return null
      }
      const supervisorDir = posix.dirname(resolveCgroupProcsPath(await backend.readFile('/proc/self/mountinfo'), own))
      const unitDir = posix.dirname(supervisorDir)
      const available = (await backend.readFile(`${unitDir}/cgroup.controllers`)).split(/\s+/)
      const controllers = WORKLOAD_CONTROLLERS.filter((name) => available.includes(name))
      const enable = controllers.map((name) => `+${name}`).join(' ')
      if (enable) await backend.writeFile(`${unitDir}/cgroup.subtree_control`, enable)
      try {
        backend.setXattr(supervisorDir, OOMD_OMIT_XATTR, '1')
      } catch (error) {
        log(
          `WARN: could not mark the server cgroup ${OOMD_OMIT_XATTR}; systemd-oomd may consider it: ${errorMessage(error)}`
        )
      }
      const workloadDir = `${unitDir}/${WORKLOAD_SUBGROUP}`
      await backend.mkdir(workloadDir)
      if (enable) await backend.writeFile(`${workloadDir}/cgroup.subtree_control`, enable)
      log(`Workload cgroups: on (${controllers.join(', ') || 'no controllers'}; server omitted from systemd-oomd)`)
      return new WorkloadCgroups(backend, workloadDir, log)
    } catch (error) {
      log(`WARN: workload cgroups unavailable; commands share the server cgroup: ${errorMessage(error)}`)
      return null
    }
  }

  /**
   * Move a stopped, not yet running invocation into its own workload leaf.
   * Returns false (the command still runs, in the server's cgroup) on failure.
   */
  async place(pid: number, invocationId: string, command: string): Promise<boolean> {
    const name = leafName(invocationId)
    if (!name || !Number.isSafeInteger(pid) || pid <= 1) return false
    const leaf = `${this.workloadDir}/${name}`
    try {
      await this.backend.mkdir(leaf)
      await this.backend.writeFile(`${leaf}/cgroup.procs`, String(pid))
      this.tracked.set(name, { command: summarizeCommand(command), reported: NO_KILLS, attached: true })
      return true
    } catch (error) {
      this.log(`WARN: could not place invocation ${invocationId} in a workload cgroup: ${errorMessage(error)}`)
      return false
    }
  }

  /**
   * The memory kills of an invocation's leaf not yet reported. Marks them
   * reported, so a later sweep does not announce them again.
   */
  async takeInvocationKills(invocationId: string): Promise<WorkloadKills> {
    const name = leafName(invocationId)
    const entry = name ? this.tracked.get(name) : undefined
    if (!name || !entry) return NO_KILLS
    entry.attached = false
    const kills = await this.readKills(name)
    const fresh = {
      oomd: Math.max(0, kills.oomd - entry.reported.oomd),
      kernel: Math.max(0, kills.kernel - entry.reported.kernel),
    }
    entry.reported = kills
    return fresh
  }

  /**
   * Notices for kills of earlier invocations' leaves (background processes the
   * agent is no longer attached to), then removes leaves that are empty.
   * Returns the notices not yet delivered and clears them.
   */
  async takeNotices(): Promise<string[]> {
    let names: string[]
    try {
      names = (await this.backend.readdir(this.workloadDir)).filter((name) => name.startsWith('inv-'))
    } catch {
      names = []
    }
    for (const name of names) {
      const entry = this.tracked.get(name) ?? { command: '', reported: NO_KILLS, attached: false }
      if (entry.attached) continue
      const kills = await this.readKills(name)
      if (kills.oomd > entry.reported.oomd) {
        this.pendingNotices.push(
          `[ficus] systemd-oomd killed the processes started by an earlier command in this box ` +
            `(${entry.command ? `\`${entry.command}\`` : name}) because the box was under sustained memory ` +
            'pressure. Restart it only if you still need it.'
        )
      } else if (kills.kernel > entry.reported.kernel) {
        this.pendingNotices.push(
          `[ficus] The kernel OOM killer stopped ${kills.kernel - entry.reported.kernel} process(es) started by an ` +
            `earlier command in this box (${entry.command ? `\`${entry.command}\`` : name}) because the box reached ` +
            'its memory limit. Restart it only if you still need it.'
        )
      }
      entry.reported = kills
      this.tracked.set(name, entry)
      if (!(await this.populated(name))) {
        try {
          await this.backend.rmdir(`${this.workloadDir}/${name}`)
          this.tracked.delete(name)
        } catch {
          // A process joined or the leaf is already gone; the next sweep retries.
        }
      }
    }
    return this.pendingNotices.splice(0)
  }

  /** Processes in every workload leaf (for the idle-exit census). */
  async countProcesses(): Promise<number> {
    let count = 0
    for (const name of await this.backend.readdir(this.workloadDir)) {
      if (!name.startsWith('inv-')) continue
      const procs = await this.backend.readFile(`${this.workloadDir}/${name}/cgroup.procs`).catch(() => '')
      count += procs.split('\n').filter(Boolean).length
    }
    return count
  }

  private async readKills(name: string): Promise<WorkloadKills> {
    const dir = `${this.workloadDir}/${name}`
    let oomd: number
    try {
      oomd = parseCount(this.backend.getXattr(dir, OOMD_KILL_COUNT_XATTR))
    } catch {
      oomd = 0
    }
    const events = await this.backend.readFile(`${dir}/memory.events`).catch(() => '')
    return { oomd, kernel: parseKernelOomKills(events) }
  }

  private async populated(name: string): Promise<boolean> {
    const events = await this.backend.readFile(`${this.workloadDir}/${name}/cgroup.events`).catch(() => '')
    return !/^populated 0$/m.test(events)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readBounded(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(MAX_CONTROL_FILE_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

const ENODATA = 61

/** Real cgroupfs access. Node has no xattr API, so the two xattr calls go through libc. */
export async function linuxCgroupBackend(): Promise<WorkloadCgroupBackend> {
  const { dlopen, FFIType, ptr, read: readNative } = await import('bun:ffi')
  const libc = dlopen('libc.so.6', {
    setxattr: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.i32],
      returns: FFIType.i32,
    },
    getxattr: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
    __errno_location: { args: [], returns: FFIType.ptr },
  })
  // Keep every buffer in a local for the duration of the native call.
  const cstring = (value: string) => Buffer.from(`${value}\0`, 'utf8')
  const errno = () => readNative.i32(libc.symbols.__errno_location()!)
  return {
    readFile: readBounded,
    writeFile: (path, data) => writeFile(path, data),
    async mkdir(path) {
      await mkdir(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
    },
    rmdir: (path) => rmdir(path),
    readdir: (path) => readdir(path),
    setXattr(path, name, value) {
      const target = cstring(path)
      const key = cstring(name)
      const data = Buffer.from(value, 'utf8')
      const rc = libc.symbols.setxattr(ptr(target), ptr(key), ptr(data), data.length, 0)
      if (rc !== 0) throw new Error(`setxattr ${name} failed (errno ${errno()})`)
    },
    getXattr(path, name) {
      const target = cstring(path)
      const key = cstring(name)
      const data = Buffer.alloc(64)
      const size = Number(libc.symbols.getxattr(ptr(target), ptr(key), ptr(data), data.length))
      if (size < 0) {
        if (errno() === ENODATA) return undefined
        throw new Error(`getxattr ${name} failed (errno ${errno()})`)
      }
      return data.subarray(0, size).toString('utf8')
    },
  }
}
