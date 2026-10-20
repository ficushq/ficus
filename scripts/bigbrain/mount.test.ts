import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reservedVaultFixture } from './host-test-fixtures'
import { managedPaths } from './paths'
import { initializeStorageNamespace, imageJournalSchema } from './volume-image'
import { ensureOwnedDirectory, writePrivateJson } from './secure-files'
import { controlReceiptSchema } from './receipts'
import { mountPreparedVolume, assertVolumeRootDevice } from './mount'
import type { PrivateCommandRunner } from './process'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const uid = process.getuid!()
async function fixture() {
  const outer = await mkdtemp(join(tmpdir(), 'bigbrain-mount-'))
  roots.push(outer)
  const root = join(outer, 'state')
  const unitDirectory = join(outer, 'units')
  const record = reservedVaultFixture(root)
  const paths = managedPaths({ root, vaultId: record.receipt.vaultId })
  await initializeStorageNamespace({ root, uid })
  await ensureOwnedDirectory(paths.control, 0o700, { uid })
  await writePrivateJson(paths.control, 'receipt.json', record, controlReceiptSchema, { uid })
  const file = await open(paths.image, 'wx', 0o600)
  try {
    const block = Buffer.alloc(65536)
    for (let p = 0; p < record.storage.diskBytes; p += block.length) await file.write(block)
    await file.sync()
  } finally {
    await file.close()
  }
  const info = await stat(paths.image)
  await writePrivateJson(
    paths.control,
    'image.json',
    {
      schema: 1,
      tenantId: record.receipt.tenantId,
      physicalHostBinding: record.receipt.physicalHostBinding,
      vaultId: record.receipt.vaultId,
      creationRequestId: record.operation.requestId,
      creationHash: record.operation.inputHash,
      storage: record.storage,
      identity: { uid: 1200, gid: 1201 },
      image: { device: info.dev, inode: info.ino },
      formatted: true,
    },
    imageJournalSchema,
    { uid }
  )
  const device = BigInt(info.dev)
  const backDevice = `${((device >> 8n) & 0xfffn) | ((device >> 32n) & ~0xfffn)}:${(device & 0xffn) | ((device >> 12n) & ~0xffn)}`
  let mounted = false
  let foreign = false
  let dropin = false
  let layouts = 0
  const calls: string[][] = []
  const run: PrivateCommandRunner = async (args) => {
    calls.push(args)
    if (args[0] === '/usr/bin/systemctl' && args[1] === 'show')
      return {
        code: 0,
        stdout: `FragmentPath=${join(unitDirectory, args.at(-1)!)}\nDropInPaths=${dropin ? '/etc/foreign.conf' : ''}\nLoadState=loaded\n`,
      }
    if (args[0] === '/usr/bin/systemctl' && args[1] === 'start') mounted = true
    if (args[0] === '/usr/sbin/losetup')
      return {
        code: 0,
        stdout: JSON.stringify({
          loopdevices: [
            {
              name: '/dev/loop4',
              'back-file': foreign ? paths.image + '.other' : paths.image,
              'back-ino': info.ino,
              'back-maj:min': backDevice,
            },
          ],
        }),
      }
    return { code: 0, stdout: '' }
  }
  const options = {
    root,
    uid,
    unitDirectory,
    run,
    mountinfo: async () => (mounted ? `1 0 7:4 / ${paths.mount} rw,nodev,nosuid,noexec - ext4 /dev/loop4 rw` : ''),
    prepareLayout: async (path: string, identity: { uid: number; gid: number }) => {
      expect(path).toBe(paths.mount)
      expect(identity).toEqual({ uid: 1200, gid: 1201 })
      layouts++
    },
  }
  return {
    record,
    options,
    calls,
    layouts: () => layouts,
    foreignMount() {
      mounted = true
      foreign = true
    },
    ownMount() {
      mounted = true
    },
    override() {
      dropin = true
    },
  }
}
test('starts only the owned mount and validates its backing inode before any native-UID layout; crash replay adopts only that mount', async () => {
  const f = await fixture()
  const first = await mountPreparedVolume(f.record, f.options)
  expect(first).toMatchObject({ uid: 1200, gid: 1201, mountDevice: '7:4' })
  expect(f.layouts()).toBe(1)
  expect(await mountPreparedVolume(f.record, f.options)).toEqual(first)
  expect(f.calls.filter((c) => c[1] === 'start')).toHaveLength(1)
})
test('held descriptor device, not an earlier pathname mount observation, gates every ownership/write operation', () => {
  expect(() => assertVolumeRootDevice({ dev: 1796, uid: 0 }, '7:4', { uid: 1200, gid: 1201 })).not.toThrow()
  expect(() => assertVolumeRootDevice({ dev: 2049, uid: 0 }, '7:4', { uid: 1200, gid: 1201 })).toThrow(
    'storage_unavailable'
  )
  expect(() => assertVolumeRootDevice({ dev: 1796, uid: 1300 }, '7:4', { uid: 1200, gid: 1201 })).toThrow(
    'storage_unavailable'
  )
})

test('foreign backing and systemd overrides refuse before chown/layout or starting an override', async () => {
  const foreign = await fixture()
  foreign.foreignMount()
  await expect(mountPreparedVolume(foreign.record, foreign.options)).rejects.toThrow('storage_unavailable')
  expect(foreign.layouts()).toBe(0)
  const overridden = await fixture()
  overridden.override()
  await expect(mountPreparedVolume(overridden.record, overridden.options)).rejects.toThrow('identity_mismatch')
  expect(overridden.calls.some((c) => c[1] === 'start')).toBe(false)
})
