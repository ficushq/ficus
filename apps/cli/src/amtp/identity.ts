import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { createPrivateKey, createPublicKey, sign } from 'crypto'
import { expandTilde } from '@ficus/shared/node'

function privateRoot(): string {
  const configured = process.env.FICUS_PRIVATE_DIR
  if (configured) return expandTilde(configured)
  return existsSync('/private') ? '/private' : join(homedir(), '.private')
}

/** Path to this agent's PKCS8 Ed25519 private key (constant per-agent identity, mounted at /private). */
export function identityPemPath(): string {
  const configured = process.env.FICUS_IDENTITY_PEM
  return configured ? expandTilde(configured) : join(privateRoot(), 'identity.pem')
}

/** Path to the small JSON cache holding the registered handle + full amtp:// address. */
export function identityCachePath(): string {
  const configured = process.env.FICUS_IDENTITY_CACHE
  return configured ? expandTilde(configured) : join(privateRoot(), '.tau', 'identity.json')
}

export function readIdentityPrivateKeyPem(): string {
  const path = identityPemPath()
  if (!existsSync(path)) {
    throw new Error(`Federation identity key not found at ${path}. Retry after the sandbox finishes provisioning.`)
  }
  return readFileSync(path, 'utf8')
}

/**
 * Detached Ed25519 signature (base64) over raw bytes. For Ed25519 the algorithm
 * argument MUST be null — byte-for-byte identical to apps/core crypto.ts signEnvelope,
 * so the server verifies it over the same @ficus/shared canonical bytes.
 */
export function signAgentSig(privateKeyPem: string, bytes: Uint8Array): string {
  return sign(null, bytes, createPrivateKey(privateKeyPem)).toString('base64')
}

/** SPKI public PEM derived from the private key — the `agentKey` the server matches against agents.identityPublicKey. */
export function deriveAgentKeyPem(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }) as string
}

export interface CachedIdentity {
  handle: string
  address: string
  identityPublicKey: string
}

export function writeIdentityCache(identity: CachedIdentity): void {
  const path = identityCachePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(identity, null, 2))
}

export function readIdentityCache(): CachedIdentity | null {
  const path = identityCachePath()
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CachedIdentity
  } catch {
    return null
  }
}

export interface MatchingSigningIdentity {
  privateKeyPem: string
  publicKeyPem: string
}

/** Require the delivered Ed25519 private key to match Core's recorded identity. */
export function requireMatchingSigningIdentity(expectedPublicKey: string | null): MatchingSigningIdentity {
  if (!expectedPublicKey) throw new Error('The server has no available federation signing identity.')
  const privateKeyPem = readIdentityPrivateKeyPem()
  let privateKey
  let expected
  try {
    privateKey = createPrivateKey(privateKeyPem)
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519')
  } catch {
    throw new Error(`Federation identity key at ${identityPemPath()} is invalid Ed25519 private key material.`)
  }
  try {
    expected = createPublicKey(expectedPublicKey)
    if (expected.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519')
  } catch {
    throw new Error('The server federation signing identity is invalid.')
  }
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) as string
  const actualDer = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }) as Buffer
  const expectedDer = expected.export({ type: 'spki', format: 'der' }) as Buffer
  if (!actualDer.equals(expectedDer)) {
    throw new Error(
      'Local private key does not match the recorded public identity; automatic rotation is disabled. Contact an operator.'
    )
  }
  return { privateKeyPem, publicKeyPem }
}
