/**
 * Synthetic WebAuthn registration responses for tests. Every key and certificate
 * is generated on the fly; nothing comes from a real authenticator.
 *
 * `none` and `packed-self` are complete, verifiable registrations (a real ES256
 * credential key, valid authenticator data and, for `packed-self`, a valid
 * self-attestation signature). The other kinds carry an `x5c` certificate chain
 * (or, for `android-safetynet`, a format Ficus does not accept) and exist to show
 * that such registrations are refused.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers'

export type SyntheticAttestation =
  'none' | 'packed-self' | 'packed-x5c' | 'fido-u2f' | 'android-key' | 'android-safetynet' | 'tpm' | 'apple'

export const ATTESTATIONS_WITH_CERTIFICATE_CHAINS = ['packed-x5c', 'fido-u2f', 'android-key', 'tpm', 'apple'] as const

export interface SyntheticRegistrationOptions {
  challenge: string
  origin: string
  rpId: string
  attestation: SyntheticAttestation
  /** Revocation list URL written into the synthetic certificate, if any. */
  certificateRevocationUrl?: string
}

const ES256 = -7

/** A value the library's CBOR encoder accepts. */
type CBOR = Parameters<typeof isoCBOR.encode>[0]

export function syntheticRegistrationResponse(opts: SyntheticRegistrationOptions) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const credentialId = new Uint8Array(randomBytes(16))
  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({ type: 'webauthn.create', challenge: opts.challenge, origin: opts.origin, crossOrigin: false })
  )
  const clientDataHash = sha256(clientDataJSON)
  const authData = concat(
    sha256(new TextEncoder().encode(opts.rpId)),
    Uint8Array.of(0x45), // user present, user verified, attested credential data
    new Uint8Array(4), // signature counter
    new Uint8Array(16), // zero AAGUID
    Uint8Array.of(0, credentialId.length),
    credentialId,
    coseKey(publicKey)
  )
  const selfSignature = new Uint8Array(sign('sha256', concat(authData, clientDataHash), privateKey))
  const chain = () => [syntheticCertificate(publicKey, privateKey, opts.certificateRevocationUrl)]

  const statements: Record<SyntheticAttestation, [string, Map<string, CBOR>]> = {
    none: ['none', new Map()],
    'packed-self': [
      'packed',
      new Map<string, CBOR>([
        ['alg', ES256],
        ['sig', selfSignature],
      ]),
    ],
    'packed-x5c': [
      'packed',
      new Map<string, CBOR>([
        ['alg', ES256],
        ['sig', selfSignature],
        ['x5c', chain()],
      ]),
    ],
    'fido-u2f': [
      'fido-u2f',
      new Map<string, CBOR>([
        ['sig', selfSignature],
        ['x5c', chain()],
      ]),
    ],
    'android-key': [
      'android-key',
      new Map<string, CBOR>([
        ['alg', ES256],
        ['sig', selfSignature],
        ['x5c', chain()],
      ]),
    ],
    'android-safetynet': [
      'android-safetynet',
      new Map<string, CBOR>([
        ['ver', '1'],
        ['response', new TextEncoder().encode('synthetic')],
      ]),
    ],
    tpm: [
      'tpm',
      new Map<string, CBOR>([
        ['ver', '2.0'],
        ['alg', ES256],
        ['sig', selfSignature],
        ['x5c', chain()],
        ['certInfo', new Uint8Array(32)],
        ['pubArea', new Uint8Array(32)],
      ]),
    ],
    apple: ['apple', new Map<string, CBOR>([['x5c', chain()]])],
  }
  const [fmt, attStmt] = statements[opts.attestation]
  const attestationObject = isoCBOR.encode(
    new Map<string, CBOR>([
      ['fmt', fmt],
      ['attStmt', attStmt],
      ['authData', authData],
    ])
  )

  const id = isoBase64URL.fromBuffer(credentialId)
  return {
    id,
    rawId: id,
    type: 'public-key' as const,
    clientExtensionResults: {},
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
      attestationObject: isoBase64URL.fromBuffer(attestationObject),
      transports: ['internal'],
    },
  }
}

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest())
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function coseKey(publicKey: KeyObject): Uint8Array {
  const jwk = publicKey.export({ format: 'jwk' })
  return isoCBOR.encode(
    new Map<number, CBOR>([
      [1, 2], // kty: EC2
      [3, ES256],
      [-1, 1], // crv: P-256
      [-2, isoBase64URL.toBuffer(jwk.x!)],
      [-3, isoBase64URL.toBuffer(jwk.y!)],
    ])
  )
}

// ── Minimal DER encoding for a self-signed ECDSA P-256 certificate ────────────

function der(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(...parts)
  const n = body.length
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]
  return concat(Uint8Array.of(tag, ...length), body)
}

const bytes = (...values: number[]) => Uint8Array.of(...values)
const text = (value: string) => new TextEncoder().encode(value)
const sequence = (...parts: Uint8Array[]) => der(0x30, ...parts)
const ECDSA_WITH_SHA256 = sequence(der(0x06, bytes(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02)))
const COMMON_NAME = der(0x06, bytes(0x55, 0x04, 0x03))
const CRL_DISTRIBUTION_POINTS = der(0x06, bytes(0x55, 0x1d, 0x1f))

function utcTime(date: Date): Uint8Array {
  const iso = date.toISOString() // YYYY-MM-DDTHH:MM:SS.sssZ
  return der(0x17, text(iso.slice(2, 19).replace(/[-T:]/g, '') + 'Z'))
}

/** A self-signed certificate for `publicKey`, optionally naming a revocation list URL. */
function syntheticCertificate(publicKey: KeyObject, privateKey: KeyObject, revocationUrl?: string): Uint8Array {
  const name = sequence(der(0x31, sequence(COMMON_NAME, der(0x0c, text('Synthetic attestation')))))
  const extensions = revocationUrl
    ? [
        der(
          0xa3,
          sequence(
            sequence(
              CRL_DISTRIBUTION_POINTS,
              der(0x04, sequence(sequence(der(0xa0, der(0xa0, der(0x86, text(revocationUrl)))))))
            )
          )
        ),
      ]
    : []
  const tbs = sequence(
    der(0xa0, der(0x02, bytes(2))), // version 3
    der(0x02, bytes(1)), // serial number
    ECDSA_WITH_SHA256,
    name,
    sequence(utcTime(new Date(Date.now() - 86_400_000)), utcTime(new Date(Date.now() + 86_400_000))),
    name,
    new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })),
    ...extensions
  )
  const signature = new Uint8Array(sign('sha256', tbs, privateKey))
  return sequence(tbs, ECDSA_WITH_SHA256, der(0x03, bytes(0), signature))
}
