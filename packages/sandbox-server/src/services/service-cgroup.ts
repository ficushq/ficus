import { open } from 'node:fs/promises'
import { posix } from 'node:path'

const MAX_CONTROL_FILE_BYTES = 64 * 1024

type ReadTextFile = (path: string) => Promise<string>

async function readBoundedControlFile(path: string): Promise<string> {
  const handle = await open(path, 'r')
  const buffer = Buffer.allocUnsafe(MAX_CONTROL_FILE_BYTES + 1)
  let offset = 0
  try {
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null)
      if (bytesRead === 0) break
      offset += bytesRead
    }
  } finally {
    await handle.close()
  }
  if (offset > MAX_CONTROL_FILE_BYTES) throw new Error('cgroup control file exceeded size limit')
  return buffer.subarray(0, offset).toString('utf8')
}

function validateControlFile(content: string): string {
  if (Buffer.byteLength(content) > MAX_CONTROL_FILE_BYTES) throw new Error('cgroup control file exceeded size limit')
  return content
}

function validateAbsoluteCgroupPath(path: string): string {
  if (
    !path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.includes(' (deleted)') ||
    posix.normalize(path) !== path
  )
    throw new Error('invalid cgroup path')
  return path
}

/** The ExecStart switch box-provision.sh bakes into every sandbox unit. */
export const SERVICE_CGROUP_ARG = '--service-cgroup'

/**
 * Whether this server runs inside its pinned systemd service cgroup
 * (`Delegate=no`, `ExitType=main`, `KillMode=control-group`) and therefore
 * must run the residual-child census before an idle exit.
 *
 * The AUTHORITATIVE signal is the ExecStart argv switch: host.env and
 * server.env are systemd `EnvironmentFile=` inputs, and `EnvironmentFile=`
 * content replaces `Environment=` values regardless of unit order
 * (the systemd.exec man page), so ANY `EXECUTOR_SERVICE_CGROUP` value those configurable
 * files carry — hostile, empty, or merely mistaken — defeats an
 * environment-only marker while `KillMode=control-group` still kills the
 * uncounted children at service exit. argv belongs to the root-installed
 * unit, and environment files cannot override it.
 *
 * The legacy `EXECUTOR_SERVICE_CGROUP === '1'` check remains ONLY as a
 * transitional fallback for units provisioned before the flag existed
 * (their `Environment=` line survives until the next re-provision, and a
 * bundle can roll out ahead of a box's unit rewrite). It can re-affirm the
 * census for such a unit but can never defeat the flag.
 */
export function isServiceCgroupManaged(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return argv.includes(SERVICE_CGROUP_ARG) || env.EXECUTOR_SERVICE_CGROUP === '1'
}

/** Parse the single cgroup-v2 membership row from /proc/self/cgroup. */
export function parseUnifiedCgroupPath(content: string): string {
  const rows = validateControlFile(content).split('\n').filter(Boolean)
  const unified = rows.filter((row) => row.startsWith('0::'))
  if (rows.length !== 1 || unified.length !== 1) throw new Error('expected one unified cgroup row')
  return validateAbsoluteCgroupPath(unified[0]!.slice(3))
}

/** Resolve cgroup.procs through the cgroup2 mount root recorded in mountinfo. */
export function resolveCgroupProcsPath(mountinfo: string, cgroupPath: string): string {
  validateAbsoluteCgroupPath(cgroupPath)
  const resolved = new Set<string>()
  for (const row of validateControlFile(mountinfo).split('\n').filter(Boolean)) {
    const separator = row.indexOf(' - ')
    if (separator < 0 || row.slice(separator + 3).split(' ')[0] !== 'cgroup2') continue
    const fields = row.slice(0, separator).split(' ')
    if (fields.length < 5) continue
    const root = validateAbsoluteCgroupPath(fields[3]!)
    const mountpoint = validateAbsoluteCgroupPath(fields[4]!)
    const underRoot = root === '/' || cgroupPath === root || cgroupPath.startsWith(`${root}/`)
    if (!underRoot) continue
    const relative = root === '/' ? cgroupPath.slice(1) : cgroupPath.slice(root.length).replace(/^\//, '')
    const candidate = posix.join(mountpoint, relative, 'cgroup.procs')
    if (candidate !== mountpoint && !candidate.startsWith(`${mountpoint}/`)) throw new Error('invalid cgroup path')
    resolved.add(candidate)
  }
  if (resolved.size !== 1) throw new Error('expected one applicable cgroup2 mount')
  return [...resolved][0]!
}

export async function countOwnServiceCgroupChildren(
  options: {
    selfPid?: number
    platform?: NodeJS.Platform
    readFile?: ReadTextFile
  } = {}
): Promise<number> {
  const platform = options.platform ?? process.platform
  if (platform !== 'linux') throw new Error('service cgroup census requires Linux')
  const selfPid = options.selfPid ?? process.pid
  if (!Number.isSafeInteger(selfPid) || selfPid <= 1) throw new Error('invalid server process id')
  const readFile = options.readFile ?? readBoundedControlFile
  const cgroupPath = parseUnifiedCgroupPath(await readFile('/proc/self/cgroup'))
  const procsPath = resolveCgroupProcsPath(await readFile('/proc/self/mountinfo'), cgroupPath)
  const membersText = validateControlFile(await readFile(procsPath))
  const members = new Set<number>()
  for (const row of membersText.split('\n').filter(Boolean)) {
    if (!/^[1-9]\d*$/.test(row)) throw new Error('invalid cgroup member')
    const pid = Number(row)
    if (!Number.isSafeInteger(pid)) throw new Error('invalid cgroup member')
    members.add(pid)
  }
  if (!members.delete(selfPid)) throw new Error('server process missing from service cgroup')
  return members.size
}

/** Fixed warning: callers cannot accidentally interpolate sensitive process data. */
export function formatDetachedProcessWarning(count: number): string {
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error('invalid service cgroup child count')
  return `[sandbox] WARN: idle exit will terminate ${count} unsupported background ${
    count === 1 ? 'process' : 'processes'
  } in the box service cgroup`
}
