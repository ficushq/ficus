import { isPlaceholderEmail } from '@ficus/shared'
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses'
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto'
import { eq, and, gt, isNull, desc, sql } from 'drizzle-orm'
import { db } from '../../db'
import { emailVerifications, authSettings, type EmailVerificationPurpose } from '../../db/schema'
import { createLogger } from '../../lib/infra/logger'
import { primaryWebAppUrl } from './web-origins'

const log = createLogger('auth-email')

/**
 * Whether outbound verification email is configured. We require an explicit sender address
 * (SES_FROM_ADDRESS) as the signal — most local deployments don't set it, so they run in
 * "no-email" mode where codes are logged / surfaced via invite links instead of mailed.
 */
export function isEmailConfigured(): boolean {
  return !!process.env.SES_FROM_ADDRESS
}

// Max wrong guesses allowed against a single verification code before it is
// burned. Combined with the 6-digit space this bounds online brute force to
// ~MAX/900k per issued code (issuance itself is rate-limited to 3/15min/email).
const MAX_VERIFY_ATTEMPTS = 5

const ses = new SESClient({
  region: process.env.AWS_SES_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
})

/** sha256-hex. Used for both the 6-digit code and the deep-link token — neither is ever stored raw. */
function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

interface InstanceIdentity {
  /** Full public origin, e.g. https://demo.ficus.sh — named ONCE in the body. */
  url: string
  /** Bare host, e.g. demo.ficus.sh — the short label for the subject line. */
  host: string
}

/**
 * Which Ficus instance this process IS, for naming in outbound mail. A person can
 * own several instances (hosted tenants all mail from the same platform), and a
 * bare "Ficus — Verify your email" gives them no way to tell which one asked.
 *
 * Derived from APP_URL, the public origin every hosted tenant and most
 * self-hosts already set. Returns null when it is unset or unparseable — a bare
 * local install then gets the original, instance-less wording rather than an
 * `undefined` in its subject line.
 */
export function instanceIdentity(): InstanceIdentity | null {
  const raw = process.env.APP_URL?.trim()
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (!parsed.host) return null
    return { url: raw.replace(/\/+$/, ''), host: parsed.host }
  } catch {
    return null
  }
}

export async function getAuthSettings() {
  const [settings] = await db.select().from(authSettings)
  return settings ?? { allowedDomains: [] as string[], requireInvite: true, defaultSignupRoleId: null }
}

export async function updateAuthSettings(input: {
  allowedDomains?: string[]
  requireInvite?: boolean
  defaultSignupRoleId?: string | null
}) {
  const existing = await getAuthSettings()
  if ('id' in existing) {
    await db
      .update(authSettings)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(authSettings.id, 'default'))
  } else {
    await db.insert(authSettings).values({
      id: 'default',
      allowedDomains: input.allowedDomains ?? [],
      requireInvite: input.requireInvite ?? true,
      defaultSignupRoleId: input.defaultSignupRoleId ?? null,
    })
  }
}

export async function isEmailAllowed(email: string): Promise<boolean> {
  const settings = await getAuthSettings()
  if (!settings.requireInvite) return true

  const { User } = await import('../../entities/User')
  const existingUser = await User.findByEmail(email)
  if (existingUser) return true

  const domain = email.split('@')[1]?.toLowerCase()
  if (domain && (settings.allowedDomains as string[]).some((d: string) => d.toLowerCase() === domain)) return true

  return false
}

/** Default lifetime of a self-serve registration code. Invites pass a longer ttlMs. */
export const DEFAULT_VERIFICATION_TTL_MS = 15 * 60 * 1000

/**
 * Human wording for a code lifetime, in the coarsest unit that stays exact-ish —
 * "15 minutes" for the self-serve code, "7 days" for an invite. The email must
 * quote the TTL it was actually issued with; a hardcoded phrase silently lies
 * the moment a caller passes a different one.
 */
export function formatCodeLifetime(ttlMs: number): string {
  const minutes = Math.round(ttlMs / 60_000)
  if (minutes < 60) return minutes === 1 ? '1 minute' : `${minutes} minutes`
  const hours = Math.round(ttlMs / 3_600_000)
  if (hours < 48) return hours === 1 ? '1 hour' : `${hours} hours`
  const days = Math.round(ttlMs / 86_400_000)
  return days === 1 ? '1 day' : `${days} days`
}

/** Minimal HTML escaping for the operator-supplied instance strings interpolated into the HTML part. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * The verification email itself — subject + text/HTML bodies, naming WHICH Ficus
 * instance is asking so a person with several of them can tell them apart. With
 * no instance identity available this renders the original instance-less
 * wording verbatim.
 *
 * Plain-text style: one paragraph per line with blank lines between, and NO
 * hard wraps inside a sentence — mail clients wrap to the viewport themselves,
 * and a manual break makes every line wrap AGAIN on narrow screens.
 */
export function buildVerificationMessage(code: string, instance: InstanceIdentity | null, ttlMs: number) {
  const subject = instance ? `Your Ficus verification code for ${instance.host}` : 'Ficus — Verify your email'
  const expiry = `This code expires in ${formatCodeLifetime(ttlMs)}.`
  const text = [
    `Your Ficus verification code is: ${code}`,
    '',
    ...(instance ? [`This code is for the Ficus instance at ${instance.url}.`, ''] : []),
    expiry,
  ].join('\n')
  const heading = instance ? `Ficus — Verify your email for ${escapeHtml(instance.host)}` : 'Ficus — Email Verification'
  const instanceLine = instance
    ? `<p style="color:#6b7280;font-size:14px;">This code is for the Ficus instance at ${escapeHtml(instance.url)}.</p>`
    : ''
  const html =
    `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;"><h2>${heading}</h2>` +
    `<p>Your verification code is:</p>` +
    `<p style="font-size:32px;font-weight:bold;letter-spacing:4px;text-align:center;padding:16px;background:#f3f4f6;border-radius:8px;">${code}</p>` +
    instanceLine +
    `<p style="color:#6b7280;font-size:14px;">${expiry}</p></div>`
  return {
    Subject: { Data: subject },
    Body: { Text: { Data: text }, Html: { Data: html } },
  }
}

export async function sendVerificationEmail(email: string, opts: { ttlMs?: number } = {}): Promise<string> {
  // The no-email owner's placeholder can never receive mail; a code for it would verify nothing.
  if (isPlaceholderEmail(email)) throw new Error('This account has no email address')
  const code = String(randomInt(100000, 999999))
  const codeHash = hashCode(code)
  const ttlMs = opts.ttlMs ?? DEFAULT_VERIFICATION_TTL_MS

  await db.insert(emailVerifications).values({
    email: email.toLowerCase(),
    code: codeHash,
    expiresAt: new Date(Date.now() + ttlMs),
  })

  // No email provider configured: surface the code via logs instead of mailing it (local deployments).
  if (!isEmailConfigured()) {
    log.info(`Email not configured — verification code for ${email}: ${code}`)
    return code
  }

  const fromAddress = process.env.SES_FROM_ADDRESS ?? 'noreply@ficus.sh'
  const command = new SendEmailCommand({
    Source: fromAddress,
    Destination: { ToAddresses: [email] },
    Message: buildVerificationMessage(code, instanceIdentity(), ttlMs),
  })

  await ses.send(command)
  return code
}

export async function verifyEmailCode(email: string, code: string): Promise<boolean> {
  const codeHash = hashCode(code)
  // Look up the latest unexpired/unused code for this email WITHOUT matching on
  // the code, so we can count failed guesses per code and lock it after a cap.
  //
  // Restricted to purpose 'register': a recovery challenge is redeemable ONLY by
  // its deep-link token, because redeeming it here would add a passkey through
  // the ordinary registration path without revoking the lost credential.
  const [row] = await db
    .select()
    .from(emailVerifications)
    .where(
      and(
        eq(emailVerifications.email, email.toLowerCase()),
        eq(emailVerifications.purpose, 'register'),
        gt(emailVerifications.expiresAt, new Date()),
        isNull(emailVerifications.usedAt)
      )
    )
    .orderBy(desc(emailVerifications.createdAt))
    .limit(1)

  if (!row) return false

  // Too many wrong guesses against this code -> burn it (anti-brute-force).
  if (row.attempts >= MAX_VERIFY_ATTEMPTS) {
    await db.update(emailVerifications).set({ usedAt: new Date() }).where(eq(emailVerifications.id, row.id))
    return false
  }

  const expected = Buffer.from(row.code, 'hex')
  const received = Buffer.from(codeHash, 'hex')
  const match = expected.length === received.length && timingSafeEqual(expected, received)

  if (!match) {
    // Conditionally bump the attempt counter for this exact observed value.
    await db
      .update(emailVerifications)
      .set({ attempts: row.attempts + 1 })
      .where(and(eq(emailVerifications.id, row.id), eq(emailVerifications.attempts, row.attempts)))
    return false
  }

  // Atomic single-use consume: only the request that flips usedAt from NULL
  // wins, closing the select-then-update TOCTOU under concurrency.
  const consumed = await db
    .update(emailVerifications)
    .set({ usedAt: new Date() })
    .where(and(eq(emailVerifications.id, row.id), isNull(emailVerifications.usedAt)))
    .returning({ id: emailVerifications.id })
  return consumed.length > 0
}

// ── Deep-link tokens ─────────────────────────────────────────────────────────
//
// An invite or a recovery request issues ONE `email_verifications` row carrying
// two presentations of the same challenge: the 6-digit code (typed into the
// registration form) and a high-entropy token (embedded in a link). Because both
// live on one row, the existing atomic `used_at` consume already makes the pair
// single-use — redeeming either burns the other, and no second token store, TTL
// or expiry sweep has to be kept in sync.
//
// A token authorises exactly one thing: registering a passkey for the address the
// row was issued to. It is never a session and never a bearer credential for the
// API — see routes/auth.ts, where the only endpoints that accept it are the two
// halves of the passkey-registration ceremony.

/** Bytes of entropy in a deep-link token. 32 bytes → 43 base64url chars. */
const TOKEN_BYTES = 32

/**
 * Invites live longer than a self-serve registration code — an invite has to
 * survive a weekend and an out-of-band handover on a no-email install.
 */
export const INVITE_CHALLENGE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Passkey recovery is deliberately MUCH shorter-lived than an invite. A recovery
 * link is the one credential path that reaches an already-provisioned account, so
 * it should be spent within the sitting that requested it, not left in a mailbox
 * for a week.
 */
export const PASSKEY_RECOVERY_TTL_MS = 60 * 60 * 1000

/** How many verification rows an address may accrue in the rate-limit window. */
export const VERIFICATION_RATE_LIMIT = 3

/**
 * Where a deep link must land. Deliberately `primaryWebOrigin()` (FICUS_WEB_ORIGIN
 * → WEBAUTHN_ORIGIN → APP_URL) rather than APP_URL directly: the link's whole
 * purpose is to open a WebAuthn ceremony, and a ceremony only verifies on the RP
 * origin, so the link has to point at the same origin WebAuthn is pinned to — under
 * the app's base path, where the web app serves /register.
 */
export function buildPasskeyRegistrationLink(token: string): string {
  return `${primaryWebAppUrl()}/register?token=${encodeURIComponent(token)}`
}

export interface IssuedChallenge {
  /** 6-digit code, for typing into the registration form on another device. */
  code: string
  /** Raw deep-link token — returned once, stored only as a hash. */
  token: string
  /** Absolute URL that lands on passkey registration. */
  link: string
}

/**
 * Insert one verification row bearing both a code and a deep-link token, and
 * return the raw values (the caller mails or hands them over; the DB has hashes).
 */
export async function issueEmailChallenge(
  email: string,
  opts: { ttlMs?: number; purpose?: EmailVerificationPurpose } = {}
): Promise<IssuedChallenge> {
  const code = String(randomInt(100000, 999999))
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const ttlMs = opts.ttlMs ?? DEFAULT_VERIFICATION_TTL_MS

  await db.insert(emailVerifications).values({
    email: email.toLowerCase(),
    code: hashCode(code),
    tokenHash: hashCode(token),
    purpose: opts.purpose ?? 'register',
    expiresAt: new Date(Date.now() + ttlMs),
  })

  return { code, token, link: buildPasskeyRegistrationLink(token) }
}

/**
 * Burn every outstanding (unconsumed) REGISTRATION challenge for an address, so
 * the caller can mint a replacement and leave exactly one live link behind.
 *
 * Marking `used_at` — rather than deleting the rows or back-dating `expires_at`
 * — is deliberate: every reader of this table (verifyEmailCode,
 * peekVerificationToken, consumeVerificationToken and User.findAllWithOnboarding)
 * already filters on `used_at IS NULL`, so one write retires the old 6-digit
 * code, the old deep-link token AND the old "invite expires…" line on the admin
 * Users list without adding a predicate anywhere. The row itself survives, which
 * keeps the issuance history (and therefore the rate-limit count) intact.
 *
 * Deliberately scoped to purpose 'register': a passkey-recovery challenge belongs
 * to a different flow with different revocation semantics and must never be
 * collaterally burned by an admin resending an invite.
 *
 * Returns how many challenges were retired.
 */
export async function supersedeRegistrationChallenges(email: string): Promise<number> {
  const retired = await db
    .update(emailVerifications)
    .set({ usedAt: new Date() })
    .where(
      and(
        // Rows are written lowercased, but match case-insensitively anyway —
        // findAllWithOnboarding does the same, and a row this misses would stay
        // redeemable after a "resend".
        sql`lower(${emailVerifications.email}) = ${email.toLowerCase()}`,
        eq(emailVerifications.purpose, 'register'),
        isNull(emailVerifications.usedAt)
      )
    )
    .returning({ id: emailVerifications.id })
  return retired.length
}

export interface ChallengeSubject {
  email: string
  purpose: EmailVerificationPurpose
}

/**
 * Look up a live token WITHOUT consuming it. Used to open the registration
 * ceremony (which needs the subject's email to build WebAuthn options); the
 * consume happens only when the ceremony completes, so a failed or abandoned
 * ceremony doesn't burn the invite.
 */
export async function peekVerificationToken(token: string): Promise<ChallengeSubject | null> {
  if (!token) return null
  const [row] = await db
    .select({ email: emailVerifications.email, purpose: emailVerifications.purpose })
    .from(emailVerifications)
    .where(
      and(
        eq(emailVerifications.tokenHash, hashCode(token)),
        gt(emailVerifications.expiresAt, new Date()),
        isNull(emailVerifications.usedAt)
      )
    )
  return row ?? null
}

/**
 * Atomically burn a token. Only the request that flips `used_at` from NULL wins,
 * so two concurrent redemptions can never both succeed (single-use under races).
 * Returns the subject on success, null if the token is unknown, expired or spent.
 */
export async function consumeVerificationToken(token: string): Promise<ChallengeSubject | null> {
  if (!token) return null
  const [row] = await db
    .update(emailVerifications)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(emailVerifications.tokenHash, hashCode(token)),
        gt(emailVerifications.expiresAt, new Date()),
        isNull(emailVerifications.usedAt)
      )
    )
    .returning({ email: emailVerifications.email, purpose: emailVerifications.purpose })
  return row ?? null
}

/** Verification rows issued to this address in the last 15 minutes (the rate-limit window). */
export async function recentVerificationCount(email: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(emailVerifications)
    .where(
      and(
        eq(emailVerifications.email, email.toLowerCase()),
        sql`${emailVerifications.createdAt} > now() - interval '15 minutes'`
      )
    )
  return Number(row.count)
}

// ── Invite / recovery messages ───────────────────────────────────────────────
//
// Same plain-text style as buildVerificationMessage: one paragraph per line,
// blank-line separated, and no hard wraps inside a sentence.

/**
 * Invite mail: link only.
 *
 * The row behind an invite still carries a 6-digit code (see issueEmailChallenge),
 * but the mail deliberately does NOT advertise it. Typing a code requires the
 * login page's "Create account" form, and that affordance is hidden exactly when
 * invites matter most — an invite-only instance with no allowed domains reports
 * canSelfRegister:false, so the invitee has nowhere to type it. Rather than tell
 * the reader to do something the UI won't let them do, the mail names the one
 * channel that always works.
 *
 * The link is itself the cross-device answer: it is an ordinary URL, so it can be
 * opened on whichever device holds the passkeys. This matches the admin invite UI,
 * which has only ever surfaced the link for out-of-band handover.
 */
export function buildInviteMessage(link: string, instance: InstanceIdentity | null, ttlMs: number) {
  const subject = instance ? `You have been invited to Ficus at ${instance.host}` : 'Ficus — You have been invited'
  const expiry = `This invitation expires in ${formatCodeLifetime(ttlMs)}.`
  const text = [
    instance
      ? `You have been invited to the Ficus instance at ${instance.url}.`
      : 'You have been invited to join Ficus.',
    '',
    'Open this link to set up your passkey:',
    '',
    link,
    '',
    'The link works on any device, so open it wherever you keep your passkeys.',
    '',
    expiry,
  ].join('\n')
  const heading = instance
    ? `You have been invited to Ficus at ${escapeHtml(instance.host)}`
    : 'You have been invited to Ficus'
  const html =
    `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;"><h2>${heading}</h2>` +
    `<p>Set up your passkey to finish creating your account:</p>` +
    `<p style="text-align:center;padding:16px;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#111827;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold;">Set up your passkey</a></p>` +
    `<p style="color:#6b7280;font-size:14px;">The link works on any device, so open it wherever you keep your passkeys.</p>` +
    `<p style="color:#6b7280;font-size:14px;">${expiry}</p></div>`
  return {
    Subject: { Data: subject },
    Body: { Text: { Data: text }, Html: { Data: html } },
  }
}

/**
 * Passkey-recovery mail: link only. There is deliberately no typeable code —
 * a recovery challenge must go through the recovery endpoints (which revoke the
 * old credentials), and `verifyEmailCode` refuses purpose 'recovery' rows.
 */
export function buildPasskeyRecoveryMessage(link: string, instance: InstanceIdentity | null, ttlMs: number) {
  const subject = instance ? `Register a new passkey for Ficus at ${instance.host}` : 'Ficus — Register a new passkey'
  const expiry = `This link expires in ${formatCodeLifetime(ttlMs)} and can only be used once.`
  const text = [
    instance
      ? `Someone asked to register a new passkey for your account on the Ficus instance at ${instance.url}.`
      : 'Someone asked to register a new passkey for your Ficus account.',
    '',
    'Open this link to register a new passkey:',
    '',
    link,
    '',
    'Registering a new passkey removes every passkey currently on the account and signs out all of its sessions.',
    '',
    expiry,
    '',
    'If this was not you, ignore this email — nothing changes until the link is used.',
  ].join('\n')
  const heading = instance ? `Register a new passkey for ${escapeHtml(instance.host)}` : 'Register a new Ficus passkey'
  const html =
    `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;"><h2>${heading}</h2>` +
    `<p>Someone asked to register a new passkey for your account.</p>` +
    `<p style="text-align:center;padding:16px;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#111827;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold;">Register a new passkey</a></p>` +
    `<p style="color:#6b7280;font-size:14px;">Registering a new passkey removes every passkey currently on the account and signs out all of its sessions.</p>` +
    `<p style="color:#6b7280;font-size:14px;">${expiry}</p>` +
    `<p style="color:#6b7280;font-size:14px;">If this was not you, ignore this email — nothing changes until the link is used.</p></div>`
  return {
    Subject: { Data: subject },
    Body: { Text: { Data: text }, Html: { Data: html } },
  }
}

async function sendMail(email: string, message: ReturnType<typeof buildInviteMessage>): Promise<void> {
  if (isPlaceholderEmail(email)) {
    log.warn('Skipping mail to an account with no email address')
    return
  }
  const fromAddress = process.env.SES_FROM_ADDRESS ?? 'noreply@ficus.sh'
  await ses.send(
    new SendEmailCommand({
      Source: fromAddress,
      Destination: { ToAddresses: [email] },
      Message: message,
    })
  )
}

export interface SentInvite extends IssuedChallenge {
  /** Whether the invite was actually mailed (false on a no-email install). */
  mailed: boolean
}

/**
 * Issue and (when email is configured) MAIL an invitation. The no-email branch
 * still returns the code + link so the admin can hand them over out of band.
 */
export async function sendInviteEmail(email: string, opts: { ttlMs?: number } = {}): Promise<SentInvite> {
  const ttlMs = opts.ttlMs ?? DEFAULT_VERIFICATION_TTL_MS
  const issued = await issueEmailChallenge(email, { ttlMs, purpose: 'register' })

  if (!isEmailConfigured()) {
    log.info(`Email not configured — invite code for ${email}: ${issued.code}`)
    return { ...issued, mailed: false }
  }

  await sendMail(email, buildInviteMessage(issued.link, instanceIdentity(), ttlMs))
  return { ...issued, mailed: true }
}

/**
 * Issue and (when email is configured) MAIL a passkey-recovery link. Callers must
 * NOT return anything from this to the requester — see routes/auth.ts, where the
 * recovery endpoint answers identically whether or not the address exists.
 */
/** `jane@example.com` → `j***@example.com`: enough for the owner to recognise, not a full address. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at <= 0) return '***'
  return `${email[0]}***${email.slice(at)}`
}

/**
 * Sent to an account's PREVIOUS address after its email changes, so the owner hears about it
 * even if someone else changed it from a signed-in session. No link: it only informs.
 */
export function buildEmailChangedMessage(newEmail: string, instance: InstanceIdentity | null) {
  const subject = instance ? `Your Ficus email at ${instance.host} was changed` : 'Ficus — Your email was changed'
  const where = instance ? `your account on the Ficus instance at ${instance.url}` : 'your Ficus account'
  const masked = maskEmail(newEmail)
  const text = [
    `The email address for ${where} was changed to ${masked}.`,
    '',
    'If you made this change, you can ignore this email.',
    'If you did not, sign in with your passkey and change it back, and tell your Ficus administrator.',
  ].join('\n')
  const html =
    `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;"><h2>Your Ficus email was changed</h2>` +
    `<p>The email address for ${escapeHtml(where)} was changed to <strong>${escapeHtml(masked)}</strong>.</p>` +
    `<p style="color:#6b7280;font-size:14px;">If you made this change, you can ignore this email. If you did not, sign in with your passkey and change it back, and tell your Ficus administrator.</p></div>`
  return {
    Subject: { Data: subject },
    Body: { Text: { Data: text }, Html: { Data: html } },
  }
}

/** Tell the previous address about an email change. Best effort; does nothing without a mail provider. */
export async function sendEmailChangedNotice(previousEmail: string, newEmail: string): Promise<void> {
  if (!isEmailConfigured()) return
  await sendMail(previousEmail, buildEmailChangedMessage(newEmail, instanceIdentity()))
}

export async function sendPasskeyRecoveryEmail(email: string, opts: { ttlMs?: number } = {}): Promise<void> {
  const ttlMs = opts.ttlMs ?? DEFAULT_VERIFICATION_TTL_MS
  const issued = await issueEmailChallenge(email, { ttlMs, purpose: 'recovery' })

  if (!isEmailConfigured()) {
    // Same escape hatch sendVerificationEmail uses: with no mail provider the
    // link goes to the server log, never to the HTTP response — otherwise anyone
    // who can POST an address could recover the account behind it.
    log.info(`Email not configured — passkey recovery link for ${email}: ${issued.link}`)
    return
  }

  await sendMail(email, buildPasskeyRecoveryMessage(issued.link, instanceIdentity(), ttlMs))
}
