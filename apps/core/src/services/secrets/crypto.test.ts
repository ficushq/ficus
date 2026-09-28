import { describe, test, expect, afterAll } from 'bun:test'
import { encrypt, decrypt, getEncryptionKey } from './crypto'
import { randomBytes } from 'crypto'

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

  describe('getEncryptionKey', () => {
    const originalKey = process.env.FICUS_ENCRYPTION_KEY

    afterAll(() => {
      if (originalKey) {
        process.env.FICUS_ENCRYPTION_KEY = originalKey
      } else {
        delete process.env.FICUS_ENCRYPTION_KEY
      }
    })

    test('reads hex key from env', () => {
      const hex = randomBytes(32).toString('hex')
      process.env.FICUS_ENCRYPTION_KEY = hex
      const key = getEncryptionKey()
      expect(key.length).toBe(32)
      expect(key.toString('hex')).toBe(hex)
    })

    test('throws if not set', () => {
      delete process.env.FICUS_ENCRYPTION_KEY
      expect(() => getEncryptionKey()).toThrow('FICUS_ENCRYPTION_KEY environment variable is required')
    })

    test('derives key via SHA-256 for non-hex strings', () => {
      process.env.FICUS_ENCRYPTION_KEY = 'abcd'
      const key = getEncryptionKey()
      expect(key).toBeInstanceOf(Buffer)
      expect(key.length).toBe(32)
    })
  })
})
