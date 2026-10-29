/** Aggregate host admission forecast, NOT measured CPU utilization. Kernel
 * per-box quotas are unchanged; shared box identities are charged only once. */
export interface SandboxHostCapacity {
  allowed: boolean
  reason: 'unknown' | 'quota' | 'available' | 'already-accounted'
  cpus?: number
  budgetCpus?: number
  activeQuotaCpus?: number
  projectedQuotaCpus?: number
}
