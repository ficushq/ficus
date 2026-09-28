import { describe, test, expect } from 'bun:test'
import { type AmtpEnvelope, amtpEnvelopeSchema } from '@ficus/shared'
import { generateInstanceKeyPair, signEnvelope, verifyEnvelope } from './crypto'
import { formatAmtpAddress } from './address'

describe('federation envelope sign/verify roundtrip', () => {
  test('build -> JSON.stringify -> signEnvelope -> verifyEnvelope over raw bytes', () => {
    const { publicKeyPem, privateKeyPem } = generateInstanceKeyPair()

    const envelope: AmtpEnvelope = {
      v: 1,
      id: crypto.randomUUID(),
      ts: Date.now(),
      from: formatAmtpAddress('senderInstance', 'alice'),
      to: formatAmtpAddress('recipientInstance', 'bob'),
      subject: 'hi',
      content: 'hello bob',
    }

    // The schema accepts the envelope we just built.
    expect(amtpEnvelopeSchema.safeParse(envelope).success).toBe(true)

    // Sign the EXACT serialized bytes (the same bytes the transport will carry).
    const raw = JSON.stringify(envelope)
    const sig = signEnvelope(privateKeyPem, new TextEncoder().encode(raw))
    expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/) // base64

    // Verifier re-encodes the raw body and checks the signature.
    expect(verifyEnvelope(publicKeyPem, new TextEncoder().encode(raw), sig)).toBe(true)

    // Tampering with the body invalidates the signature.
    const tampered = new TextEncoder().encode(raw.replace('hello bob', 'hello eve'))
    expect(verifyEnvelope(publicKeyPem, tampered, sig)).toBe(false)

    // A different key cannot verify the signature.
    const other = generateInstanceKeyPair()
    expect(verifyEnvelope(other.publicKeyPem, new TextEncoder().encode(raw), sig)).toBe(false)
  })
})
