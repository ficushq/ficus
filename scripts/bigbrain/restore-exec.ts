import { createHash } from 'node:crypto'
import { lstat, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { MANAGED_BACKUP_DIR } from './backup'
import { NativeVaultAdmin } from './native-admin'
import { BIGBRAIN_STATE_ROOT, GATEWAY_UNIT, managedPaths } from './paths'
import {
  markReady,
  prepareStorage,
  readHost,
  readUpstreamIdentity,
  readVaultRecord,
  reserveStorage,
  saveVaultRecord,
  startVaultService,
} from './provision'
import { controlReceiptSchema, type ControlReceipt } from './receipts'
import {
  inspectVaultArchive,
  planArchiveRestore,
  readStagedArchive,
  recordRestorePlan,
  restorePlanSchema,
  type RestoreEntry,
} from './restore'
import { readPrivateJson } from './secure-files'
import { runPrivateCommand, startServiceDeliberately } from './process'
import { writeVaultName, type VaultNameDeps } from './vault-name'
import type { InstalledHost } from './control-input'

export interface RestoreDeps extends VaultNameDeps {
  /** Native administration as the vault's own UID (default NativeVaultAdmin). */
  admin?: (record: ControlReceipt) => Pick<NativeVaultAdmin, 'listMembers' | 'listCredentials' | 'revokeCredential'>
  ingress?: () => Promise<unknown>
}
export interface RestoreRequest {
  requestId: string
  effectId: string
  archiveManifestDigest: string
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
const sha = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`

/** storage_ready -> initialized for ONE restored vault. The archive was header-inspected (only
 * regular files/directories under auth/ and vault/), so root extraction cannot escape the
 * verified mount; ownership is then given to the NEW vault account (archived numeric owners are
 * ignored). The store must carry the granted upstream identity and owner. Its upstream server name
 * becomes the vault's recorded Ficus name (Core's, not whatever the archive's identity file says),
 * written as the new vault UID before the store is first served. Every imported
 * credential and invitation is revoked: the owner reconnects through a fresh owner link and Ficus
 * read access stays revoked until a human reconnects it.
 */
async function loadVault(
  record: ControlReceipt,
  grant: RestoreEntry,
  archive: string,
  host: InstalledHost,
  deps: RestoreDeps
): Promise<ControlReceipt> {
  const run = deps.run ?? runPrivateCommand
  const paths = managedPaths({ vaultId: record.receipt.vaultId, root: deps.root })
  await inspectVaultArchive(archive, { maxEntries: 200000, maxBytes: record.storage.diskBytes })
  const checked = async (argv: string[]) => {
    if ((await run(argv, { timeoutMs: 45000 })).code !== 0) throw new Error('operation_failed')
  }
  // A crashed earlier attempt may have left a partial tree: start from empty, never merge.
  for (const dir of [paths.mount + '/auth', paths.vault])
    await checked(['/usr/bin/find', dir, '-mindepth', '1', '-delete'])
  await checked([
    '/usr/bin/tar',
    '--extract',
    '--file',
    archive,
    '--directory',
    paths.mount,
    '--no-same-owner',
    '--no-same-permissions',
    '--no-overwrite-dir',
    '--delay-directory-restore',
    '--',
    'auth',
    'vault',
  ])
  if ((await readUpstreamIdentity(record, deps)) !== grant.upstreamVaultId) throw new Error('identity_mismatch')
  for (const dir of [paths.mount + '/auth', paths.vault]) {
    await checked(['/usr/bin/chown', '-R', '--no-dereference', `${record.os!.uid}:${record.os!.gid}`, '--', dir])
    await checked(['/usr/bin/chmod', '-R', 'go-rwx', '--', dir])
  }
  await writeVaultName(record, record.displayName, host, deps)
  // Every pending invitation and app link from the archive is void on this host.
  if (await present(`${paths.memberStore}.invites.json`)) await unlink(`${paths.memberStore}.invites.json`)
  const admin = (deps.admin ?? ((r) => new NativeVaultAdmin(r, { root: deps.root, run })))(record)
  const owners = (await admin.listMembers()).filter((m) => m.role === 'owner' && m.revoked === null)
  if (owners.length !== 1 || owners[0]!.handle !== grant.owner.handle) throw new Error('identity_mismatch')
  for (const credential of await admin.listCredentials())
    if (credential.revoked === null) await admin.revokeCredential(credential.id)
  return saveVaultRecord({ ...record, phase: 'initialized' }, deps)
}

/** `restore`: every vault in the fenced, re-verified staged archive. Each gets fresh local
 * storage, account and socket on THIS host at a newer generation, keeps its upstream identity
 * and arrives read-revoked with every credential and invite revoked. Idempotent per vault
 * phase; the staged plaintext copy is discarded once every vault is ready. Core reconciles its
 * restored rows (including later-deleted vaults) against these receipts after boot.
 */
export async function executeRestore(request: RestoreRequest, deps: RestoreDeps): Promise<ControlReceipt[]> {
  const root = deps.root ?? BIGBRAIN_STATE_ROOT
  const host = await readHost(deps)
  const staging = join(root, 'restore', MANAGED_BACKUP_DIR)
  let plan: RestoreEntry[]
  const staged = await present(staging)
  if (staged) {
    const { manifest, inventory } = await readStagedArchive({ root: deps.root, etc: deps.etc, uid: deps.uid })
    plan = planArchiveRestore(manifest, inventory, request.archiveManifestDigest, host.zone)
    await recordRestorePlan(plan, inventory.manifestDigest, { root: deps.root, uid: deps.uid })
  } else {
    // Staging already discarded: only an exact replay of the completed plan is answerable.
    const recorded = await readPrivateJson(join(root, 'restore'), 'plan.json', restorePlanSchema, {
      uid: deps.uid,
    }).catch(() => {
      throw new Error('storage_unavailable')
    })
    if (recorded.manifestDigest !== request.archiveManifestDigest) throw new Error('request_conflict')
    plan = recorded.vaults
  }
  const restored: ControlReceipt[] = []
  for (const grant of plan) {
    let record = await readVaultRecord(grant.vaultId, deps)
    if (!record) {
      if (!staged) throw new Error('storage_unavailable')
      const storage = await reserveStorage(grant.vaultId, host, deps)
      record = await saveVaultRecord(
        controlReceiptSchema.parse({
          schema: 1,
          phase: 'reserved',
          // The archived name: Core's restored database holds the same backup point and its
          // reconciler renames if it later differs.
          displayName: grant.displayName,
          owner: grant.owner,
          operation: {
            requestId: request.requestId,
            action: 'create',
            inputHash: sha({ effectId: request.effectId, digest: request.archiveManifestDigest, grant }),
            expectedGeneration: grant.generation - 1,
          },
          receipt: {
            receiptId: request.effectId,
            tenantId: host.tenantId,
            physicalHostBinding: host.physicalHostBinding,
            vaultId: grant.vaultId,
            hostEpoch: host.hostEpoch,
            generation: grant.generation,
            upstreamVaultId: grant.upstreamVaultId,
            displayName: grant.displayName,
            state: 'provisioning',
            upstreamCommit: host.upstreamCommit,
            artifactDigest: host.artifactDigest,
            localPort: storage.port,
            origin: grant.origin,
            readAccess: 'revoked',
          },
          storage,
          os: null,
        }),
        deps
      )
    } else if (record.operation.requestId !== request.requestId || record.receipt.generation !== grant.generation)
      throw new Error('request_conflict')
    record = await prepareStorage(record, deps)
    if (record.phase === 'storage_ready')
      record = await loadVault(record, grant, join(staging, `vaults/${grant.vaultId}.tar`), host, deps)
    record = await startVaultService(record, deps)
    record = await markReady(record, deps)
    restored.push(record)
  }
  // The restore fence stopped the gateway with every vault: reopen ingress only now that every
  // archived vault runs.
  if (!(await startServiceDeliberately(deps.run ?? runPrivateCommand, GATEWAY_UNIT)))
    throw new Error('operation_failed')
  await (deps.ingress ?? (async () => {}))()
  await rm(staging, { recursive: true, force: true })
  return restored
}
