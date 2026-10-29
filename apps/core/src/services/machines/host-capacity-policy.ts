/** Admission target, not a change to kernel quotas or permission to evict work. */
export const HOST_CPU_OVERSUBSCRIPTION = 1.5

/** Mirrors box-provision.sh's unchanged CPUQuota=max(100%, nproc*50%). */
export function boxCpuQuota(cpus: number): number {
  return Math.max(1, cpus / 2)
}

export type { SandboxHostCapacity as HostCapacityDecision } from '@ficus/shared'
import type { SandboxHostCapacity as HostCapacityDecision } from '@ficus/shared'

/**
 * Charge unique box identities, never agent counts or sampled CPU utilization.
 * A shared squad box is charged once even when several agents can use it.
 * Existing activity is grandfathered if the host is already above the target:
 * admission limits growth; it must not block reconnects or terminate work.
 */
export function evaluateHostCapacity(
  cpus: number | undefined,
  active: readonly string[],
  incoming: readonly string[]
): HostCapacityDecision {
  return evaluateHostQuotaCounts(cpus, new Set(active).size, new Set([...active, ...incoming]).size)
}

/** Also supports atomic replacement of planned demand with actual resources. */
export function evaluateHostQuotaCounts(
  cpus: number | undefined,
  currentCount: number,
  projectedCount: number
): HostCapacityDecision {
  if (cpus === undefined || !Number.isSafeInteger(cpus) || cpus <= 0) {
    return { allowed: currentCount > 0 && projectedCount <= currentCount, reason: 'unknown' }
  }
  const quota = boxCpuQuota(cpus)
  const budgetCpus = cpus * HOST_CPU_OVERSUBSCRIPTION
  const activeQuotaCpus = currentCount * quota
  const projectedQuotaCpus = projectedCount * quota
  const unchanged = projectedCount <= currentCount
  // A one-CPU host must be able to start one minimal owner set (private +
  // shared). This is a bounded empty-host exception, not another box's slot.
  const minimalOwner = cpus === 1 && currentCount === 0 && projectedCount === 2
  const allowed = unchanged || minimalOwner || projectedQuotaCpus <= budgetCpus
  return {
    allowed,
    reason: unchanged ? 'already-accounted' : allowed ? 'available' : 'quota',
    cpus,
    budgetCpus,
    activeQuotaCpus,
    projectedQuotaCpus,
  }
}
