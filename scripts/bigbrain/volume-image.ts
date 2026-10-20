import { lstat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { managedBigbrainHostBindingSchema } from '../../packages/shared/src/managed-bigbrain'
import { ensureManagedIdentity, managedIdentityNames, type ManagedIdentity } from './accounts'
import { managedPaths } from './paths'
import { controlReceiptSchema, type ControlReceipt } from './receipts'
import { storageReservationSchema } from './storage'
import { ensureOwnedDirectory, openPrivateFile, readPrivateJson, writePrivateJson } from './secure-files'
import { runPrivateCommand, type PrivateCommandRunner } from './process'

const uint = z.number().int().safe().nonnegative()
const keySchema = managedBigbrainHostBindingSchema
  .omit({ hostEpoch: true })
  .extend({ vaultId: managedBigbrainHostBindingSchema.shape.tenantId })
  .strict()
const stampSchema = keySchema
  .extend({
    schema: z.literal(1),
    creationRequestId: managedBigbrainHostBindingSchema.shape.tenantId,
    creationHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict()
/** Root-private birth stamp written AS the image file before allocation (crash adoption proof). */
export const birthStampSchema = stampSchema
export const imageJournalSchema = stampSchema
  .extend({
    storage: storageReservationSchema,
    identity: z
      .object({ uid: uint.min(1).max(0xfffffffe), gid: uint.min(1).max(0xfffffffe) })
      .strict()
      .nullable(),
    image: z
      .object({ device: uint, inode: uint.min(1) })
      .strict()
      .nullable(),
    formatted: z.boolean(),
  })
  .strict()
  .refine((v) => !v.formatted || (v.identity !== null && v.image !== null))
export type ImageJournal = z.infer<typeof imageJournalSchema>
export type PreparedImage = ImageJournal & {
  identity: ManagedIdentity
  image: { device: number; inode: number }
  formatted: true
}
interface Options {
  root?: string
  uid?: number
  run?: PrivateCommandRunner
}

/** Root/fixture-only configuration; no request may supply these paths or owner overrides. */
export async function initializeStorageNamespace(options: Pick<Options, 'root' | 'uid'> = {}): Promise<void> {
  const paths = managedPaths({ vaultId: '00000000-0000-4000-8000-000000000001', root: options.root })
  await ensureOwnedDirectory(paths.root, 0o711, options)
  for (const [name, mode] of [
    ['control', 0o700],
    ['volumes', 0o700],
    ['vaults', 0o711],
  ] as const)
    await ensureOwnedDirectory(join(paths.root, name), mode, options)
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
function stamp(record: ControlReceipt) {
  return stampSchema.parse({
    schema: 1,
    tenantId: record.receipt.tenantId,
    physicalHostBinding: record.receipt.physicalHostBinding,
    vaultId: record.receipt.vaultId,
    creationRequestId: record.operation.requestId,
    creationHash: record.operation.inputHash,
  })
}
/** Must run under the lifecycle lock, AFTER the reserved ControlReceipt was fsynced.
 * This does not initialize a native vault or publish routes. It produces a preallocated,
 * owned ext4 image for the subsequent mount stage. An unrecorded image requires the exact
 * private birth stamp; its inode is then fsynced into the journal BEFORE fallocate/format.
 */
export async function prepareVaultImage(input: ControlReceipt, options: Options = {}): Promise<PreparedImage> {
  try {
    const parsed = controlReceiptSchema.safeParse(input)
    if (!parsed.success) throw new Error('storage_unavailable')
    const record = parsed.data
    if (record.phase !== 'reserved' || record.operation.action !== 'create' || record.os !== null)
      throw new Error('request_conflict')
    const paths = managedPaths({ vaultId: record.receipt.vaultId, root: options.root })
    const key = {
      tenantId: record.receipt.tenantId,
      physicalHostBinding: record.receipt.physicalHostBinding,
      vaultId: record.receipt.vaultId,
    }
    if (
      record.storage.image !== paths.image ||
      record.storage.mount !== paths.mount ||
      record.storage.username !== managedIdentityNames(key).username ||
      record.storage.diskBytes < 16 * 1024 ** 2
    )
      throw new Error('identity_mismatch')
    const stored = await readPrivateJson(paths.control, 'receipt.json', controlReceiptSchema, options)
    if (JSON.stringify(stored) !== JSON.stringify(record)) throw new Error('generation_conflict')
    const birth = stamp(record)
    let journal: ImageJournal
    if (await present(join(paths.control, 'image.json')))
      journal = await readPrivateJson(paths.control, 'image.json', imageJournalSchema, options)
    else {
      journal = imageJournalSchema.parse({
        ...birth,
        storage: record.storage,
        identity: null,
        image: null,
        formatted: false,
      })
      await writePrivateJson(paths.control, 'image.json', journal, imageJournalSchema, options)
    }
    const { storage: _storage, identity: _identity, image: _image, formatted: _formatted, ...recordedBirth } = journal
    if (
      JSON.stringify(recordedBirth) !== JSON.stringify(birth) ||
      JSON.stringify(journal.storage) !== JSON.stringify(record.storage)
    )
      throw new Error('identity_mismatch')
    const save = async () => writePrivateJson(paths.control, 'image.json', journal, imageJournalSchema, options)
    const run = options.run ?? runPrivateCommand
    const identity = await ensureManagedIdentity(key, run)
    if (journal.identity && (journal.identity.uid !== identity.uid || journal.identity.gid !== identity.gid))
      throw new Error('identity_mismatch')
    if (!journal.identity) {
      journal.identity = identity
      await save()
    }
    if (!journal.image) {
      if (!(await present(paths.image)))
        await writePrivateJson(dirname(paths.image), basename(paths.image), birth, stampSchema, options)
      // Full private stamp is an ownership proof even if the process died between its
      // atomic publication and the following inode journal write. Arbitrary bytes refuse.
      const raw = await openPrivateFile(dirname(paths.image), basename(paths.image), options)
      try {
        const prefix = Buffer.alloc(8193)
        const { bytesRead } = await raw.read(prefix, 0, prefix.length, 0)
        const newline = prefix.subarray(0, bytesRead).indexOf(10)
        if (newline < 0 || newline > 8192) throw new Error('storage_unavailable')
        const marker = stampSchema.parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(prefix.subarray(0, newline)))
        )
        if (JSON.stringify(marker) !== JSON.stringify(birth)) throw new Error('identity_mismatch')
        const info = await raw.stat()
        journal.image = { device: info.dev, inode: info.ino }
      } finally {
        await raw.close()
      }
      await save()
    }
    const verifyImage = async (allocated: boolean) => {
      const raw = await openPrivateFile(dirname(paths.image), basename(paths.image), options)
      try {
        const info = await raw.stat()
        if (
          info.dev !== journal.image!.device ||
          info.ino !== journal.image!.inode ||
          info.size > record.storage.diskBytes ||
          (allocated && (info.size !== record.storage.diskBytes || info.blocks * 512 < record.storage.diskBytes))
        )
          throw new Error('storage_unavailable')
        if (allocated) await raw.sync()
      } finally {
        await raw.close()
      }
    }
    const filesystem = async () => {
      const result = await run([
        '/usr/sbin/blkid',
        '--probe',
        '--output',
        'export',
        '-s',
        'TYPE',
        '-s',
        'UUID',
        '--',
        paths.image,
      ])
      if (result.code === 2) return false
      if (result.code !== 0) throw new Error('operation_failed')
      const fields = new Map(
        result.stdout
          .trim()
          .split('\n')
          .map((line) => {
            const at = line.indexOf('=')
            return [line.slice(0, at), line.slice(at + 1)]
          })
      )
      if (fields.get('TYPE') !== 'ext4' || fields.get('UUID') !== record.receipt.vaultId)
        throw new Error('storage_unavailable')
      return true
    }
    await verifyImage(journal.formatted)
    if (!(await filesystem())) {
      if (journal.formatted) throw new Error('storage_unavailable')
      if (
        (await run(['/usr/bin/fallocate', '--length', String(record.storage.diskBytes), '--', paths.image])).code !== 0
      )
        throw new Error('operation_failed')
      await verifyImage(true)
      if (
        (await run(['/usr/sbin/mkfs.ext4', '-F', '-q', '-U', record.receipt.vaultId, '--', paths.image])).code !== 0 ||
        !(await filesystem())
      )
        throw new Error('operation_failed')
    }
    await verifyImage(true)
    if (!journal.formatted) {
      journal.formatted = true
      await save()
    }
    return { ...journal, identity, image: journal.image!, formatted: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (
      [
        'storage_unavailable',
        'identity_mismatch',
        'request_conflict',
        'generation_conflict',
        'operation_failed',
      ].includes(message)
    )
      throw new Error(message)
    throw new Error('operation_failed')
  }
}
