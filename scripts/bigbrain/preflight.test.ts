import { expect, test } from 'bun:test'
import {
  assertCgroupBudget,
  proveSocketBindPolicy,
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
    { ...facts, limits: 'Max open files 512 512 files' },
  ])
    expect(() => assertCgroupBudget('vault', bad)).toThrow('unsupported_host')
})
test('own port must bind, a denied arbitrary port must return policy denial, never collision; probes close even if unsupported', async () => {
  const calls: number[] = []
  let closed = 0
  const binder = async (port: number) => {
    calls.push(port)
    if (port === 0) throw Object.assign(new Error(), { code: 'EACCES' })
    return {
      close: async () => {
        closed++
      },
    }
  }
  await proveSocketBindPolicy(30000, binder)
  expect(calls).toEqual([30000, 0])
  expect(closed).toBe(1)
  for (const code of ['EADDRINUSE', 'UNKNOWN'])
    await expect(
      proveSocketBindPolicy(null, async () => {
        throw Object.assign(new Error(), { code })
      })
    ).rejects.toThrow('unsupported_host')
  await proveSocketBindPolicy(null, async () => {
    throw Object.assign(new Error(), { code: 'EPERM' })
  })
  await expect(
    proveSocketBindPolicy(null, async () => ({
      close: async () => {
        closed++
      },
    }))
  ).rejects.toThrow('unsupported_host')
  expect(closed).toBe(2)
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
  const shared = await import('../../packages/shared/src/managed-bigbrain')
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
