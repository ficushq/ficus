/**
 * Registration attestation policy, exercised against the real @simplewebauthn/server
 * library (no module mocks): `none` and `packed` self-attestation register; any
 * statement with a certificate chain is refused before the library processes it, so
 * no URL named in a submitted certificate is ever contacted.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test'
import { _decodeClientDataJSONInternals } from '@simplewebauthn/server/helpers'
import { generateRegOptions, rpConfigFor, verifyRegResponse } from './webauthn'
import {
  ATTESTATIONS_WITH_CERTIFICATE_CHAINS,
  syntheticRegistrationResponse,
  type SyntheticAttestation,
} from '../../test-utils/webauthn-registration'

function makeUser(id: string) {
  return { id, email: `${id}@example.com`, displayName: null, getCredentials: async () => [] }
}

let listenerRequests: string[] = []
let listener: ReturnType<typeof Bun.serve>
let revocationUrl: string

beforeAll(() => {
  listener = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      listenerRequests.push(new URL(request.url).pathname)
      return new Response(new Uint8Array(0))
    },
  })
  revocationUrl = `http://127.0.0.1:${listener.port}/synthetic.crl`
})

afterAll(() => {
  listener.stop(true)
})

afterEach(() => {
  listenerRequests = []
})

async function register(userId: string, attestation: SyntheticAttestation) {
  const user = makeUser(userId)
  const options = await generateRegOptions(user as any)
  const { origin, rpId } = rpConfigFor()
  const response = syntheticRegistrationResponse({
    challenge: options.challenge,
    origin,
    rpId,
    attestation,
    certificateRevocationUrl: revocationUrl,
  })
  return verifyRegResponse(user as any, response)
}

describe('registration attestation policy', () => {
  it('requests attestation "none" (the policy below relies on it)', async () => {
    const options = await generateRegOptions(makeUser('attestation-requested') as any)
    expect(options.attestation).toBe('none')
  })

  it.each([
    ['none', 'none'],
    ['packed-self', 'packed'],
  ] as const)('registers a passkey with %s attestation', async (attestation, fmt) => {
    const libraryEntry = spyOn(_decodeClientDataJSONInternals, 'stubThis')
    try {
      const result = await register(`attestation-accepted-${attestation}`, attestation)
      expect(result.verified).toBe(true)
      expect(result.registrationInfo?.fmt).toBe(fmt)
      // The library's full verification ran (its first step decodes clientDataJSON).
      expect(libraryEntry).toHaveBeenCalledTimes(1)
    } finally {
      libraryEntry.mockRestore()
    }
  })

  it.each(ATTESTATIONS_WITH_CERTIFICATE_CHAINS)(
    'refuses %s attestation with a certificate chain without contacting any URL it names',
    async (attestation) => {
      const fetchSpy = spyOn(globalThis, 'fetch')
      const libraryEntry = spyOn(_decodeClientDataJSONInternals, 'stubThis')
      try {
        const result = await register(`attestation-refused-${attestation}`, attestation)
        expect(result).toEqual({ verified: false })
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(listenerRequests).toEqual([])
        // Refused before the library's verification started.
        expect(libraryEntry).not.toHaveBeenCalled()
      } finally {
        fetchSpy.mockRestore()
        libraryEntry.mockRestore()
      }
    }
  )
})
