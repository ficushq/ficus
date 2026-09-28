import { createHash } from 'crypto'

export { encrypt, decrypt } from '@ficus/shared/crypto'

/**
 * Get the encryption key from environment.
 * Must be a 64-char hex string (32 bytes).
 * Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
export function getEncryptionKey(): Buffer {
  const key = process.env.FICUS_ENCRYPTION_KEY
  if (!key) {
    throw new Error('FICUS_ENCRYPTION_KEY environment variable is required for secret management')
  }
  // If it's a 64-char hex string, use it directly as 32 bytes
  if (key.length === 64 && /^[0-9a-f]+$/i.test(key)) {
    return Buffer.from(key, 'hex')
  }
  // Otherwise, derive a 32-byte key via SHA-256 hash
  return createHash('sha256').update(key).digest()
}
