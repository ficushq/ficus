/**
 * Bounded synchronization of each managed vault's host read handoff into exactly one pool
 * connection (vault state itself comes from the reconciler applying host receipts).
 *
 * Only lifecycle state moves here — never vault content. Every step is idempotent: a lost
 * acknowledgement or restart re-runs safely (an unbound connection whose configuration names the
 * vault is adopted, not duplicated). Revoked/deleted/non-ready vaults are fenced (material
 * forgotten, connection disabled). A connection is enabled when Ficus imports it or rotates in a
 * newly minted credential, and re-enabled when that enable did not stick: a failed import
 * validation or a runtime authentication failure leaves the connection of a readable vault
 * disabled with current material, and nothing else would ever enable it again. A person's disable
 * is never undone, and an upstream owner revocation is never silently repaired: enabling validates
 * the credential live, so a revoked reader stays off.
 *
 * Names are labels, never identity (see connection-names.ts): each live vault's connection carries
 * the vault's name, and a stale connection standing on it is moved aside.
 *
 * A failure is never silent: its safe code is logged and stored on the vault (shown in settings),
 * and the vault is retried with exponential backoff instead of every run.
 */
import { and, desc, eq, inArray } from 'drizzle-orm'
import { MANAGED_BIGBRAIN_UPSTREAM_COMMIT, type ManagedBigbrainCapabilities } from '@ficus/shared/managed-bigbrain'
import { db, integrationAuditEvents } from '../../../../db'
import { createLogger } from '../../../../lib/infra/logger'
import { isPlatformManaged } from '../../../secrets/managed'
import type { IntegrationConnectionRecord } from '../../connection-repository'
import { readMaterialMatches } from '../shared-client'
import { currentManagedBigbrainCapabilities } from './availability'
import type { ManagedSharedConfig } from './config'
import { managedConnectionNames, type ManagedConnectionNames } from './connection-names'
import { readManagedReadHandoff, splitReadHandoff } from './host-material'
import { managedReadVault } from './read-target'
import { MANAGED_VAULT_READABLE_STATES } from './readable'
import { ManagedVaultStoreError, managedReadMaterialSchema, managedVaultStore, type ManagedVault } from './store'

export const MANAGED_BIGBRAIN_SYNC_ACTOR = 'system:managed-bigbrain-sync'
/** Backoff after a failed synchronization of one vault: doubling from the first delay, capped. */
export const MANAGED_BIGBRAIN_SYNC_RETRY_FIRST_MS = 60_000
export const MANAGED_BIGBRAIN_SYNC_RETRY_MAX_MS = 15 * 60_000

const log = createLogger('managed-bigbrain-sync')

/** Whether the latest enable/disable of a connection was a person's (or an agent's) disable.
 * System actors (this synchronizer) and runtime authentication fences record no person. */
export async function connectionDisabledByPerson(connectionId: string): Promise<boolean> {
  const [latest] = await db
    .select({
      action: integrationAuditEvents.action,
      userId: integrationAuditEvents.userId,
      agentId: integrationAuditEvents.agentId,
    })
    .from(integrationAuditEvents)
    .where(
      and(
        eq(integrationAuditEvents.connectionId, connectionId),
        inArray(integrationAuditEvents.action, ['connection_enable', 'connection_disable'])
      )
    )
    .orderBy(desc(integrationAuditEvents.createdAt))
    .limit(1)
  return latest?.action === 'connection_disable' && Boolean(latest.userId || latest.agentId)
}

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
    /** The vault's current configuration when the connection's is stale; otherwise unchanged. */
    configuration: unknown,
    authorizationGrant: true
  ): Promise<unknown>
  enable(id: string, actor?: string): Promise<unknown>
  disable(id: string, actor?: string, confirmAssigned?: boolean): Promise<void>
}

export interface ManagedSyncDeps {
  store?: Pick<
    typeof managedVaultStore,
    | 'all'
    | 'clearReadMaterial'
    | 'recordReadMaterial'
    | 'bindConnection'
    | 'recordReadSyncFailure'
    | 'clearReadSyncFailure'
  >
  capabilities?: () => ManagedBigbrainCapabilities | null
  readHandoff?: typeof readManagedReadHandoff
  connections: ManagedSyncConnections
  /** Pool rows for this provider (adopting an orphan after a lost acknowledgement). */
  listConnections: () => Promise<readonly IntegrationConnectionRecord[]>
  getConnection: (id: string) => Promise<IntegrationConnectionRecord | null>
  /** Current secret for a connection's credentialRef (only compared, never returned). */
  credential: (ref: string) => string | undefined
  /** Whether a person turned this connection off (their disable is never undone here). */
  disabledByPerson?: (connectionId: string) => Promise<boolean>
  names?: ManagedConnectionNames
  now?: () => Date
}

export type ManagedSyncOutcome =
  | 'imported'
  | 'rotated'
  | 'current'
  /** The read connection of a readable vault was off without a person's disable; Ficus enabled it. */
  | 'reenabled'
  /** A recent attempt failed: this vault waits for its backoff. */
  | 'backoff'
  | 'pending_handoff'
  | 'handoff_mismatch'
  | 'fenced'
  | 'failed'
export interface ManagedSyncReport {
  skipped?: 'not_managed'
  vaults: Record<string, ManagedSyncOutcome>
}

type SyncStore = NonNullable<ManagedSyncDeps['store']>

export async function synchronizeManagedBigbrain(deps: ManagedSyncDeps): Promise<ManagedSyncReport> {
  const report: ManagedSyncReport = { vaults: {} }
  if (!isPlatformManaged()) return { ...report, skipped: 'not_managed' }
  const store = deps.store ?? managedVaultStore
  const now = (deps.now ?? (() => new Date()))()
  // Fences always run (they are local); imports need an eligible host right now.
  const capabilities = (deps.capabilities ?? currentManagedBigbrainCapabilities)()
  for (const row of await store.all()) {
    if (row.state === 'deleted' && !row.connectionId && !row.readMaterial) continue
    let outcome: ManagedSyncOutcome
    try {
      outcome = await reconcileVault(row, capabilities, deps, store, now)
    } catch (error) {
      outcome = 'failed'
      await recordFailure(row, syncErrorCode(error), store, now)
    }
    report.vaults[row.id] = outcome
    if (outcome === 'handoff_mismatch') await recordFailure(row, 'handoff_mismatch', store, now)
    else if (outcome !== 'failed' && outcome !== 'backoff' && outcome !== 'pending_handoff')
      await store.clearReadSyncFailure(row.id)
  }
  return report
}

async function recordFailure(row: ManagedVault, code: string, store: SyncStore, now: Date): Promise<void> {
  const delay = Math.min(
    MANAGED_BIGBRAIN_SYNC_RETRY_FIRST_MS * 2 ** Math.min(row.readSyncAttempts, 10),
    MANAGED_BIGBRAIN_SYNC_RETRY_MAX_MS
  )
  log.warn(`Managed vault ${row.id} read sync failed: ${code} (attempt ${row.readSyncAttempts + 1})`)
  try {
    await store.recordReadSyncFailure(row.id, code, new Date(now.getTime() + delay))
  } catch (error) {
    log.warn(`Managed vault ${row.id} read sync failure was not recorded: ${syncErrorCode(error)}`)
  }
}

async function reconcileVault(
  row: ManagedVault,
  capabilities: ManagedBigbrainCapabilities | null,
  deps: ManagedSyncDeps,
  store: SyncStore,
  now: Date
): Promise<ManagedSyncOutcome> {
  if (!MANAGED_VAULT_READABLE_STATES.includes(row.state) || row.readAccess !== 'active') {
    // Fence first: forget material, then disable the connection (an access fence, not deletion).
    if (row.readMaterial) await store.clearReadMaterial(row.id)
    if (row.connectionId && (await deps.getConnection(row.connectionId))?.enabled)
      await deps.connections.disable(row.connectionId, MANAGED_BIGBRAIN_SYNC_ACTOR, true)
    return 'fenced'
  }
  if (row.readSyncNextAt && row.readSyncNextAt > now) return 'backoff'
  if (!capabilities) return 'pending_handoff'
  const handoff = await (deps.readHandoff ?? readManagedReadHandoff)(row.id)
  if (!handoff) return 'pending_handoff'
  const { material, token } = splitReadHandoff(handoff)
  const vault = managedReadVault(row)
  if (!vault || !readMaterialMatches(capabilities, vault, material)) return 'handoff_mismatch'

  const names = deps.names ?? managedConnectionNames
  const configuration: ManagedSharedConfig = {
    version: 2,
    mode: 'managed_shared',
    vaultId: row.id,
    upstreamVaultId: material.upstreamVaultId,
    upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  }
  const stored = managedReadMaterialSchema.safeParse(row.readMaterial)
  let connectionId = row.connectionId
  if (!connectionId) {
    // A previous run may have created the connection and lost the bind acknowledgement. Identity
    // is the configuration's vault, never the name; a stale shape (another pin) is still ours.
    const orphan = (await deps.listConnections()).find(
      (c) => c.providerKey === 'bigbrain' && configuredVaultId(c.configuration) === row.id
    )
    connectionId = orphan?.id ?? null
  }
  const connection = connectionId ? await deps.getConnection(connectionId) : null
  const configurationCurrent = connection !== null && sameConfiguration(connection.configuration, configuration)
  const sameCredential =
    connection !== null &&
    configurationCurrent &&
    stored.success &&
    stored.data.credentialId === material.credentialId &&
    deps.credential(connection.credentialRef) === token
  await store.recordReadMaterial(row.id, material)
  if (connection) {
    if (!row.connectionId) await store.bindConnection(row.id, connection.id)
    if (connection.displayName !== row.displayName) {
      await names.free(row.displayName, connection.id)
      await names.rename(connection.id, row.displayName)
    }
  }
  if (connection && sameCredential) {
    if (!row.connectionId) {
      // Adopting our own orphaned import (its create acknowledgement was lost): finish the import.
      if (!connection.enabled) await deps.connections.enable(connection.id, MANAGED_BIGBRAIN_SYNC_ACTOR)
      return 'imported'
    }
    if (connection.enabled) return 'current'
    return reenable(connection, deps)
  }
  if (connection) {
    // A newly minted credential (explicit human reconnect) or a stale configuration: rotate,
    // then re-enable.
    await deps.connections.replaceCredential(
      connection.id,
      token,
      MANAGED_BIGBRAIN_SYNC_ACTOR,
      true,
      configurationCurrent ? undefined : configuration,
      true
    )
    await deps.connections.enable(connection.id, MANAGED_BIGBRAIN_SYNC_ACTOR)
    return 'rotated'
  }
  // The vault's name may still label a deleted vault's (or an abandoned) connection.
  await names.free(row.displayName, null)
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

/** A bound connection with current material that is off: Ficus's own enable failed (validation
 * during import or rotation) or a runtime authentication failure fenced it. Enabling validates the
 * credential live first, so this never repairs a reader the owner removed upstream. */
async function reenable(connection: IntegrationConnectionRecord, deps: ManagedSyncDeps): Promise<ManagedSyncOutcome> {
  if (await (deps.disabledByPerson ?? connectionDisabledByPerson)(connection.id)) return 'current'
  await deps.connections.enable(connection.id, MANAGED_BIGBRAIN_SYNC_ACTOR)
  return 'reenabled'
}

function configuredVaultId(configuration: unknown): string | null {
  if (!configuration || typeof configuration !== 'object') return null
  const value = configuration as { mode?: unknown; vaultId?: unknown }
  return value.mode === 'managed_shared' && typeof value.vaultId === 'string' ? value.vaultId : null
}

function sameConfiguration(stored: unknown, expected: ManagedSharedConfig): boolean {
  if (!stored || typeof stored !== 'object') return false
  const value = stored as Record<string, unknown>
  return (
    Object.keys(value).length === Object.keys(expected).length &&
    (Object.keys(expected) as (keyof ManagedSharedConfig)[]).every((key) => value[key] === expected[key])
  )
}

/** A safe, bounded code: never an error message, SQL text or provider body. */
function syncErrorCode(error: unknown): string {
  if (error instanceof ManagedVaultStoreError) return `store_${error.code}`
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : undefined
  for (const candidate of [error, cause]) {
    if (!(candidate instanceof Error)) continue
    const validation = /^Integration authentication failed: ([a-z0-9_]{1,48})$/.exec(candidate.message)?.[1]
    if (validation) return validation
    if ((candidate as { code?: unknown }).code === '23505') return 'connection_conflict'
  }
  return 'sync_failed'
}
