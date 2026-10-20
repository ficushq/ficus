import { lt, or, isNotNull } from 'drizzle-orm'
import { db } from '../../db'
import {
  emailVerifications,
  passkeyEnrollmentCodes,
  sessions,
  webauthnChallenges,
  webHandoffs,
  wsTickets,
} from '../../db/schema'
import { PASSKEY_ENROLLMENT_AUDIT_RETENTION_MS } from './passkey-enrollment'
import { AmtpReceived } from '../../entities/AmtpReceived'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('auth-cleanup')

/**
 * Delete expired authentication data that is no longer useful after its TTL.
 *
 * The cutoff is strict (`expires_at < now`) so rows expiring exactly at the
 * supplied timestamp are left for the next sweep, matching the usual boundary
 * semantics used by auth checks in this codebase.
 *
 * Also prunes amtp_received dedup rows older than the replay window (10 min)
 * to bound table growth as federation traffic scales with peer count.
 */
export async function cleanupExpiredAuthData(now: Date = new Date()): Promise<void> {
  await Promise.all([
    db.delete(sessions).where(lt(sessions.expiresAt, now)),
    db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, now)),
    db.delete(emailVerifications).where(lt(emailVerifications.expiresAt, now)),
    // WS tickets are single-use + short-lived: drop expired or already-consumed.
    db.delete(wsTickets).where(or(lt(wsTickets.expiresAt, now), isNotNull(wsTickets.usedAt))),
    // Web handoff codes are the same: single-use and a minute long.
    db.delete(webHandoffs).where(or(lt(webHandoffs.expiresAt, now), isNotNull(webHandoffs.usedAt))),
    // Passkey enrollment codes are their own audit record: kept 30 days past expiry.
    db
      .delete(passkeyEnrollmentCodes)
      .where(lt(passkeyEnrollmentCodes.expiresAt, new Date(now.getTime() - PASSKEY_ENROLLMENT_AUDIT_RETENTION_MS))),
    // Federation dedup rows outside the ±5-min replay window can no longer be replayed.
    AmtpReceived.pruneOld(10 * 60 * 1000, now),
  ])
  log.debug('Expired auth data purged')
}
