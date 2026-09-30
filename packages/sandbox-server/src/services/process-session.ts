import { readFile, readdir } from 'node:fs/promises'
export interface ProcessIdentity {
  pid: number
  pgid: number
  sid: number
  state: string
  startToken: string
}
export interface ProcessSessionDriver {
  readIdentity(pid: number): Promise<ProcessIdentity | undefined>
  scanSessionIdentities(sid: number): Promise<ProcessIdentity[]>
  signal(target: number, signal: NodeJS.Signals | 0): void
  scanSession(sid: number): Promise<number[]>
  waitForExit(pid: number, graceMs: number): Promise<boolean>
  waitForSessionEmpty?(sid: number, graceMs: number): Promise<number[]>
  processGroup?(pid: number): Promise<number | undefined>
}
export interface DarwinBsdInfo {
  pid: number
  status: number
  reportedProcessGroup: number
  startSeconds: bigint
  startMicroseconds: bigint
}
export interface DarwinProcessNativeBackend {
  listPids(): Promise<number[]>
  readBsdInfo(pid: number): Promise<DarwinBsdInfo | undefined>
  getProcessGroup(pid: number): Promise<number>
  getSessionId(pid: number): Promise<number>
}
export class ProcessSessionCapabilityError extends Error {}
const DARWIN_STATUS: Readonly<Record<number, string>> = {
  1: 'I', // SIDL
  2: 'R', // SRUN
  3: 'S', // SSLEEP
  4: 'T', // SSTOP
  5: 'Z', // SZOMB
}
/**
 * Parse/validation failures carry code EINVALIDPROC so process-scan callers can
 * distinguish "this /proc entry is not an ownable process" (kernel threads have
 * pgid=0/sid=0, and a recycled or exotic pid can produce an unparseable stat)
 * from a real programming error. On VM machine hosts rootless boxes share the
 * HOST /proc, so kernel threads are always present in a scan — treating them as
 * fatal crash-looped every box server (2026-08-26 incident); the fail-safe
 * reading is "cannot validate → never signal it → skip it".
 */
function invalidProc(message: string): Error {
  return Object.assign(new Error(message), { code: 'EINVALIDPROC' })
}
export function isIgnorableProcScanError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'ENOENT' || code === 'ESRCH' || code === 'EINVALIDPROC'
}
function safePositive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalidProc(`invalid ${label}`)
  return value
}
function validateIdentity(identity: ProcessIdentity, label: string): ProcessIdentity {
  safePositive(identity.pid, `${label} PID`)
  safePositive(identity.pgid, `${label} PGID`)
  safePositive(identity.sid, `${label} SID`)
  if (!identity.state || !identity.startToken) throw invalidProc(`invalid ${label} state or start token`)
  return identity
}
export function parseProcStat(stat: string): ProcessIdentity & { startTicks: number } {
  const close = stat.lastIndexOf(')')
  const firstSpace = stat.indexOf(' ')
  if (close < 0 || firstSpace < 1 || close + 2 >= stat.length) throw invalidProc('invalid /proc stat')
  const fields = stat
    .slice(close + 2)
    .trim()
    .split(/\s+/)
  if (fields.length < 20) throw invalidProc('invalid /proc stat fields')
  const pid = Number(stat.slice(0, firstSpace))
  const state = fields[0] ?? ''
  const pgid = Number(fields[2])
  const sid = Number(fields[3])
  const startTicks = Number(fields[19])
  if (!Number.isSafeInteger(startTicks) || startTicks < 0) throw invalidProc('invalid /proc stat start token')
  return {
    ...validateIdentity({ pid, pgid, sid, state, startToken: `linux:${startTicks}` }, '/proc stat'),
    startTicks,
  }
}
/** Diagnostic-only parser. darwin-ps tokens must never authorize ownership or signaling. */
export function parseDarwinPs(output: string): ProcessIdentity[] {
  const found = new Map<number, ProcessIdentity>()
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line)
    if (!match) throw new Error('invalid Darwin ps identity row')
    const pid = Number(match[1])
    if (found.has(pid)) throw new Error('duplicate Darwin ps PID')
    found.set(
      pid,
      validateIdentity(
        {
          pid,
          pgid: Number(match[2]),
          sid: Number(match[3]),
          state: match[4]![0] ?? '',
          startToken: `darwin-ps:${match[5]!.trim()}`,
        },
        'Darwin ps identity'
      )
    )
  }
  return [...found.values()].sort((a, b) => a.pid - b.pid)
}
function darwinIdentity(info: DarwinBsdInfo, pgid: number, sid: number): ProcessIdentity {
  const state = DARWIN_STATUS[info.status]
  if (!state) throw new Error(`invalid Darwin process status ${info.status}`)
  if (info.startSeconds < 0n || info.startMicroseconds < 0n || info.startMicroseconds >= 1_000_000n) {
    throw new Error('invalid Darwin process start time')
  }
  return validateIdentity(
    {
      pid: info.pid,
      pgid,
      sid,
      state,
      startToken: `darwin:${info.startSeconds}:${info.startMicroseconds}`,
    },
    'Darwin native identity'
  )
}
function provenAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false
    throw error
  }
}
const PROC_PIDTBSDINFO = 3
const PROC_BSDINFO_SIZE = 136
const PROC_BSDINFO_STATUS_OFFSET = 4
const PROC_BSDINFO_PID_OFFSET = 12
const PROC_BSDINFO_PROCESS_GROUP_OFFSET = 100
const PROC_BSDINFO_START_SECONDS_OFFSET = 120
const PROC_BSDINFO_START_MICROSECONDS_OFFSET = 128
const DARWIN_PID_LIST_ATTEMPTS = 3
export function parseDarwinBsdInfo(buffer: Uint8Array, requestedPid: number): DarwinBsdInfo {
  if (buffer.byteLength !== PROC_BSDINFO_SIZE) {
    throw new ProcessSessionCapabilityError(
      `proc_bsdinfo buffer was ${buffer.byteLength}, expected ${PROC_BSDINFO_SIZE}`
    )
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const info = {
    pid: view.getUint32(PROC_BSDINFO_PID_OFFSET, true),
    status: view.getUint32(PROC_BSDINFO_STATUS_OFFSET, true),
    reportedProcessGroup: view.getUint32(PROC_BSDINFO_PROCESS_GROUP_OFFSET, true),
    startSeconds: view.getBigUint64(PROC_BSDINFO_START_SECONDS_OFFSET, true),
    startMicroseconds: view.getBigUint64(PROC_BSDINFO_START_MICROSECONDS_OFFSET, true),
  }
  if (info.pid !== requestedPid) throw new Error('Darwin proc_bsdinfo PID mismatch')
  safePositive(info.reportedProcessGroup, 'Darwin proc_bsdinfo PGID')
  return info
}
async function loadDarwinBackend(): Promise<DarwinProcessNativeBackend> {
  if (process.platform !== 'darwin')
    throw new ProcessSessionCapabilityError('Darwin process inspection is unavailable on this platform')
  const { dlopen, FFIType, ptr, read: readNative } = await import('bun:ffi')
  const libproc = dlopen('/usr/lib/libproc.dylib', {
    proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_pidinfo: {
      args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
  })
  const libc = dlopen('/usr/lib/libSystem.B.dylib', {
    __error: { args: [], returns: FFIType.ptr },
    getpgid: { args: [FFIType.i32], returns: FFIType.i32 },
    getsid: { args: [FFIType.i32], returns: FFIType.i32 },
  })
  const procSymbols = libproc.symbols
  const libcSymbols = libc.symbols
  return {
    async listPids() {
      for (let attempt = 0; attempt < DARWIN_PID_LIST_ATTEMPTS; attempt += 1) {
        const count = procSymbols.proc_listallpids(null, 0)
        if (!Number.isSafeInteger(count) || count < 0)
          throw new ProcessSessionCapabilityError('proc_listallpids sizing failed')
        const capacity = Math.max(16, count + 32)
        const storage = Buffer.alloc(capacity * Int32Array.BYTES_PER_ELEMENT)
        const listed = procSymbols.proc_listallpids(ptr(storage), storage.byteLength)
        if (!Number.isSafeInteger(listed) || listed < 0)
          throw new ProcessSessionCapabilityError('proc_listallpids failed')
        if (listed >= capacity) continue
        const pids = [...new Int32Array(storage.buffer, storage.byteOffset, listed)]
        if (new Set(pids).size !== pids.length) throw new Error('duplicate Darwin native PID')
        return pids.sort((a, b) => a - b)
      }
      throw new ProcessSessionCapabilityError('proc_listallpids remained truncated')
    },
    async readBsdInfo(pid) {
      safePositive(pid, 'Darwin requested PID')
      const storage = Buffer.alloc(PROC_BSDINFO_SIZE)
      const read = procSymbols.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ptr(storage), storage.byteLength)
      // ESRCH is authoritative even while kill(pid, 0) still sees a zombie.
      if (read === 0 && (readNative.i32(libcSymbols.__error()!) === 3 || provenAbsent(pid))) return undefined
      if (read !== PROC_BSDINFO_SIZE)
        throw new ProcessSessionCapabilityError(`proc_pidinfo returned ${read}, expected ${PROC_BSDINFO_SIZE}`)
      return parseDarwinBsdInfo(storage, pid)
    },
    async getProcessGroup(pid) {
      const pgid = libcSymbols.getpgid(pid)
      if (pgid < 0 && (readNative.i32(libcSymbols.__error()!) === 3 || provenAbsent(pid)))
        throw Object.assign(new Error('process exited'), { code: 'ESRCH' })
      return safePositive(pgid, 'Darwin native PGID')
    },
    async getSessionId(pid) {
      const sid = libcSymbols.getsid(pid)
      if (sid < 0 && (readNative.i32(libcSymbols.__error()!) === 3 || provenAbsent(pid)))
        throw Object.assign(new Error('process exited'), { code: 'ESRCH' })
      // Kernel/system processes may have SID 0. It can never match an owned
      // session (validated positive by the driver), so scans may exclude it.
      if (sid === 0) return 0
      return safePositive(sid, 'Darwin native SID')
    },
  }
}
let darwinBackendPromise: Promise<DarwinProcessNativeBackend> | undefined
function productionDarwinBackend(): Promise<DarwinProcessNativeBackend> {
  darwinBackendPromise ??= loadDarwinBackend()
  return darwinBackendPromise
}
export function createDarwinProcessSessionDriver(
  backend?: DarwinProcessNativeBackend | Promise<DarwinProcessNativeBackend>
): ProcessSessionDriver {
  let resolved: Promise<DarwinProcessNativeBackend> | undefined
  const nativeBackend = () => (resolved ??= backend ? Promise.resolve(backend) : productionDarwinBackend())
  const readIdentity = async (pid: number): Promise<ProcessIdentity | undefined> => {
    const native = await nativeBackend()
    const info = await native.readBsdInfo(pid)
    if (!info) return undefined
    if (info.pid !== pid) throw new Error('Darwin proc_bsdinfo PID mismatch')
    try {
      const [pgid, sid] = await Promise.all([native.getProcessGroup(pid), native.getSessionId(pid)])
      if (info.reportedProcessGroup !== pgid) throw new Error('Darwin process group cross-check mismatch')
      return darwinIdentity(info, pgid, sid)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH' && (await native.readBsdInfo(pid)) === undefined)
        return undefined
      throw error
    }
  }
  return makeDriver(readIdentity, async (sid) => {
    const native = await nativeBackend()
    const pids = await native.listPids()
    const identities: ProcessIdentity[] = []
    for (const pid of pids.filter((candidate) => candidate > 0)) {
      // Session membership is readable even for protected system processes
      // whose proc_pidinfo is denied. They cannot belong to our owned session;
      // requiring their BSD info made unrelated OS processes block all cleanup.
      try {
        if ((await native.getSessionId(pid)) !== sid) continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue
        throw error
      }
      const identity = await readIdentity(pid)
      if (identity) identities.push(identity)
    }
    return identities
  })
}
export async function readProcessIdentity(pid: number): Promise<ProcessIdentity & { startTicks: number }> {
  return parseProcStat(await readFile(`/proc/${pid}/stat`, 'utf8'))
}
function waitForPidExit(pid: number, graceMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now()
    const check = () => {
      if (provenAbsent(pid)) resolve(true)
      else if (Date.now() - started >= graceMs) resolve(false)
      else setTimeout(check, 25)
    }
    check()
  })
}
function makeDriver(
  readIdentity: (pid: number) => Promise<ProcessIdentity | undefined>,
  scanAll: (sid: number) => Promise<ProcessIdentity[]>
): ProcessSessionDriver {
  const scanSessionIdentities = async (sid: number) => {
    safePositive(sid, 'session scan SID')
    const identities = await scanAll(sid)
    const seen = new Set<number>()
    for (const identity of identities) {
      validateIdentity(identity, 'session scan identity')
      if (seen.has(identity.pid)) throw new Error('duplicate process identity PID')
      seen.add(identity.pid)
    }
    return identities.filter((identity) => identity.sid === sid).sort((a, b) => a.pid - b.pid)
  }
  const driver: ProcessSessionDriver = {
    readIdentity,
    scanSessionIdentities,
    signal: (target, signal) => process.kill(target, signal),
    async scanSession(sid) {
      return (await scanSessionIdentities(sid)).map((identity) => identity.pid)
    },
    async processGroup(pid) {
      return (await readIdentity(pid))?.pgid
    },
    waitForExit: waitForPidExit,
    async waitForSessionEmpty(sid, graceMs) {
      const started = Date.now()
      while (true) {
        const remaining = await driver.scanSession(sid)
        if (remaining.length === 0 || Date.now() - started >= graceMs) return remaining
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    },
  }
  return driver
}
export const linuxProcessSessionDriver = makeDriver(
  async (pid) => {
    try {
      return await readProcessIdentity(pid)
    } catch (error) {
      if (isIgnorableProcScanError(error)) return undefined
      throw error
    }
  },
  async () => {
    const found: ProcessIdentity[] = []
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        found.push(await readProcessIdentity(Number(entry)))
      } catch (error) {
        if (!isIgnorableProcScanError(error)) throw error
      }
    }
    return found
  }
)
export function createProcessSessionDriver(
  platform = process.platform,
  darwinBackend?: DarwinProcessNativeBackend | Promise<DarwinProcessNativeBackend>
): ProcessSessionDriver {
  if (platform === 'linux') return linuxProcessSessionDriver
  if (platform === 'darwin') return createDarwinProcessSessionDriver(darwinBackend)
  throw new ProcessSessionCapabilityError(`Process session inspection is unsupported on ${platform}`)
}
export const processSessionDriver = createProcessSessionDriver()
function sameProcessTuple(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return (
    left.pid === right.pid && left.pgid === right.pgid && left.sid === right.sid && left.startToken === right.startToken
  )
}
async function signalProvenSessionGroups(
  sid: number,
  members: ProcessIdentity[],
  signal: NodeJS.Signals,
  driver: ProcessSessionDriver
): Promise<void> {
  // A process group is the kernel signal target. One freshly re-read member
  // from each exact-SID snapshot is sufficient to prove that PGID still names
  // the snapshotted owned group; other members may legitimately fork/exit
  // between scan and signal without changing the group ownership tuple.
  const representatives = new Map<number, ProcessIdentity>()
  for (const member of members) {
    validateIdentity(member, 'owned session member')
    if (member.sid !== sid || member.pgid <= 1 || member.startToken.startsWith('darwin-ps:')) {
      throw new Error('owned session member identity is ambiguous')
    }
    representatives.set(member.pgid, representatives.get(member.pgid) ?? member)
  }
  for (const [pgid, representative] of [...representatives].sort(([left], [right]) => left - right)) {
    const current = await driver.readIdentity(representative.pid)
    if (!current) continue
    if (!sameProcessTuple(current, representative)) throw new Error('owned session member changed before signal')
    try {
      driver.signal(-pgid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}
export async function terminateOwnedSession(
  owner: Pick<ProcessIdentity, 'pid' | 'pgid' | 'sid' | 'startToken'>,
  driver: ProcessSessionDriver = processSessionDriver,
  graceMs = 5_000
): Promise<{ remainingPids: [] }> {
  if (
    owner.pid <= 1 ||
    owner.pgid <= 1 ||
    owner.sid <= 1 ||
    !owner.startToken ||
    owner.startToken.startsWith('darwin-ps:')
  ) {
    throw new Error('unsafe process session identity')
  }
  const leader = await driver.readIdentity(owner.pid)
  if (
    leader &&
    (leader.pid !== owner.pid ||
      leader.pgid !== owner.pgid ||
      leader.sid !== owner.sid ||
      leader.startToken !== owner.startToken)
  ) {
    throw new Error('owned session leader identity changed')
  }
  let remaining = await driver.scanSessionIdentities(owner.sid)
  if (remaining.length === 0) return { remainingPids: [] }
  await signalProvenSessionGroups(owner.sid, remaining, 'SIGTERM', driver)
  await driver.waitForExit(owner.pid, graceMs)
  if (driver.waitForSessionEmpty) await driver.waitForSessionEmpty(owner.sid, graceMs)
  remaining = await driver.scanSessionIdentities(owner.sid)
  if (remaining.length > 0) {
    await signalProvenSessionGroups(owner.sid, remaining, 'SIGKILL', driver)
    await driver.waitForExit(owner.pid, graceMs)
    if (driver.waitForSessionEmpty) await driver.waitForSessionEmpty(owner.sid, graceMs)
    remaining = await driver.scanSessionIdentities(owner.sid)
  }
  if (remaining.length) {
    throw new Error(`owned session ${owner.sid} still owns processes: ${remaining.map(({ pid }) => pid).join(',')}`)
  }
  return { remainingPids: [] }
}
