export const HUMAN_FALLBACK_MS = 15 * 60_000

/** An overloaded sandbox alerts only once it has stayed overloaded this long. */
export const SANDBOX_OVERLOAD_ALERT_AFTER_MS = 10 * 60_000
/**
 * An open overload episode with no load reading for this long is closed: its
 * box is no longer busy (the detector samples only boxes an agent is running
 * in, so it never wakes or keeps awake an idle box) or it stopped answering.
 * A reading after a longer gap starts a fresh episode rather than alerting on
 * load that was never observed to be sustained.
 */
export const SANDBOX_OVERLOAD_STALE_MS = 10 * 60_000

export type FleetIncidentAudience = 'manager' | 'human'
export type ManagerAlertDisposition = 'none' | 'deliver' | 'skip'

export interface FleetAlertAudiencePlan {
  manager: ManagerAlertDisposition
  humanDelayMs: number
}

const MANAGER_FIRST_SANDBOX_REASONS = new Set(['devbox_unavailable', 'bashrc_unavailable'])

export function planSandboxAlert(reasons: readonly string[], hasValidManager: boolean): FleetAlertAudiencePlan {
  if (!hasValidManager) return { manager: 'skip', humanDelayMs: 0 }

  const managerOnly = reasons.length > 0 && reasons.every((reason) => MANAGER_FIRST_SANDBOX_REASONS.has(reason))
  return { manager: 'deliver', humanDelayMs: managerOnly ? HUMAN_FALLBACK_MS : 0 }
}

/**
 * An overloaded sandbox is something its squad manager can fix (find and stop
 * the runaway job), so the manager hears first and humans after the standard
 * fallback. With no valid manager, humans hear immediately.
 */
export function planSandboxOverloadAlert(hasValidManager: boolean): FleetAlertAudiencePlan {
  if (!hasValidManager) return { manager: 'skip', humanDelayMs: 0 }
  return { manager: 'deliver', humanDelayMs: HUMAN_FALLBACK_MS }
}

/**
 * A long slot queue goes to the squad manager first, who can check the squad's
 * own holders; humans hear after the standard fallback if it persists.
 */
export function planSlotCapacityAlert(hasValidManager: boolean): FleetAlertAudiencePlan {
  if (!hasValidManager) return { manager: 'skip', humanDelayMs: 0 }
  return { manager: 'deliver', humanDelayMs: HUMAN_FALLBACK_MS }
}

export function planFleetAlert(input: {
  kind: 'provider_unhealthy' | 'squad_dead_fleet'
  causeCode: string
  hasValidManager: boolean
}): FleetAlertAudiencePlan {
  if (input.kind === 'provider_unhealthy') return { manager: 'none', humanDelayMs: 0 }
  return { manager: 'deliver', humanDelayMs: HUMAN_FALLBACK_MS }
}
