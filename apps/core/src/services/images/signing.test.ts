import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { signImageUrl, verifyImageUrlSignature, __resetSigningKeyForTests } from './signing'

const ID = '05b52d4f-7898-46d7-a9f9-34061ca7a446'

describe('image url signing', () => {
  const origEnc = process.env.FICUS_ENCRYPTION_KEY
  const origPw = process.env.FICUS_PASSWORD

  beforeEach(() => {
    process.env.FICUS_ENCRYPTION_KEY = 'a'.repeat(64)
    delete process.env.FICUS_PASSWORD
    __resetSigningKeyForTests()
  })

  afterEach(() => {
    if (origEnc === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = origEnc
    if (origPw === undefined) delete process.env.FICUS_PASSWORD
    else process.env.FICUS_PASSWORD = origPw
    __resetSigningKeyForTests()
  })

  it('signs and verifies a fresh URL', () => {
    const signed = signImageUrl(ID)
    expect(signed).not.toBeNull()
    expect(verifyImageUrlSignature(ID, String(signed!.exp), signed!.sig)).toBe(true)
  })

  it('rejects expired signature', () => {
    const past = Math.floor(Date.now() / 1000) - 10
    const signed = signImageUrl(ID, { expSeconds: past })
    expect(signed).not.toBeNull()
    expect(verifyImageUrlSignature(ID, String(past), signed!.sig)).toBe(false)
  })

  it('rejects tampered sig', () => {
    const signed = signImageUrl(ID)
    expect(signed).not.toBeNull()
    const flipped = signed!.sig.slice(0, -2) + (signed!.sig.endsWith('A') ? 'B' : 'A')
    expect(verifyImageUrlSignature(ID, String(signed!.exp), flipped)).toBe(false)
  })

  it('rejects sig issued for a different id', () => {
    const signed = signImageUrl(ID)
    expect(signed).not.toBeNull()
    expect(verifyImageUrlSignature('00000000-0000-0000-0000-000000000000', String(signed!.exp), signed!.sig)).toBe(
      false
    )
  })

  it('returns null when no base secret is configured and fails closed on verify', () => {
    delete process.env.FICUS_ENCRYPTION_KEY
    delete process.env.FICUS_PASSWORD
    __resetSigningKeyForTests()
    expect(signImageUrl(ID)).toBeNull()
    // Fail closed: with no signing key we cannot validate a signature, so the
    // unauthenticated signed-image bypass must be denied (was fail-open => true).
    expect(verifyImageUrlSignature(ID, '0', 'x')).toBe(false)
    expect(verifyImageUrlSignature(ID, undefined, undefined)).toBe(false)
  })
})
