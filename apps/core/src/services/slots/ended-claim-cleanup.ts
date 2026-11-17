import { createLogger } from '../../lib/infra/logger'

const log = createLogger('slot-ended-claim')

/** A claim that ended, for stopping what its owner started under it. */
export interface EndedClaimCleanupInput {
  claimId: string
  agentId: string
  squadId: string
  poolKey: string
  reason: 'claim-released' | 'claim-expired'
}

/**
 * Stop what the owner's commands started while holding an ended claim
 * (sandbox/leftover-processes.ts). Runs in the background, after the claim's
 * transaction has committed: the box allows a grace period, and nothing here
 * may fail or delay a release or an expiry notice.
 */
function stopLeftoversOfEndedClaim(claim: EndedClaimCleanupInput): void {
  void import('../sandbox/leftover-processes')
    .then(({ stopLeftoversForEndedClaim }) => stopLeftoversForEndedClaim(claim))
    .catch((error) => log.warn(`Could not stop leftover processes of slot claim ${claim.claimId}`, error))
}

let cleanup: (claim: EndedClaimCleanupInput) => void = stopLeftoversOfEndedClaim

export function setSlotEndedClaimCleanupForTest(
  replacement: ((claim: EndedClaimCleanupInput) => void) | undefined
): void {
  cleanup = replacement ?? stopLeftoversOfEndedClaim
}

/** Release and expiry trigger: called once the claim has ended. Never throws. */
export function endedSlotClaimCleanup(claim: EndedClaimCleanupInput): void {
  try {
    cleanup(claim)
  } catch (error) {
    log.warn(`Could not stop leftover processes of slot claim ${claim.claimId}`, error)
  }
}
