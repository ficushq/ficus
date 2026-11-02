import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { db, userCredentials, users } from '../../db'
import { eq } from 'drizzle-orm'

// ── Mock @simplewebauthn/server before importing ──────────────────────────────
const mockGenerateRegistrationOptions = mock(async () => ({
  challenge: 'mock-reg-challenge',
  rp: { name: 'Ficus', id: 'localhost' },
  user: { id: 'user-id', name: 'user@example.com', displayName: 'user@example.com' },
  pubKeyCredParams: [],
  timeout: 60000,
  excludeCredentials: [],
  authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
}))

const mockVerifyRegistrationResponse = mock(async () => ({
  verified: true,
  registrationInfo: {
    credentialID: 'cred-id',
    credentialPublicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
  },
}))

const mockGenerateAuthenticationOptions = mock(async () => ({
  challenge: 'mock-auth-challenge',
  rpId: 'localhost',
  timeout: 60000,
  allowCredentials: [],
  userVerification: 'preferred',
}))

const mockVerifyAuthenticationResponse = mock(async () => ({
  verified: true,
  authenticationInfo: {
    newCounter: 1,
    credentialID: 'cred-id',
  },
}))

mock.module('@simplewebauthn/server', () => ({
  generateRegistrationOptions: mockGenerateRegistrationOptions,
  verifyRegistrationResponse: mockVerifyRegistrationResponse,
  generateAuthenticationOptions: mockGenerateAuthenticationOptions,
  verifyAuthenticationResponse: mockVerifyAuthenticationResponse,
}))

// ── Import service under test (after mocks) ───────────────────────────────────
const {
  generateRegOptions,
  verifyRegResponse,
  generateAuthOptions,
  verifyAuthResponse,
  cleanupExpiredChallenges,
  unsupportedAttestationReason,
} = await import('./webauthn')
const { syntheticRegistrationResponse, ATTESTATIONS_WITH_CERTIFICATE_CHAINS } =
  await import('../../test-utils/webauthn-registration')

/** A registration response the mocked library would accept, with the given attestation. */
function registration(attestation: Parameters<typeof syntheticRegistrationResponse>[0]['attestation'] = 'none') {
  return syntheticRegistrationResponse({
    challenge: 'mock-reg-challenge',
    origin: 'http://localhost',
    rpId: 'localhost',
    attestation,
  })
}

// ── Minimal User stub ─────────────────────────────────────────────────────────
function makeUser(overrides: Partial<{ id: string; email: string; displayName: string | null }> = {}) {
  return {
    id: overrides.id ?? 'user-1',
    email: overrides.email ?? 'user@example.com',
    displayName: overrides.displayName ?? null,
    getCredentials: mock(async () => []),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('generateRegOptions', () => {
  beforeEach(() => {
    mockGenerateRegistrationOptions.mockClear()
  })

  it('calls generateRegistrationOptions and returns options', async () => {
    const user = makeUser()
    const options = await generateRegOptions(user as any)
    expect(options).toBeDefined()
    expect(options.challenge).toBe('mock-reg-challenge')
    expect(mockGenerateRegistrationOptions).toHaveBeenCalledTimes(1)
  })

  it('stores the challenge in the DB (subsequent verifyRegResponse finds it)', async () => {
    const user = makeUser({ id: 'user-store-test' })
    await generateRegOptions(user as any)
    // If challenge was stored, verifyRegResponse should not throw "Challenge expired"
    // (it will call the mocked verifyRegistrationResponse)
    const result = await verifyRegResponse(user as any, registration())
    expect(result.verified).toBe(true)
  })

  it('uses email as userName', async () => {
    const user = makeUser({ email: 'alice@example.com' })
    await generateRegOptions(user as any)
    const call = (mockGenerateRegistrationOptions.mock.calls as any[])[0][0] as any
    expect(call.userName).toBe('alice@example.com')
    expect(call.authenticatorSelection.userVerification).toBe('required')
  })
})

describe('verifyRegResponse', () => {
  beforeEach(() => {
    mockVerifyRegistrationResponse.mockClear()
  })

  it('throws when no challenge is found', async () => {
    const user = makeUser({ id: 'no-challenge-user' })
    // Do NOT call generateRegOptions first — no challenge stored
    await expect(verifyRegResponse(user as any, registration())).rejects.toThrow('Challenge expired or not found')
  })

  it('returns verification result', async () => {
    const user = makeUser({ id: 'verify-reg-user' })
    await generateRegOptions(user as any)
    const result = await verifyRegResponse(user as any, registration())
    expect(result.verified).toBe(true)
  })

  it('challenge is single-use — second call throws', async () => {
    const user = makeUser({ id: 'single-use-reg' })
    await generateRegOptions(user as any)
    await verifyRegResponse(user as any, registration())
    await expect(verifyRegResponse(user as any, registration())).rejects.toThrow('Challenge expired or not found')
  })

  it.each(['none', 'packed-self'] as const)('passes %s attestation on to full verification', async (attestation) => {
    const user = makeUser({ id: `accepted-${attestation}` })
    await generateRegOptions(user as any)
    const result = await verifyRegResponse(user as any, registration(attestation))
    expect(result.verified).toBe(true)
    expect(mockVerifyRegistrationResponse).toHaveBeenCalledTimes(1)
  })

  it.each([...ATTESTATIONS_WITH_CERTIFICATE_CHAINS, 'android-safetynet'] as const)(
    'refuses %s attestation as a failed registration without running full verification',
    async (attestation) => {
      const user = makeUser({ id: `refused-${attestation}` })
      await generateRegOptions(user as any)
      const result = await verifyRegResponse(user as any, registration(attestation))
      expect(result).toEqual({ verified: false })
      expect(mockVerifyRegistrationResponse).not.toHaveBeenCalled()
      // The refusal is a spent ceremony like any other failure.
      await expect(verifyRegResponse(user as any, registration())).rejects.toThrow('Challenge expired or not found')
    }
  )

  it('refuses a response with a missing or malformed attestation object', async () => {
    for (const response of [
      {},
      { response: {} },
      { response: { attestationObject: 'not-cbor' } },
      { response: { attestationObject: 42 } },
    ]) {
      const user = makeUser({ id: 'refused-malformed' })
      await generateRegOptions(user as any)
      expect(await verifyRegResponse(user as any, response)).toEqual({ verified: false })
    }
    expect(mockVerifyRegistrationResponse).not.toHaveBeenCalled()
  })
})

describe('unsupportedAttestationReason', () => {
  it('accepts none and packed self-attestation', () => {
    expect(unsupportedAttestationReason(registration('none'))).toBeNull()
    expect(unsupportedAttestationReason(registration('packed-self'))).toBeNull()
  })

  it('names the unsupported format or certificate chain', () => {
    expect(unsupportedAttestationReason(registration('apple'))).toBe('unsupported attestation format "apple"')
    expect(unsupportedAttestationReason(registration('packed-x5c'))).toBe(
      'attestation certificate chain in packed attestation'
    )
    expect(unsupportedAttestationReason(null)).toBe('missing attestation object')
  })
})

describe('generateAuthOptions', () => {
  beforeEach(() => {
    mockGenerateAuthenticationOptions.mockClear()
  })

  it('returns options and challengeKey', async () => {
    const { options, challengeKey } = await generateAuthOptions()
    expect(options).toBeDefined()
    expect(challengeKey).toBeDefined()
    expect(typeof challengeKey).toBe('string')
    expect((mockGenerateAuthenticationOptions.mock.calls as any[]).at(-1)[0].userVerification).toBe('required')
  })

  it('does not key the auth challenge by email (uses the unpredictable challenge value)', async () => {
    const { challengeKey, options } = await generateAuthOptions('user@example.com')
    // Email-derived keys are predictable/clobberable; key by the random challenge.
    expect(challengeKey).not.toBe('auth:user@example.com')
    expect(challengeKey).toBe(`auth:${options.challenge}`)
  })

  it('challengeKey uses challenge value when no email', async () => {
    const { challengeKey, options } = await generateAuthOptions()
    expect(challengeKey).toBe(`auth:${options.challenge}`)
  })
})

describe('cleanupExpiredChallenges', () => {
  it('runs without error', async () => {
    await expect(cleanupExpiredChallenges()).resolves.toBeUndefined()
  })
})

describe('verifyAuthResponse', () => {
  // Track inserted rows for cleanup
  let insertedCredId: string | undefined
  let insertedUserId: string | undefined

  afterEach(async () => {
    if (insertedCredId) {
      await db.delete(userCredentials).where(eq(userCredentials.credentialId, insertedCredId))
      insertedCredId = undefined
    }
    if (insertedUserId) {
      await db.delete(users).where(eq(users.id, insertedUserId))
      insertedUserId = undefined
    }
    mockVerifyAuthenticationResponse.mockClear()
  })

  async function insertUserAndCredential(credentialId: string, email: string, counter = 0) {
    // Insert user first (FK constraint)
    const [user] = await db.insert(users).values({ email }).returning()
    insertedUserId = user.id
    // Insert credential referencing the user
    const [cred] = await db
      .insert(userCredentials)
      .values({
        userId: user.id,
        credentialId,
        publicKey: Buffer.from([1, 2, 3]).toString('base64url'),
        counter,
        transports: null,
        displayName: null,
      })
      .returning()
    insertedCredId = cred.credentialId
    return { user, cred }
  }

  it('success: returns { verification, userId } and updates counter', async () => {
    const credId = 'auth-test-cred-success'
    const newCounter = 42

    mockVerifyAuthenticationResponse.mockResolvedValueOnce({
      verified: true,
      authenticationInfo: { newCounter, credentialID: credId },
    })

    const { user } = await insertUserAndCredential(credId, 'auth-test-success@example.com', 0)

    // Store a challenge via generateAuthOptions using a unique email
    const { challengeKey } = await generateAuthOptions('auth-challenge-success@example.com')

    const result = await verifyAuthResponse(challengeKey, { id: credId })

    expect(result.userId).toBe(user.id)
    expect(result.verification.verified).toBe(true)

    // Verify counter was updated in DB
    const [updated] = await db.select().from(userCredentials).where(eq(userCredentials.credentialId, credId))
    expect(updated.counter).toBe(newCounter)
  })

  it('rejects an unverified phone assertion without updating the counter or reusing its challenge', async () => {
    const credId = 'auth-test-unverified-phone'
    await insertUserAndCredential(credId, 'auth-test-unverified-phone@example.com', 7)
    const { challengeKey } = await generateAuthOptions()
    mockVerifyAuthenticationResponse.mockRejectedValueOnce(
      new Error('User verification required, but user could not be verified')
    )
    await expect(verifyAuthResponse(challengeKey, { id: credId })).rejects.toThrow('Passkey verification failed')
    expect((mockVerifyAuthenticationResponse.mock.calls as any[]).at(-1)[0].requireUserVerification).toBe(true)
    const [credential] = await db.select().from(userCredentials).where(eq(userCredentials.credentialId, credId))
    expect(credential.counter).toBe(7)
    await expect(verifyAuthResponse(challengeKey, { id: credId })).rejects.toThrow('Challenge expired or not found')
  })

  it('no challenge: throws "Challenge expired or not found"', async () => {
    // Use a key that was never stored
    await expect(verifyAuthResponse('auth:no-such-key-ever', { id: 'any-cred' })).rejects.toThrow(
      'Challenge expired or not found'
    )
  })

  it('unknown credential: throws "Credential not found"', async () => {
    // Store a challenge first so we get past the challenge check
    const { challengeKey } = await generateAuthOptions('auth-unknown-cred@example.com')

    await expect(verifyAuthResponse(challengeKey, { id: 'nonexistent-cred-id-xyz' })).rejects.toThrow(
      'Credential not found'
    )
  })
})
