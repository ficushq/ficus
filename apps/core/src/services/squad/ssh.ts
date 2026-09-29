import { join } from 'path'
import * as fs from 'fs'
import { rm } from 'fs/promises'
import { getHomeDir } from '../../lib/utils/home'

export interface SshKeyInfo {
  name: string
  hasPublicKey: boolean
  createdAt: Date
}

/**
 * Check if an SSH private key is passphrase-protected.
 * Returns true if the key appears to be encrypted.
 */
function isKeyEncrypted(privateKey: string): boolean {
  // OpenSSH format encrypted keys contain "ENCRYPTED" in the header
  if (privateKey.includes('ENCRYPTED')) {
    return true
  }

  // PEM format encrypted keys have Proc-Type and DEK-Info headers
  if (privateKey.includes('Proc-Type:') && privateKey.includes('ENCRYPTED')) {
    return true
  }

  // Newer OpenSSH format: check for bcrypt encryption marker
  // The key contains base64-encoded data, but encrypted keys have specific markers
  if (privateKey.includes('-----BEGIN OPENSSH PRIVATE KEY-----')) {
    // Decode the base64 content to check for encryption
    const lines = privateKey.split('\n').filter((l) => !l.startsWith('-----') && l.trim())
    const base64Content = lines.join('')
    try {
      const decoded = Buffer.from(base64Content, 'base64')
      // OpenSSH format: first bytes are "openssh-key-v1\0"
      // After that comes cipher name - "none" means unencrypted
      const str = decoded.toString('utf-8', 0, 100)
      // If cipher is not "none", it's encrypted (e.g., "aes256-ctr")
      // The format is: AUTH_MAGIC || ciphername || kdfname || ...
      // For unencrypted: ciphername = "none", kdfname = "none"
      if (str.includes('openssh-key-v1')) {
        // Check if cipher is "none" (unencrypted) - appears after the magic
        const afterMagic = decoded.slice(15) // skip "openssh-key-v1\0"
        // Next is a 4-byte length + cipher name
        if (afterMagic.length >= 8) {
          const cipherLen = afterMagic.readUInt32BE(0)
          const cipherName = afterMagic.slice(4, 4 + cipherLen).toString('utf-8')
          return cipherName !== 'none'
        }
      }
    } catch {
      // If we can't parse it, assume it might be encrypted to be safe
      return false // Allow it through, let SSH give the actual error
    }
  }

  return false
}

function isPermissionDeniedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code !== undefined &&
    ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code!)
  )
}

/** A host filesystem problem, not an invalid SSH key or an authorization failure. */
export class SshDirectoryPermissionError extends Error {
  constructor(path: string, cause: Error) {
    const uid = process.geteuid?.() ?? process.getuid?.() ?? 'unknown'
    const gid = process.getegid?.() ?? process.getgid?.() ?? 'unknown'
    super(
      `SSH directory "${path}" requires owner UID ${uid} (GID ${gid}) and permissions 0700. ` +
        `Ask the instance administrator to repair ownership (chown ${uid}:${gid}) and permissions (chmod 700) ` +
        `on this directory and check access to its parent directories, then retry. ${cause.message}`,
      { cause }
    )
    this.name = 'SshDirectoryPermissionError'
  }
}

function ensureSshDirectory(path: string): void {
  try {
    fs.mkdirSync(path, { recursive: true, mode: 0o700 })
    const stat = fs.statSync(path)
    const uid = process.geteuid?.() ?? process.getuid?.()
    // Mode 0700 grants access only to the owner; the directory's group may
    // legitimately differ (e.g. inherited from a setgid parent).
    if (uid !== undefined && stat.uid !== uid) {
      throw new SshDirectoryPermissionError(path, new Error(`Current owner is UID ${stat.uid} (GID ${stat.gid}).`))
    }
    fs.chmodSync(path, 0o700)
    fs.accessSync(path, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK)
  } catch (error) {
    if (isPermissionDeniedError(error)) {
      throw new SshDirectoryPermissionError(path, error as Error)
    }
    throw error
  }
}

/**
 * Get the base path for all squad SSH directories.
 */
export function getSshBasePath(): string {
  const basePath = join(getHomeDir(), 'ssh')
  ensureSshDirectory(basePath)
  return basePath
}

/**
 * Get the SSH directory path for a squad.
 */
export function getSquadSshPath(squadId: string): string {
  return join(getSshBasePath(), squadId)
}

/**
 * Ensure a squad's SSH directory exists with proper permissions. Owned
 * directories are repaired automatically; legacy ownership/access failures
 * require administrator intervention and throw SshDirectoryPermissionError.
 */
export function ensureSquadSshDir(squadId: string): string {
  const sshPath = getSquadSshPath(squadId)
  ensureSshDirectory(sshPath)
  return sshPath
}

/**
 * Prefix reserved for `apps/core/src/services/remote-hosts/materialize.ts`'s
 * `ficus_remote_<hostName>` key files. That module's stale-sweep unlinks ANY
 * file under this prefix that isn't in the squad's current grant set on
 * every materialize call (which runs on every VM box ensure) — so a
 * user-uploaded key sharing this prefix would be silently destroyed on the
 * next materialize. `validateKeyName` rejects new uploads using it; the
 * constant is exported so `materialize.ts` derives its own filenames from
 * the same source instead of duplicating the literal.
 */
export const REMOTE_HOST_KEY_PREFIX = 'ficus_remote_'

/** Every prefix whose files materialize owns. */
export const RESERVED_REMOTE_HOST_KEY_PREFIXES = [REMOTE_HOST_KEY_PREFIX] as const

/** The reserved remote-host key prefix a name starts with, if any. */
function reservedRemoteHostKeyPrefix(name: string): string | undefined {
  return RESERVED_REMOTE_HOST_KEY_PREFIXES.find((prefix) => name.startsWith(prefix))
}

/**
 * Validate key name (alphanumeric with _ or -)
 */
function validateKeyName(keyName: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(keyName)) {
    throw new Error('Key name must be alphanumeric with _ or -')
  }
  // Prevent reserved names
  if (['config', 'known_hosts', 'authorized_keys'].includes(keyName)) {
    throw new Error(`"${keyName}" is a reserved name`)
  }
  // Prevent collision with materialized remote-host key files (see
  // REMOTE_HOST_KEY_PREFIX doc comment).
  const reserved = reservedRemoteHostKeyPrefix(keyName)
  if (reserved) {
    throw new Error(`Key name cannot use the reserved "${reserved}" prefix`)
  }
}

/**
 * Ensure an existing squad private key and its containing directories have
 * permissions accepted by OpenSSH.
 */
export function ensurePrivateSshKeyPermissions(squadId: string, keyName: string): string {
  validateKeyName(keyName)
  const sshPath = ensureSquadSshDir(squadId)
  const privateKeyPath = join(sshPath, keyName)

  if (!fs.existsSync(privateKeyPath)) {
    throw new Error(`SSH private key "${keyName}" does not exist for squad ${squadId}`)
  }

  fs.chmodSync(privateKeyPath, 0o600)
  return privateKeyPath
}

/**
 * Normalize SSH key content for proper formatting.
 * - Removes BOM and other invisible Unicode characters
 * - Converts CRLF to LF (Windows -> Unix line endings)
 * - Strips non-printable characters (keys should be printable ASCII + newlines)
 * - Ensures single trailing newline
 * - Trims leading/trailing whitespace from lines
 * - Fixes malformed PEM boundaries (wrong number of dashes)
 */
function normalizeKey(key: string): string {
  // Build result character by character, keeping only valid chars
  let cleaned = ''
  for (const char of key) {
    const code = char.charCodeAt(0)
    // Keep: printable ASCII (32-126), newline (10), carriage return (13), tab (9)
    if ((code >= 32 && code <= 126) || code === 10 || code === 13 || code === 9) {
      cleaned += char
    }
    // Skip: BOM, zero-width chars, other control chars, non-ASCII
  }

  let normalized = cleaned
    // Normalize line endings: CRLF -> LF
    .replace(/\r\n/g, '\n')
    // Remove any standalone CR
    .replace(/\r/g, '\n')
    // Replace tabs with spaces (shouldn't be in keys, but just in case)
    .replace(/\t/g, ' ')
    // Trim trailing whitespace from each line (but preserve structure)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    // Ensure single trailing newline
    .trim()

  // Fix malformed PEM boundaries - should have exactly 5 dashes on each side
  // Matches BEGIN/END lines with wrong number of dashes and normalizes them
  normalized = normalized.replace(/^-{3,}(BEGIN [A-Z0-9 ]+)-{3,}$/gm, '-----$1-----')
  normalized = normalized.replace(/^-{3,}(END [A-Z0-9 ]+)-{3,}$/gm, '-----$1-----')

  return normalized + '\n'
}

/**
 * Validate SSH private key format.
 * Throws if the key doesn't look like a valid SSH private key.
 */
function validatePrivateKey(key: string): void {
  const trimmed = key.trim()

  // Check for OpenSSH format
  if (trimmed.includes('-----BEGIN OPENSSH PRIVATE KEY-----')) {
    if (!trimmed.includes('-----END OPENSSH PRIVATE KEY-----')) {
      throw new Error('Malformed SSH key: missing or corrupted END boundary')
    }
    return
  }

  // Check for PEM format (RSA, DSA, EC)
  const pemTypes = ['RSA PRIVATE KEY', 'DSA PRIVATE KEY', 'EC PRIVATE KEY', 'PRIVATE KEY']
  for (const type of pemTypes) {
    if (trimmed.includes(`-----BEGIN ${type}-----`)) {
      if (!trimmed.includes(`-----END ${type}-----`)) {
        throw new Error(`Malformed SSH key: missing or corrupted END ${type} boundary`)
      }
      return
    }
  }

  throw new Error(
    'Invalid SSH private key format. ' +
      'Key must be in OpenSSH or PEM format (should start with -----BEGIN ... PRIVATE KEY-----)'
  )
}

/**
 * Add an SSH key to a squad's credential store.
 */
export async function addSshKey(
  squadId: string,
  keyName: string,
  privateKey: string,
  publicKey?: string
): Promise<void> {
  validateKeyName(keyName)

  // Normalize first so validation sees the fixed version
  const normalizedPrivateKey = normalizeKey(privateKey)

  // Validate key format
  validatePrivateKey(normalizedPrivateKey)

  // Check if key is passphrase-protected (won't work in non-interactive sandbox)
  if (isKeyEncrypted(normalizedPrivateKey)) {
    throw new Error(
      'SSH key appears to be passphrase-protected. ' +
        'Sandbox agents cannot use encrypted keys. ' +
        'Please provide an unencrypted key or remove the passphrase with: ' +
        'ssh-keygen -p -f <keyfile>'
    )
  }

  const sshPath = ensureSquadSshDir(squadId)

  // Write private key with strict permissions. writeFileSync's mode does not
  // update permissions for existing files, so chmod after writing too.
  const privateKeyPath = join(sshPath, keyName)
  fs.writeFileSync(privateKeyPath, normalizedPrivateKey, { mode: 0o600 })
  fs.chmodSync(privateKeyPath, 0o600)

  // Write public key if provided
  if (publicKey) {
    const normalizedPublicKey = normalizeKey(publicKey)
    const publicKeyPath = join(sshPath, `${keyName}.pub`)
    fs.writeFileSync(publicKeyPath, normalizedPublicKey, { mode: 0o644 })
  }
}

/**
 * Remove an SSH key from a squad's credential store.
 */
export async function removeSshKey(squadId: string, keyName: string): Promise<void> {
  validateKeyName(keyName)
  const sshPath = getSquadSshPath(squadId)

  const privateKeyPath = join(sshPath, keyName)
  const publicKeyPath = join(sshPath, `${keyName}.pub`)

  if (fs.existsSync(privateKeyPath)) fs.unlinkSync(privateKeyPath)
  if (fs.existsSync(publicKeyPath)) fs.unlinkSync(publicKeyPath)
}

/**
 * List SSH keys for a squad with metadata.
 */
export async function listSshKeys(squadId: string): Promise<SshKeyInfo[]> {
  const sshPath = ensureSquadSshDir(squadId)

  const files = fs.readdirSync(sshPath)
  const keyNames = files.filter(
    (f) =>
      !f.endsWith('.pub') &&
      f !== 'config' &&
      f !== 'known_hosts' &&
      f !== 'authorized_keys' &&
      // Materialized remote-host key files aren't uploaded squad keys — they're
      // managed entirely by remote-hosts/materialize.ts and would otherwise show
      // up as phantom entries a user could try (and fail) to delete via this API.
      !reservedRemoteHostKeyPrefix(f)
  )

  return keyNames.map((name) => {
    const keyPath = join(sshPath, name)
    const stat = fs.statSync(keyPath)
    return {
      name,
      hasPublicKey: fs.existsSync(join(sshPath, `${name}.pub`)),
      createdAt: stat.birthtime,
    }
  })
}

/**
 * Get the public key content for a squad key.
 */
export function getPublicKey(squadId: string, keyName: string): string | null {
  validateKeyName(keyName)
  const publicKeyPath = join(getSquadSshPath(squadId), `${keyName}.pub`)
  if (!fs.existsSync(publicKeyPath)) return null
  return fs.readFileSync(publicKeyPath, 'utf-8')
}

/**
 * Set or update SSH config for a squad.
 *
 * The squad's granted remote hosts (`services/remote-hosts/materialize.ts`)
 * own a managed block in this file, delimited by markers only they may
 * write. User-supplied `config` here can never clobber it and can never
 * forge it: any managed block present in the incoming content is stripped,
 * the user content is written, and the *current* managed block (recomputed
 * live from the DB) is re-appended.
 *
 * `materialize.ts` imports `ensureSquadSshDir` from this module, so a
 * static top-level import of `materialize.ts` here would form a hard cycle.
 * Reached lazily instead — by the time `setSshConfig` is actually called,
 * both modules are already fully loaded.
 */
export async function setSshConfig(squadId: string, config: string): Promise<void> {
  const sshPath = ensureSquadSshDir(squadId)
  const configPath = join(sshPath, 'config')

  const { stripManagedBlock, composeManagedConfig, getManagedBlockForSquad } =
    await import('../remote-hosts/materialize')
  const userContent = stripManagedBlock(config)
  const block = await getManagedBlockForSquad(squadId)

  fs.writeFileSync(configPath, composeManagedConfig(userContent, block), { mode: 0o644 })
}

/**
 * Get SSH config for a squad.
 */
export function getSshConfig(squadId: string): string | null {
  const configPath = join(getSquadSshPath(squadId), 'config')
  if (!fs.existsSync(configPath)) return null
  return fs.readFileSync(configPath, 'utf-8')
}

/**
 * Add a host to known_hosts.
 */
export async function addKnownHost(squadId: string, hostEntry: string): Promise<void> {
  const sshPath = ensureSquadSshDir(squadId)
  const knownHostsPath = join(sshPath, 'known_hosts')

  const existing = fs.existsSync(knownHostsPath) ? fs.readFileSync(knownHostsPath, 'utf-8') : ''

  // Avoid duplicates
  const trimmedEntry = hostEntry.trim()
  if (!existing.includes(trimmedEntry)) {
    const newContent = existing + (existing.endsWith('\n') || existing === '' ? '' : '\n') + trimmedEntry + '\n'
    fs.writeFileSync(knownHostsPath, newContent, { mode: 0o644 })
  }
}

/**
 * Set known_hosts content (full replacement).
 */
export async function setKnownHosts(squadId: string, knownHosts: string): Promise<void> {
  const sshPath = ensureSquadSshDir(squadId)
  const knownHostsPath = join(sshPath, 'known_hosts')
  fs.writeFileSync(knownHostsPath, knownHosts, { mode: 0o644 })
}

/**
 * Get known_hosts content for a squad.
 */
export function getKnownHosts(squadId: string): string | null {
  const knownHostsPath = join(getSquadSshPath(squadId), 'known_hosts')
  if (!fs.existsSync(knownHostsPath)) return null
  return fs.readFileSync(knownHostsPath, 'utf-8')
}

/**
 * Remove a squad's SSH directory entirely.
 */
export async function removeSquadSsh(squadId: string): Promise<void> {
  const sshPath = getSquadSshPath(squadId)
  if (fs.existsSync(sshPath)) {
    await rm(sshPath, { recursive: true, force: true })
  }
}
