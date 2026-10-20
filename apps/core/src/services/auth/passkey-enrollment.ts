import { createHash, randomBytes } from 'crypto'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { db } from '../../db'
import { passkeyEnrollmentCodes, users } from '../../db/schema'

/**
 * Passkey enrollment codes: the non-destructive way to add a passkey at another
 * allowed address of this server (for example a new public address).
 *
 * A signed-in person mints one after a fresh passkey assertion (routes/auth.ts,
 * POST /me/passkey-codes). What a code authorises, exactly: registering ONE
 * additional passkey for the user it was issued to, once, within 15 minutes, at an
 * origin in the live allowlist. It is not a session or an API credential — no
 * middleware reads this table. Only the newest code per user is live, and only a
 * sha256 of it is stored. The row stays after use as the audit record.
 */

/** Long enough to save a new public address and open it; short enough not to linger in a chat log. */
export const PASSKEY_ENROLLMENT_CODE_TTL_MS = 15 * 60 * 1000
/** Rows outlive their code by this long so issue/redeem history stays auditable. */
export const PASSKEY_ENROLLMENT_AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/** Crockford base32: no I, L, O, U — typeable, case-insensitive, 5 bits per character. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** 16 characters × 5 bits = 80 bits: guessing against the rate-limited public endpoint is hopeless. */
export const CODE_LENGTH = 16

/** `XXXX-XXXX-XXXX-XXXX` for display, links and typing. */
export function formatEnrollmentCode(normalized: string): string {
  return normalized.match(/.{4}/g)!.join('-')
}

/** Uppercase, drop separators, fold look-alikes (O→0, I/L→1); null unless exactly 16 alphabet characters. */
export function normalizeEnrollmentCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null
  const folded = raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (folded.length !== CODE_LENGTH) return null
  for (const ch of folded) if (!ALPHABET.includes(ch)) return null
  return folded
}

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH) // 256 = 8 × 32, so `% 32` is uniform
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[bytes[i] % 32]
  return out
}

function hashCode(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex')
}

const live = (hash: string, now: Date) =>
  and(
    eq(passkeyEnrollmentCodes.codeHash, hash),
    isNull(passkeyEnrollmentCodes.usedAt),
    isNull(passkeyEnrollmentCodes.revokedAt),
    gt(passkeyEnrollmentCodes.expiresAt, now)
  )

/** Mint a code for `userId`; any earlier live code is retired (its row stays for audit). The raw code is returned once. */
export async function issuePasskeyEnrollmentCode(
  userId: string,
  opts: { issuedOrigin?: string | null; now?: Date } = {}
): Promise<{ code: string; expiresAt: Date }> {
  const now = opts.now ?? new Date()
  const code = generateCode()
  const expiresAt = new Date(now.getTime() + PASSKEY_ENROLLMENT_CODE_TTL_MS)
  await db.transaction(async (tx) => {
    await tx
      .update(passkeyEnrollmentCodes)
      .set({ revokedAt: now })
      .where(
        and(
          eq(passkeyEnrollmentCodes.userId, userId),
          isNull(passkeyEnrollmentCodes.usedAt),
          isNull(passkeyEnrollmentCodes.revokedAt)
        )
      )
    await tx
      .insert(passkeyEnrollmentCodes)
      .values({ userId, codeHash: hashCode(code), issuedOrigin: opts.issuedOrigin ?? null, expiresAt })
  })
  return { code: formatEnrollmentCode(code), expiresAt }
}

/** Non-consuming lookup (opens the ceremony). Null for unknown, expired, used or retired codes and disabled users. */
export async function peekPasskeyEnrollmentCode(raw: unknown, now = new Date()): Promise<{ userId: string } | null> {
  const code = normalizeEnrollmentCode(raw)
  if (!code) return null
  const [row] = await db
    .select({ userId: passkeyEnrollmentCodes.userId, disabledAt: users.disabledAt })
    .from(passkeyEnrollmentCodes)
    .innerJoin(users, eq(users.id, passkeyEnrollmentCodes.userId))
    .where(live(hashCode(code), now))
  return row && !row.disabledAt ? { userId: row.userId } : null
}

/** Atomic single-use consume: only the request that flips used_at from NULL wins. */
export async function consumePasskeyEnrollmentCode(
  raw: unknown,
  outcome: { redeemedOrigin: string; credentialId: string },
  now = new Date()
): Promise<{ userId: string } | null> {
  const code = normalizeEnrollmentCode(raw)
  if (!code) return null
  const [row] = await db
    .update(passkeyEnrollmentCodes)
    .set({ usedAt: now, redeemedOrigin: outcome.redeemedOrigin, redeemedCredentialId: outcome.credentialId })
    .where(live(hashCode(code), now))
    .returning({ userId: passkeyEnrollmentCodes.userId })
  if (!row) return null
  const [user] = await db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, row.userId))
  return user && !user.disabledAt ? { userId: row.userId } : null
}

/** Audit a failed ceremony against a known code (no-op for unknown codes). */
export async function recordPasskeyEnrollmentFailure(raw: unknown): Promise<void> {
  const code = normalizeEnrollmentCode(raw)
  if (!code) return
  await db
    .update(passkeyEnrollmentCodes)
    .set({ attempts: sql`${passkeyEnrollmentCodes.attempts} + 1` })
    .where(eq(passkeyEnrollmentCodes.codeHash, hashCode(code)))
}
