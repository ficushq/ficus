export type { SandboxHostCapacity as HostCapacityDecision } from '@ficus/shared'
import type { SandboxHostCapacity as HostCapacityDecision } from '@ficus/shared'

/** Provisioning installs/builds can be expensive. Serialize on small or unknown
 * hosts; allow at most two concurrent generations elsewhere. Running boxes do
 * not consume these slots: their CPU/memory usage is constrained by cgroups. */
export function hostStartupLimit(cpus: number | undefined): number {
  return cpus !== undefined && Number.isSafeInteger(cpus) && cpus >= 4 ? 2 : 1
}

/** CPU quotas are ceilings, not exclusive reservations. Squads share the host. */
export function evaluateHostCapacity(
  cpus: number | undefined,
  active: readonly string[],
  incoming: readonly string[]
): HostCapacityDecision {
  return evaluateHostBoxCounts(cpus, new Set(active).size, new Set([...active, ...incoming]).size)
}

/** Also supports atomic replacement of planned demand with actual resources. */
export function evaluateHostBoxCounts(
  cpus: number | undefined,
  currentCount: number,
  projectedCount: number
): HostCapacityDecision {
  const known = cpus !== undefined && Number.isSafeInteger(cpus) && cpus > 0
  return {
    allowed: true,
    reason: !known ? 'unknown' : projectedCount <= currentCount ? 'already-accounted' : 'available',
    ...(known ? { cpus } : {}),
    activeBoxes: currentCount,
    projectedBoxes: projectedCount,
    startupLimit: hostStartupLimit(cpus),
  }
}

/** Only live, admitted physical generations occupy startup slots. Same-box
 * retries reuse their slot; queued work and uncertain old generations do not. */
export function withHostStartupCapacity(
  capacity: HostCapacityDecision,
  starting: readonly string[],
  incoming: readonly string[]
): HostCapacityDecision {
  const current = new Set(starting)
  const projected = new Set([...current, ...incoming])
  const allowed = projected.size <= current.size || projected.size <= capacity.startupLimit!
  return {
    ...capacity,
    startingBoxes: current.size,
    allowed,
    reason: allowed ? capacity.reason : 'starting',
  }
}
