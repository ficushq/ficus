/**
 * Deployment eligibility for managed shared BigBrain vaults: capability-based, never a flag.
 *
 * Available only when, within the TTL, three independent observations agree: the local helper
 * probe (this host runs the installed, active, pinned runtime), Platform's support report (its
 * pinned-SSH probe, certificate and zone coverage) and the root-owned installed host record, all
 * naming the same tenant, physical-host binding, epoch and zone. Anything missing, stale or
 * inconsistent is unavailable. Each process (API and worker) keeps its own snapshot.
 */
import {
  MANAGED_BIGBRAIN_CONTRACT_VERSION,
  MANAGED_BIGBRAIN_SHARED_PROTOCOL,
  MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  managedBigbrainCapabilitiesSchema,
  managedBigbrainInstalledHostSchema,
  type ManagedBigbrainCapabilities,
  type ManagedBigbrainInstalledHost,
} from '@ficus/shared/managed-bigbrain'
import { isPlatformManaged } from '../../../secrets/managed'
import { bigbrainHostAvailability } from '../availability'

/** A capability report older than this is stale: managed mode becomes unavailable until refreshed. */
export const MANAGED_BIGBRAIN_CAPABILITY_TTL_MS = 10 * 60_000

interface Snapshot {
  local: ManagedBigbrainCapabilities
  platform: ManagedBigbrainCapabilities
  host: ManagedBigbrainInstalledHost
  receivedAt: number
}
let snapshot: Snapshot | null = null
let refusal: string | null = null

function usable(c: ManagedBigbrainCapabilities): boolean {
  return (
    c.available &&
    c.installed &&
    c.hostState === 'active' &&
    c.contractVersion === MANAGED_BIGBRAIN_CONTRACT_VERSION &&
    c.sharedProtocol === MANAGED_BIGBRAIN_SHARED_PROTOCOL &&
    c.upstreamCommit === MANAGED_BIGBRAIN_UPSTREAM_COMMIT
  )
}

/** Record one refresh: the local probe, Platform's report and the installed host record. Any
 * invalid or disagreeing input clears eligibility (with a fixed reason code). */
export function recordManagedBigbrainSupport(
  input: { local: unknown; platform: unknown; host: unknown },
  receivedAt = Date.now()
): void {
  const local = managedBigbrainCapabilitiesSchema.safeParse(input.local)
  const platform = managedBigbrainCapabilitiesSchema.safeParse(input.platform)
  const host = managedBigbrainInstalledHostSchema.safeParse(input.host)
  snapshot = null
  if (!local.success || !platform.success || !host.success || !Number.isFinite(receivedAt)) {
    refusal = 'invalid_response'
    return
  }
  const [l, p, h] = [local.data, platform.data, host.data]
  if (!usable(l) || !usable(p)) {
    refusal = (!usable(l) ? l.reasonCode : p.reasonCode) ?? 'not_installed'
    return
  }
  const same = (c: ManagedBigbrainCapabilities) =>
    c.tenantId === h.tenantId &&
    c.physicalHostBinding === h.physicalHostBinding &&
    c.hostEpoch === h.hostEpoch &&
    c.zone === h.zone
  if (!same(l) || !same(p) || l.artifactDigest !== h.artifactDigest) {
    refusal = 'identity_mismatch'
    return
  }
  refusal = null
  snapshot = { local: l, platform: p, host: h, receivedAt }
}
export function clearManagedBigbrainCapabilities(): void {
  snapshot = null
  refusal = null
}
/** A failed refresh: a definite (non-retryable) refusal clears eligibility at once; a transient
 * failure (busy helper, unreachable Platform) keeps the last snapshot until its TTL expires it. */
export function noteManagedBigbrainCapabilityFailure(error: unknown): void {
  const retryable = typeof error === 'object' && error !== null && (error as { retryable?: unknown }).retryable === true
  if (retryable) return
  snapshot = null
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  refusal = typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : 'unavailable'
}
/** The local probe of an eligible host (tenant, binding, epoch, zone, pin), or null. */
export function currentManagedBigbrainCapabilities(now = Date.now()): ManagedBigbrainCapabilities | null {
  return managedBigbrainAvailability(now).available ? snapshot!.local : null
}
/** The installed host record of an eligible host (helper envelope, zone, limits), or null. */
export function currentManagedBigbrainHost(now = Date.now()): ManagedBigbrainInstalledHost | null {
  return managedBigbrainAvailability(now).available ? snapshot!.host : null
}

export function managedBigbrainAvailability(now = Date.now()): { available: boolean; reason?: string } {
  if (!isPlatformManaged())
    return { available: false, reason: 'Managed shared BigBrain vaults are available only on Ficus Cloud.' }
  if (!snapshot)
    return {
      available: false,
      reason: refusal
        ? `Managed BigBrain is unavailable on this server (${refusal}).`
        : 'Managed BigBrain support has not been confirmed yet.',
    }
  if (now - snapshot.receivedAt > MANAGED_BIGBRAIN_CAPABILITY_TTL_MS || snapshot.receivedAt - now > 60_000)
    return { available: false, reason: 'Managed BigBrain support could not be confirmed recently.' }
  return { available: true }
}

/** On Ficus Cloud every BigBrain connection is a managed shared vault: generic integration
 * endpoints must not bypass the managed lifecycle or disclose unassigned vaults. */
export function isManagedBigbrainProvider(providerKey: string | null | undefined): boolean {
  return providerKey === 'bigbrain' && isPlatformManaged()
}

/** Provider eligibility for this deployment: managed shared vaults on Ficus Cloud, a local
 * binding elsewhere. Local-binding code keeps using `bigbrainHostAvailability` directly. */
export function bigbrainDeploymentAvailability(now = Date.now()): { available: boolean; reason?: string } {
  return isPlatformManaged() ? managedBigbrainAvailability(now) : bigbrainHostAvailability()
}
