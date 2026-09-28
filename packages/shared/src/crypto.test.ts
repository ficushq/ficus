import { describe, test, expect } from 'bun:test'
import { randomBytes } from 'crypto'
import { encrypt, decrypt } from './crypto'

describe('crypto', () => {
  const testKey = randomBytes(32)

  test('encrypt and decrypt round-trips', () => {
    const plaintext = 'sk-abc123-my-secret-key'
    const { encrypted, iv } = encrypt(plaintext, testKey)
    const decrypted = decrypt(encrypted, iv, testKey)
    expect(decrypted).toBe(plaintext)
  })

  test('encrypt produces different output each time (unique IV)', () => {
    const plaintext = 'same-input'
    const a = encrypt(plaintext, testKey)
    const b = encrypt(plaintext, testKey)
    expect(a.encrypted).not.toBe(b.encrypted)
    expect(a.iv).not.toBe(b.iv)
    // Both decrypt to the same value
    expect(decrypt(a.encrypted, a.iv, testKey)).toBe(plaintext)
    expect(decrypt(b.encrypted, b.iv, testKey)).toBe(plaintext)
  })

  test('decrypt with wrong key throws', () => {
    const plaintext = 'secret'
    const { encrypted, iv } = encrypt(plaintext, testKey)
    const wrongKey = randomBytes(32)
    expect(() => decrypt(encrypted, iv, wrongKey)).toThrow()
  })

  test('decrypt with tampered data throws', () => {
    const plaintext = 'secret'
    const { encrypted, iv } = encrypt(plaintext, testKey)
    const firstByte = encrypted.slice(0, 2)
    const tamperedFirstByte = firstByte === 'ff' ? '00' : 'ff'
    const tampered = tamperedFirstByte + encrypted.slice(2)
    expect(tampered).not.toBe(encrypted)
    expect(() => decrypt(tampered, iv, testKey)).toThrow()
  })

  test('handles empty string', () => {
    const { encrypted, iv } = encrypt('', testKey)
    expect(decrypt(encrypted, iv, testKey)).toBe('')
  })

  test('handles unicode', () => {
    const plaintext = '🔑 sécret kéy 日本語'
    const { encrypted, iv } = encrypt(plaintext, testKey)
    expect(decrypt(encrypted, iv, testKey)).toBe(plaintext)
  })

  describe('byte-compat with the pre-lift core implementation', () => {
    // Fixture captured from apps/core/src/services/secrets/crypto.ts BEFORE
    // it was rewritten to re-export from @ficus/shared (see task-5 report for
    // the generating script). Verifies the lifted implementation produces
    // ciphertexts that decrypt identically to what core already has at rest.
    const fixtureKey = Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex')
    const fixturePlaintext = 'fixture-plaintext-for-byte-compat-check 🔑'
    const fixtureEncrypted =
      '57ced8c03f5ea2e65e19b2475c7e1a0b7dad62e520b5a7a0a93aa1b0441c51425ddbb610f8750449a90be4c79b7026cc9b3cab738a7cf6d3d791cb3d'
    const fixtureIv = '26ee0417d473d1ca41ec716a5ce957d1'

    test('lifted decrypt() round-trips a ciphertext produced by the old core implementation', () => {
      expect(decrypt(fixtureEncrypted, fixtureIv, fixtureKey)).toBe(fixturePlaintext)
    })
  })
})
