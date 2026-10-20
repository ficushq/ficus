import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { managedPaths } from './paths'
import { controlReceiptSchema } from './receipts'
import { managedIdentityNames } from './accounts'
import { writePrivateJson, ensureOwnedDirectory, readPrivateJson } from './secure-files'
import { initializeStorageNamespace, prepareVaultImage, imageJournalSchema } from './volume-image'
import { reservedVaultFixture } from './host-test-fixtures'
import type { PrivateCommandRunner } from './process'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const uid = process.getuid!()
const tenantId = '11111111-1111-4111-8111-111111111111'
const vaultId = '22222222-2222-4222-8222-222222222222'
const binding = '33333333-3333-4333-8333-333333333333'
async function fixture() {
  const outer = await mkdtemp(join(tmpdir(), 'bigbrain-image-'))
  roots.push(outer)
  const root = join(outer, 'state')
  const options = { root, uid }
  await initializeStorageNamespace(options)
  const paths = managedPaths({ vaultId, root })
  await ensureOwnedDirectory(paths.control, 0o700, { uid })
  const record = reservedVaultFixture(root)
  await writePrivateJson(paths.control, 'receipt.json', record, controlReceiptSchema, { uid })
  const names = managedIdentityNames({ tenantId, physicalHostBinding: binding, vaultId })
  let account = false
  let formatted = false
  let failAfterFormat = false
  let quotaFailure = false
  const calls: string[][] = []
  const run: PrivateCommandRunner = async (args) => {
    calls.push(args)
    if (args[0] === '/usr/bin/getent') {
      if (!account) return { code: 2, stdout: '' }
      return {
        code: 0,
        stdout:
          args[1] === 'passwd'
            ? `${names.username}:x:1200:1201:${names.comment}:/nonexistent:/usr/sbin/nologin\n`
            : `${names.username}:x:1201:\n`,
      }
    }
    if (args[0] === '/usr/sbin/useradd') account = true
    if (args[0] === '/usr/sbin/blkid')
      return formatted ? { code: 0, stdout: `TYPE=ext4\nUUID=${vaultId}\n` } : { code: 2, stdout: '' }
    if (args[0] === '/usr/bin/fallocate') {
      if (quotaFailure) return { code: 1, stdout: '' }
      const durable = await readPrivateJson(paths.control, 'image.json', imageJournalSchema, { uid })
      expect(durable.identity).toEqual({ uid: 1200, gid: 1201 })
      expect(durable.image?.inode).toBe((await stat(paths.image)).ino)
      // Real bounded fixture bytes, not a sparse file passing an allocation check.
      // No mount, UID, cgroup, systemd or actual formatting operation is performed.
      const file = await open(paths.image, 'r+')
      try {
        const block = Buffer.alloc(65536)
        for (let p = 4096; p < record.storage.diskBytes; p += block.length)
          await file.write(block, 0, Math.min(block.length, record.storage.diskBytes - p), p)
        await file.sync()
      } finally {
        await file.close()
      }
    }
    if (args[0] === '/usr/sbin/mkfs.ext4') {
      formatted = true
      if (failAfterFormat) {
        failAfterFormat = false
        throw new Error('lost response')
      }
    }
    return { code: 0, stdout: '' }
  }
  return {
    options: { ...options, run },
    record,
    paths,
    calls,
    failFormatOnce() {
      failAfterFormat = true
    },
    failQuota() {
      quotaFailure = true
    },
    allowQuota() {
      quotaFailure = false
    },
  }
}
test('journals identity/image inode before reservation/format; exact retry never recreates or reformats', async () => {
  const f = await fixture()
  const first = await prepareVaultImage(f.record, f.options)
  expect(first.identity).toEqual({ uid: 1200, gid: 1201 })
  expect(first.formatted).toBe(true)
  expect((await stat(f.paths.image)).size).toBe(f.record.storage.diskBytes)
  expect((await stat(f.paths.image)).blocks * 512).toBeGreaterThanOrEqual(f.record.storage.diskBytes)
  expect(await prepareVaultImage(f.record, f.options)).toEqual(first)
  expect(f.calls.filter((c) => c[0] === '/usr/sbin/useradd')).toHaveLength(1)
  expect(f.calls.filter((c) => c[0] === '/usr/sbin/mkfs.ext4')).toHaveLength(1)
})
test('lost format response recovers matching filesystem without repeating format; reservation failure never formats', async () => {
  const f = await fixture()
  f.failFormatOnce()
  await expect(prepareVaultImage(f.record, f.options)).rejects.toThrow('operation_failed')
  expect((await readPrivateJson(f.paths.control, 'image.json', imageJournalSchema, { uid })).image).not.toBeNull()
  expect((await prepareVaultImage(f.record, f.options)).formatted).toBe(true)
  expect(f.calls.filter((c) => c[0] === '/usr/sbin/mkfs.ext4')).toHaveLength(1)
  const full = await fixture()
  full.failQuota()
  await expect(prepareVaultImage(full.record, full.options)).rejects.toThrow('operation_failed')
  expect(full.calls.some((c) => c[0] === '/usr/sbin/mkfs.ext4')).toBe(false)
})
test('atomic birth stamp recovers a crash before the image inode journal without a second image', async () => {
  const f = await fixture()
  f.failQuota()
  await expect(prepareVaultImage(f.record, f.options)).rejects.toThrow('operation_failed')
  const before = (await stat(f.paths.image)).ino
  const saved = await readPrivateJson(f.paths.control, 'image.json', imageJournalSchema, { uid })
  await writePrivateJson(f.paths.control, 'image.json', { ...saved, image: null }, imageJournalSchema, { uid })
  f.allowQuota()
  expect((await prepareVaultImage(f.record, f.options)).image.inode).toBe(before)
  expect(f.calls.filter((c) => c[0] === '/usr/sbin/useradd')).toHaveLength(1)
})

test('unrecorded foreign image and substituted recorded inode are never adopted or formatted', async () => {
  const foreign = await fixture()
  await writeFile(foreign.paths.image, 'FOREIGN', { mode: 0o600 })
  await expect(prepareVaultImage(foreign.record, foreign.options)).rejects.toThrow('storage_unavailable')
  expect(foreign.calls.some((c) => c[0] === '/usr/sbin/mkfs.ext4')).toBe(false)
  const changed = await fixture()
  await prepareVaultImage(changed.record, changed.options)
  await rm(changed.paths.image)
  await writeFile(changed.paths.image, 'OTHER', { mode: 0o600 })
  await expect(prepareVaultImage(changed.record, changed.options)).rejects.toThrow('storage_unavailable')
  expect(changed.calls.filter((c) => c[0] === '/usr/sbin/mkfs.ext4')).toHaveLength(1)
})
