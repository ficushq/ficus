import { consultantSandboxSquadId } from '../sandbox/consultant-sandbox'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { createPrivateKey, createPublicKey, type KeyObject } from 'crypto'
import { getHomeDir } from '../../lib/utils/home'
import type { Agent } from '../../entities/Agent'
import { generateInstanceKeyPair } from './crypto'
import { prepareWorkspaceDotDir, workspaceDotPath } from '../workspace/dot-dir'

/** Canonical host-side path for an agent's AMTP private identity. A pure path; it touches no filesystem. */
export function agentIdentityHostPath(sandboxId: string): string {
  return workspaceDotPath(join(getHomeDir(), 'private', sandboxId), 'identity.pem')
}

/**
 * {@link agentIdentityHostPath} for a caller about to read or write the key: a private dir still under
 * the legacy dot dir is moved to `.ficus` first, so the key is found rather than read as missing.
 */
export function preparedAgentIdentityHostPath(sandboxId: string): string {
  prepareWorkspaceDotDir(join(getHomeDir(), 'private', sandboxId))
  return agentIdentityHostPath(sandboxId)
}

function requireEd25519Private(privateKeyPem: string): KeyObject {
  const key = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Identity private key is not Ed25519')
  return key
}

/** Derive the SPKI public PEM from a PKCS8 Ed25519 private PEM. */
export function publicPemFromPrivate(privateKeyPem: string): string {
  return createPublicKey(requireEd25519Private(privateKeyPem)).export({ type: 'spki', format: 'pem' }) as string
}

/** Compare public keys by parsed SPKI material rather than PEM formatting. */
export function samePublicKey(left: string, right: string): boolean {
  const parse = (pem: string) => {
    const key = createPublicKey(pem)
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Identity public key is not Ed25519')
    return key.export({ type: 'spki', format: 'der' }) as Buffer
  }
  return parse(left).equals(parse(right))
}

/**
 * Provision a new identity or backfill its public key without ever rotating an
 * already-recorded identity. Loss, corruption, and mismatch require explicit
 * operator-coordinated recovery.
 */
export async function ensureAgentIdentity(agent: Agent, sandboxId: string): Promise<string> {
  if (consultantSandboxSquadId(sandboxId))
    throw new Error('Shared consultant sandboxes have no per-agent signing identity')
  const path = preparedAgentIdentityHostPath(sandboxId)
  let privateKeyPem: string | undefined

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8')
      publicPemFromPrivate(raw)
      privateKeyPem = raw
    } catch {
      if (agent.identityPublicKey) {
        throw new Error('Recorded federation identity has no usable private key; refusing automatic rotation')
      }
    }
  } else if (agent.identityPublicKey) {
    throw new Error('Recorded federation identity has no usable private key; refusing automatic rotation')
  }

  if (!privateKeyPem) {
    privateKeyPem = generateInstanceKeyPair().privateKeyPem
    mkdirSync(dirname(path), { recursive: true })
    const tmpPath = `${path}.tmp`
    writeFileSync(tmpPath, privateKeyPem, { mode: 0o600 })
    renameSync(tmpPath, path)
  }

  const publicKeyPem = publicPemFromPrivate(privateKeyPem)
  if (!agent.identityPublicKey) {
    await agent.update({ identityPublicKey: publicKeyPem })
  } else if (!samePublicKey(agent.identityPublicKey, publicKeyPem)) {
    throw new Error('Recorded federation identity does not match the private key; refusing automatic rotation')
  }
  return publicKeyPem
}
