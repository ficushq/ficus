/**
 * Bounded synchronization of managed shared vaults: Platform capability + vault summaries into
 * Core's store, and each ready vault's host read handoff into exactly one pool connection.
 *
 * Only lifecycle state moves here — never vault content. Every step is idempotent: a lost
 * acknowledgement or restart re-runs safely (an orphaned connection for the vault is adopted, not
 * duplicated). Revoked/deleted/non-ready vaults are fenced (material forgotten, connection
 * disabled). A connection is enabled only when Ficus imports it or rotates in a newly minted
 * credential; a human's disable is never undone, and an upstream owner revocation is never
 * silently repaired.
 */
import { MANAGED_BIGBRAIN_UPSTREAM_COMMIT, type ManagedBigbrainCapabilities } from '@ficus/shared/managed-bigbrain'
import { isPlatformManaged } from '../../../secrets/managed'
import type { IntegrationConnectionRecord } from '../../connection-repository'
import { readMaterialMatches } from '../shared-client'
import { noteManagedBigbrainCapabilityFailure, recordManagedBigbrainCapabilities } from './availability'
import { isManagedSharedConfig, type ManagedSharedConfig } from './config'
import { readManagedReadHandoff, splitReadHandoff } from './host-material'
import { managedBigbrainPlatform } from './platform-client'
import { managedReadVault } from './read-target'
import { managedReadMaterialSchema, managedVaultStore, type ManagedVault } from './store'

export const MANAGED_BIGBRAIN_SYNC_ACTOR = 'system:managed-bigbrain-sync'

export interface ManagedSyncConnections {
  create(input: {
    providerKey: string
    adapterVersion: number
    displayName: string
    configuration: unknown
    credential: string
    actor: string
    authorizationGrant: true
  }): Promise<{ id: string }>
  replaceCredential(
    id: string,
    credential: string,
    actor: string,
    confirmAssigned: boolean,
    configuration: undefined,
    authorizationGrant: true
  ): Promise<unknown>
  enable(id: string, actor?: string): Promise<unknown>
  disable(id: string, actor?: string, confirmAssigned?: boolean): Promise<void>
}

export interface ManagedSyncDeps {
  platform?: Pick<typeof managedBigbrainPlatform, 'capabilities' | 'listVaults'>
  store?: typeof managedVaultStore
  readHandoff?: typeof readManagedReadHandoff
  connections: ManagedSyncConnections
  /** Pool rows for this provider (adopting an orphan after a lost acknowledgement). */
  listConnections: () => Promise<readonly IntegrationConnectionRecord[]>
  getConnection: (id: string) => Promise<IntegrationConnectionRecord | null>
  /** Current secret for a connection's credentialRef (only compared, never returned). */
  credential: (ref: string) => string | undefined
}

export type ManagedSyncOutcome =
  | 'imported'
  | 'rotated'
  | 'current'
  | 'pending_handoff'
  | 'handoff_mismatch'
  | 'fenced'
  | 'failed'
export interface ManagedSyncReport {
  skipped?: 'not_managed' | 'capabilities_unavailable' | 'unavailable'
  vaults: Record<string, ManagedSyncOutcome>
}

export async function synchronizeManagedBigbrain(deps: ManagedSyncDeps): Promise<ManagedSyncReport> {
  const report: ManagedSyncReport = { vaults: {} }
  if (!isPlatformManaged()) return { ...report, skipped: 'not_managed' }
  const platform = deps.platform ?? managedBigbrainPlatform
  const store = deps.store ?? managedVaultStore
  let capabilities: ManagedBigbrainCapabilities
  try {
    capabilities = await platform.capabilities()
  } catch (error) {
    noteManagedBigbrainCapabilityFailure(error)
    return { ...report, skipped: 'capabilities_unavailable' }
  }
  recordManagedBigbrainCapabilities(capabilities)
  // Unavailable/suspended: reads already fail closed through availability; import nothing.
  if (!capabilities.available) return { ...report, skipped: 'unavailable' }
  const { items } = await platform.listVaults()
  const touched = new Set<string>()
  for (const summary of items) {
    if (!(await store.get(summary.vaultId))) continue // created elsewhere: never adopted blindly
    try {
      await store.applySummary(summary)
      touched.add(summary.vaultId)
    } catch {
      report.vaults[summary.vaultId] = 'failed'
    }
  }
  for (const id of touched) {
    const row = await store.get(id)
    if (!row) continue
    try {
      report.vaults[id] = await reconcileVault(row, capabilities, deps, store)
    } catch {
      report.vaults[id] = 'failed'
    }
  }
  return report
}

async function reconcileVault(
  row: ManagedVault,
  capabilities: ManagedBigbrainCapabilities,
  deps: ManagedSyncDeps,
  store: typeof managedVaultStore
): Promise<ManagedSyncOutcome> {
  if (row.state !== 'ready' || row.readAccess !== 'active') {
    // Fence first: forget material, then disable the connection (an access fence, not deletion).
    if (row.readMaterial) await store.clearReadMaterial(row.id)
    if (row.connectionId && (await deps.getConnection(row.connectionId))?.enabled)
      await deps.connections.disable(row.connectionId, MANAGED_BIGBRAIN_SYNC_ACTOR, true)
    return 'fenced'
  }
  const handoff = await (deps.readHandoff ?? readManagedReadHandoff)(row.id)
  if (!handoff) return 'pending_handoff'
  const { material, token } = splitReadHandoff(handoff)
  const vault = managedReadVault(row)
  if (!vault || !readMaterialMatches(capabilities, vault, material)) return 'handoff_mismatch'

  const stored = managedReadMaterialSchema.safeParse(row.readMaterial)
  let connectionId = row.connectionId
  if (!connectionId) {
    // A previous run may have created the connection and lost the bind acknowledgement.
    const orphan = (await deps.listConnections()).find(
      (c) =>
        c.providerKey === 'bigbrain' && isManagedSharedConfig(c.configuration) && c.configuration.vaultId === row.id
    )
    connectionId = orphan?.id ?? null
  }
  const connection = connectionId ? await deps.getConnection(connectionId) : null
  const sameCredential =
    connection !== null &&
    stored.success &&
    stored.data.credentialId === material.credentialId &&
    deps.credential(connection.credentialRef) === token
  await store.recordReadMaterial(row.id, material)
  if (connection && sameCredential) {
    if (row.connectionId) return 'current'
    // Adopting our own orphaned import (its create acknowledgement was lost): finish the import.
    await store.bindConnection(row.id, connection.id)
    if (!connection.enabled) await deps.connections.enable(connection.id, MANAGED_BIGBRAIN_SYNC_ACTOR)
    return 'imported'
  }
  if (connection) {
    // A newly minted credential (explicit human reconnect): rotate, then re-enable.
    if (!row.connectionId) await store.bindConnection(row.id, connection.id)
    await deps.connections.replaceCredential(connection.id, token, MANAGED_BIGBRAIN_SYNC_ACTOR, true, undefined, true)
    await deps.connections.enable(connection.id, MANAGED_BIGBRAIN_SYNC_ACTOR)
    return 'rotated'
  }
  const configuration: ManagedSharedConfig = {
    version: 2,
    mode: 'managed_shared',
    vaultId: row.id,
    upstreamVaultId: material.upstreamVaultId,
    upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  }
  const created = await deps.connections.create({
    providerKey: 'bigbrain',
    adapterVersion: 2,
    displayName: row.displayName,
    configuration,
    credential: token,
    actor: MANAGED_BIGBRAIN_SYNC_ACTOR,
    authorizationGrant: true,
  })
  await store.bindConnection(row.id, created.id)
  await deps.connections.enable(created.id, MANAGED_BIGBRAIN_SYNC_ACTOR)
  return 'imported'
}
