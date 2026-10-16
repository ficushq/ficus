import { and, asc, eq, inArray, ne } from 'drizzle-orm'
import { hostKeyFingerprint } from '@ficus/shared/known-hosts'
import { db, remoteHostKeys, remoteHosts } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import type { RemoteHost } from './queries'

/**
 * SSH host keys for remote hosts: fetched without logging in (ssh-keyscan),
 * held as `pending` until a PERSON trusts or rejects them, and pinned once
 * trusted. Only trusted keys reach a squad's known_hosts (see
 * `materialize.ts`), and a remote host is usable by agents only while it has
 * one. Nothing here ever trusts a key on its own: a scan only records what the
 * host presented, and a later scan that sees a different key records it as a
 * pending key-change for a person to decide.
 *
 * Pinned keys are written under a per-host `HostKeyAlias`
 * (`ficus-remote.<name>`), so only Core-managed entries count for a remote
 * host: a key a box learned for the real hostname (for example through the
 * old `accept-new`) never satisfies the strict check.
 */

const log = createLogger('remote-hosts-host-keys')

export const HOST_KEY_ALIAS_PREFIX = 'ficus-remote.'

/** The known_hosts name a remote host's pinned keys are recorded under (its ssh `HostKeyAlias`). */
export function hostKeyAlias(name: string): string {
  return `${HOST_KEY_ALIAS_PREFIX}${name}`
}

export type RemoteHostKey = typeof remoteHostKeys.$inferSelect
export type RemoteHostKeyStatus = 'pending' | 'trusted' | 'rejected' | 'replaced'

/**
 * A remote host's overall host-key state:
 * - `adopting`: registered before keys were pinned; its existing trust is being
 *   adopted (`host-key-adoption.ts`). Connections use strict checking against
 *   keys the box already trusts.
 * - `trusted`: at least one pinned key and no pending key-change.
 * - `changed`: a pinned key exists, but the host presented a different key of
 *   the same type. Connections are refused until a person decides.
 * - `pending`: no pinned key yet; fetched keys await a person.
 * - `unverified`: no pinned and no pending key (the fetch failed or every key
 *   was rejected). The host is unusable until keys are fetched and trusted.
 */
export type HostKeyState = 'adopting' | 'trusted' | 'changed' | 'pending' | 'unverified'

export function trustedHostKeys(keys: RemoteHostKey[]): RemoteHostKey[] {
  return keys.filter((k) => k.status === 'trusted')
}

export function hostKeyState(host: Pick<RemoteHost, 'hostKeyAdoptionPending'>, keys: RemoteHostKey[]): HostKeyState {
  const trusted = trustedHostKeys(keys)
  const pending = keys.filter((k) => k.status === 'pending')
  if (trusted.length) {
    const trustedTypes = new Set(trusted.map((k) => k.keyType))
    return pending.some((k) => trustedTypes.has(k.keyType)) ? 'changed' : 'trusted'
  }
  if (host.hostKeyAdoptionPending) return 'adopting'
  return pending.length ? 'pending' : 'unverified'
}

/** Whether agents may connect: a pinned key exists, or existing trust is still being adopted. */
export function hostKeyUsable(state: HostKeyState): boolean {
  return state === 'trusted' || state === 'changed' || state === 'adopting'
}

/** The host-key view returned over the API. Fingerprints only; never secret material. */
export interface PublicHostKey {
  id: string
  keyType: string
  fingerprint: string
  status: string
  origin: string
  decisionNote: string | null
  decidedByUserId: string | null
  decidedAt: Date | null
  firstSeenAt: Date
  lastSeenAt: Date
  /** For a pending key: fingerprints of the pinned keys of the same type it would replace (a key change). */
  replacesFingerprints: string[]
}

export function toPublicHostKeys(keys: RemoteHostKey[]): PublicHostKey[] {
  const trusted = trustedHostKeys(keys)
  return keys.map((k) => ({
    id: k.id,
    keyType: k.keyType,
    fingerprint: k.fingerprint,
    status: k.status,
    origin: k.origin,
    decisionNote: k.decisionNote,
    decidedByUserId: k.decidedByUserId,
    decidedAt: k.decidedAt,
    firstSeenAt: k.firstSeenAt,
    lastSeenAt: k.lastSeenAt,
    replacesFingerprints:
      k.status === 'pending' ? trusted.filter((t) => t.keyType === k.keyType).map((t) => t.fingerprint) : [],
  }))
}

// ── Fetching ────────────────────────────────────────────────────────────────

export interface ScannedHostKey {
  keyType: string
  publicKey: string
}

const KEY_TYPE = /^(ssh|ecdsa|sk)-[A-Za-z0-9@.-]+$/
const BASE64_KEY = /^[A-Za-z0-9+/]+={0,3}$/

/** The algorithm name embedded at the start of an SSH public key blob, or null if malformed. */
function embeddedKeyType(publicKey: string): string | null {
  const blob = Buffer.from(publicKey, 'base64')
  if (blob.length < 4) return null
  const len = blob.readUInt32BE(0)
  if (len <= 0 || len > 64 || blob.length < 4 + len) return null
  return blob.subarray(4, 4 + len).toString('latin1')
}

/**
 * Parse `ssh-keyscan` output (`<name> <type> <base64>` lines; `#` comments).
 * Keys whose blob does not carry the declared type are dropped, and
 * duplicates are collapsed.
 */
export function parseKeyscanOutput(stdout: string): ScannedHostKey[] {
  const keys: ScannedHostKey[] = []
  const seen = new Set<string>()
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [, keyType, publicKey] = trimmed.split(/\s+/)
    if (!keyType || !publicKey || !KEY_TYPE.test(keyType) || !BASE64_KEY.test(publicKey)) continue
    if (embeddedKeyType(publicKey) !== keyType) continue
    const id = `${keyType} ${publicKey}`
    if (seen.has(id)) continue
    seen.add(id)
    keys.push({ keyType, publicKey })
  }
  return keys
}

/** Fetch a host's public host keys without authenticating. Throws with a readable message on failure. */
export type HostKeyScanner = (target: { sshHost: string; sshPort: number }) => Promise<ScannedHostKey[]>

const KEYSCAN_CONNECT_TIMEOUT_SECONDS = 5
const KEYSCAN_WALL_TIMEOUT_MS = 15_000

export function createHostKeyScanner(deps: { spawn?: typeof Bun.spawn; timeoutMs?: number } = {}): HostKeyScanner {
  const spawn = deps.spawn ?? Bun.spawn
  const timeoutMs = deps.timeoutMs ?? KEYSCAN_WALL_TIMEOUT_MS
  return async ({ sshHost, sshPort }) => {
    // Argument array (no shell). A leading '-' would be read as an option.
    if (!sshHost || sshHost.startsWith('-') || /\s/.test(sshHost)) throw new Error('invalid host name')
    const proc = spawn(
      [
        'ssh-keyscan',
        '-T',
        String(KEYSCAN_CONNECT_TIMEOUT_SECONDS),
        '-p',
        String(sshPort),
        '-t',
        'ed25519,ecdsa,rsa',
        sshHost,
      ],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          // best-effort
        }
        reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s fetching the host key`))
      }, timeoutMs)
    })
    try {
      const [stdout, stderr] = await Promise.race([
        Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
        timeout,
      ])
      const keys = parseKeyscanOutput(stdout)
      if (!keys.length) {
        const reason = stderr
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'))
          .at(-1)
        throw new Error(reason ? `no host key received: ${reason}` : 'no host key received (host unreachable?)')
      }
      return keys
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

export const defaultHostKeyScanner: HostKeyScanner = createHostKeyScanner()

// ── Persistence ─────────────────────────────────────────────────────────────

export async function listHostKeys(hostId: string): Promise<RemoteHostKey[]> {
  return db
    .select()
    .from(remoteHostKeys)
    .where(eq(remoteHostKeys.hostId, hostId))
    .orderBy(asc(remoteHostKeys.firstSeenAt), asc(remoteHostKeys.keyType))
}

export async function listHostKeysForHosts(hostIds: string[]): Promise<Map<string, RemoteHostKey[]>> {
  const byHost = new Map<string, RemoteHostKey[]>(hostIds.map((id) => [id, []]))
  if (!hostIds.length) return byHost
  const rows = await db
    .select()
    .from(remoteHostKeys)
    .where(inArray(remoteHostKeys.hostId, hostIds))
    .orderBy(asc(remoteHostKeys.firstSeenAt), asc(remoteHostKeys.keyType))
  for (const row of rows) byHost.get(row.hostId)?.push(row)
  return byHost
}

/**
 * Record keys a host presented. A key already on record (any status) only has
 * `lastSeenAt` bumped — a rejected key stays rejected, a trusted key stays
 * trusted. A new key is stored as `pending`: never trusted here.
 */
export async function recordPresentedKeys(
  hostId: string,
  keys: ScannedHostKey[],
  origin: 'scan' | 'adoption-conflict' = 'scan',
  decisionNote: string | null = null
): Promise<void> {
  const now = new Date()
  for (const key of keys) {
    await db
      .insert(remoteHostKeys)
      .values({
        hostId,
        keyType: key.keyType,
        publicKey: key.publicKey,
        fingerprint: hostKeyFingerprint(key.publicKey),
        status: 'pending',
        origin,
        decisionNote,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [remoteHostKeys.hostId, remoteHostKeys.keyType, remoteHostKeys.publicKey],
        set: { lastSeenAt: now },
      })
  }
}

/**
 * Fetch a host's keys and record them (see {@link recordPresentedKeys}). A
 * failed fetch is recorded on the host (`hostKeyCheckError`) and returned,
 * never thrown: an unreachable host is a normal state to show a person.
 */
export async function refreshHostKeys(
  host: RemoteHost,
  scanner: HostKeyScanner = defaultHostKeyScanner
): Promise<{ ok: boolean; error?: string }> {
  try {
    const keys = await scanner({ sshHost: host.sshHost, sshPort: host.sshPort })
    await recordPresentedKeys(host.id, keys)
    await db
      .update(remoteHosts)
      .set({ hostKeyCheckedAt: new Date(), hostKeyCheckError: null })
      .where(eq(remoteHosts.id, host.id))
    return { ok: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.warn(`host key fetch failed for remote host ${host.id} (${host.name}): ${error}`)
    await db
      .update(remoteHosts)
      .set({ hostKeyCheckedAt: new Date(), hostKeyCheckError: error })
      .where(eq(remoteHosts.id, host.id))
    return { ok: false, error }
  }
}

// ── Human decisions ─────────────────────────────────────────────────────────

export class HostKeyDecisionError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409
  ) {
    super(message)
  }
}

/**
 * A person trusts a key. The key becomes pinned; any other pinned key of the
 * same type is marked `replaced`, and any other pending key of that type (a
 * conflicting candidate) is rejected — all recorded against the same person.
 * A trusted key ends adoption for the host. Callers MUST have established that
 * `userId` is a signed-in person (never an agent or token).
 */
export async function trustHostKey(hostId: string, keyId: string, userId: string): Promise<RemoteHostKey> {
  return db.transaction(async (tx) => {
    const [key] = await tx
      .select()
      .from(remoteHostKeys)
      .where(and(eq(remoteHostKeys.id, keyId), eq(remoteHostKeys.hostId, hostId)))
      .for('update')
    if (!key) throw new HostKeyDecisionError('Host key not found', 404)
    if (key.status !== 'pending' && key.status !== 'rejected') {
      throw new HostKeyDecisionError(`Host key is already ${key.status}`, 409)
    }
    const now = new Date()
    const sameTypeOthers = and(
      eq(remoteHostKeys.hostId, hostId),
      eq(remoteHostKeys.keyType, key.keyType),
      ne(remoteHostKeys.id, key.id)
    )
    await tx
      .update(remoteHostKeys)
      .set({
        status: 'replaced',
        decidedByUserId: userId,
        decidedAt: now,
        decisionNote: `replaced by ${key.fingerprint}`,
      })
      .where(and(sameTypeOthers, eq(remoteHostKeys.status, 'trusted')))
    await tx
      .update(remoteHostKeys)
      .set({
        status: 'rejected',
        decidedByUserId: userId,
        decidedAt: now,
        decisionNote: `not chosen: ${key.fingerprint} was trusted`,
      })
      .where(and(sameTypeOthers, eq(remoteHostKeys.status, 'pending')))
    const [updated] = await tx
      .update(remoteHostKeys)
      .set({ status: 'trusted', decidedByUserId: userId, decidedAt: now, decisionNote: 'trusted by a person' })
      .where(eq(remoteHostKeys.id, key.id))
      .returning()
    await tx
      .update(remoteHosts)
      .set({ hostKeyAdoptionPending: false, updatedAt: now })
      .where(eq(remoteHosts.id, hostId))
    return updated
  })
}

/** A person rejects a pending key. The key is never pinned (a pinned key of the same type stays pinned). */
export async function rejectHostKey(hostId: string, keyId: string, userId: string): Promise<RemoteHostKey> {
  return db.transaction(async (tx) => {
    const [key] = await tx
      .select()
      .from(remoteHostKeys)
      .where(and(eq(remoteHostKeys.id, keyId), eq(remoteHostKeys.hostId, hostId)))
      .for('update')
    if (!key) throw new HostKeyDecisionError('Host key not found', 404)
    if (key.status !== 'pending') throw new HostKeyDecisionError(`Host key is already ${key.status}`, 409)
    const [updated] = await tx
      .update(remoteHostKeys)
      .set({ status: 'rejected', decidedByUserId: userId, decidedAt: new Date(), decisionNote: 'rejected by a person' })
      .where(eq(remoteHostKeys.id, key.id))
      .returning()
    return updated
  })
}
