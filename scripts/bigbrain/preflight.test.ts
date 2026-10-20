import { expect, test } from 'bun:test'
import {
  assertCgroupBudget,
  proveNoInetSockets,
  verifySocketDirectory,
  verifyLoopBacking,
  verifyRecordedVaultStorage,
  verifyScratchMounts,
} from './preflight'
const facts = {
  memoryMax: '268435456',
  swapMax: '0',
  pidsMax: '64',
  aggregateMemoryMax: '671088640',
  aggregateMemoryHigh: '536870912',
  aggregateSwapMax: '0',
  aggregatePidsMax: '192',
  aggregateCpuMax: '50000 100000',
  limits: 'Max open files            256                  256                  files',
}
test('preflight reads enforceable cgroup-v2 values, not unit declarations or an optimistic marker', () => {
  expect(() => assertCgroupBudget('vault', facts)).not.toThrow()
  for (const bad of [
    { ...facts, memoryMax: 'max' },
    { ...facts, swapMax: '1' },
    { ...facts, memoryMax: '268435457' },
    { ...facts, aggregateMemoryMax: 'max' },
    { ...facts, aggregateCpuMax: 'max 100000' },
    { ...facts, aggregateCpuMax: '60000 100000' },
    { ...facts, pidsMax: 'max' },
  ])
    expect(() => assertCgroupBudget('vault', bad)).toThrow(/^(budget_[a-z_]+|unsupported_host)$/)
})
test('the live process must be refused every IPv4/IPv6 TCP and UDP socket; an open or an unexpected errno is never proof', async () => {
  const calls: [number, number][] = []
  await proveNoInetSockets((domain, type) => (calls.push([domain, type]), { opened: false, errno: 97 }))
  expect(calls).toEqual([
    [2, 1],
    [10, 1],
    [2, 2],
    [10, 2],
  ])
  await expect(proveNoInetSockets(() => ({ opened: false, errno: 22 }))).rejects.toThrow('inet_tcp_v_einval')
  await expect(
    proveNoInetSockets((domain, type) => ({ opened: domain === 10 && type === 2, errno: 97 }))
  ).rejects.toThrow('inet_allowed_udp_vsix')
})

test('the real libc probe in this unconfined test process can open IP sockets, so it refuses (fails closed)', async () => {
  await expect(proveNoInetSockets()).rejects.toThrow('inet_allowed_tcp_v')
})

test('socket directory verification requires exact owner, client group and setgid 2750', async () => {
  const { mkdtemp, mkdir, chmod, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'bigbrain-sock-'))
  try {
    const dir = join(root, 'd')
    await mkdir(dir)
    await chmod(dir, 0o2750)
    await verifySocketDirectory(dir, process.getuid!(), process.getgid!())
    await expect(verifySocketDirectory(dir, process.getuid!() + 1, process.getgid!())).rejects.toThrow(
      'socket_directory_unexpected'
    )
    await chmod(dir, 0o2770)
    await expect(verifySocketDirectory(dir, process.getuid!(), process.getgid!())).rejects.toThrow(
      'socket_directory_unexpected'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('descriptor limits: control is checked in its own process; vault/gateway in the unprivileged sandbox', async () => {
  const { verifyOpenFileLimit } = await import('./preflight')
  const line = (soft: number, hard: number) =>
    `Max open files            ${soft}                 ${hard}                 files`
  expect(() => verifyOpenFileLimit(line(256, 256), 256)).not.toThrow()
  expect(() => verifyOpenFileLimit(line(256, 524288), 256)).toThrow('open_files_unbounded')
  // A root preflight that raised its own limit is not mistaken for the unit's configuration.
  expect(() => assertCgroupBudget('gateway', { ...facts, limits: line(1048576, 1048576) })).not.toThrow()
  expect(() => assertCgroupBudget('control', { ...facts, limits: line(1048576, 1048576) })).toThrow(
    'budget_unit_nofile'
  )
})
test('scratch must be memory-backed, noexec/nodev/nosuid and bounded; PrivateTmp on disk is insufficient', () => {
  const mounts = '/tmp /var/tmp'
    .split(' ')
    .map((path, i) => `${i + 1} 0 0:42 / ${path} rw,nosuid,nodev,noexec - tmpfs tmpfs rw,size=16384k,mode=1777`)
    .join('\n')
  expect(() => verifyScratchMounts(mounts)).not.toThrow()
  for (const bad of [
    mounts.replace('size=16384k', 'size=32768k'),
    mounts.replace('tmpfs tmpfs', 'ext4 /dev/vda'),
    mounts.replace(',noexec', ''),
    mounts.split('\n')[0]!,
  ])
    expect(() => verifyScratchMounts(bad)).toThrow('unsupported_host')
})

test('loop device is tied to the exact root-owned image inode and backing filesystem, not merely a path', () => {
  const expected = { device: '7:4', image: '/var/lib/ficus-bigbrain/volumes/a.img', inode: 321, imageDevice: 2049 }
  const loop = { name: '/dev/loop4', 'back-file': expected.image, 'back-ino': 321, 'back-maj:min': '8:1' }
  expect(() => verifyLoopBacking(expected, { loopdevices: [loop] })).not.toThrow()
  for (const bad of [
    { ...loop, name: '/dev/loop5' },
    { ...loop, 'back-ino': 322 },
    { ...loop, 'back-file': expected.image + '.other' },
    { ...loop, 'back-maj:min': '8:2' },
  ])
    expect(() => verifyLoopBacking(expected, { loopdevices: [bad] })).toThrow('storage_unavailable')
})

test('recorded storage stays verifiable across host epoch advances and upgrades; a foreign binding or image never is', async () => {
  const { mkdtemp, mkdir, open, rm, stat } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { reservedVaultFixture } = await import('./host-test-fixtures')
  const { initializeStorageNamespace } = await import('./volume-image')
  const { ensureOwnedDirectory, writePrivateJson } = await import('./secure-files')
  const { installedHostSchema } = await import('./control-input')
  const { controlReceiptSchema } = await import('./receipts')
  const { managedPaths } = await import('./paths')
  const shared = await import('@ficus/shared/managed-bigbrain')
  const outer = await mkdtemp(join(tmpdir(), 'bigbrain-storage-'))
  try {
    const uid = process.getuid!()
    const gid = process.getgid!()
    const root = join(outer, 'state')
    const etc = join(outer, 'etc')
    await initializeStorageNamespace({ root, uid })
    await mkdir(etc, { mode: 0o700 })
    const base = reservedVaultFixture(root)
    const paths = managedPaths({ root, vaultId: base.receipt.vaultId })
    const image = await open(paths.image, 'wx', 0o600)
    await image.truncate(base.storage.diskBytes)
    await image.close()
    const info = await stat(paths.image)
    await mkdir(paths.mount, { mode: 0o700 })
    const os = { uid, gid, imageDevice: info.dev, imageInode: info.ino, mountDevice: '7:4' }
    const record = { ...base, phase: 'ready' as const, os }
    await ensureOwnedDirectory(paths.control, 0o700, { uid })
    await writePrivateJson(paths.control, 'receipt.json', record, controlReceiptSchema, { uid })
    const host = {
      contractVersion: 1,
      tenantId: base.receipt.tenantId,
      physicalHostBinding: base.receipt.physicalHostBinding,
      // Advanced epoch and upgraded artifact since the vault was created.
      hostEpoch: base.receipt.hostEpoch + 3,
      hostState: 'active',
      upstreamCommit: shared.MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
      artifactDigest: `sha256:${'c'.repeat(64)}`,
      zone: 'example.com',
      limits: shared.MANAGED_BIGBRAIN_DEFAULT_LIMITS,
      effect: null,
    }
    await writePrivateJson(etc, 'host.json', host, installedHostSchema, { uid })
    const major = (info.dev >> 8) & 0xfff
    const minor = (info.dev & 0xff) | ((info.dev >> 12) & 0xfff00)
    const options = {
      root,
      etc,
      uid,
      mountinfo: async () => `1 0 7:4 / ${paths.mount} rw,nodev,nosuid,noexec - ext4 /dev/loop4 rw\n`,
      run: async () => ({
        code: 0,
        stdout: JSON.stringify({
          loopdevices: [
            { name: '/dev/loop4', 'back-file': paths.image, 'back-ino': info.ino, 'back-maj:min': `${major}:${minor}` },
          ],
        }),
      }),
    }
    await verifyRecordedVaultStorage(base.receipt.vaultId, options)
    await writePrivateJson(
      etc,
      'host.json',
      { ...host, physicalHostBinding: '99999999-9999-4999-8999-999999999999' },
      installedHostSchema,
      { uid }
    )
    await expect(verifyRecordedVaultStorage(base.receipt.vaultId, options)).rejects.toThrow('storage_unavailable')
    await writePrivateJson(etc, 'host.json', host, installedHostSchema, { uid })
    await writePrivateJson(
      paths.control,
      'receipt.json',
      { ...record, os: { ...os, imageInode: os.imageInode + 1 } },
      controlReceiptSchema,
      { uid }
    )
    await expect(verifyRecordedVaultStorage(base.receipt.vaultId, options)).rejects.toThrow('storage_unavailable')
  } finally {
    await rm(outer, { recursive: true, force: true })
  }
})
