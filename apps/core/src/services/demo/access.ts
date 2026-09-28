import { createHash, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { users } from '../../db/schema'
import { buildMobilePairingServerUrl } from '../../lib/mobilePairingUrl'
import { FixedWindowLimiter } from '../auth/device-auth-rate-limit'
import { createPairingCode } from '../auth/pairing'
import { getSecretStore } from '../secrets'

/**
 * Reviewer access to a designated demo instance.
 *
 * App-store reviewers pair fresh phones with no passkey, no mailbox, and no
 * operator on hand. On an instance that opts in, a private reviewer secret
 * unlocks nothing more than an ordinary pairing code for the shared demo
 * account: the same 90-second single-use code the Devices page mints, claimed
 * by the app the same way, yielding a per-device token under the demo role.
 * Rotating or deleting the secret closes the door; disabling the demo user
 * fails every device it ever paired.
 */

/** Env flag: reviewer access is off unless explicitly on. */
export const DEMO_REVIEWER_ACCESS_ENV = 'FICUS_DEMO_REVIEWER_ACCESS'
/** Secret-store key holding the reviewer credential; rotate to revoke. */
export const DEMO_REVIEWER_SECRET_KEY = 'DEMO_REVIEWER_SECRET'
/** RFC 2606 reserved TLD: the demo account can never receive mail. */
export const DEMO_REVIEWER_EMAIL = 'demo-reviewer@demo.invalid'
export const DEMO_REVIEWER_ROLE_SLUG = 'demo-reviewer'
/** Shorter than this is a password, not a credential. */
const MIN_SECRET_LENGTH = 16

export function isDemoReviewerAccessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['1', 'true', 'yes'].includes((env[DEMO_REVIEWER_ACCESS_ENV] ?? '').trim().toLowerCase())
}

export type DemoPairResult =
  | { status: 'disabled' }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'invalid_secret' }
  | { status: 'not_seeded' }
  | { status: 'ok'; code: string; serverUrl: string; expiresAt: string }

export interface DemoPairRequest {
  secret: string
  clientAddress: string
  requestUrl: string
  originHeader?: string
}

export interface DemoReviewerAccessDependencies {
  enabled?: () => boolean
  secret?: () => string | undefined
  /** Attempts per client address, valid and invalid alike. */
  limit?: { max: number; windowMs: number }
  now?: () => number
}

const sha256 = (value: string) => createHash('sha256').update(value).digest()

export class DemoReviewerAccess {
  readonly #enabled: () => boolean
  readonly #secret: () => string | undefined
  readonly #limit: { max: number; windowMs: number }
  readonly #limiter: FixedWindowLimiter

  constructor(deps: DemoReviewerAccessDependencies = {}) {
    this.#enabled = deps.enabled ?? (() => isDemoReviewerAccessEnabled())
    this.#secret = deps.secret ?? (() => getSecretStore().get(DEMO_REVIEWER_SECRET_KEY))
    this.#limit = deps.limit ?? { max: 5, windowMs: 60_000 }
    this.#limiter = new FixedWindowLimiter(deps.now)
  }

  enabled(): boolean {
    return this.#enabled()
  }

  async pair(request: DemoPairRequest): Promise<DemoPairResult> {
    if (!this.#enabled()) return { status: 'disabled' }
    if (!this.#limiter.take(request.clientAddress, this.#limit.max, this.#limit.windowMs)) {
      return { status: 'rate_limited', retryAfterSeconds: Math.ceil(this.#limit.windowMs / 1000) }
    }
    if (!this.#secretMatches(request.secret)) return { status: 'invalid_secret' }

    const demo = await findDemoReviewerUser()
    if (!demo || demo.disabledAt) return { status: 'not_seeded' }

    const { code, expiresAt } = await createPairingCode(demo.id)
    const serverUrl = buildMobilePairingServerUrl({
      requestUrl: request.requestUrl,
      originHeader: request.originHeader,
    })
    return { status: 'ok', code, serverUrl, expiresAt: expiresAt.toISOString() }
  }

  #secretMatches(presented: string): boolean {
    const expected = this.#secret()?.trim()
    if (!expected || expected.length < MIN_SECRET_LENGTH || !presented) return false
    return timingSafeEqual(sha256(presented), sha256(expected))
  }
}

export async function findDemoReviewerUser(): Promise<{ id: string; disabledAt: Date | null } | null> {
  const [row] = await db
    .select({ id: users.id, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.email, DEMO_REVIEWER_EMAIL))
    .limit(1)
  return row ?? null
}

export const demoReviewerAccess = new DemoReviewerAccess()
