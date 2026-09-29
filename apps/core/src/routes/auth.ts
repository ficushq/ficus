import { getServerInfo } from '../services/server-info'
import { permissionMatches } from '../services/rbac'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { CSRF_HEADER } from '@ficus/shared/http-headers'
import { zValidator } from '@hono/zod-validator'
import { parseOptionalJsonObjectBody } from '../middleware/json-body-errors'
import { createHash, timingSafeEqual } from 'crypto'
import { eq, sql } from 'drizzle-orm'
import { getSecretStore } from '../services/secrets'
import { User } from '../entities/User'
import { createSelfRegisteredUser } from '../services/auth/signup'
import { Role, isUserAssignable } from '../entities/Role'
import { db } from '../db'
import { users, roleAssignments, userCredentials, sessions, type EmailVerificationPurpose } from '../db/schema'
import {
  generateRegOptions,
  verifyRegResponse,
  generateAuthOptions,
  verifyAuthResponse,
  PasskeyAuthenticationError,
} from '../services/auth/webauthn'
import {
  consumeVerificationToken,
  isEmailAllowed,
  isEmailConfigured,
  peekVerificationToken,
  recentVerificationCount,
  sendPasskeyRecoveryEmail,
  sendVerificationEmail,
  verifyEmailCode,
  getAuthSettings,
  updateAuthSettings,
  PASSKEY_RECOVERY_TTL_MS,
  VERIFICATION_RATE_LIMIT,
} from '../services/auth/email'
import { identityMiddleware } from '../middleware/identity'
import { requirePermission } from '../middleware/require-permission'
import { resolvePermissions, resolveRoleSummaries, type Identity } from '../services/rbac'
import { createWsTicket } from '../services/auth/ws-ticket'
import { consumeWebHandoff, createWebHandoff } from '../services/auth/web-handoff'
import { hasAdminUsers, adminHasPasskey, pendingAdminSetup } from '../services/auth/admin-users'
import { createPairingCode, claimPairingCode } from '../services/auth/pairing'
import { buildMobilePairingServerUrl } from '../lib/mobilePairingUrl'
import { listDeviceTokens, revokeDeviceToken } from '../services/auth/device-tokens'
import {
  approveDeviceAuthorization,
  createDeviceAuthorization,
  DEVICE_AUTH_POLL_INTERVAL_SECONDS,
  exchangeDeviceAuthorization,
  inspectDeviceAuthorization,
  type DeviceAuthorizationPlatform,
} from '../services/auth/device-authorization'
import { deviceAuthorizationStartLimiter, webHandoffExchangeLimiter } from '../services/auth/device-auth-rate-limit'
import { setSessionCookie, clearSessionCookie, extractSessionToken } from '../services/auth/session-cookie'
import { resolveToken } from '../services/auth/resolve-token'
import { replaceCredentialsAfterRecovery } from '../services/auth/passkey-recovery'
import { MAX_CREDENTIAL_NAME_LENGTH, resolveCredentialName } from '../services/auth/credential-name'
import { createLogger } from '../lib/infra/logger'
import { getClientAddress } from '../lib/client-address'
import { demoReviewerAccess } from '../services/demo/access'
import { primaryWebOrigin } from '../services/auth/web-origins'

const log = createLogger('auth-routes')

// Fixed key for the first-user admin-bootstrap advisory lock (see register/verify).
const ADMIN_BOOTSTRAP_LOCK_KEY = 424242

/**
 * First-admin bootstrap gate.
 *
 * On a bare local install (no FICUS_PASSWORD configured) the first visitor is
 * legitimately the owner, so the first-user registration flow stays ungated —
 * exactly today's localhost self-hosting behavior. Do not break that path.
 *
 * But when a FICUS_PASSWORD is provisioned (hosted per-tenant subdomains), that
 * per-instance random env secret IS the bootstrap credential: it exists precisely
 * to gate the window before the first admin exists. In that mode the first-user
 * paths of /register/email, /register/options and /register/verify require the
 * caller to already hold the legacy password session (resolveToken → 'legacy',
 * established by POST /login). This closes the public-subdomain takeover race
 * where whoever visits a freshly provisioned instance first would otherwise
 * become its admin (and, with no email provider, be handed the verification code
 * straight in the response body).
 *
 * Returns a Response to short-circuit when the gate fails, or null when the
 * caller may proceed.
 */
async function requireBootstrapAuthForFirstUser(c: Context): Promise<Response | null> {
  const ficusPassword = getSecretStore().get('FICUS_PASSWORD')
  if (!ficusPassword) return null // bare local install — first-run stays ungated

  if (await holdsBootstrapSession(c)) return null // authenticated as the bootstrap identity
  return c.json({ error: 'Bootstrap authentication required. Sign in with the instance password first.' }, 401)
}

/** Whether this request carries the bootstrap `FICUS_PASSWORD` identity (only resolvable while no admin has a passkey). */
async function holdsBootstrapSession(c: Context): Promise<boolean> {
  const token = extractSessionToken(c)
  if (!token) return false
  return (await resolveToken(token))?.type === 'legacy'
}

/**
 * Make `userId` the system admin if no enabled admin exists yet. Returns whether
 * it did. Callers must already have established that this request may mint the
 * first admin (see requireBootstrapAuthForFirstUser).
 */
async function assignFirstAdminIfNone(userId: string): Promise<boolean> {
  if (await hasAdminUsers()) return false
  return db.transaction(async (tx) => {
    // Serialize concurrent first-user bootstraps so two simultaneous
    // registrations can't both become system admin under READ COMMITTED
    // (the per-subject unique indexes don't stop two distinct users each
    // inserting an admin assignment). The lock auto-releases at commit.
    await tx.execute(sql`select pg_advisory_xact_lock(${ADMIN_BOOTSTRAP_LOCK_KEY})`)
    // Double-check inside the transaction, with the same definition of "an admin
    // exists" as the gate above: a leftover assignment for a deleted user must not
    // stop the first admin being made.
    if (await hasAdminUsers(tx)) return false

    // Admin role must exist (created by config sync)
    const adminRole = await Role.findBySlug('admin')
    if (!adminRole) {
      throw new Error('Admin role not found. System is misconfigured — ensure config sync has run.')
    }
    await tx.insert(roleAssignments).values({
      subjectType: 'user',
      subjectId: userId,
      roleId: adminRole.id,
      scope: 'system',
    })
    return true
  })
}

function normalizeDisplayName(displayName: string | undefined): string | undefined {
  const trimmed = displayName?.trim()
  return trimmed ? trimmed : undefined
}

export const authRouter = new Hono()

// ── GET /status ──────────────────────────────────────────────────────────────

authRouter.get('/status', async (c) => {
  const password = getSecretStore().get('FICUS_PASSWORD')
  const hasAdmin = await hasAdminUsers()
  const passkeyEnrolled = await adminHasPasskey()
  const userCount = await User.count()
  const settings = await getAuthSettings()

  return c.json({
    server: await getServerInfo(),
    authEnabled: !!password || hasAdmin,
    // Passkey mode only once an admin actually holds a passkey. While admin rows
    // exist but no admin has a usable credential (e.g. a cross-subdomain restore
    // stripped the origin-bound credentials), the UI must still offer password login.
    mode: passkeyEnrolled ? 'passkey' : 'password',
    hasUsers: userCount > 0,
    hasAdminUser: hasAdmin,
    emailConfigured: isEmailConfigured(),
    // Whether POST /register/email could succeed for SOME address a stranger types.
    // This is the ONLY signup-policy signal exposed anonymously: the login page needs
    // it to decide whether to offer "Create account", and the allowed-domain list
    // itself stays behind GET /settings (identity + settings:read).
    //
    // Mirrors isEmailAllowed(): requireInvite:false is open to everyone, and while
    // requireInvite is true only already-invited users (whose rows exist) plus
    // addresses at an allowed domain get through — so an empty allowlist means
    // nobody new can register themselves. Zero users is the first-admin bootstrap
    // window, which deliberately bypasses the policy entirely.
    canSelfRegister: userCount === 0 || !settings.requireInvite || settings.allowedDomains.length > 0,
    // The /demo reviewer page exists on this instance (FICUS_DEMO_REVIEWER_ACCESS).
    // Says nothing about the secret or whether the demo account is seeded.
    demoReviewerAccess: demoReviewerAccess.enabled(),
  })
})

// ── POST /login (legacy password) ───────────────────────────────────────────

authRouter.post('/login', async (c) => {
  // Password auth is disabled once an admin holds a passkey. It remains available
  // while admin rows exist but none has a usable credential (the restore state),
  // so a locked-out owner can log in and re-register a passkey.
  const passkeyEnrolled = await adminHasPasskey()
  if (passkeyEnrolled) {
    return c.json({ error: 'Password auth disabled. Use passkey login.' }, 403)
  }

  const password = getSecretStore().get('FICUS_PASSWORD')
  if (!password) {
    return c.json({ ok: true })
  }

  const body = await c.req.json<{ password?: string }>()
  if (!body.password) {
    return c.json({ error: 'Invalid password' }, 401)
  }

  const expected = Buffer.from(createHash('sha256').update(password).digest('hex'), 'hex')
  const received = Buffer.from(createHash('sha256').update(body.password).digest('hex'), 'hex')

  if (!timingSafeEqual(expected, received)) {
    return c.json({ error: 'Invalid password' }, 401)
  }

  // Legacy password mode: the password itself is the bearer token (resolveToken
  // matches it while no admin users exist). Set it as the HttpOnly cookie so the
  // browser never has to hold it in JS-readable storage.
  setSessionCookie(c, body.password)
  return c.json({ ok: true })
})

// ── POST /register/email ────────────────────────────────────────────────────

authRouter.post('/register/email', async (c) => {
  const { email } = await c.req.json<{ email: string }>()
  if (!email || !email.includes('@')) {
    return c.json({ error: 'Valid email required' }, 400)
  }

  const userCount = await User.count()
  const isFirstUser = userCount === 0

  if (isFirstUser) {
    // Bootstrap gate: when FICUS_PASSWORD is configured, only the bootstrap-password
    // session may kick off first-admin creation (and thus receive the code below).
    const gate = await requireBootstrapAuthForFirstUser(c)
    if (gate) return gate
  } else {
    // Allow if user was invited OR if their email domain matches allowed domains
    const existingUser = await User.findByEmail(email)
    if (!existingUser) {
      const allowed = await isEmailAllowed(email)
      if (!allowed) {
        return c.json({ error: 'Email not allowed. Contact an admin for an invite.' }, 403)
      }
    }
  }

  // Rate limit: 3 per 15 min per email
  if ((await recentVerificationCount(email)) >= VERIFICATION_RATE_LIMIT) {
    return c.json({ error: 'Too many verification attempts. Try again later.' }, 429)
  }

  // No email provider: the code is generated + logged, never mailed. For the first-user bootstrap we
  // return the code so the local setup UI can complete admin creation with no email at all. For
  // invited (non-first) users the code is NOT returned here — it reaches them via the admin's invite
  // link — so knowing an invited address isn't enough to register as them.
  if (!isEmailConfigured()) {
    const code = await sendVerificationEmail(email)
    return c.json({
      ok: true,
      firstUser: isFirstUser,
      emailConfigured: false,
      ...(isFirstUser ? { code } : {}),
    })
  }

  try {
    await sendVerificationEmail(email)
  } catch (err) {
    // Email is configured but sending failed.
    if (isFirstUser) {
      return c.json({ ok: true, firstUser: true, emailConfigured: true })
    }
    throw err
  }

  return c.json({ ok: true, firstUser: isFirstUser, emailConfigured: true })
})

// ── POST /register/options ──────────────────────────────────────────────────

authRouter.post('/register/options', async (c) => {
  const { email, code, displayName } = await c.req.json<{ email: string; code: string; displayName?: string }>()
  if (!email || !email.includes('@')) {
    return c.json({ error: 'Valid email required' }, 400)
  }

  const userCount = await User.count()
  const isFirstUser = userCount === 0

  if (isFirstUser) {
    // Bootstrap gate: when FICUS_PASSWORD is configured, only the bootstrap-password
    // session may complete first-admin creation, even with a mailed/logged code.
    const gate = await requireBootstrapAuthForFirstUser(c)
    if (gate) return gate
  }

  // All users must verify their email code
  if (!code) {
    return c.json({ error: 'Verification code required' }, 400)
  }
  const valid = await verifyEmailCode(email, code)
  if (!valid) {
    return c.json({ error: 'Invalid or expired verification code' }, 401)
  }

  // Find or create user
  const userDisplayName = normalizeDisplayName(displayName)
  let user = await User.findByEmail(email)
  if (!user) {
    if (isFirstUser) {
      user = await User.create({ email, displayName: userDisplayName })
    } else {
      // Check if email domain matches allowed domains
      const allowed = await isEmailAllowed(email)
      if (allowed) {
        user = await createSelfRegisteredUser({ email, displayName: userDisplayName })
        if (!user) return c.json({ error: 'Sign-up is no longer allowed for this email.' }, 403)
      } else {
        return c.json({ error: 'User not found. Contact an admin for an invite.' }, 404)
      }
    }
  } else if (userDisplayName && user.displayName !== userDisplayName) {
    await user.update({ displayName: userDisplayName })
  }

  const options = await generateRegOptions(user)
  return c.json({ options })
})

// ── POST /register/verify ───────────────────────────────────────────────────

authRouter.post('/register/verify', async (c) => {
  // `displayName` names the USER; `credentialName` names the passkey being
  // registered. Two different things, so two different fields.
  const { email, response, displayName, credentialName } = await c.req.json<{
    email: string
    response: any
    displayName?: string
    credentialName?: string
  }>()
  if (!email || !response) {
    return c.json({ error: 'Email and response required' }, 400)
  }

  // Bootstrap gate: while no admin user exists yet this call would mint the first
  // admin (see the auto-admin assignment below). When FICUS_PASSWORD is configured,
  // require the bootstrap-password session so the passkey can't be planted by an
  // anonymous first visitor. By /register/verify the first user row already exists
  // (created in /register/options), so the first-user condition is "no admin yet".
  if (!(await hasAdminUsers())) {
    const gate = await requireBootstrapAuthForFirstUser(c)
    if (gate) return gate
  }

  const user = await User.findByEmail(email)
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  const verification = await verifyRegResponse(user, response)
  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: 'Verification failed' }, 401)
  }

  const { registrationInfo } = verification
  const userDisplayName = normalizeDisplayName(displayName)
  if (userDisplayName && user.displayName !== userDisplayName) {
    await user.update({ displayName: userDisplayName })
  }

  // Store credential
  await user.addCredential({
    credentialId: registrationInfo.credential.id,
    publicKey: Buffer.from(registrationInfo.credential.publicKey).toString('base64url'),
    counter: registrationInfo.credential.counter,
    transports: registrationInfo.credential.transports,
    displayName: resolveCredentialName(credentialName, c.req.header('User-Agent')),
  })

  // First user auto-admin: check and assign atomically
  const firstAdmin = await assignFirstAdminIfNone(user.id)

  // Create session
  const token = await user.createSession({
    userAgent: c.req.header('User-Agent'),
    ipAddress: c.req.header('X-Forwarded-For') ?? c.req.header('X-Real-IP'),
  })
  setSessionCookie(c, token)

  return c.json({ ok: true, token, user: user.toJSON(), firstAdmin })
})

// ── Deep-link token registration (invites + passkey recovery) ───────────────
//
// What a token authorises, exactly: registering a passkey for the ONE email
// address its `email_verifications` row was issued to, once, before it expires.
// It is not a session and not an API credential — no middleware accepts it, and
// the only two endpoints that read it are the halves of the WebAuthn
// registration ceremony below. A session is minted only AFTER a passkey has been
// successfully registered, exactly as in /register/verify; from then on the
// passkey is the credential.
//
// The token is consumed on the verify half, not the options half, so an
// abandoned or failed ceremony doesn't burn an invite. The consume is a single
// conditional UPDATE (`used_at IS NULL` → now), so concurrent redemptions of one
// token cannot both win.

/** The user a live token points at, or an error response if it doesn't point at a usable one. */
async function resolveTokenSubject(
  c: Context,
  token: string | undefined
): Promise<{ user: User; purpose: EmailVerificationPurpose } | Response> {
  if (!token) return c.json({ error: 'Token required' }, 400)
  const subject = await peekVerificationToken(token)
  // One indistinguishable failure for unknown / expired / already-used tokens.
  if (!subject) return c.json({ error: 'This link is invalid or has expired.' }, 401)

  // Case-insensitive: verification rows are lowercased, `users.email` is not.
  const user = await User.findByEmailInsensitive(subject.email)
  // Fail closed: a token outlives its user row (deleted) or the account was
  // disabled after the invite went out.
  if (!user || user.isDisabled) return c.json({ error: 'This link is invalid or has expired.' }, 401)
  return { user, purpose: subject.purpose }
}

// POST /api/auth/register/token/options — open the ceremony for a token holder.
// Non-consuming: returns the WebAuthn options plus the address the token belongs
// to, so the page can show whose account it is about to set up.
authRouter.post('/register/token/options', async (c) => {
  const { token } = await c.req.json<{ token?: string }>()
  const resolved = await resolveTokenSubject(c, token)
  if (resolved instanceof Response) return resolved
  const { user, purpose } = resolved

  const options = await generateRegOptions(user)
  return c.json({ options, email: user.email, displayName: user.displayName, purpose })
})

// POST /api/auth/register/token/verify — finish the ceremony and spend the token.
authRouter.post('/register/token/verify', async (c) => {
  // `displayName` names the USER (invite setup only — recovery never re-asks it,
  // the account already exists); `credentialName` names the passkey itself.
  type TokenVerifyBody = { token?: string; response?: any; displayName?: string; credentialName?: string }
  const { token, response, displayName, credentialName } = await c.req.json<TokenVerifyBody>()
  if (!response) return c.json({ error: 'Response required' }, 400)

  const resolved = await resolveTokenSubject(c, token)
  if (resolved instanceof Response) return resolved
  const { user } = resolved

  // Finishing first-admin setup: while no admin exists, the bootstrap session may
  // redeem a registration link for the account whose first-admin ceremony never
  // completed, and that account becomes the admin — exactly what /register/verify
  // grants the same session. Read before the credential is added below, because
  // the bootstrap password stops resolving the moment an admin holds a passkey.
  const bootstrapCaller = !(await hasAdminUsers()) && (await holdsBootstrapSession(c))

  // Verify the WebAuthn response BEFORE spending the token: a failed ceremony
  // (wrong authenticator, expired challenge) must leave the invite usable.
  // verifyRegResponse throws on a missing/expired challenge — that's a failed
  // ceremony, not a server fault, so it answers 401 like any other bad response.
  const verification = await verifyRegResponse(user, response).catch(() => null)
  if (!verification?.verified || !verification.registrationInfo) {
    return c.json({ error: 'Verification failed' }, 401)
  }

  // Atomic single-use consume. Only now is the token spent, and the purpose we
  // act on is the one on the row we actually burned — never the client's claim.
  const consumed = await consumeVerificationToken(token!)
  if (!consumed) return c.json({ error: 'This link is invalid or has expired.' }, 401)

  // Only an INVITE may set the user's display name — that is the ceremony where
  // the account is genuinely being set up. Recovery re-registers a passkey on an
  // account that already exists, so its form doesn't ask for an identity and the
  // server won't accept one either (the purpose is the one on the row we burned,
  // never the client's claim).
  const userDisplayName = consumed.purpose === 'recovery' ? undefined : normalizeDisplayName(displayName)
  if (userDisplayName && user.displayName !== userDisplayName) {
    await user.update({ displayName: userDisplayName })
  }

  await user.addCredential({
    credentialId: verification.registrationInfo.credential.id,
    publicKey: Buffer.from(verification.registrationInfo.credential.publicKey).toString('base64url'),
    counter: verification.registrationInfo.credential.counter,
    transports: verification.registrationInfo.credential.transports,
    displayName: resolveCredentialName(credentialName, c.req.header('User-Agent')),
  })

  if (consumed.purpose === 'recovery') {
    await replaceCredentialsAfterRecovery(user.id, verification.registrationInfo.credential.id)
  }
  const firstAdmin = consumed.purpose === 'register' && bootstrapCaller && (await assignFirstAdminIfNone(user.id))

  const sessionToken = await user.createSession({
    userAgent: c.req.header('User-Agent'),
    ipAddress: c.req.header('X-Forwarded-For') ?? c.req.header('X-Real-IP'),
  })
  setSessionCookie(c, sessionToken)

  return c.json({ ok: true, token: sessionToken, user: user.toJSON(), firstAdmin })
})

// ── POST /recover/passkey ───────────────────────────────────────────────────

// Explicit "I lost my passkey" request. Answers { ok: true } unconditionally: any
// difference in status, body or error between a known and an unknown address turns
// this endpoint into an account-existence oracle for anonymous callers. Everything
// that decides whether mail actually goes out happens silently after the response
// shape is already fixed.
authRouter.post('/recover/passkey', async (c) => {
  const { email } = await parseOptionalJsonObjectBody(c, {} as { email?: string })
  const ok = c.json({ ok: true })
  if (!email || !email.includes('@')) return ok

  const user = await User.findByEmailInsensitive(email)
  // Fail closed. No mail for unknown or disabled accounts — and no hint either.
  if (!user || user.isDisabled) return ok

  // Same 3-per-15-min-per-email budget as /register/email, and deliberately
  // silent: a 429 here would confirm the address is registered.
  if ((await recentVerificationCount(email)) >= VERIFICATION_RATE_LIMIT) return ok

  try {
    await sendPasskeyRecoveryEmail(user.email, { ttlMs: PASSKEY_RECOVERY_TTL_MS })
  } catch (err) {
    // A provider outage must not surface as a different response than "unknown address".
    log.error(`Failed to send passkey recovery email: ${(err as Error).message}`)
  }
  return ok
})

// ── POST /login/options ─────────────────────────────────────────────────────

authRouter.post('/login/options', async (c) => {
  const body = await parseOptionalJsonObjectBody(c, {} as { email?: string })
  const { options, challengeKey } = await generateAuthOptions(body.email)
  return c.json({ options, challengeKey })
})

// ── POST /login/verify ──────────────────────────────────────────────────────

authRouter.post('/login/verify', async (c) => {
  const { challengeKey, response } = await c.req.json<{ challengeKey: string; response: any }>()
  if (!challengeKey || !response) {
    return c.json({ error: 'challengeKey and response required' }, 400)
  }

  const result = await verifyAuthResponse(challengeKey, response).catch((error) => {
    if (error instanceof PasskeyAuthenticationError) return null
    throw error
  })
  if (!result) {
    return c.json(
      { error: 'Passkey verification failed. Try again and complete your device’s biometric or PIN prompt.' },
      401
    )
  }
  const { verification, userId } = result
  if (!verification.verified) {
    return c.json({ error: 'Authentication failed' }, 401)
  }

  const user = await User.findById(userId)
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  const token = await user.createSession({
    userAgent: c.req.header('User-Agent'),
    ipAddress: c.req.header('X-Forwarded-For') ?? c.req.header('X-Real-IP'),
  })
  setSessionCookie(c, token)

  return c.json({ ok: true, token, user: user.toJSON() })
})

// ── GET /settings ───────────────────────────────────────────────────────────

// The allowed-domain list is operator configuration, not public information: served
// anonymously it enumerates the organizations that can walk into the instance. Anything
// an unauthenticated login page legitimately needs is on GET /status (canSelfRegister).
authRouter.get('/settings', identityMiddleware, requirePermission('settings:read'), async (c) => {
  const settings = await getAuthSettings()
  return c.json({
    allowedDomains: settings.allowedDomains,
    requireInvite: settings.requireInvite,
    defaultSignupRoleId: settings.defaultSignupRoleId,
  })
})

// ── PUT /settings ───────────────────────────────────────────────────────────

authRouter.put('/settings', identityMiddleware, requirePermission('settings:write'), async (c) => {
  const parsed = z
    .object({
      allowedDomains: z.array(z.string().trim().min(1)).optional(),
      requireInvite: z.boolean().optional(),
      defaultSignupRoleId: z.string().uuid().nullable().optional(),
    })
    .strict()
    .safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: 'Invalid sign-up settings' }, 400)
  const body = parsed.data
  const existing = await getAuthSettings()
  const roleId = body.defaultSignupRoleId === undefined ? existing.defaultSignupRoleId : body.defaultSignupRoleId
  // Editing the admission policy can grant this role even when its ID is unchanged.
  // Apply the same no-privilege-escalation rule as manual user role assignments.
  const selfRegistrationEnabled =
    !(body.requireInvite ?? existing.requireInvite) || (body.allowedDomains ?? existing.allowedDomains).length > 0
  if (roleId && (selfRegistrationEnabled || roleId !== existing.defaultSignupRoleId)) {
    const role = await Role.findById(roleId)
    if (!role || !isUserAssignable(role)) return c.json({ error: 'Choose a role that can be assigned to users' }, 400)
    const permissions = await resolvePermissions(c.get('identity'))
    if (role.permissions.some((grant) => !permissions.some((held) => permissionMatches(held, grant)))) {
      return c.json({ error: 'Cannot grant permissions you do not hold' }, 403)
    }
  }
  await updateAuthSettings(body)
  const settings = await getAuthSettings()
  return c.json({
    allowedDomains: settings.allowedDomains,
    requireInvite: settings.requireInvite,
    defaultSignupRoleId: settings.defaultSignupRoleId,
  })
})

// ── GET /validate ───────────────────────────────────────────────────────────
// Validates a session token. Used by the frontend to check if a stored token
// is still valid without making a full login request.

authRouter.get('/validate', identityMiddleware, async (c) => {
  const identity = c.get('identity')
  if (identity.type !== 'legacy') return c.json({ valid: true, identityType: identity.type })
  // The bootstrap password session belongs to no person. While an account is
  // waiting to become the first passkey-holding admin, the web app shows the
  // finish-setup screen instead of the app (see pendingAdminSetup).
  return c.json({ valid: true, identityType: identity.type, firstAdmin: await pendingAdminSetup() })
})

// ── POST /logout ──────────────────────────────────────────────────────────────
// Clears the session cookie and revokes this device's session row. No identity
// middleware: logout must succeed (and clear the cookie) even if the token is
// already invalid.
authRouter.post('/logout', async (c) => {
  const token = extractSessionToken(c)
  if (token) {
    const tokenHash = createHash('sha256').update(token).digest('hex')
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash))
  }
  clearSessionCookie(c)
  return c.json({ ok: true })
})

// POST /api/auth/ws-ticket — mint a single-use, short-lived ticket for the
// caller's user session so the long-lived session bearer never travels in a
// WebSocket URL. Tickets are user-only; agents authenticate WS with their token.
authRouter.post('/ws-ticket', identityMiddleware, async (c) => {
  const identity = c.get('identity') as Identity | undefined
  if (!identity || identity.type !== 'user') {
    return c.json({ error: 'WS tickets require a user session' }, 400)
  }
  const ticket = await createWsTicket(identity.userId, c.get('authContext').deviceTokenId)
  return c.json({ ticket })
})

// ── Web handoff: a paired device signs its embedded web view in ─────────────
// See services/auth/web-handoff.ts. Responses are never cached, and the code is
// returned in a body, never a URL.

const handoffHeaders = { 'Cache-Control': 'no-store' }

// POST /api/auth/web-handoff — a paired device (its device token, not a browser
// session) mints a single-use, one-minute code for its web view.
authRouter.post('/web-handoff', identityMiddleware, async (c) => {
  const identity = c.get('identity') as Identity | undefined
  const deviceTokenId = c.get('authContext').deviceTokenId
  if (!identity || identity.type !== 'user' || !deviceTokenId) {
    return c.json({ error: 'Web handoffs are for paired devices' }, 403, handoffHeaders)
  }
  const { code, expiresAt } = await createWebHandoff(identity.userId, deviceTokenId)
  return c.json({ code, expiresAt: expiresAt.toISOString() }, 200, handoffHeaders)
})

// POST /api/auth/web-handoff/exchange — the web view trades the code for a
// browser session cookie tied to the device. The session token is not returned.
authRouter.post('/web-handoff/exchange', async (c) => {
  if (!webHandoffExchangeLimiter.take(getClientAddress(c.req.raw), 20, 60_000)) {
    return c.json({ error: 'rate_limited' }, 429, { ...handoffHeaders, 'Retry-After': '60' })
  }
  // Always require the first-party header, even with no cookie yet (the CSRF
  // middleware checks it only for cookie requests): a cross-site page must not
  // be able to post someone else's code and sign this browser into their account.
  if (!c.req.header(CSRF_HEADER)) return c.json({ error: 'Missing CSRF token' }, 403, handoffHeaders)
  const body = await parseOptionalJsonObjectBody(c, {} as { code?: unknown })
  const consumed = typeof body.code === 'string' ? await consumeWebHandoff(body.code) : null
  const user = consumed ? await User.findById(consumed.userId) : null
  if (!consumed || !user) return c.json({ error: 'invalid_handoff' }, 401, handoffHeaders)

  const token = await user.createSession({
    userAgent: c.req.header('User-Agent'),
    ipAddress: c.req.header('X-Forwarded-For') ?? c.req.header('X-Real-IP'),
    deviceTokenId: consumed.deviceTokenId,
  })
  setSessionCookie(c, token)
  return c.json({ ok: true }, 200, handoffHeaders)
})

// ── Browser-assisted CLI device authorization ───────────────────────────────

const deviceAuthHeaders = { 'Cache-Control': 'no-store' }

function isSecureDeviceAuthOrigin(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    // A misconfigured FICUS_WEB_ORIGIN must fail closed, never 500 an unauthenticated route.
    return false
  }
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
}

authRouter.post('/device/start', async (c) => {
  const clientAddress = getClientAddress(c.req.raw)
  if (!deviceAuthorizationStartLimiter.take(clientAddress, 10, 60_000)) {
    return c.json({ error: 'rate_limited' }, 429, { ...deviceAuthHeaders, 'Retry-After': '60' })
  }
  const body = await parseOptionalJsonObjectBody(c, {} as { name?: unknown; platform?: unknown })
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : ''
  if (body.platform !== undefined && body.platform !== 'cli' && body.platform !== 'desktop') {
    return c.json({ error: 'invalid_platform' }, 400, deviceAuthHeaders)
  }
  const platform = (body.platform as DeviceAuthorizationPlatform | undefined) ?? 'cli'
  // The verification URI points at /settings, a WEB route, so the configured browser origin
  // is the right base — and it must NOT be derived from the request. A CLI sends no Origin,
  // and core never terminates TLS (it sits behind caddy/nginx on plain 127.0.0.1), so
  // `c.req.url` is http:// on every HTTPS deployment and would 400 here. Ignoring the caller's
  // Origin also stops an attacker-chosen host being echoed into a URL a human is told to open.
  const webOrigin = primaryWebOrigin()
  if (!isSecureDeviceAuthOrigin(webOrigin)) {
    return c.json({ error: 'HTTPS is required' }, 400, deviceAuthHeaders)
  }
  const grant = await createDeviceAuthorization({ name, platform })
  const verificationUri = `${webOrigin}/settings?section=devices#device_request=${grant.verificationCode}`
  return c.json(
    {
      deviceCode: grant.deviceCode,
      verificationUri,
      expiresAt: grant.expiresAt.toISOString(),
      interval: DEVICE_AUTH_POLL_INTERVAL_SECONDS,
      // Desktop pairing is supported only when this field comes back exactly 'desktop'; an
      // older server ignores `platform` in the request and always issues a CLI grant, so
      // callers must check the value and discard the grant otherwise.
      platform: grant.platform,
    },
    200,
    deviceAuthHeaders
  )
})

authRouter.post('/device/inspect', identityMiddleware, async (c) => {
  const identity = c.get('identity') as Identity | undefined
  if (!identity || identity.type !== 'user') return c.json({ error: 'Not a user' }, 400, deviceAuthHeaders)
  const body = await parseOptionalJsonObjectBody(c, {} as { verificationCode?: unknown })
  const preview =
    typeof body.verificationCode === 'string' ? await inspectDeviceAuthorization(body.verificationCode) : null
  if (!preview) return c.json({ error: 'Invalid or expired authorization' }, 401, deviceAuthHeaders)
  return c.json({ ...preview, expiresAt: preview.expiresAt.toISOString() }, 200, deviceAuthHeaders)
})

authRouter.post('/device/approve', identityMiddleware, async (c) => {
  const identity = c.get('identity') as Identity | undefined
  if (!identity || identity.type !== 'user') return c.json({ error: 'Not a user' }, 400, deviceAuthHeaders)
  const body = await parseOptionalJsonObjectBody(c, {} as { verificationCode?: unknown })
  const approved =
    typeof body.verificationCode === 'string'
      ? await approveDeviceAuthorization(body.verificationCode, identity.userId)
      : false
  if (!approved) return c.json({ error: 'Invalid or expired authorization' }, 401, deviceAuthHeaders)
  return c.json({ ok: true }, 200, deviceAuthHeaders)
})

authRouter.post('/device/token', async (c) => {
  const body = await parseOptionalJsonObjectBody(c, {} as { deviceCode?: unknown })
  if (typeof body.deviceCode !== 'string') {
    return c.json({ error: 'invalid_or_expired_grant' }, 401, deviceAuthHeaders)
  }
  const result = await exchangeDeviceAuthorization(body.deviceCode)
  if (result.status === 'invalid') return c.json({ error: 'invalid_or_expired_grant' }, 401, deviceAuthHeaders)
  if (result.status === 'slow_down') {
    return c.json({ error: 'slow_down', interval: result.interval }, 429, {
      ...deviceAuthHeaders,
      'Retry-After': String(result.interval),
    })
  }
  if (result.status === 'pending') {
    return c.json({ status: 'authorization_pending', interval: result.interval }, 202, deviceAuthHeaders)
  }
  return c.json({ token: result.token, deviceId: result.deviceId, user: result.user }, 200, deviceAuthHeaders)
})

// ── Mobile device pairing (QR) ──────────────────────────────────────────────

// POST /api/auth/pair/start — (authenticated) mint a short-lived code + return the server URL to QR-encode.
authRouter.post('/pair/start', identityMiddleware, async (c) => {
  const identity = c.get('identity') as Identity | undefined
  if (!identity || identity.type !== 'user') {
    return c.json({ error: 'Pairing requires a user session' }, 400)
  }
  const { code, expiresAt } = await createPairingCode(identity.userId)
  // The phone should reach the same web/API base the user's browser is on.
  const serverUrl = buildMobilePairingServerUrl({ requestUrl: c.req.url, originHeader: c.req.header('origin') })
  return c.json({ code, serverUrl, expiresAt: expiresAt.toISOString() })
})

// POST /api/auth/pair/claim — (unauthenticated) claim a scanned code → a long-lived device token.
authRouter.post('/pair/claim', async (c) => {
  const body = await c.req.json<{ code?: string; name?: string; platform?: string }>()
  if (!body.code) return c.json({ error: 'Pairing code required' }, 400)
  const platform = body.platform === 'android' ? 'android' : body.platform === 'cli' ? 'cli' : 'ios'
  const defaultName = platform === 'cli' ? 'Ficus CLI' : platform === 'android' ? 'Android device' : 'iOS device'
  const name = (body.name?.trim() || defaultName).slice(0, 200)
  const result = await claimPairingCode({ code: body.code, name, platform })
  if (!result) return c.json({ error: 'Invalid or expired pairing code' }, 401)
  return c.json(result)
})

// POST /api/auth/demo/pair — (unauthenticated) app-store reviewer access on a
// designated demo instance: the private reviewer secret mints an ordinary
// pairing code for the shared demo account. Off (404) unless
// FICUS_DEMO_REVIEWER_ACCESS is set; see services/demo/access.ts.
authRouter.post('/demo/pair', async (c) => {
  const body = await c.req.json<{ secret?: unknown }>()
  const secret = typeof body.secret === 'string' ? body.secret : ''
  const result = await demoReviewerAccess.pair({
    secret,
    clientAddress: getClientAddress(c.req.raw),
    requestUrl: c.req.url,
    originHeader: c.req.header('origin'),
  })
  switch (result.status) {
    case 'disabled':
      return c.json({ error: 'Not found' }, 404)
    case 'rate_limited':
      return c.json({ error: 'rate_limited' }, 429, { 'Retry-After': String(result.retryAfterSeconds) })
    case 'invalid_secret':
      return c.json({ error: 'Invalid reviewer access code' }, 401)
    case 'not_seeded':
      return c.json({ error: 'demo_not_seeded' }, 503)
    case 'ok': {
      const { status: _status, ...pairing } = result
      return c.json(pairing)
    }
  }
})

// GET /api/auth/devices — (self-service) list my paired devices.
authRouter.get('/devices', identityMiddleware, async (c) => {
  const identity = c.get('identity') as Identity | undefined
  if (!identity || identity.type !== 'user') return c.json({ error: 'Not a user' }, 400)
  return c.json(await listDeviceTokens(identity.userId))
})

// DELETE /api/auth/devices/:id — (self-service) revoke one of my devices.
authRouter.delete('/devices/:id', identityMiddleware, async (c) => {
  const identity = c.get('identity') as Identity | undefined
  if (!identity || identity.type !== 'user') return c.json({ error: 'Not a user' }, 400)
  const ok = await revokeDeviceToken(identity.userId, c.req.param('id'))
  if (!ok) return c.json({ error: 'Device not found' }, 404)
  return c.body(null, 204)
})

// ── Self-service Account Management ─────────────────────────────────────────

// GET /api/auth/me — return current user info
authRouter.get('/me', identityMiddleware, async (c) => {
  const identity = c.get('identity')
  if (identity.type !== 'user') return c.json({ error: 'Not a user' }, 400)
  const user = await User.findById(identity.userId)
  if (!user) return c.json({ error: 'User not found' }, 404)
  return c.json(user.toJSON())
})

// Snapshot the account watermark without marking anything read. The browser
// acknowledges this server time only after the Feed has loaded successfully.
authRouter.get('/me/feed-visit', identityMiddleware, async (c) => {
  const identity = c.get('identity')
  if (identity.type !== 'user') return c.json({ error: 'Not a user' }, 400)
  const [row] = await db
    .select({
      lastVisitedAt: users.lastFeedVisitAt,
      observedAt: sql<string>`to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(users)
    .where(eq(users.id, identity.userId))
  if (!row) return c.json({ error: 'User not found' }, 404)
  c.header('Cache-Control', 'no-store')
  return c.json({ lastVisitedAt: row.lastVisitedAt?.toISOString() ?? null, observedAt: row.observedAt })
})

authRouter.post(
  '/me/feed-visit',
  identityMiddleware,
  zValidator('json', z.object({ visitedAt: z.string().datetime() })),
  async (c) => {
    const identity = c.get('identity')
    if (identity.type !== 'user') return c.json({ error: 'Not a user' }, 400)
    const { visitedAt } = c.req.valid('json')
    // Atomic max protects against delayed acknowledgments from another device;
    // the server clock caps client-supplied times so clock skew cannot skip work.
    const [row] = await db
      .update(users)
      .set({
        lastFeedVisitAt: sql`greatest(${users.lastFeedVisitAt}, least(${visitedAt}::timestamptz, clock_timestamp()))`,
      })
      .where(eq(users.id, identity.userId))
      .returning({ lastVisitedAt: users.lastFeedVisitAt })
    if (!row) return c.json({ error: 'User not found' }, 404)
    return c.json({ lastVisitedAt: row.lastVisitedAt?.toISOString() ?? null })
  }
)

// PATCH /api/auth/me — update current user profile
authRouter.patch('/me', identityMiddleware, async (c) => {
  const identity = c.get('identity')
  if (identity.type !== 'user') return c.json({ error: 'Not a user' }, 400)
  const { displayName } = await c.req.json<{ displayName?: string }>()
  const user = await User.findById(identity.userId)
  if (!user) return c.json({ error: 'User not found' }, 404)

  const updated = await user.update({ displayName: normalizeDisplayName(displayName) ?? null })

  return c.json(updated.toJSON())
})

// GET /api/auth/me/credentials — list passkeys (safe fields only)
authRouter.get('/me/credentials', identityMiddleware, async (c) => {
  const identity = c.get('identity')
  if (identity.type !== 'user') return c.json({ error: 'Not a user' }, 400)
  const user = await User.findById(identity.userId)
  if (!user) return c.json({ error: 'User not found' }, 404)
  const credentials = await user.getCredentials()
  return c.json(
    credentials.map((cred) => ({
      id: cred.id,
      credentialId: cred.credentialId,
      displayName: cred.displayName,
      createdAt: cred.createdAt,
    }))
  )
})

// PATCH /api/auth/me/credentials/:id — rename a passkey.
//
// Ownership is scoped exactly as the DELETE below scopes it: we only ever search
// inside THIS user's credential list, so someone else's id is simply "not found".
// Same 404 shape, same non-oracle — a stranger's credential is indistinguishable
// from one that never existed.
//
// Ownership is resolved BEFORE the name is validated, so a caller poking at an id
// they don't own learns nothing from the difference between a bad name and a bad id.
authRouter.patch('/me/credentials/:id', identityMiddleware, async (c) => {
  const identity = c.get('identity')
  if (identity.type !== 'user') return c.json({ error: 'Not a user' }, 400)
  const user = await User.findById(identity.userId)
  if (!user) return c.json({ error: 'User not found' }, 404)
  const credentials = await user.getCredentials()
  const credId = c.req.param('id')
  const target = credentials.find((cr) => cr.id === credId)
  if (!target) return c.json({ error: 'Credential not found' }, 404)

  const body = await c.req.json<{ displayName?: unknown }>()
  // Rejected rather than truncated (unlike the registration paths): a rename can
  // be retyped, so silently storing something other than what was asked for would
  // just be a lie the user has to discover.
  const name = typeof body.displayName === 'string' ? body.displayName.trim() : ''
  if (!name) return c.json({ error: 'Passkey name required' }, 400)
  if (name.length > MAX_CREDENTIAL_NAME_LENGTH) {
    return c.json({ error: `Passkey name must be ${MAX_CREDENTIAL_NAME_LENGTH} characters or fewer` }, 400)
  }

  await db.update(userCredentials).set({ displayName: name }).where(eq(userCredentials.id, credId))
  return c.json({ id: credId, displayName: name })
})

// DELETE /api/auth/me/credentials/:id — remove a passkey
authRouter.delete('/me/credentials/:id', identityMiddleware, async (c) => {
  const identity = c.get('identity')
  if (identity.type !== 'user') return c.json({ error: 'Not a user' }, 400)
  const user = await User.findById(identity.userId)
  if (!user) return c.json({ error: 'User not found' }, 404)
  const credentials = await user.getCredentials()
  if (credentials.length <= 1) {
    return c.json({ error: 'Cannot remove your only passkey' }, 400)
  }
  const credId = c.req.param('id')
  const credToDelete = credentials.find((cr) => cr.id === credId)
  if (!credToDelete) return c.json({ error: 'Credential not found' }, 404)

  await db.delete(userCredentials).where(eq(userCredentials.id, credId))
  return c.body(null, 204)
})

// POST /api/auth/me/credentials/options — start adding a new passkey
authRouter.post('/me/credentials/options', identityMiddleware, async (c) => {
  const identity = c.get('identity')
  if (identity.type !== 'user') return c.json({ error: 'Not a user' }, 400)
  const user = await User.findById(identity.userId)
  if (!user) return c.json({ error: 'User not found' }, 404)
  const options = await generateRegOptions(user)
  return c.json({ options })
})

// POST /api/auth/me/credentials/verify — complete adding a new passkey
authRouter.post('/me/credentials/verify', identityMiddleware, async (c) => {
  const identity = c.get('identity')
  if (identity.type !== 'user') return c.json({ error: 'Not a user' }, 400)
  const { response, displayName } = await c.req.json<{ response: any; displayName?: string }>()
  const user = await User.findById(identity.userId)
  if (!user) return c.json({ error: 'User not found' }, 404)

  const verification = await verifyRegResponse(user, response)
  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: 'Verification failed' }, 401)
  }

  await user.addCredential({
    credentialId: verification.registrationInfo.credential.id,
    publicKey: Buffer.from(verification.registrationInfo.credential.publicKey).toString('base64url'),
    counter: verification.registrationInfo.credential.counter,
    transports: verification.registrationInfo.credential.transports,
    // `displayName` on this endpoint has always meant the PASSKEY's label, not
    // the user's — this route only ever adds a credential to an existing account.
    displayName: resolveCredentialName(displayName, c.req.header('User-Agent')),
  })

  return c.json({ ok: true })
})

// ── Permissions / Introspection ──────────────────────────────────────────────

// GET /api/auth/introspect — returns current identity, effective roles, and permissions.
authRouter.get('/introspect', identityMiddleware, async (c) => {
  const identity = c.get('identity')
  const squadId = c.req.query('squadId')
  const [permissions, roles] = await Promise.all([
    resolvePermissions(identity, squadId),
    resolveRoleSummaries(identity, squadId),
  ])
  return c.json({ identity, squadId: squadId ?? null, roles, permissions, server: await getServerInfo() })
})

// GET /api/auth/permissions — returns current identity's resolved permissions
authRouter.get('/permissions', identityMiddleware, async (c) => {
  const identity = c.get('identity')
  const squadId = c.req.query('squadId')
  const permissions = await resolvePermissions(identity, squadId)
  return c.json({ permissions, identity })
})
