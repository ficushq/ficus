import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, rm, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { removeManagedIdentity, type ManagedIdentity, type ManagedIdentityKey } from './accounts'
import { managedPaths } from './paths'
import { controlReceiptSchema, type ControlReceipt } from './receipts'
import { openPrivateFile, readPrivateJson, writePrivateJson } from './secure-files'
import { runPrivateCommand, type PrivateCommandRunner } from './process'
import { unitOwnershipSchema } from './unit-assets'
import { mountUnitName } from './units'
import { vaultTmpfilesName } from './unit-assets'
import { birthStampSchema, imageJournalSchema } from './volume-image'

export interface DeleteOptions {
  root?: string
  uid?: number
  unitDirectory?: string
  tmpfilesDirectory?: string
  run?: PrivateCommandRunner
  mountinfo?: () => Promise<string>
  removeIdentity?: (key: ManagedIdentityKey, identity: ManagedIdentity) => Promise<void>
  /** Runs after the tombstone intent is durable and before any unit stops (unpublish ingress). */
  beforeStop?: () => Promise<unknown>
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw new Error('storage_unavailable')
  }
}
const sha = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

/** Explicit, nonresurrectable deletion of ONE vault's recorded resources. Root lifecycle lock
 * required; the caller has already fenced name/ID/generation. Order: tombstone intent first,
 * then stop, prove unmounted/detached, remove only assets whose identity is recorded (unit hashes,
 * image inode or exact birth stamp, numeric account) and finally keep a secret-free tombstone.
 * Every step is idempotent, so a crashed delete resumes; nothing outside this vault is touched.
 * Existing Core backups keep their own retention (no immediate historical erasure).
 */
export async function deleteVaultResources(
  input: ControlReceipt,
  options: DeleteOptions = {}
): Promise<ControlReceipt> {
  const uid = options.uid ?? 0
  const fs = { uid }
  const run = options.run ?? runPrivateCommand
  const record = controlReceiptSchema.parse(input)
  const paths = managedPaths({ vaultId: record.receipt.vaultId, root: options.root })
  const stored = await readPrivateJson(paths.control, 'receipt.json', controlReceiptSchema, fs)
  if (JSON.stringify(stored) !== JSON.stringify(record)) throw new Error('generation_conflict')
  if (record.phase === 'deleted') return record
  const key = {
    tenantId: record.receipt.tenantId,
    physicalHostBinding: record.receipt.physicalHostBinding,
    vaultId: record.receipt.vaultId,
  }
  const deleting = controlReceiptSchema.parse({
    ...record,
    phase: 'deleting',
    receipt: { ...record.receipt, state: 'deleting', readAccess: 'revoked' },
  })
  if (record.phase !== 'deleting')
    await writePrivateJson(paths.control, 'receipt.json', deleting, controlReceiptSchema, fs)

  // 1. Stop the service and its mount. Not-loaded (5) is fine on a resumed/partial delete.
  const mountUnit = mountUnitName(paths.mount)
  for (const unit of [paths.unit, mountUnit]) {
    const code = (await run(['/usr/bin/systemctl', 'stop', unit], { timeoutMs: 45000 })).code
    if (code !== 0 && code !== 5) throw new Error('operation_failed')
  }
  const mountinfo = await (options.mountinfo ?? (() => readFile('/proc/self/mountinfo', 'utf8')))()
  if (mountinfo.split('\n').some((line) => line.split(' ')[4] === paths.mount)) throw new Error('busy')

  const journal = (await present(join(paths.control, 'image.json')))
    ? await readPrivateJson(paths.control, 'image.json', imageJournalSchema, fs)
    : null
  for (const field of ['tenantId', 'physicalHostBinding', 'vaultId'] as const)
    if (journal && journal[field] !== key[field]) throw new Error('identity_mismatch')

  // 2. A loop device still attached to OUR image inode is detached; nothing else is touched.
  if (journal?.image && (await present(paths.image))) {
    const loops = await run([
      '/usr/sbin/losetup',
      '--list',
      '--json',
      '--output',
      'NAME,BACK-INO',
      '--associated',
      paths.image,
    ])
    if (loops.code !== 0) throw new Error('storage_unavailable')
    const parsed = z
      .object({
        loopdevices: z.array(z.object({ name: z.string().regex(/^\/dev\/loop\d+$/), 'back-ino': z.coerce.number() })),
      })
      .catch({ loopdevices: [] })
      .parse(loops.stdout.trim() ? JSON.parse(loops.stdout) : { loopdevices: [] })
    for (const loop of parsed.loopdevices) {
      if (loop['back-ino'] !== journal.image.inode) throw new Error('identity_mismatch')
      if ((await run(['/usr/sbin/losetup', '--detach', loop.name])).code !== 0) throw new Error('busy')
    }
  }

  // 3. Unit files: only exact recorded bytes are removed.
  const units = options.unitDirectory ?? '/etc/systemd/system'
  if (await present(join(paths.control, 'units.json'))) {
    const owned = await readPrivateJson(paths.control, 'units.json', unitOwnershipSchema, fs)
    for (const field of ['tenantId', 'physicalHostBinding', 'vaultId'] as const)
      if (owned[field] !== key[field]) throw new Error('identity_mismatch')
    const tmpfiles = options.tmpfilesDirectory ?? '/etc/tmpfiles.d'
    const assets = [
      [units, paths.unit, owned.serviceHash],
      [units, mountUnit, owned.mountHash],
      [tmpfiles, vaultTmpfilesName(record.receipt.vaultId), owned.tmpfilesHash],
    ] as const
    for (const [dir, name, hash] of assets)
      if ((await present(join(dir, name))) && sha(await readFile(join(dir, name))) !== hash)
        throw new Error('identity_mismatch')
    for (const [dir, name] of assets) if (await present(join(dir, name))) await unlink(join(dir, name))
    if ((await run(['/usr/bin/systemctl', 'daemon-reload'])).code !== 0) throw new Error('operation_failed')
  }

  // 4. The image: the recorded inode, or (crash before the inode journal) our exact birth stamp.
  if (await present(paths.image)) {
    if (journal?.image) {
      const file = await openPrivateFile(dirname(paths.image), basename(paths.image), fs)
      try {
        const info = await file.stat()
        if (info.dev !== journal.image.device || info.ino !== journal.image.inode) throw new Error('identity_mismatch')
      } finally {
        await file.close()
      }
    } else {
      const birth = await readPrivateJson(dirname(paths.image), basename(paths.image), birthStampSchema, fs).catch(
        () => {
          throw new Error('identity_mismatch')
        }
      )
      if (
        birth.creationRequestId !== record.operation.requestId &&
        journal?.creationRequestId !== birth.creationRequestId
      )
        throw new Error('identity_mismatch')
      for (const field of ['tenantId', 'physicalHostBinding', 'vaultId'] as const)
        if (birth[field] !== key[field]) throw new Error('identity_mismatch')
    }
    await unlink(paths.image)
  }

  // 5. The (unmounted) mountpoint must be empty: anything there landed on the Core disk.
  if (await present(paths.mount)) {
    try {
      await rmdir(paths.mount)
    } catch {
      throw new Error('storage_unavailable')
    }
  }

  // 5b. The root-prepared socket directory (stopped service; never another vault's).
  await rm(`/run/ficus-bigbrain/vaults/${record.receipt.vaultId}`, { recursive: true, force: true }).catch(() => {})

  // 6. The account, by exact numeric identity and full ownership marker.
  if (journal?.identity)
    await (options.removeIdentity ?? ((k, i) => removeManagedIdentity(k, i, run)))(key, journal.identity)

  // 7. Private material and journals; the receipt stays as a secret-free tombstone.
  for (const name of await readdir(paths.control))
    if (name !== 'receipt.json') await rm(join(paths.control, name), { recursive: true, force: true })
  if (await present(paths.handoff)) await unlink(paths.handoff)
  const tombstone = controlReceiptSchema.parse({
    ...deleting,
    phase: 'deleted',
    receipt: { ...deleting.receipt, state: 'deleted' },
    os: null,
  })
  await writePrivateJson(paths.control, 'receipt.json', tombstone, controlReceiptSchema, fs)
  return tombstone
}
