import { createHmac, timingSafeEqual } from 'crypto'

const DEFAULT_TTL_SECONDS = 24 * 60 * 60
const DOMAIN = 'image-url-v1'

let cachedKey: Buffer | null | undefined

function baseSecret(): string | null {
  return process.env.FICUS_ENCRYPTION_KEY || process.env.FICUS_PASSWORD || null
}

function getKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey

  const base = baseSecret()
  cachedKey = base ? createHmac('sha256', base).update(DOMAIN).digest() : null
  return cachedKey
}

export function __resetSigningKeyForTests(): void {
  cachedKey = undefined
}

function computeSig(key: Buffer, id: string, exp: number): string {
  return createHmac('sha256', key).update(`${DOMAIN}\n${id}\n${exp}`).digest('base64url')
}

export interface SignedUrlParts {
  exp: number
  sig: string
}

export function signImageUrl(id: string, opts?: { ttlSeconds?: number; expSeconds?: number }): SignedUrlParts | null {
  const key = getKey()
  if (!key) return null

  const now = Math.floor(Date.now() / 1000)
  const exp = opts?.expSeconds ?? now + (opts?.ttlSeconds ?? DEFAULT_TTL_SECONDS)
  return { exp, sig: computeSig(key, id, exp) }
}

export function buildSignedImageUrlPath(id: string): string {
  const signed = signImageUrl(id)
  if (!signed) return `/api/images/${id}`
  return `/api/images/${id}?exp=${signed.exp}&sig=${signed.sig}`
}

export function verifyImageUrlSignature(
  id: string,
  expStr: string | null | undefined,
  sig: string | null | undefined
): boolean {
  const key = getKey()
  // Fail closed: with no signing key configured we cannot validate any
  // signature, so the unauthenticated signed-image bypass must NOT grant access
  // (previously returned true — fail-open, exposing any image id to anyone).
  if (!key) return false
  if (!expStr || !sig) return false

  const exp = Number(expStr)
  if (!Number.isFinite(exp)) return false
  if (exp < Math.floor(Date.now() / 1000)) return false

  const expected = Buffer.from(computeSig(key, id, exp))
  const received = Buffer.from(sig)
  if (expected.length !== received.length) return false
  return timingSafeEqual(expected, received)
}
