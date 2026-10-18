/**
 * Webhook token generation and hashing utilities.
 *
 * Token format: whsec_<64-hex-chars> (32 bytes = 64 hex chars)
 * Storage: SHA-256 hash of the full token (including prefix)
 */

import { createHash, randomBytes } from 'crypto'
import { bytesToHex } from './hex'

export const WEBHOOK_TOKEN_PREFIX = 'whsec_'
const TOKEN_BYTES = 32 // 256 bits of entropy

/**
 * Generate a new webhook token.
 * Returns the plain token (only shown once to user).
 */
export function generateWebhookToken(): string {
  const bytes = randomBytes(TOKEN_BYTES)
  return WEBHOOK_TOKEN_PREFIX + bytesToHex(bytes)
}

/**
 * Hash a webhook token for storage.
 * Uses SHA-256 for fast comparison (tokens have high entropy, no need for bcrypt).
 */
export function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Verify a webhook token against its stored hash.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function verifyWebhookToken(token: string, storedHash: string): boolean {
  const tokenHash = hashWebhookToken(token)
  // Constant-time comparison
  if (tokenHash.length !== storedHash.length) return false
  let result = 0
  for (let i = 0; i < tokenHash.length; i++) {
    result |= tokenHash.charCodeAt(i) ^ storedHash.charCodeAt(i)
  }
  return result === 0
}
