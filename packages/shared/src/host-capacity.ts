/** Shared-host activity and physical startup concurrency, not reserved CPU. */
export interface SandboxHostCapacity {
  allowed: boolean
  reason: 'unknown' | 'quota' | 'available' | 'already-accounted' | 'starting'
  cpus?: number
  activeBoxes?: number
  projectedBoxes?: number
  startingBoxes?: number
  startupLimit?: number
  /** @deprecated Older Core versions reported summed CPU ceilings as capacity. */
  budgetCpus?: number
  /** @deprecated Not measured CPU usage or exclusive reservations. */
  activeQuotaCpus?: number
  /** @deprecated Not measured CPU usage or exclusive reservations. */
  projectedQuotaCpus?: number
}
