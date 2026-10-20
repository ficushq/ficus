import { createHash } from 'node:crypto'
import { open, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  MANAGED_BIGBRAIN_MAX_VAULTS,
  managedBigbrainArchiveInventorySchema,
  managedBigbrainOriginHasVault,
  managedBigbrainOwnerSchema,
  managedBigbrainVaultOrigin,
  parseManagedBigbrainOrigin,
  type ManagedBigbrainArchiveInventory,
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

/** One archived vault as this host restores it: identity, name and owner from the archive (Core's
 * restored database is the vault authority), the archived hostname label (bb-<32 hex> or
 * <tenant>-bb-<12 hex>, never re-derived from the current tenant label) in THIS host's installed
 * zone, a strictly newer generation, and read access always revoked. */
export const restoreEntrySchema = z
  .object({
    vaultId: z.string().uuid(),
    upstreamVaultId: z.string().uuid(),
    generation: z.number().int().safe().positive(),
    displayName: z.string().min(1).max(120),
    owner: managedBigbrainOwnerSchema,
    origin: z.string().max(253),
  })
  .strict()
export type RestoreEntry = z.infer<typeof restoreEntrySchema>
export const restorePlanSchema = z
  .object({
    schema: z.literal(2),
    manifestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    vaults: z.array(restoreEntrySchema).max(MANAGED_BIGBRAIN_MAX_VAULTS),
  })
  .strict()
export type RestorePlan = z.infer<typeof restorePlanSchema>

/** Every archived vault is restored (whole-instance restore semantics: a vault deleted after the
 * backup comes back, and Core reconciles it after boot). The digest must be the staged one. */
export function planArchiveRestore(
  manifest: BackupManifest,
  inventory: ManagedBigbrainArchiveInventory,
  archiveManifestDigest: string,
  zone: string
): RestoreEntry[] {
  if (archiveManifestDigest !== inventory.manifestDigest) throw new Error('identity_mismatch')
  const plan = manifest.vaults.map((v) => {
    // Archives without an origin predate tenant-prefixed hostnames: those vaults use bb-<32 hex>.
    const archived = v.origin === undefined ? null : parseManagedBigbrainOrigin(v.origin)
    if (v.origin !== undefined && (!archived || !managedBigbrainOriginHasVault(v.origin, v.vaultId)))
      throw new Error('identity_mismatch')
    const origin = managedBigbrainVaultOrigin({ vaultId: v.vaultId, zone, tenantLabel: archived?.tenantLabel ?? null })
    // Never silently change the recorded form (a prefixed label that cannot fit this zone).
    if (archived && parseManagedBigbrainOrigin(origin)?.tenantLabel !== archived.tenantLabel)
      throw new Error('identity_mismatch')
    return restoreEntrySchema.parse({
      vaultId: v.vaultId,
      upstreamVaultId: v.upstreamVaultId,
      generation: v.generation + 1,
      displayName: v.displayName,
      owner: v.owner,
      origin,
    })
  })
  // Two archived vaults behind one hostname would misroute: refuse the whole plan.
  if (new Set(plan.map((v) => new URL(v.origin).hostname)).size !== plan.length) throw new Error('identity_mismatch')
  return plan
}

/** Persist the plan OUTSIDE the extracted archive before any vault is restored. A retry for the
 * same staged archive must derive the identical plan; anything else is a conflict.
 */
export async function recordRestorePlan(
  vaults: RestoreEntry[],
  manifestDigest: string,
  options: Options = {}
): Promise<RestorePlan> {
  const dir = join(options.root ?? BIGBRAIN_STATE_ROOT, 'restore')
  const plan = restorePlanSchema.parse({ schema: 2, manifestDigest, vaults })
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
