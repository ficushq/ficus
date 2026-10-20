#!/usr/bin/env bun
import { createServer } from 'node:net'
import { lstat, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { readPrivateJson } from './secure-files'
import { installedHostSchema } from './control-input'
import { controlReceiptSchema } from './receipts'
import { managedPaths } from './paths'
import { verifyVaultMount } from './storage'
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
      throw new Error('unsupported_host')
    }
    await own.close()
  }
  let unexpected: Awaited<ReturnType<Binder>>
  try {
    unexpected = await bind(0)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    if (code === 'EACCES' || code === 'EPERM') return
    throw new Error('unsupported_host')
  }
  await unexpected.close()
  throw new Error('unsupported_host')
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
  const device = BigInt(expected.imageDevice)
  const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & ~0xfffn)
  const minor = (device & 0xffn) | ((device >> 12n) & ~0xffn)
  if (
    entry.name !== `/dev/loop${expected.device.slice(2)}` ||
    entry['back-file'] !== expected.image ||
    String(entry['back-ino']) !== String(expected.inode) ||
    entry['back-maj:min'] !== `${major}:${minor}`
  )
    throw new Error('storage_unavailable')
}

export async function verifyCurrentCgroup(role: Role, unit: string): Promise<void> {
  if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    (await readFile('/proc/1/comm', 'utf8')).trim() !== 'systemd'
  )
    throw new Error('unsupported_host')
  const lines = (await readFile('/proc/self/cgroup', 'utf8')).trim().split('\n')
  const path = lines.length === 1 && lines[0]!.startsWith('0::/') ? lines[0]!.slice(3) : ''
  if (!path.endsWith(`/ficus-bigbrain.slice/${unit}`) || path.includes('..') || path.includes('\\'))
    throw new Error('unsupported_host')
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
  ])
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
export async function verifyRecordedVaultStorage(vaultId: string): Promise<void> {
  const paths = managedPaths({ vaultId })
  const record = await readPrivateJson(paths.control, 'receipt.json', controlReceiptSchema)
  const host = await readPrivateJson('/etc/ficus/bigbrain', 'host.json', installedHostSchema)
  const os = record.os
  if (
    host.hostState !== 'active' ||
    host.physicalHostBinding !== record.receipt.physicalHostBinding ||
    host.tenantId !== record.receipt.tenantId ||
    host.hostEpoch !== record.receipt.hostEpoch ||
    host.artifactDigest !== record.receipt.artifactDigest ||
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
    image.uid !== 0 ||
    (image.mode & 0o777) !== 0o600 ||
    image.size !== record.storage.diskBytes ||
    image.dev !== os.imageDevice ||
    image.ino !== os.imageInode
  )
    throw new Error('storage_unavailable')
  verifyVaultMount(
    { mount: paths.mount, device: os.mountDevice, filesystem: 'ext4' },
    await readFile('/proc/self/mountinfo', 'utf8')
  )
  const loop = await runPrivateCommand([
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

if (import.meta.main) {
  try {
    if (process.getuid?.() !== 0 || process.argv.length !== 3) throw new Error('unsupported_host')
    const target = process.argv[2]!
    if (target === 'gateway') {
      await verifyCurrentCgroup('gateway', 'ficus-bigbrain-gateway.service')
      await proveSocketBindPolicy(34792)
    } else if (target === 'control') {
      await verifyCurrentCgroup('control', 'ficus-bigbrain-control.service')
      await proveSocketBindPolicy(null)
    } else {
      const paths = managedPaths({ vaultId: target })
      await verifyCurrentCgroup('vault', paths.unit)
      await verifyRecordedVaultStorage(target)
      const record = await readPrivateJson(paths.control, 'receipt.json', controlReceiptSchema)
      await proveSocketBindPolicy(record.storage.port)
    }
  } catch {
    console.error('Managed BigBrain isolation preflight refused')
    process.exitCode = 1
  }
}
