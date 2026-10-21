import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { InstalledHost } from './control-input'
import { memberAdapter, type MemberAdapterDeps } from './member-adapter'
import { memberAdminResultSchemas } from './member-admin'
import { BIGBRAIN_STATE_ROOT, managedPaths } from './paths'
import { listVaultRecords, startVaultService, type ProvisionDeps } from './provision'
import { runPrivateCommand } from './process'
import type { ControlReceipt } from './receipts'

/**
 * The vault's upstream server name: the `name` in its `.shared-identity.json`, which the BigBrain
 * app saves as the connection's name when an invite is redeemed and refreshes from `/v1/whoami` on
 * every sync. Ficus keeps it equal to the vault's Ficus display name. Every read and write is the
 * shipped member adapter as the vault's own UID (upstream's own identity and atomic-write
 * functions), so the id upstream generated is never fabricated or changed and the file keeps its
 * owner and 0600 mode. Callers hold the host lifecycle flock.
 */
export interface VaultNameDeps extends ProvisionDeps, MemberAdapterDeps {}

type Host = Pick<InstalledHost, 'artifactDigest'>
const vaultDirectory = (record: ControlReceipt, deps: VaultNameDeps) =>
  managedPaths({ vaultId: record.receipt.vaultId, root: deps.root }).vault

/** The id and name upstream currently records for this vault. */
export async function readVaultName(record: ControlReceipt, host: Host, deps: VaultNameDeps) {
  const raw = await memberAdapter(host, deps)(record, { op: 'vault-identity', vaultPath: vaultDirectory(record, deps) })
  const parsed = memberAdminResultSchemas['vault-identity'].safeParse(raw)
  if (!parsed.success) throw new Error('upstream_protocol')
  return parsed.data
}

/** Write `name` as the upstream server name. With no service running (create before the first
 * serve, restore before the restored store is served) this is the whole procedure; upstream
 * creates the identity file and its id when it is absent. The id must be the recorded one when
 * the receipt has one. */
export async function writeVaultName(record: ControlReceipt, name: string, host: Host, deps: VaultNameDeps) {
  const raw = await memberAdapter(host, deps)(record, {
    op: 'vault-name',
    vaultPath: vaultDirectory(record, deps),
    name,
  })
  const parsed = memberAdminResultSchemas['vault-name'].safeParse(raw)
  if (!parsed.success || parsed.data.name !== name) throw new Error('upstream_protocol')
  if (record.receipt.upstreamVaultId !== null && parsed.data.upstreamVaultId !== record.receipt.upstreamVaultId)
    throw new Error('identity_mismatch')
  return parsed.data
}

/** Make a SERVING vault's upstream name its recorded Ficus name, following upstream's guidance:
 * stop only this vault's unit, write the name, start it again and wait until it serves (with the
 * recorded upstream identity re-verified by startVaultService). Nothing happens when the names
 * already agree, so a replay or a repeated repair never restarts a vault. The unit is started
 * again even when the write fails. Routes, gateway and credentials are untouched. */
export async function syncVaultName(
  record: ControlReceipt,
  host: Host,
  deps: VaultNameDeps
): Promise<'unchanged' | 'renamed'> {
  if (record.phase !== 'ready' || record.receipt.state !== 'ready' || !record.os || !record.receipt.upstreamVaultId)
    throw new Error('generation_conflict')
  const current = await readVaultName(record, host, deps)
  if (current.upstreamVaultId !== record.receipt.upstreamVaultId) throw new Error('identity_mismatch')
  if (current.name === record.displayName) return 'unchanged'
  const run = deps.run ?? runPrivateCommand
  const unit = managedPaths({ vaultId: record.receipt.vaultId, root: deps.root }).unit
  if ((await run(['/usr/bin/systemctl', 'stop', unit], { timeoutMs: 45000 })).code !== 0)
    throw new Error('operation_failed')
  if ((await run(['/usr/bin/systemctl', 'is-active', '--quiet', unit])).code === 0) throw new Error('operation_failed')
  let written: unknown = null
  try {
    await writeVaultName(record, record.displayName, host, deps)
  } catch (error) {
    written = error
  }
  await startVaultService(record, deps)
  if (written) throw written
  return 'renamed'
}

/** Host upgrade: every vault served on an active host gets its Ficus name as its upstream name
 * once (vaults created before Ficus wrote it show upstream's default "Shared BigBrain"). One
 * vault's failure never blocks the others or the upgrade; it is counted, and the next upgrade
 * tries again. Suspended hosts and vaults stopped for a backup are left for a later upgrade. */
export async function repairVaultNames(
  host: Pick<InstalledHost, 'artifactDigest' | 'hostState'>,
  deps: VaultNameDeps
): Promise<{ repaired: number; failed: number }> {
  const result = { repaired: 0, failed: 0 }
  if (host.hostState !== 'active') return result
  // A backup's maintenance lease means its vaults are stopped on purpose: leave them be.
  const lease = join(deps.root ?? BIGBRAIN_STATE_ROOT, 'control', 'maintenance.json')
  if (
    await lstat(lease).then(
      () => true,
      (e) => e?.code !== 'ENOENT'
    )
  )
    return result
  for (const record of await listVaultRecords(deps)) {
    if (record.phase !== 'ready' || record.receipt.state !== 'ready') continue
    try {
      if ((await syncVaultName(record, host, deps)) === 'renamed') result.repaired++
    } catch {
      result.failed++
    }
  }
  return result
}
