import { createHash } from 'node:crypto'
import { open, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  managedBigbrainArchiveInventorySchema,
  managedBigbrainRestoreGrantSchema,
  type ManagedBigbrainArchiveInventory,
  type ManagedBigbrainRestoreGrant,
} from '@ficus/shared/managed-bigbrain'
import { backupManifestSchema, MANAGED_BACKUP_DIR, type BackupManifest } from './backup'
import { installedHostSchema } from './control-input'
import { BIGBRAIN_ETC } from './install'
import { BIGBRAIN_STATE_ROOT } from './paths'
import { readPrivateJson, writePrivateJson } from './secure-files'

interface Options {
  root?: string
  etc?: string
  uid?: number
}
const stagingDir = (root: string) => join(root, 'restore', MANAGED_BACKUP_DIR)

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const file = await open(path, 'r')
  try {
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of file.readableWebStream()) {
      const data = chunk as Uint8Array
      hash.update(data)
      bytes += data.byteLength
    }
    return { sha256: `sha256:${hash.digest('hex')}`, bytes }
  } finally {
    await file.close()
  }
}

/** The staged archive as the fence sees it: strict file set, every hash re-verified. */
export async function readStagedArchive(
  options: Options = {}
): Promise<{ manifest: BackupManifest; inventory: ManagedBigbrainArchiveInventory }> {
  const root = options.root ?? BIGBRAIN_STATE_ROOT
  const uid = options.uid ?? 0
  const dir = stagingDir(root)
  const host = await readPrivateJson(options.etc ?? BIGBRAIN_ETC, 'host.json', installedHostSchema, { uid })
  const manifest = await readPrivateJson(dir, 'manifest.json', backupManifestSchema, { uid, maxBytes: 16384 })
  if (manifest.tenantId !== host.tenantId) throw new Error('identity_mismatch')
  const top = (await readdir(dir)).sort()
  const archives = (await readdir(join(dir, 'vaults'))).sort()
  const expected = manifest.vaults.map((v) => `${v.vaultId}.tar`).sort()
  if (
    JSON.stringify(top) !== JSON.stringify(['manifest.json', 'vaults']) ||
    JSON.stringify(archives) !== JSON.stringify(expected)
  )
    throw new Error('invalid_request')
  for (const vault of manifest.vaults) {
    const actual = await hashFile(join(dir, vault.archive))
    if (actual.sha256 !== vault.sha256 || actual.bytes !== vault.bytes) throw new Error('invalid_request')
  }
  const manifestDigest = `sha256:${createHash('sha256')
    .update(await readFile(join(dir, 'manifest.json')))
    .digest('hex')}`
  return {
    manifest,
    inventory: managedBigbrainArchiveInventorySchema.parse({
      tenantId: manifest.tenantId,
      sourcePhysicalHostBinding: manifest.sourcePhysicalHostBinding,
      manifestDigest,
      vaults: manifest.vaults.map(({ vaultId, upstreamVaultId, generation }) => ({
        vaultId,
        upstreamVaultId,
        generation,
      })),
    }),
  }
}

export const restorePlanSchema = z
  .object({
    schema: z.literal(1),
    manifestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    grants: z.array(managedBigbrainRestoreGrantSchema).max(2),
  })
  .strict()
export type RestorePlan = z.infer<typeof restorePlanSchema>

/** Authoritative current grants vs the staged inventory: exactly one grant per archived vault,
 * no unknown IDs, same digest; a restore keeps the upstream identity at a strictly newer
 * generation and always arrives read-revoked. Anything else fails closed.
 */
export function planRestore(
  inventory: ManagedBigbrainArchiveInventory,
  archiveManifestDigest: string,
  input: unknown[]
): ManagedBigbrainRestoreGrant[] {
  if (archiveManifestDigest !== inventory.manifestDigest) throw new Error('identity_mismatch')
  const grants = z.array(managedBigbrainRestoreGrantSchema).max(2).safeParse(input)
  if (!grants.success) throw new Error('invalid_request')
  const archived = new Map(inventory.vaults.map((v) => [v.vaultId, v]))
  const seen = new Set<string>()
  for (const grant of grants.data) {
    const source = archived.get(grant.vaultId)
    if (!source || seen.has(grant.vaultId)) throw new Error('invalid_request')
    seen.add(grant.vaultId)
    if (
      grant.disposition === 'restore' &&
      (grant.upstreamVaultId !== source.upstreamVaultId || grant.generation <= source.generation)
    )
      throw new Error('generation_conflict')
  }
  if (seen.size !== archived.size) throw new Error('invalid_request')
  return grants.data
}

/** Persist the grants OUTSIDE the extracted archive before any vault is restored. A retry must
 * present the identical plan; a different plan for the same staged archive is a conflict.
 */
export async function recordRestorePlan(
  grants: ManagedBigbrainRestoreGrant[],
  manifestDigest: string,
  options: Options = {}
): Promise<RestorePlan> {
  const dir = join(options.root ?? BIGBRAIN_STATE_ROOT, 'restore')
  const plan = restorePlanSchema.parse({ schema: 1, manifestDigest, grants })
  let existing: RestorePlan | null = null
  try {
    existing = await readPrivateJson(dir, 'plan.json', restorePlanSchema, { uid: options.uid })
  } catch {
    existing = null
  }
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(plan)) throw new Error('request_conflict')
    return existing
  }
  await writePrivateJson(dir, 'plan.json', plan, restorePlanSchema, { uid: options.uid })
  return plan
}

const BLOCK = 512
const ROOTS = new Set(['auth', 'vault'])
function field(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? length : end).toString('utf8')
}
function octal(header: Buffer, offset: number, length: number): number {
  const text = field(header, offset, length).trim()
  if (!/^[0-7]+$/.test(text)) throw new Error('invalid_request')
  const value = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value)) throw new Error('invalid_request')
  return value
}
function safeName(name: string): boolean {
  const parts = name.replace(/\/$/, '').split('/')
  return (
    name.length > 0 &&
    name.length <= 4096 &&
    !name.startsWith('/') &&
    !/[\p{Cc}\\]/u.test(name) &&
    ROOTS.has(parts[0]!) &&
    parts.every((p) => p !== '' && p !== '.' && p !== '..')
  )
}

/** Header-level inspection of a staged vault tarball BEFORE extraction (never trust tar to
 * refuse): only regular files and directories under auth/ and vault/, no links, devices, FIFOs,
 * absolute/parent paths or extended headers; bounded entry count and total size. GNU long
 * names are supported because the backup role writes GNU-format archives.
 */
export async function inspectVaultArchive(
  path: string,
  limits: { maxEntries: number; maxBytes: number }
): Promise<{ entries: number; bytes: number }> {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    let position = 0
    let entries = 0
    let bytes = 0
    let longName: string | null = null
    const header = Buffer.alloc(BLOCK)
    for (;;) {
      if (position + BLOCK > size) throw new Error('invalid_request')
      await file.read(header, 0, BLOCK, position)
      position += BLOCK
      if (header.every((b) => b === 0)) return { entries, bytes }
      let sum = 0
      for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!
      if (sum !== octal(header, 148, 8)) throw new Error('invalid_request')
      const type = String.fromCharCode(header[156]!)
      const length = octal(header, 124, 12)
      const padded = Math.ceil(length / BLOCK) * BLOCK
      if (type === 'L') {
        if (longName !== null || length > 4097 || position + padded > size) throw new Error('invalid_request')
        const data = Buffer.alloc(length)
        await file.read(data, 0, length, position)
        longName = data.toString('utf8').replace(/\0+$/, '')
        position += padded
        continue
      }
      const prefix = field(header, 345, 155)
      const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100))
      longName = null
      if (!safeName(name)) throw new Error('invalid_request')
      if (type === '5') {
        if (length !== 0) throw new Error('invalid_request')
      } else if (type !== '0' && type !== '\0') throw new Error('invalid_request')
      entries++
      bytes += length
      if (entries > limits.maxEntries || bytes > limits.maxBytes || position + padded > size)
        throw new Error('invalid_request')
      position += padded
    }
  } finally {
    await file.close()
  }
}
