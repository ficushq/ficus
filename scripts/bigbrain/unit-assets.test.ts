import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reservedVaultFixture } from './host-test-fixtures'
import { managedPaths } from './paths'
import { initializeStorageNamespace, imageJournalSchema } from './volume-image'
import { ensureOwnedDirectory, writePrivateJson } from './secure-files'
import { controlReceiptSchema } from './receipts'
import { installVaultUnitAssets } from './unit-assets'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const uid = process.getuid!()
async function fixture() {
  const outer = await mkdtemp(join(tmpdir(), 'bigbrain-units-'))
  roots.push(outer)
  const root = join(outer, 'state')
  const unitDirectory = join(outer, 'units')
  const options = { root, unitDirectory, uid, tmpfilesDirectory: join(outer, 'tmpfiles.d') }
  await initializeStorageNamespace(options)
  const record = reservedVaultFixture(root)
  const paths = managedPaths({ root, vaultId: record.receipt.vaultId })
  await ensureOwnedDirectory(paths.control, 0o700, options)
  await writePrivateJson(paths.control, 'receipt.json', record, controlReceiptSchema, options)
  // Unit ownership tests only, not an actual formatted filesystem or Linux enforcement claim.
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
      image: { device: 2049, inode: 123 },
      formatted: true,
    },
    imageJournalSchema,
    options
  )
  return { record, options, paths }
}
test('installs two exact owned units and durably records hashes; exact/partial publication replay is safe', async () => {
  const f = await fixture()
  const first = await installVaultUnitAssets(f.record, f.options)
  expect((await stat(join(f.options.unitDirectory, first.serviceUnitName))).mode & 0o777).toBe(0o644)
  expect(await installVaultUnitAssets(f.record, f.options)).toEqual(first)
  // Crash between asset rename and ownership-metadata publication: exact bytes recover.
  await rm(join(f.paths.control, 'units.json'))
  expect(await installVaultUnitAssets(f.record, f.options)).toEqual(first)
})
test('refuses an unrecorded/changed foreign unit before writing any other asset', async () => {
  const f = await fixture()
  await ensureOwnedDirectory(f.options.unitDirectory, 0o755, f.options)
  await writeFile(join(f.options.unitDirectory, f.paths.unit), 'FOREIGN', { mode: 0o644 })
  await expect(installVaultUnitAssets(f.record, f.options)).rejects.toThrow('identity_mismatch')
  expect(await readFile(join(f.options.unitDirectory, f.paths.unit), 'utf8')).toBe('FOREIGN')
})
test('missing recorded origin refuses before unit publication', async () => {
  const f = await fixture()
  await expect(
    installVaultUnitAssets({ ...f.record, receipt: { ...f.record.receipt, origin: null } }, f.options)
  ).rejects.toThrow('storage_unavailable')
  await expect(stat(f.options.unitDirectory)).rejects.toThrow()
})

test('tombstones/deletion never create or refresh a service asset', async () => {
  const f = await fixture()
  await expect(installVaultUnitAssets({ ...f.record, phase: 'deleting' }, f.options)).rejects.toThrow('forbidden')
  await expect(
    installVaultUnitAssets({ ...f.record, receipt: { ...f.record.receipt, state: 'deleted' } }, f.options)
  ).rejects.toThrow('forbidden')
  await expect(stat(f.options.unitDirectory)).rejects.toThrow()
})

test('compatible upgrades replace only recorded hashes, not a newly substituted foreign asset', async () => {
  const f = await fixture()
  const first = await installVaultUnitAssets(f.record, f.options)
  const upgraded = { ...f.record, receipt: { ...f.record.receipt, artifactDigest: `sha256:${'c'.repeat(64)}` } }
  await writePrivateJson(f.paths.control, 'receipt.json', upgraded, controlReceiptSchema, f.options)
  await installVaultUnitAssets(upgraded, f.options)
  expect(await readFile(join(f.options.unitDirectory, first.serviceUnitName), 'utf8')).toContain('c'.repeat(64))
  await writeFile(join(f.options.unitDirectory, first.mountUnitName), 'FOREIGN', { mode: 0o644 })
  await expect(installVaultUnitAssets(upgraded, f.options)).rejects.toThrow('identity_mismatch')
})
