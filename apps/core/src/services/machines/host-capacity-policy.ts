export type { SandboxHostCapacity as HostCapacityDecision } from '@ficus/shared'
import type { SandboxHostCapacity as HostCapacityDecision } from '@ficus/shared'

/** Concurrent physical box startups per host: half its CPUs, at least
 * {@link MIN_STARTUP_SLOTS} (also for unknown CPU facts) and at most
 * {@link MAX_STARTUP_SLOTS}. A startup is mostly short now (devbox installs from
 * a locked comfort set in seconds), and a flat two queued a deploy's
 * re-provision wave on an 8-CPU host for minutes (2026-10-30); squad toolchain
 * installs can still be heavy, so it stays bounded. Running boxes do not
 * consume these slots: their CPU/memory usage is constrained by cgroups. */
export const MIN_STARTUP_SLOTS = 2
export const MAX_STARTUP_SLOTS = 8
export function hostStartupLimit(cpus: number | undefined): number {
  if (cpus === undefined || !Number.isSafeInteger(cpus) || cpus <= 0) return MIN_STARTUP_SLOTS
  return Math.min(MAX_STARTUP_SLOTS, Math.max(MIN_STARTUP_SLOTS, Math.floor(cpus / 2)))
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
 * retries reuse their slot; queued work and uncertain old generations do not.
 * A `background` start (a warmup, reconcile or prewarm with no execution
 * waiting on the box) never takes the last free slot: there is no queue, so
 * without this reserve a waiting turn raced every background retry for it. */
export function withHostStartupCapacity(
  capacity: HostCapacityDecision,
  starting: readonly string[],
  incoming: readonly string[],
  options: { background?: boolean } = {}
): HostCapacityDecision {
  const current = new Set(starting)
  const projected = new Set([...current, ...incoming])
  const limit = capacity.startupLimit! - (options.background ? 1 : 0)
  const allowed = projected.size <= current.size || projected.size <= limit
  return {
    ...capacity,
    startingBoxes: current.size,
    allowed,
    reason: allowed ? capacity.reason : 'starting',
  }
}
