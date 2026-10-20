import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
} from '@simplewebauthn/server'
import { db } from '../../db'
import { userCredentials, webauthnChallenges } from '../../db/schema'
import { eq, and, gt, lt } from 'drizzle-orm'
import { User } from '../../entities/User'
import { rpOriginForRequest, rpOriginForStepUp } from './web-origins'

/** Authentication-ceremony options. `stepUp` marks a re-confirmation of an already signed-in person. */
export interface CeremonyOptions {
  stepUp?: { sessionOrigin: string | null | undefined }
}

// AuthenticatorTransport is not exported from @simplewebauthn/server main entry
type AuthenticatorTransport = 'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb'

/**
 * WebAuthn relying-party settings for one ceremony. The origin is the request's
 * Origin when it is one of this server's allowed origins (public address, local
 * address, pinned web origins), else the primary origin — so a passkey works on the
 * hostname it was registered on and no existing credential is silently re-bound.
 * The RP ID is that origin's host; WEBAUTHN_RP_ID pins a parent domain only when it
 * actually covers the chosen host (otherwise the browser would reject it anyway).
 *
 * `stepUp` (authentication ceremonies that re-confirm a signed-in person, never
 * login or registration) may also fall back to the origin recorded on the caller's
 * session — see rpOriginForStepUp.
 */
export function rpConfigFor(requestOrigin?: string | null, opts?: CeremonyOptions) {
  const origin = opts?.stepUp
    ? rpOriginForStepUp(requestOrigin, opts.stepUp.sessionOrigin)
    : rpOriginForRequest(requestOrigin)
  let originHost = 'localhost'
  try {
    originHost = new URL(origin).hostname
  } catch {
    /* keep the localhost fallback */
  }
  const pinned = process.env.WEBAUTHN_RP_ID?.trim().toLowerCase()
  const rpId = pinned && (originHost === pinned || originHost.endsWith(`.${pinned}`)) ? pinned : originHost
  const rpName = process.env.WEBAUTHN_RP_NAME ?? 'Ficus'
  return { rpId, rpName, origin }
}

// DB-backed challenge store (5 min TTL, single-use)
async function storeChallenge(key: string, challenge: string): Promise<void> {
  await db
    .insert(webauthnChallenges)
    .values({
      challengeKey: key,
      challenge,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    })
    .onConflictDoUpdate({
      target: webauthnChallenges.challengeKey,
      set: { challenge, expiresAt: new Date(Date.now() + 5 * 60 * 1000) },
    })
}

async function getAndDeleteChallenge(key: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(webauthnChallenges)
    .where(and(eq(webauthnChallenges.challengeKey, key), gt(webauthnChallenges.expiresAt, new Date())))
  if (!row) return null
  await db.delete(webauthnChallenges).where(eq(webauthnChallenges.id, row.id))
  return row.challenge
}

export async function cleanupExpiredChallenges(): Promise<void> {
  await db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, new Date()))
}

export async function generateRegOptions(user: User, requestOrigin?: string | null) {
  const { rpId, rpName } = rpConfigFor(requestOrigin)
  const existingCreds = await user.getCredentials()

  const options = await generateRegistrationOptions({
    rpName,
    rpID: rpId,
    userName: user.email,
    userDisplayName: user.displayName ?? user.email,
    excludeCredentials: existingCreds.map((c) => ({
      id: c.credentialId,
      transports: (c.transports as AuthenticatorTransport[] | null) ?? undefined,
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
    },
  })

  await storeChallenge(`reg:${user.id}`, options.challenge)
  return options
}

export async function verifyRegResponse(
  user: User,
  response: any,
  requestOrigin?: string | null
): Promise<VerifiedRegistrationResponse> {
  const { rpId, origin } = rpConfigFor(requestOrigin)
  const expectedChallenge = await getAndDeleteChallenge(`reg:${user.id}`)
  if (!expectedChallenge) throw new Error('Challenge expired or not found')

  return verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
  })
}

export async function generateAuthOptions(email?: string, requestOrigin?: string | null, opts?: CeremonyOptions) {
  const { rpId } = rpConfigFor(requestOrigin, opts)
  let allowCredentials: { id: string; transports?: AuthenticatorTransport[] }[] | undefined

  if (email) {
    const user = await User.findByEmail(email)
    if (user) {
      const creds = await user.getCredentials()
      allowCredentials = creds.map((c) => ({
        id: c.credentialId,
        transports: (c.transports as AuthenticatorTransport[] | null) ?? undefined,
      }))
    }
  }

  const options = await generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials,
    userVerification: 'required',
  })

  // Always key the challenge by the random challenge value, never by the
  // client-supplied email: an email-derived key is predictable (an attacker can
  // pre-populate it) and concurrent same-email logins clobber each other via
  // the upsert. allowCredentials is still computed from email above.
  const challengeKey = `auth:${options.challenge}`
  await storeChallenge(challengeKey, options.challenge)

  return { options, challengeKey }
}

export class PasskeyAuthenticationError extends Error {}

export async function verifyAuthResponse(
  challengeKey: string,
  response: any,
  requestOrigin?: string | null,
  opts?: CeremonyOptions
) {
  const { rpId, origin } = rpConfigFor(requestOrigin, opts)
  const expectedChallenge = await getAndDeleteChallenge(challengeKey)
  if (!expectedChallenge) throw new PasskeyAuthenticationError('Challenge expired or not found')

  const credId = response?.id
  if (typeof credId !== 'string' || !credId) throw new PasskeyAuthenticationError('Invalid credential response')
  const [cred] = await db.select().from(userCredentials).where(eq(userCredentials.credentialId, credId))
  if (!cred) throw new PasskeyAuthenticationError('Credential not found')

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    requireUserVerification: true,
    credential: {
      id: cred.credentialId,
      publicKey: Buffer.from(cred.publicKey, 'base64url'),
      counter: cred.counter,
      transports: (cred.transports as AuthenticatorTransport[] | null) ?? undefined,
    },
  }).catch((cause) => {
    throw new PasskeyAuthenticationError('Passkey verification failed', { cause })
  })

  if (verification.verified && verification.authenticationInfo) {
    await db
      .update(userCredentials)
      .set({ counter: verification.authenticationInfo.newCounter })
      .where(eq(userCredentials.id, cred.id))
  }

  return { verification, userId: cred.userId }
}
