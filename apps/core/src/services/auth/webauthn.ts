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
import { primaryWebOrigin } from './web-origins'

// AuthenticatorTransport is not exported from @simplewebauthn/server main entry
type AuthenticatorTransport = 'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb'

function getRpConfig() {
  const origin = primaryWebOrigin()
  // The RP ID must be the registrable domain of the origin — default it to the origin's
  // host (e.g. home.example.com) rather than "localhost", which would reject passkeys on a
  // real domain. Set WEBAUTHN_RP_ID only to pin a parent domain.
  let originHost = 'localhost'
  try {
    originHost = new URL(origin).hostname
  } catch {
    /* keep the localhost fallback */
  }
  const rpId = process.env.WEBAUTHN_RP_ID ?? originHost
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

export async function generateRegOptions(user: User) {
  const { rpId, rpName } = getRpConfig()
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

export async function verifyRegResponse(user: User, response: any): Promise<VerifiedRegistrationResponse> {
  const { rpId, origin } = getRpConfig()
  const expectedChallenge = await getAndDeleteChallenge(`reg:${user.id}`)
  if (!expectedChallenge) throw new Error('Challenge expired or not found')

  return verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
  })
}

export async function generateAuthOptions(email?: string) {
  const { rpId } = getRpConfig()
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

export async function verifyAuthResponse(challengeKey: string, response: any) {
  const { rpId, origin } = getRpConfig()
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
