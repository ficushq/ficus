import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readdir, rm, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  MANAGED_BIGBRAIN_MAX_VAULTS,
  managedBigbrainArchiveInventorySchema,
  managedBigbrainOwnerSchema,
  type ManagedBigbrainArchiveInventory,
} from '@ficus/shared/managed-bigbrain'
import { installedHostSchema } from './control-input'
import { managedPaths, BIGBRAIN_STATE_ROOT } from './paths'
import { controlReceiptSchema, type ControlReceipt } from './receipts'
import { readPrivateJson, writePrivateJson } from './secure-files'
import { runPrivateCommand, type PrivateCommandRunner } from './process'
import { BIGBRAIN_ETC } from './install'

const uuid = z
  .string()
  .uuid()
  .regex(/^[0-9a-f-]{36}$/)
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/)
/** Archive directory name inside the existing encrypted Core backup envelope. */
export const MANAGED_BACKUP_DIR = 'managed-bigbrain'
/** Secret-free: data tarballs carry the native stores; credentials are rotated on restore. */
export const backupManifestSchema = z
  .object({
    schema: z.literal(1),
    tenantId: uuid,
    sourcePhysicalHostBinding: uuid,
    vaults: z
      .array(
        z
          .object({
            vaultId: uuid,
            upstreamVaultId: uuid,
            generation: z.number().int().safe().positive(),
            displayName: z.string().min(1).max(120),
            owner: managedBigbrainOwnerSchema,
            archive: z.string().regex(/^vaults\/[0-9a-f-]{36}\.tar$/),
            sha256: digest,
            bytes: z.number().int().safe().positive(),
          })
          .strict()
      )
      .max(MANAGED_BIGBRAIN_MAX_VAULTS),
  })
  .strict()
  .refine((m) => m.vaults.every((v) => v.archive === `vaults/${v.vaultId}.tar`))
  .refine((m) => new Set(m.vaults.map((v) => v.vaultId)).size === m.vaults.length)
export type BackupManifest = z.infer<typeof backupManifestSchema>
const leaseSchema = z
  .object({ schema: z.literal(1), leaseId: uuid, stopped: z.array(uuid).max(MANAGED_BIGBRAIN_MAX_VAULTS) })
  .strict()

export interface BackupOptions {
  /** Fixture roots only; the installed role always uses the fixed paths. */
  root?: string
  etc?: string
  uid?: number
  run?: PrivateCommandRunner
  leaseId: string
  /** Mounted-storage identity check (image inode, loop backing, ext4 mount) before reading. */
  verifyStorage: (record: ControlReceipt) => Promise<void>
  freeBytes?: (path: string) => Promise<number>
}

const serviceUnit = (vaultId: string) => managedPaths({ vaultId }).unit
async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer)
    bytes += (chunk as Buffer).byteLength
  }
  return { sha256: `sha256:${hash.digest('hex')}`, bytes }
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
async function vaultRecords(root: string, uid: number): Promise<ControlReceipt[]> {
  const control = join(root, 'control')
  const names = (await readdir(control))
    .sort()
    .filter((n) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(n))
  const records = await Promise.all(
    names.map((vaultId) => readPrivateJson(join(control, vaultId), 'receipt.json', controlReceiptSchema, { uid }))
  )
  if (records.some((r, i) => r.receipt.vaultId !== names[i])) throw new Error('identity_mismatch')
  return records
}
const serving = (r: ControlReceipt) =>
  r.receipt.state !== 'deleted' && ['service_started', 'ready'].includes(r.phase) && r.receipt.upstreamVaultId !== null

/** Restart only what the lease stopped AND current desired state still wants running. A vault
 * deleted, suspended or replaced while staging stays stopped (no unconditional restart).
 */
async function restartStopped(stopped: string[], options: BackupOptions): Promise<void> {
  const root = options.root ?? BIGBRAIN_STATE_ROOT
  const uid = options.uid ?? 0
  const run = options.run ?? runPrivateCommand
  const host = await readPrivateJson(options.etc ?? BIGBRAIN_ETC, 'host.json', installedHostSchema, { uid })
  const current = new Map((await vaultRecords(root, uid)).map((r) => [r.receipt.vaultId, r]))
  let failed = false
  for (const vaultId of stopped) {
    const record = current.get(vaultId)
    if (host.hostState !== 'active' || !record || !serving(record)) continue
    if ((await run(['/usr/bin/systemctl', 'start', serviceUnit(vaultId)], { timeoutMs: 45000 })).code !== 0)
      failed = true
  }
  if (failed) throw new Error('operation_failed')
}

/** Recovery for a stager that died mid-maintenance. The caller MUST hold the host lifecycle
 * flock; the stager holds it for the whole stage, so a lease observed under the lock is proven
 * abandoned. Restarts per CURRENT desired state, then clears the lease. Idempotent.
 */
export async function reconcileMaintenance(
  options: Omit<BackupOptions, 'leaseId' | 'verifyStorage'>
): Promise<boolean> {
  const control = join(options.root ?? BIGBRAIN_STATE_ROOT, 'control')
  if (!(await present(join(control, 'maintenance.json')))) return false
  const lease = await readPrivateJson(control, 'maintenance.json', leaseSchema, { uid: options.uid })
  await restartStopped(lease.stopped, options as BackupOptions)
  await rm(join(control, 'maintenance.json'))
  return true
}

/** `backup-stage`, run by the existing local Core backup tool under the host lifecycle flock
 * (never a Platform/remote path). Quiesces ONLY serving vaults, copies each verified mounted
 * store into a fixed root-private staging directory, restarts per current desired state and
 * returns the bounded inventory. Any copy/verification failure fails the backup (never a
 * "changed while reading" success). Returns null when no managed host is installed.
 */
export async function stageManagedBackup(
  options: BackupOptions
): Promise<{ staging: string; inventory: ManagedBigbrainArchiveInventory } | null> {
  const root = options.root ?? BIGBRAIN_STATE_ROOT
  const etc = options.etc ?? BIGBRAIN_ETC
  const uid = options.uid ?? 0
  const run = options.run ?? runPrivateCommand
  if (!(await present(join(etc, 'host.json')))) return null
  const host = await readPrivateJson(etc, 'host.json', installedHostSchema, { uid })
  if (host.hostState === 'deleted') throw new Error('forbidden')
  await reconcileMaintenance(options)
  const records = (await vaultRecords(root, uid)).filter(serving)
  for (const r of records)
    if (r.receipt.tenantId !== host.tenantId || r.receipt.physicalHostBinding !== host.physicalHostBinding)
      throw new Error('identity_mismatch')
  const staging = join(root, 'backup')
  // Staging is root-private and fixed; a leftover from a crashed run is ours to discard.
  if (await present(staging)) {
    const info = await lstat(staging)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid) throw new Error('storage_unavailable')
    await rm(staging, { recursive: true })
  }
  const required = records.reduce((sum, r) => sum + r.storage.diskBytes, 0)
  const free = await (
    options.freeBytes ??
    (async (p: string) => {
      const s = await statfs(p)
      return s.bavail * s.bsize
    })
  )(root)
  if (free < required + host.limits.minCoreFreeDiskBytes) throw new Error('storage_unavailable')
  await mkdir(join(staging, MANAGED_BACKUP_DIR, 'vaults'), { recursive: true, mode: 0o700 })

  const stopped: string[] = []
  for (const r of records)
    if ((await run(['/usr/bin/systemctl', 'is-active', '--quiet', serviceUnit(r.receipt.vaultId)])).code === 0)
      stopped.push(r.receipt.vaultId)
  // Persisted BEFORE the first stop: a crash leaves an exact record of what to restart.
  await writePrivateJson(
    join(root, 'control'),
    'maintenance.json',
    { schema: 1, leaseId: options.leaseId, stopped },
    leaseSchema,
    {
      uid,
    }
  )
  const out = join(staging, MANAGED_BACKUP_DIR)
  const staged: BackupManifest['vaults'] = []
  try {
    for (const vaultId of stopped) {
      if ((await run(['/usr/bin/systemctl', 'stop', serviceUnit(vaultId)], { timeoutMs: 45000 })).code !== 0)
        throw new Error('operation_failed')
      if ((await run(['/usr/bin/systemctl', 'is-active', '--quiet', serviceUnit(vaultId)])).code === 0)
        throw new Error('operation_failed')
    }
    for (const r of records) {
      await options.verifyStorage(r)
      const archive = `vaults/${r.receipt.vaultId}.tar`
      const result = await run(
        [
          '/usr/bin/tar',
          '--create',
          '--file',
          join(out, archive),
          '--directory',
          r.storage.mount,
          '--one-file-system',
          '--numeric-owner',
          '--no-acls',
          '--no-xattrs',
          '--',
          'auth',
          'vault',
        ],
        { timeoutMs: 45000 }
      )
      // Vaults are stopped: ANY tar warning/error (including exit 1) fails the backup.
      if (result.code !== 0) throw new Error('operation_failed')
      staged.push({
        vaultId: r.receipt.vaultId,
        upstreamVaultId: r.receipt.upstreamVaultId!,
        generation: r.receipt.generation,
        displayName: r.displayName,
        owner: r.owner,
        archive,
        ...(await hashFile(join(out, archive))),
      })
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    try {
      await restartStopped(stopped, options)
      await rm(join(root, 'control', 'maintenance.json'))
    } catch {
      // The lease stays for reconcileMaintenance; the original failure is what we report.
    }
    throw error instanceof Error && /^[a-z_]+$/.test(error.message) ? error : new Error('operation_failed')
  }
  const manifest = backupManifestSchema.parse({
    schema: 1,
    tenantId: host.tenantId,
    sourcePhysicalHostBinding: host.physicalHostBinding,
    vaults: staged,
  })
  await writePrivateJson(out, 'manifest.json', manifest, backupManifestSchema, { uid })
  await restartStopped(stopped, options)
  await rm(join(root, 'control', 'maintenance.json'))
  const manifestDigest = (await hashFile(join(out, 'manifest.json'))).sha256
  return {
    staging,
    inventory: managedBigbrainArchiveInventorySchema.parse({
      tenantId: host.tenantId,
      sourcePhysicalHostBinding: host.physicalHostBinding,
      manifestDigest,
      vaults: staged.map(({ vaultId, upstreamVaultId, generation }) => ({ vaultId, upstreamVaultId, generation })),
    }),
  }
}

/** `backup-release`: discard the staged copy after the envelope was written (or failed). */
export async function releaseManagedBackup(options: { root?: string; uid?: number } = {}): Promise<void> {
  const staging = join(options.root ?? BIGBRAIN_STATE_ROOT, 'backup')
  if (!(await present(staging))) return
  const info = await lstat(staging)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== (options.uid ?? 0))
    throw new Error('storage_unavailable')
  await rm(staging, { recursive: true })
}

/** `ficus-bigbrain-host backup-stage|backup-release|reconcile-maintenance`, root only, no argv.
 * The caller (Core's backup script) holds the host lifecycle flock. Output is one safe JSON line.
 */
export async function backupMain(role: 'backup-stage' | 'backup-release' | 'reconcile-maintenance', args: string[]) {
  const { randomUUID } = await import('node:crypto')
  const { verifyRecordedVaultStorage } = await import('./preflight')
  try {
    if (process.getuid?.() !== 0 || args.length !== 0) throw new Error('invalid_request')
    const { dirname } = await import('node:path')
    const { verifyRunningInterpreter } = await import('./preflight')
    await verifyRunningInterpreter(dirname(Bun.main))
    if (role === 'backup-release') {
      await releaseManagedBackup()
      console.log(JSON.stringify({ ok: true }))
    } else if (role === 'reconcile-maintenance') {
      console.log(JSON.stringify({ ok: true, recovered: await reconcileMaintenance({}) }))
    } else {
      const result = await stageManagedBackup({
        leaseId: randomUUID(),
        verifyStorage: (record) => verifyRecordedVaultStorage(record.receipt.vaultId),
      })
      console.log(JSON.stringify(result ? { ok: true, staged: true, ...result } : { ok: true, staged: false }))
    }
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]{1,40}$/.test(error.message) ? error.message : 'operation_failed'
    console.log(JSON.stringify({ ok: false, code }))
    process.exitCode = 1
  }
}
