/**
 * Core worker reconciler for managed shared BigBrain vaults. Core's database is the vault
 * authority; this drains each row's pending host action through the local root helper (one row
 * per call, single-flight in the runner) and applies the returned receipt. A periodic status
 * sweep adopts what the host reports (a newer generation after a whole-instance restore, a
 * degraded vault, backup exclusion) and issues Core-authoritative follow-ups: deleting a vault a
 * restored host still runs although Core deleted it, and renaming when the host's name drifted.
 *
 * Exact per-vault DNS is created through Platform before the host create and removed after the
 * host delete. Helper output never reaches logs: only fixed codes are recorded on the row.
 */
import type { ManagedBigbrainHostReceipt, ManagedBigbrainInstalledHost } from '@ficus/shared/managed-bigbrain'
import { currentManagedBigbrainHost } from './availability'
import { ManagedHostError, type ManagedHostClient } from './host-client'
import { ManagedBigbrainPlatformError, type managedBigbrainPlatform } from './platform-client'
import { managedCreateRecipeSchema, managedVaultStore, type ManagedVault } from './store'

export interface ManagedReconcilerDeps {
  hostClient: Pick<ManagedHostClient, 'call'>
  platform: Pick<typeof managedBigbrainPlatform, 'ensureDns' | 'deleteDns'>
  store?: typeof managedVaultStore
  /** The eligible installed host (helper envelope); null while managed BigBrain is unavailable. */
  host?: () => ManagedBigbrainInstalledHost | null
  now?: () => Date
}
export type ReconcileOutcome = 'idle' | 'unavailable' | 'applied' | 'deleted' | 'retrying' | 'failed'

function failureOf(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof ManagedHostError || error instanceof ManagedBigbrainPlatformError)
    return { code: error.code, retryable: error.retryable }
  return { code: 'operation_failed', retryable: true }
}

/** `status` for one vault: its receipt, or null when the host has no record of it. */
async function status(
  deps: ManagedReconcilerDeps,
  host: ManagedBigbrainInstalledHost,
  vaultId: string
): Promise<ManagedBigbrainHostReceipt | null> {
  try {
    const reply = await deps.hostClient.call(host, crypto.randomUUID(), { action: 'status', vaultId })
    return 'receipt' in reply ? reply.receipt : null
  } catch (error) {
    if (error instanceof ManagedHostError && error.code === 'not_found') return null
    throw error
  }
}

async function applyPending(
  row: ManagedVault,
  host: ManagedBigbrainInstalledHost,
  deps: ManagedReconcilerDeps
): Promise<ReconcileOutcome> {
  const store = deps.store ?? managedVaultStore
  const requestId = row.operationRequestId!
  const fence = { vaultId: row.id, expectedGeneration: row.desiredGeneration - 1, generation: row.desiredGeneration }
  const receiptOf = (reply: object) => {
    if (!('receipt' in reply)) throw new ManagedHostError('invalid_response', false)
    return (reply as { receipt: ManagedBigbrainHostReceipt }).receipt
  }
  switch (row.desiredAction) {
    case 'create': {
      const recipe = managedCreateRecipeSchema.parse(row.createRecipe)
      await deps.platform.ensureDns(row.id, recipe.origin)
      const reply = await deps.hostClient.call(host, requestId, {
        action: 'create',
        vaultId: row.id,
        expectedGeneration: 0,
        generation: 1,
        displayName: row.displayName,
        owner: { userId: row.hostOwnerUserId!, handle: row.ownerHandle, display: row.ownerDisplay },
        origin: recipe.origin,
        limits: recipe.limits,
        upstreamCommit: recipe.upstreamCommit as never,
        artifactDigest: recipe.artifactDigest,
      })
      await store.applyReceipt(receiptOf(reply))
      return 'applied'
    }
    case 'rename': {
      const reply = await deps.hostClient.call(host, requestId, {
        action: 'rename',
        ...fence,
        displayName: row.displayName,
      })
      await store.applyReceipt(receiptOf(reply))
      return 'applied'
    }
    case 'read-revoke':
    case 'read-reconnect': {
      const reply = await deps.hostClient.call(host, requestId, { action: row.desiredAction, ...fence })
      await store.applyReceipt(receiptOf(reply))
      return 'applied'
    }
    case 'delete': {
      const current = await status(deps, host, row.id)
      if (current && current.state !== 'deleted') {
        // Fenced on the host's own generation and recorded name (the human confirmation was
        // already checked against Core's name).
        const reply = await deps.hostClient.call(host, requestId, {
          action: 'delete',
          vaultId: row.id,
          expectedGeneration: current.generation,
          generation: Math.max(row.desiredGeneration, current.generation + 1),
          confirmedVaultId: row.id,
          confirmedName: current.displayName,
        })
        receiptOf(reply)
      }
      await deps.platform.deleteDns(row.id)
      await store.finalizeTombstone(row.id)
      return 'deleted'
    }
    default:
      return 'idle'
  }
}

/** Drain one due pending operation. */
export async function reconcileNext(deps: ManagedReconcilerDeps): Promise<ReconcileOutcome> {
  const store = deps.store ?? managedVaultStore
  const now = (deps.now ?? (() => new Date()))()
  const [row] = await store.due(now, 1)
  if (!row || !row.operationRequestId) return 'idle'
  const host = (deps.host ?? currentManagedBigbrainHost)()
  if (!host) return 'unavailable'
  if (row.desiredAction === 'create' && row.hostOwnerUserId === null) {
    // Only a pre-instance-ownership row whose creator was deleted before the host create ran
    // (the anchor was then a user reference). Stop; a person deletes it and creates it again.
    await store.recordFailure(row.id, row.operationRequestId, { code: 'owner_removed', retryable: false, now })
    return 'failed'
  }
  try {
    return await applyPending(row, host, deps)
  } catch (error) {
    const failure = failureOf(error)
    // The host is ahead of or behind Core's fence: adopt what it reports and try again shortly.
    if (failure.code === 'generation_conflict' && row.desiredAction !== 'delete' && row.desiredAction !== 'create') {
      const current = await status(deps, host, row.id).catch(() => null)
      if (current) await store.applyReceipt(current).catch(() => {})
      failure.retryable = true
    }
    const updated = await store.recordFailure(row.id, row.operationRequestId, { ...failure, now })
    return updated?.retryable ? 'retrying' : 'failed'
  }
}

/** Status sweep over every row without a pending action. */
export async function sweepManagedVaults(deps: ManagedReconcilerDeps): Promise<Record<string, string>> {
  const store = deps.store ?? managedVaultStore
  const host = (deps.host ?? currentManagedBigbrainHost)()
  const report: Record<string, string> = {}
  if (!host) return report
  for (const row of await store.all()) {
    if (row.desiredAction !== null) continue
    try {
      const current = await status(deps, host, row.id)
      if (row.state === 'deleted') {
        // Deleted in Core after the backup a restored host came from: Core's tombstone wins.
        if (current && current.state !== 'deleted') {
          await store.scheduleFollowUp(row.id, 'delete')
          report[row.id] = 'delete_scheduled'
        }
        continue
      }
      if (!current) {
        // Created after the backup this host was restored from: nothing to serve. Not retryable.
        if (row.appliedGeneration > 0) {
          await store.markHostMissing(row.id)
          report[row.id] = 'missing'
        }
        continue
      }
      const applied = await store.applyReceipt(current)
      if (applied.state !== 'deleted' && current.displayName !== applied.displayName) {
        await store.scheduleFollowUp(row.id, 'rename')
        report[row.id] = 'rename_scheduled'
      } else report[row.id] = applied.state
    } catch (error) {
      report[row.id] = failureOf(error).code
    }
  }
  return report
}
