import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reservedVaultFixture } from './host-test-fixtures'
import { managedPaths } from './paths'
import { controlReceiptSchema } from './receipts'
import { ensureOwnedDirectory, readPrivateJson, writePrivateJson } from './secure-files'
import { initializeStorageNamespace, imageJournalSchema } from './volume-image'
import { installVaultUnitAssets } from './unit-assets'
import { deleteVaultResources } from './delete'
import type { PrivateCommandRunner } from './process'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const uid = process.getuid!()
const A = '22222222-2222-4222-8222-222222222222'
const B = '44444444-4444-4444-8444-444444444444'

async function vault(root: string, unitDirectory: string, vaultId: string, identity: { uid: number; gid: number }) {
  const base = reservedVaultFixture(root)
  const paths = managedPaths({ root, vaultId })
  const record = controlReceiptSchema.parse({
    ...base,
    phase: 'ready',
    receipt: {
      ...base.receipt,
      vaultId,
      upstreamVaultId: '66666666-6666-4666-8666-666666666666',
      state: 'ready',
      readAccess: 'active',
      origin: `https://bb-${vaultId.replaceAll('-', '')}.example.com`,
    },
    storage: {
      ...base.storage,
      vaultId,
      mount: paths.mount,
      image: paths.image,
      username: `bbv_${vaultId.replaceAll('-', '').slice(0, 24)}`,
    },
  })
  await ensureOwnedDirectory(paths.control, 0o700, { uid })
  const image = await open(paths.image, 'wx', 0o600)
  await image.write(`image ${vaultId}`)
  await image.close()
  const info = await stat(paths.image)
  await mkdir(paths.mount, { mode: 0o700 })
  const withOs = controlReceiptSchema.parse({
    ...record,
    os: { ...identity, imageDevice: info.dev, imageInode: info.ino, mountDevice: '7:4' },
  })
  await writePrivateJson(paths.control, 'receipt.json', withOs, controlReceiptSchema, { uid })
  await writePrivateJson(
    paths.control,
    'image.json',
    {
      schema: 1,
      tenantId: base.receipt.tenantId,
      physicalHostBinding: base.receipt.physicalHostBinding,
      vaultId,
      creationRequestId: base.operation.requestId,
      creationHash: base.operation.inputHash,
      storage: withOs.storage,
      identity,
      image: { device: info.dev, inode: info.ino },
      formatted: true,
    },
    imageJournalSchema,
    { uid }
  )
  await installVaultUnitAssets(withOs, { root, uid, unitDirectory })
  // Root escrow material that must not survive deletion.
  await writeFile(join(paths.control, 'owner.json'), '{"token":"sv_secret"}', { mode: 0o600 })
  return withOs
}

async function tree(dir: string): Promise<string> {
  const hash = createHash('sha256')
  for (const name of (await readdir(dir, { recursive: true })).sort()) {
    const path = join(dir, name)
    const info = await stat(path)
    hash.update(`${name}:${info.mode}:${info.isFile() ? await readFile(path, 'utf8') : ''}\n`)
  }
  return hash.digest('hex')
}

async function fixture(options: { mounted?: boolean } = {}) {
  const outer = await mkdtemp(join(tmpdir(), 'bigbrain-delete-'))
  roots.push(outer)
  const root = join(outer, 'state')
  const unitDirectory = join(outer, 'units')
  await initializeStorageNamespace({ root, uid })
  const a = await vault(root, unitDirectory, A, { uid: 1200, gid: 1201 })
  const b = await vault(root, unitDirectory, B, { uid: 1202, gid: 1203 })
  const calls: string[][] = []
  const removed: unknown[] = []
  let attached: number | null = null
  const run: PrivateCommandRunner = async (argv) => {
    calls.push(argv)
    if (argv[0] === '/usr/sbin/losetup' && argv[1] === '--list')
      return {
        code: 0,
        stdout: JSON.stringify({
          loopdevices: attached === null ? [] : [{ name: '/dev/loop7', 'back-ino': attached }],
        }),
      }
    if (argv[1] === '--detach') attached = null
    return { code: 0, stdout: '' }
  }
  const opts = {
    root,
    uid,
    unitDirectory,
    run,
    mountinfo: async () =>
      options.mounted ? `1 0 7:4 / ${managedPaths({ root, vaultId: A }).mount} rw - ext4 /dev/loop7 rw\n` : '',
    removeIdentity: async (key: unknown, identity: unknown) => {
      removed.push({ key, identity })
    },
  }
  return { root, unitDirectory, a, b, opts, calls, removed, attach: (inode: number) => (attached = inode) }
}

test('deleting A removes exactly its recorded resources, keeps a secret-free tombstone and leaves B byte-identical', async () => {
  const f = await fixture()
  const pathsB = managedPaths({ root: f.root, vaultId: B })
  const before = {
    control: await tree(pathsB.control),
    units: await readdir(f.unitDirectory),
    image: await readFile(pathsB.image, 'utf8'),
  }
  const tombstone = await deleteVaultResources(f.a, f.opts)
  expect(tombstone).toMatchObject({ phase: 'deleted', os: null, receipt: { state: 'deleted', readAccess: 'revoked' } })
  const paths = managedPaths({ root: f.root, vaultId: A })
  expect(await readdir(paths.control)).toEqual(['receipt.json'])
  await expect(stat(paths.image)).rejects.toThrow()
  await expect(stat(paths.mount)).rejects.toThrow()
  expect(f.removed).toEqual([
    {
      key: { tenantId: f.a.receipt.tenantId, physicalHostBinding: f.a.receipt.physicalHostBinding, vaultId: A },
      identity: { uid: 1200, gid: 1201 },
    },
  ])
  expect(await tree(pathsB.control)).toBe(before.control)
  expect(await readFile(pathsB.image, 'utf8')).toBe(before.image)
  expect((await readdir(f.unitDirectory)).sort()).toEqual(
    before.units.filter((u) => !u.includes(A.replaceAll('-', '\\x2d')) && !u.includes(A)).sort()
  )
  expect(f.calls.some((argv) => argv.join(' ').includes(B))).toBe(false)
  // Replay and stale-receipt use are harmless.
  expect(await deleteVaultResources(tombstone, f.opts)).toEqual(tombstone)
  await expect(deleteVaultResources(f.a, f.opts)).rejects.toThrow('generation_conflict')
})

test('a still-mounted vault is never unlinked; a crashed delete resumes from its tombstone intent', async () => {
  const f = await fixture({ mounted: true })
  await expect(deleteVaultResources(f.a, f.opts)).rejects.toThrow('busy')
  const paths = managedPaths({ root: f.root, vaultId: A })
  expect(await readFile(paths.image, 'utf8')).toBe(`image ${A}`)
  const intent = await readPrivateJson(paths.control, 'receipt.json', controlReceiptSchema, { uid })
  expect(intent.phase).toBe('deleting')
  const resumed = await deleteVaultResources(intent, { ...f.opts, mountinfo: async () => '' })
  expect(resumed.phase).toBe('deleted')
})

test('only a loop device backed by our recorded inode is detached; a foreign one refuses', async () => {
  const foreign = await fixture()
  foreign.attach(foreign.a.os!.imageInode + 1)
  await expect(deleteVaultResources(foreign.a, foreign.opts)).rejects.toThrow('identity_mismatch')
  const own = await fixture()
  own.attach(own.a.os!.imageInode)
  await deleteVaultResources(own.a, own.opts)
  expect(own.calls).toContainEqual(['/usr/sbin/losetup', '--detach', '/dev/loop7'])
})

test('a changed unit file or substituted image is never removed', async () => {
  const f = await fixture()
  const service = managedPaths({ vaultId: A }).unit
  await writeFile(join(f.unitDirectory, service), 'FOREIGN', { mode: 0o644 })
  await expect(deleteVaultResources(f.a, f.opts)).rejects.toThrow('identity_mismatch')
  expect(await readFile(join(f.unitDirectory, service), 'utf8')).toBe('FOREIGN')

  const g = await fixture()
  const paths = managedPaths({ root: g.root, vaultId: A })
  // Created while the original still exists, so it cannot reuse the recorded inode number.
  await writeFile(`${paths.image}.new`, 'substituted', { mode: 0o600 })
  await rename(`${paths.image}.new`, paths.image)
  await expect(deleteVaultResources(g.a, g.opts)).rejects.toThrow('identity_mismatch')
  expect(await readFile(paths.image, 'utf8')).toBe('substituted')
})

test('anything written into an unmounted mountpoint (the Core disk) stops deletion for an operator', async () => {
  const f = await fixture()
  await writeFile(join(managedPaths({ root: f.root, vaultId: A }).mount, 'leak'), 'x')
  await expect(deleteVaultResources(f.a, f.opts)).rejects.toThrow('storage_unavailable')
})
