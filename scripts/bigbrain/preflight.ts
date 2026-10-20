#!/usr/bin/env bun
import { createServer } from 'node:net'
import { lstat, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { readPrivateJson } from './secure-files'
import { installedHostSchema } from './control-input'
import { controlReceiptSchema } from './receipts'
import { managedPaths } from './paths'
import { verifyVaultMount, linuxDeviceId } from './storage'
import { runPrivateCommand } from './process'

export interface CgroupFacts {
  memoryMax: string
  swapMax: string
  pidsMax: string
  aggregateMemoryMax: string
  aggregateMemoryHigh: string
  aggregateSwapMax: string
  aggregatePidsMax: string
  aggregateCpuMax: string
  limits: string
}
type Role = 'vault' | 'gateway' | 'control'
const cap = (text: string, ceiling: number) =>
  /^\d+$/.test(text.trim()) && Number.isSafeInteger(Number(text)) && Number(text) > 0 && Number(text) <= ceiling
export function assertCgroupBudget(role: Role, facts: CgroupFacts): void {
  const cpu = facts.aggregateCpuMax.trim().split(/\s+/)
  const files = /Max open files\s+(\d+)\s+(\d+)/.exec(facts.limits)
  const checks: [string, boolean][] = [
    ['unit_memory', cap(facts.memoryMax, role === 'vault' ? 268435456 : 134217728)],
    ['unit_swap', facts.swapMax.trim() === '0'],
    ['unit_tasks', cap(facts.pidsMax, 64)],
    ['slice_memory', cap(facts.aggregateMemoryMax, 671088640) && cap(facts.aggregateMemoryHigh, 536870912)],
    ['slice_swap', facts.aggregateSwapMax.trim() === '0'],
    ['slice_tasks', cap(facts.aggregatePidsMax, 192)],
  ]
  const failed = checks.find(([, ok]) => !ok)
  if (failed) throw new Error(`budget_${failed[0]}`)
  if (
    !cap(facts.memoryMax, role === 'vault' ? 268435456 : 134217728) ||
    facts.swapMax.trim() !== '0' ||
    !cap(facts.pidsMax, 64) ||
    !cap(facts.aggregateMemoryMax, 671088640) ||
    !cap(facts.aggregateMemoryHigh, 536870912) ||
    facts.aggregateSwapMax.trim() !== '0' ||
    !cap(facts.aggregatePidsMax, 192) ||
    cpu.length !== 2 ||
    !cap(cpu[0]!, Number.MAX_SAFE_INTEGER) ||
    !cap(cpu[1]!, Number.MAX_SAFE_INTEGER) ||
    Number(cpu[0]) / Number(cpu[1]) > 0.5 ||
    !files ||
    !cap(files[1]!, role === 'vault' ? 256 : 128) ||
    !cap(files[2]!, role === 'vault' ? 256 : 128)
  )
    throw new Error('unsupported_host')
}

type Binder = (port: number) => Promise<{ close: () => Promise<void> }>
const bindProbe: Binder = (port) =>
  new Promise((resolve, reject) => {
    // No HTTP/TLS/data parser runs as root. Immediately close every accepted connection.
    const server = createServer((socket) => socket.destroy())
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () =>
      resolve({
        close: () => new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      })
    )
  })
/** Run inside the ACTUAL service cgroup (including ExecStartPre), not a declaration check.
 * EADDRINUSE is not a policy proof. Any unexpected successful bind is closed then refused.
 */
export async function proveSocketBindPolicy(ownPort: number | null, bind: Binder = bindProbe): Promise<void> {
  if (ownPort !== null) {
    if (!Number.isInteger(ownPort) || ownPort < 30000 || ownPort > 65535) throw new Error('unsupported_host')
    let own: Awaited<ReturnType<Binder>>
    try {
      own = await bind(ownPort)
    } catch {
      throw new Error('socket_own_port_unbindable')
    }
    await own.close()
  }
  let unexpected: Awaited<ReturnType<Binder>>
  try {
    unexpected = await bind(0)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    if (code === 'EACCES' || code === 'EPERM') return
    throw new Error(
      typeof code === 'string' && /^E[A-Z]{2,15}$/.test(code)
        ? `socket_port0_${code.toLowerCase()}`
        : 'socket_port0_error'
    )
  }
  await unexpected.close()
  // Policy not enforced: binding an arbitrary port succeeded.
  throw new Error('socket_port0_bound')
}

/** Call on the running process mount view; +ExecStartPre deliberately has a privileged
 * filesystem view and therefore is NOT proof of the eventual unprivileged scratch mounts.
 */
export function verifyScratchMounts(mountinfo: string): void {
  for (const path of ['/tmp', '/var/tmp']) {
    const matches = mountinfo
      .split('\n')
      .map((line) => line.split(' '))
      .filter((fields) => fields[4] === path)
    if (matches.length !== 1) throw new Error('unsupported_host')
    const fields = matches[0]!
    const split = fields.indexOf('-')
    const options = fields[5]?.split(',') ?? []
    const size = /(?:^|,)size=(\d+)([kmg]?)(?:,|$)/i.exec(fields[split + 3] ?? '')
    const bytes = size
      ? Number(size[1]) * ({ '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[size[2]!.toLowerCase()] ?? Infinity)
      : Infinity
    if (
      split < 6 ||
      fields[split + 1] !== 'tmpfs' ||
      !['rw', 'nosuid', 'nodev', 'noexec'].every((v) => options.includes(v)) ||
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      bytes > 16 * 1024 * 1024
    )
      throw new Error('unsupported_host')
  }
}

export function verifyLoopBacking(
  expected: { device: string; image: string; inode: number; imageDevice: number },
  value: unknown
): void {
  const schema = z
    .object({
      loopdevices: z
        .array(
          z
            .object({
              name: z.string(),
              'back-file': z.string(),
              'back-ino': z.union([z.number().int().safe(), z.string().regex(/^\d+$/)]),
              'back-maj:min': z.string(),
            })
            .passthrough()
        )
        .length(1),
    })
    .passthrough()
  const parsed = schema.safeParse(value)
  if (!parsed.success || !/^7:\d+$/.test(expected.device)) throw new Error('storage_unavailable')
  const entry = parsed.data.loopdevices[0]!
  if (
    entry.name !== `/dev/loop${expected.device.slice(2)}` ||
    entry['back-file'] !== expected.image ||
    String(entry['back-ino']) !== String(expected.inode) ||
    entry['back-maj:min'] !== linuxDeviceId(expected.imageDevice)
  )
    throw new Error('storage_unavailable')
}

export async function verifyCurrentCgroup(role: Role, unit: string): Promise<void> {
  if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    (await readFile('/proc/1/comm', 'utf8')).trim() !== 'systemd'
  )
    throw new Error('not_systemd')
  const lines = (await readFile('/proc/self/cgroup', 'utf8')).trim().split('\n')
  const path = lines.length === 1 && lines[0]!.startsWith('0::/') ? lines[0]!.slice(3) : ''
  if (!path.endsWith(`/ficus-bigbrain.slice/${unit}`) || path.includes('..') || path.includes('\\'))
    throw new Error('cgroup_path_unexpected')
  const own = `/sys/fs/cgroup${path}`
  const aggregate = dirname(own)
  const [
    memoryMax,
    swapMax,
    pidsMax,
    aggregateMemoryMax,
    aggregateMemoryHigh,
    aggregateSwapMax,
    aggregatePidsMax,
    aggregateCpuMax,
    limits,
  ] = await Promise.all([
    readFile(`${own}/memory.max`, 'utf8'),
    readFile(`${own}/memory.swap.max`, 'utf8'),
    readFile(`${own}/pids.max`, 'utf8'),
    readFile(`${aggregate}/memory.max`, 'utf8'),
    readFile(`${aggregate}/memory.high`, 'utf8'),
    readFile(`${aggregate}/memory.swap.max`, 'utf8'),
    readFile(`${aggregate}/pids.max`, 'utf8'),
    readFile(`${aggregate}/cpu.max`, 'utf8'),
    readFile('/proc/self/limits', 'utf8'),
  ]).catch(() => {
    throw new Error('cgroup_facts_unreadable')
  })
  assertCgroupBudget(role, {
    memoryMax,
    swapMax,
    pidsMax,
    aggregateMemoryMax,
    aggregateMemoryHigh,
    aggregateSwapMax,
    aggregatePidsMax,
    aggregateCpuMax,
    limits,
  })
}

/** Read-only storage verification. No missing mount may fall back to the Core root filesystem. */
/** Storage identity only. The host epoch and installed artifact digest legitimately move on
 * (suspend/resume, upgrades) without changing a vault's storage, so they are fenced at
 * admission, not here; a stale receipt epoch must not strand a vault's own service start.
 */
export async function verifyRecordedVaultStorage(
  vaultId: string,
  options: {
    root?: string
    etc?: string
    uid?: number
    mountinfo?: () => Promise<string>
    run?: typeof runPrivateCommand
  } = {}
): Promise<void> {
  const paths = managedPaths({ vaultId, root: options.root })
  const fs = { uid: options.uid }
  const record = await readPrivateJson(paths.control, 'receipt.json', controlReceiptSchema, fs)
  const host = await readPrivateJson(options.etc ?? '/etc/ficus/bigbrain', 'host.json', installedHostSchema, fs)
  const os = record.os
  if (
    host.hostState !== 'active' ||
    host.physicalHostBinding !== record.receipt.physicalHostBinding ||
    host.tenantId !== record.receipt.tenantId ||
    record.receipt.vaultId !== vaultId ||
    record.storage.mount !== paths.mount ||
    record.storage.image !== paths.image ||
    ['deleted', 'deleting', 'reserved'].includes(record.phase) ||
    !os
  )
    throw new Error('storage_unavailable')
  const image = await lstat(paths.image)
  if (
    !image.isFile() ||
    image.nlink !== 1 ||
    image.uid !== (options.uid ?? 0) ||
    (image.mode & 0o777) !== 0o600 ||
    image.size !== record.storage.diskBytes ||
    image.dev !== os.imageDevice ||
    image.ino !== os.imageInode
  )
    throw new Error('storage_unavailable')
  verifyVaultMount(
    { mount: paths.mount, device: os.mountDevice, filesystem: 'ext4' },
    await (options.mountinfo ?? (() => readFile('/proc/self/mountinfo', 'utf8')))()
  )
  const loop = await (options.run ?? runPrivateCommand)([
    '/usr/sbin/losetup',
    '--list',
    '--json',
    '--output',
    'NAME,BACK-FILE,BACK-INO,BACK-MAJ:MIN',
    `/dev/loop${os.mountDevice.slice(2)}`,
  ])
  if (loop.code !== 0) throw new Error('storage_unavailable')
  verifyLoopBacking(
    { device: os.mountDevice, image: paths.image, inode: os.imageInode, imageDevice: os.imageDevice },
    JSON.parse(loop.stdout)
  )
  const mounted = await lstat(paths.mount)
  if (!mounted.isDirectory() || mounted.uid !== os.uid || mounted.gid !== os.gid || (mounted.mode & 0o777) !== 0o700)
    throw new Error('storage_unavailable')
}

/** Every role runs as `/usr/local/bin/bun <release>/ficus-bigbrain-host.js`: the running
 * interpreter must BE the verified host Bun at exactly the release's recorded version. */
export async function verifyRunningInterpreter(
  release: string,
  options: { uid?: number; hostBun?: string; running?: { version: string; execPath: string } } = {}
): Promise<void> {
  const { realpath } = await import('node:fs/promises')
  const { readPublicJson } = await import('./secure-files')
  const { bigbrainProvenanceSchema } = await import('./artifact')
  const { HOST_BUN, verifyHostBun } = await import('./host-bun')
  try {
    const provenance = await readPublicJson(release, 'provenance.json', bigbrainProvenanceSchema, { uid: options.uid })
    const running = options.running ?? { version: Bun.version, execPath: process.execPath }
    if (running.version !== provenance.bunVersion) throw new Error()
    const hostBun = options.hostBun ?? HOST_BUN
    await verifyHostBun(provenance.bunVersion, { path: hostBun, uid: options.uid })
    if ((await realpath(running.execPath)) !== (await realpath(hostBun))) throw new Error()
  } catch {
    throw new Error('unsupported_host')
  }
}

/** Fixed stage names only (never paths, values or upstream text): operators learn WHICH
 * isolation prerequisite failed from the journal without any sensitive detail. */
export async function runIsolationChecks(target: string, stage: { name: string }): Promise<void> {
  stage.name = 'interpreter'
  await verifyRunningInterpreter(dirname(Bun.main))
  const role = target === 'gateway' ? 'gateway' : target === 'control' ? 'control' : 'vault'
  const unit =
    role === 'gateway'
      ? 'ficus-bigbrain-gateway.service'
      : role === 'control'
        ? 'ficus-bigbrain-control.service'
        : managedPaths({ vaultId: target }).unit
  stage.name = 'cgroup'
  await verifyCurrentCgroup(role, unit)
  let port: number | null = role === 'gateway' ? 34792 : null
  if (role === 'vault') {
    stage.name = 'storage'
    await verifyRecordedVaultStorage(target)
    port = (await readPrivateJson(managedPaths({ vaultId: target }).control, 'receipt.json', controlReceiptSchema))
      .storage.port
  }
  stage.name = 'socket-policy'
  await proveSocketBindPolicy(port)
}

export async function preflightMain(args: string[]): Promise<void> {
  const stage = { name: 'arguments' }
  try {
    if (process.getuid?.() !== 0 || args.length !== 1) throw new Error('unsupported_host')
    await runIsolationChecks(args[0]!, stage)
  } catch (error) {
    const reason = error instanceof Error && /^[a-z_]{1,40}$/.test(error.message) ? error.message : 'unexpected'
    console.error(`Managed BigBrain isolation preflight refused at ${stage.name} (${reason})`)
    // Units discard stdio; leave the fixed stage/reason tokens where only root can read them.
    await recordPreflightRefusal(args[0] ?? 'unknown', `${stage.name} (${reason})`).catch(() => {})
    process.exitCode = 1
  }
}
async function recordPreflightRefusal(target: string, text: string): Promise<void> {
  if (!/^(gateway|control|[0-9a-f-]{36})$/.test(target)) return
  const { mkdir, readFile: read, writeFile } = await import('node:fs/promises')
  // Operator diagnostics only (root 0600): the observed cgroup path, character-restricted.
  const cgroup = (await read('/proc/self/cgroup', 'utf8').catch(() => '')).replace(/[^\w@./:-]/g, '?').slice(0, 300)
  await mkdir('/run/ficus-bigbrain', { mode: 0o700, recursive: true })
  await writeFile(`/run/ficus-bigbrain/preflight-${target}.reason`, `${text} cgroup=${cgroup}\n`, { mode: 0o600 })
}

if (import.meta.main) await preflightMain(process.argv.slice(2))
