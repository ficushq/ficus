import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { managedBigbrainHostBindingSchema } from '../../packages/shared/src/managed-bigbrain'
import { controlReceiptSchema, type ControlReceipt } from './receipts'
import { imageJournalSchema } from './volume-image'
import { managedPaths } from './paths'
import { renderVaultUnits } from './units'
import {
  ensureOwnedDirectory,
  readPrivateJson,
  writePrivateJson,
  readPublicText,
  writePublicText,
} from './secure-files'
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/)
export const unitOwnershipSchema = managedBigbrainHostBindingSchema
  .omit({ hostEpoch: true })
  .extend({
    schema: z.literal(1),
    vaultId: managedBigbrainHostBindingSchema.shape.tenantId,
    artifactDigest: digest,
    serviceHash: digest,
    mountHash: digest,
  })
  .strict()
const hash = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`
interface Options {
  root?: string
  uid?: number
  unitDirectory?: string
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
/** Under the root lifecycle lock only. Verifies ALL targets before writing any. Unknown
 * root-owned files are not ownership proof: accept only recorded hashes or exact current
 * bytes (recovery after rename-before-journal). This installs assets, NOT an active service.
 */
export async function installVaultUnitAssets(input: ControlReceipt, options: Options = {}) {
  const record = controlReceiptSchema.parse(input)
  if (record.receipt.state === 'deleted' || ['deleting', 'deleted'].includes(record.phase)) throw new Error('forbidden')
  if (!record.receipt.origin) throw new Error('storage_unavailable')
  const paths = managedPaths({ vaultId: record.receipt.vaultId, root: options.root })
  const stored = await readPrivateJson(paths.control, 'receipt.json', controlReceiptSchema, options)
  if (JSON.stringify(stored) !== JSON.stringify(record)) throw new Error('generation_conflict')
  const image = await readPrivateJson(paths.control, 'image.json', imageJournalSchema, options)
  const key = {
    tenantId: record.receipt.tenantId,
    physicalHostBinding: record.receipt.physicalHostBinding,
    vaultId: record.receipt.vaultId,
  }
  for (const field of ['tenantId', 'physicalHostBinding', 'vaultId'] as const)
    if (image[field] !== key[field]) throw new Error('identity_mismatch')
  if (
    !image.formatted ||
    !image.identity ||
    !image.image ||
    JSON.stringify(image.storage) !== JSON.stringify(record.storage)
  )
    throw new Error('storage_unavailable')
  if (
    record.os &&
    (record.os.uid !== image.identity.uid ||
      record.os.gid !== image.identity.gid ||
      record.os.imageInode !== image.image.inode ||
      record.os.imageDevice !== image.image.device)
  )
    throw new Error('identity_mismatch')
  const units = await renderVaultUnits({
    reservation: record.storage,
    artifactDigest: record.receipt.artifactDigest,
    origin: record.receipt.origin,
    root: options.root,
  })
  const directory = options.unitDirectory ?? '/etc/systemd/system'
  await ensureOwnedDirectory(directory, 0o755, options)
  const previous = (await present(join(paths.control, 'units.json')))
    ? await readPrivateJson(paths.control, 'units.json', unitOwnershipSchema, options)
    : null
  if (previous)
    for (const field of ['tenantId', 'physicalHostBinding', 'vaultId'] as const)
      if (previous[field] !== key[field]) throw new Error('identity_mismatch')
  const assets = [
    { name: units.serviceUnitName, text: units.service, previousHash: previous?.serviceHash },
    { name: units.mountUnitName, text: units.mount, previousHash: previous?.mountHash },
  ]
  for (const asset of assets) {
    if (!(await present(join(directory, asset.name)))) continue
    const actual = await readPublicText(directory, asset.name, options)
    if (actual !== asset.text && (!asset.previousHash || hash(actual) !== asset.previousHash))
      throw new Error('identity_mismatch')
  }
  for (const asset of assets) await writePublicText(directory, asset.name, asset.text, options)
  await writePrivateJson(
    paths.control,
    'units.json',
    {
      ...key,
      schema: 1,
      artifactDigest: record.receipt.artifactDigest,
      serviceHash: hash(units.service),
      mountHash: hash(units.mount),
    },
    unitOwnershipSchema,
    options
  )
  return { serviceUnitName: units.serviceUnitName, mountUnitName: units.mountUnitName }
}
