/**
 * Deployment eligibility for managed shared BigBrain vaults: capability-based, never a flag.
 *
 * Only a fresh, schema-valid Platform capability report for an installed, active host at the
 * pinned upstream revision makes managed mode available. No report, a stale report or any refusal
 * is unavailable. Each process (API and worker) keeps its own snapshot from its own refresh.
 */
import {
  MANAGED_BIGBRAIN_CONTRACT_VERSION,
  MANAGED_BIGBRAIN_SHARED_PROTOCOL,
  MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  managedBigbrainCapabilitiesSchema,
  type ManagedBigbrainCapabilities,
} from '@ficus/shared/managed-bigbrain'
import { isPlatformManaged } from '../../../secrets/managed'
import { bigbrainHostAvailability } from '../availability'

/** A capability report older than this is stale: managed mode becomes unavailable until refreshed. */
export const MANAGED_BIGBRAIN_CAPABILITY_TTL_MS = 10 * 60_000

let snapshot: { capabilities: ManagedBigbrainCapabilities; receivedAt: number } | null = null

/** Record the latest Platform capability report. Anything invalid clears eligibility. */
export function recordManagedBigbrainCapabilities(value: unknown, receivedAt = Date.now()): void {
  const parsed = managedBigbrainCapabilitiesSchema.safeParse(value)
  snapshot = parsed.success && Number.isFinite(receivedAt) ? { capabilities: parsed.data, receivedAt } : null
}
export function clearManagedBigbrainCapabilities(): void {
  snapshot = null
}
/** The current eligible capability report (for fences that need the tenant/host binding), or null. */
export function currentManagedBigbrainCapabilities(now = Date.now()): ManagedBigbrainCapabilities | null {
  return managedBigbrainAvailability(now).available ? snapshot!.capabilities : null
}

export function managedBigbrainAvailability(now = Date.now()): { available: boolean; reason?: string } {
  if (!isPlatformManaged())
    return { available: false, reason: 'Managed shared BigBrain vaults are available only on Ficus Cloud.' }
  if (!snapshot) return { available: false, reason: 'Managed BigBrain support has not been confirmed yet.' }
  const { capabilities, receivedAt } = snapshot
  if (now - receivedAt > MANAGED_BIGBRAIN_CAPABILITY_TTL_MS || receivedAt - now > 60_000)
    return { available: false, reason: 'Managed BigBrain support could not be confirmed recently.' }
  if (
    !capabilities.available ||
    !capabilities.installed ||
    capabilities.hostState !== 'active' ||
    capabilities.contractVersion !== MANAGED_BIGBRAIN_CONTRACT_VERSION ||
    capabilities.sharedProtocol !== MANAGED_BIGBRAIN_SHARED_PROTOCOL ||
    capabilities.upstreamCommit !== MANAGED_BIGBRAIN_UPSTREAM_COMMIT
  )
    return {
      available: false,
      reason: `Managed BigBrain is unavailable on this server (${capabilities.reasonCode ?? 'not_installed'}).`,
    }
  return { available: true }
}

/** Provider eligibility for this deployment: managed shared vaults on Ficus Cloud, a local
 * binding elsewhere. Local-binding code keeps using `bigbrainHostAvailability` directly. */
export function bigbrainDeploymentAvailability(now = Date.now()): { available: boolean; reason?: string } {
  return isPlatformManaged() ? managedBigbrainAvailability(now) : bigbrainHostAvailability()
}
