import { createHash, randomUUID } from 'crypto'
import * as fs from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { and, asc, eq, inArray, ne } from 'drizzle-orm'
import { findKnownHostKeys, hostKeyFingerprint, knownHostsName } from '@ficus/shared/known-hosts'
import { db, sshTrustKeys, sshTrustTargets } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import { getHomeDir } from '../../lib/utils/home'
import { getSquadSshPath } from '../squad/ssh'
import type { HostKeyPin } from './args'
import {
  defaultHostKeyScanner,
  hostKeyState,
  toPublicHostKeys,
  trustedHostKeys,
  type HostKeyScanner,
  type HostKeyState,
  type PublicHostKey,
  type ScannedHostKey,
} from '../remote-hosts/host-keys'

/**
 * Host-key pinning for the SSH connections Core makes itself: machines (BYO
 * and exe.dev VMs), the exe.dev API endpoint, and squad memory git remotes.
 * Same model as remote hosts (`remote-hosts/host-keys.ts`): keys are fetched
 * without logging in, held `pending` until a PERSON trusts or rejects them, and
 * only trusted keys are ever pinned. Every connection checks strictly
 * (`StrictHostKeyChecking=yes`, nothing learned or updated) against a
 * Core-written known_hosts file holding exactly the endpoint's trusted keys
 * under a per-endpoint `HostKeyAlias`, so no other known_hosts entry (the
 * operator's, an old trust-on-first-use file) can satisfy the check. There is
 * no fallback: an endpoint without a trusted key is refused
 * ({@link HostKeyNotTrustedError}).
 *
 * Rollout: endpoints Core already connected to while ssh used `accept-new` are
 * created by the migration with `adoption_pending`. Their first use adopts the
 * keys Core already trusts for them (the old known_hosts files listed in
 * {@link adoptionSources}) without a prompt; conflicting or missing evidence
 * leaves the endpoint waiting for a person, like a new one.
 *
 * exe.dev: every VM is reached through exe.dev's SSH proxy. A newly
 * provisioned VM whose fetched key is byte-identical to a key already trusted
 * for another exe.dev endpoint is trusted as that same key (`provider-key`);
 * any other key waits for a person.
 */

export { strictHostKeyArgs, type HostKeyPin } from './args'

const log = createLogger('ssh-trust')

export type TrustTargetKind = 'machine' | 'exe-machine' | 'exe-api' | 'memory-git'
export type TrustTarget = typeof sshTrustTargets.$inferSelect
export type TrustKey = typeof sshTrustKeys.$inferSelect

/** What identifies an SSH endpoint Core connects to. */
export interface TrustTargetSpec {
  scope: string
  kind: TrustTargetKind
  label: string
  sshHost: string
  sshPort: number
  squadId?: string | null
}

const EXE_KINDS: TrustTargetKind[] = ['exe-machine', 'exe-api']

export function machineTrustSpec(machine: {
  id: string
  name: string
  provider: string
  sshHost: string
  sshPort: number
}): TrustTargetSpec {
  return {
    scope: `machine:${machine.id}`,
    kind: machine.provider === 'exe' ? 'exe-machine' : 'machine',
    label: `Machine ${machine.name}`,
    sshHost: machine.sshHost,
    sshPort: machine.sshPort,
  }
}

export const EXE_API_TRUST_SPEC: TrustTargetSpec = {
  scope: 'exe-api',
  kind: 'exe-api',
  label: 'exe.dev API',
  sshHost: 'exe.dev',
  sshPort: 22,
}

/** The SSH host of a memory git remote (`git@host:...` or `ssh://host/...`), or null for HTTPS. */
export function memoryGitSshHost(repoUrl: string): string | null {
  const match = repoUrl.match(/^git@([A-Za-z0-9_.-]+):/) ?? repoUrl.match(/^ssh:\/\/([A-Za-z0-9_.-]+)\//)
  return match ? match[1].toLowerCase() : null
}

export function memoryGitTrustSpec(squadId: string, repoUrl: string): TrustTargetSpec | null {
  const host = memoryGitSshHost(repoUrl)
  if (!host) return null
  return {
    scope: `memory-git:${squadId}:${host}`,
    kind: 'memory-git',
    label: `Memory sync (${host})`,
    sshHost: host,
    sshPort: 22,
    squadId,
  }
}

function scopeHash(scope: string): string {
  return createHash('sha256').update(scope).digest('hex').slice(0, 24)
}

/** The known_hosts name an endpoint's pinned keys are written under (its ssh `HostKeyAlias`). Shell-safe. */
export function trustAlias(scope: string): string {
  return `ficus-trust.${scopeHash(scope)}`
}

function pinDir(): string {
  return join(getHomeDir(), 'ssh-trust')
}

export function pinFilePath(scope: string): string {
  return join(pinDir(), `${scopeHash(scope)}.known_hosts`)
}

type RefusedTarget = Pick<TrustTarget, 'id' | 'label' | 'sshHost' | 'sshPort' | 'kind'>

function refusalMessage(target: RefusedTarget, state: HostKeyState): string {
  const where = target.kind === 'memory-git' ? 'Memory settings' : 'Settings > Machines'
  const why =
    state === 'pending'
      ? 'its fetched host key is waiting for a person to confirm it'
      : 'no host key has been confirmed for it'
  return (
    `ficus: SSH to ${target.label} (${target.sshHost}:${target.sshPort}) refused: ${why}. ` +
    `A signed-in person must trust the host key in ${where}.`
  )
}

/** Refusal for an endpoint without a trusted host key. Never carries key material. */
export class HostKeyNotTrustedError extends Error {
  constructor(
    readonly target: RefusedTarget,
    readonly state: HostKeyState
  ) {
    super(refusalMessage(target, state))
    this.name = 'HostKeyNotTrustedError'
  }
}

// ── Persistence ─────────────────────────────────────────────────────────────

/** The endpoint for `spec`, created (not adopting) if it does not exist yet. Never changes an existing row. */
export async function ensureTrustTarget(spec: TrustTargetSpec): Promise<TrustTarget> {
  await db
    .insert(sshTrustTargets)
    .values({
      scope: spec.scope,
      kind: spec.kind,
      label: spec.label,
      sshHost: spec.sshHost,
      sshPort: spec.sshPort,
      squadId: spec.squadId ?? null,
    })
    .onConflictDoNothing({ target: sshTrustTargets.scope })
  const [row] = await db.select().from(sshTrustTargets).where(eq(sshTrustTargets.scope, spec.scope))
  return row
}

export async function getTrustTarget(id: string): Promise<TrustTarget | null> {
  const [row] = await db.select().from(sshTrustTargets).where(eq(sshTrustTargets.id, id))
  return row ?? null
}

export async function deleteTrustTarget(scope: string): Promise<void> {
  await db.delete(sshTrustTargets).where(eq(sshTrustTargets.scope, scope))
  fs.rmSync(pinFilePath(scope), { force: true })
}

export async function listTrustKeys(targetId: string): Promise<TrustKey[]> {
  return db
    .select()
    .from(sshTrustKeys)
    .where(eq(sshTrustKeys.targetId, targetId))
    .orderBy(asc(sshTrustKeys.firstSeenAt), asc(sshTrustKeys.keyType))
}

export function trustTargetState(target: Pick<TrustTarget, 'adoptionPending'>, keys: TrustKey[]): HostKeyState {
  return hostKeyState({ hostKeyAdoptionPending: target.adoptionPending }, keys)
}

/** The API view of an endpoint: its state and key fingerprints, never key material. */
export interface PublicTrustTarget {
  id: string
  scope: string
  kind: string
  squadId: string | null
  label: string
  sshHost: string
  sshPort: number
  hostKeyState: HostKeyState
  hostKeys: PublicHostKey[]
  hostKeyCheckedAt: Date | null
  hostKeyCheckError: string | null
}

export async function toPublicTrustTargets(targets: TrustTarget[]): Promise<PublicTrustTarget[]> {
  const ids = targets.map((t) => t.id)
  const byTarget = new Map<string, TrustKey[]>(ids.map((id) => [id, []]))
  if (ids.length) {
    const rows = await db
      .select()
      .from(sshTrustKeys)
      .where(inArray(sshTrustKeys.targetId, ids))
      .orderBy(asc(sshTrustKeys.firstSeenAt), asc(sshTrustKeys.keyType))
    for (const row of rows) byTarget.get(row.targetId)?.push(row)
  }
  return targets.map((t) => {
    const keys = byTarget.get(t.id) ?? []
    return {
      id: t.id,
      scope: t.scope,
      kind: t.kind,
      squadId: t.squadId,
      label: t.label,
      sshHost: t.sshHost,
      sshPort: t.sshPort,
      hostKeyState: trustTargetState(t, keys),
      hostKeys: toPublicHostKeys(keys.map(({ targetId: _targetId, ...k }) => k)),
      hostKeyCheckedAt: t.checkedAt,
      hostKeyCheckError: t.checkError,
    }
  })
}

/**
 * Record keys an endpoint presented. A key already on record only has
 * `lastSeenAt` bumped (a rejected key stays rejected); a new key is `pending`.
 * For exe.dev endpoints, a new key identical to one already trusted for
 * another exe.dev endpoint is trusted as that key (see module doc).
 */
async function recordPresentedKeys(
  target: TrustTarget,
  keys: ScannedHostKey[],
  origin: 'scan' | 'adoption-conflict' = 'scan',
  decisionNote: string | null = null
): Promise<void> {
  const now = new Date()
  const peerKeys = EXE_KINDS.includes(target.kind as TrustTargetKind) ? await trustedExePeerKeys(target.id) : new Map()
  for (const key of keys) {
    const peer = origin === 'scan' ? peerKeys.get(`${key.keyType} ${key.publicKey}`) : undefined
    await db
      .insert(sshTrustKeys)
      .values({
        targetId: target.id,
        keyType: key.keyType,
        publicKey: key.publicKey,
        fingerprint: hostKeyFingerprint(key.publicKey),
        firstSeenAt: now,
        lastSeenAt: now,
        ...(peer
          ? {
              status: 'trusted',
              origin: 'provider-key',
              decisionNote: `same exe.dev key as trusted ${peer}`,
              decidedAt: now,
            }
          : { status: 'pending', origin, decisionNote }),
      })
      .onConflictDoUpdate({
        target: [sshTrustKeys.targetId, sshTrustKeys.keyType, sshTrustKeys.publicKey],
        set: { lastSeenAt: now },
      })
  }
}

/** `"<type> <key>"` → label of the exe.dev endpoint that trusts it, excluding `targetId`. */
async function trustedExePeerKeys(targetId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ keyType: sshTrustKeys.keyType, publicKey: sshTrustKeys.publicKey, label: sshTrustTargets.label })
    .from(sshTrustKeys)
    .innerJoin(sshTrustTargets, eq(sshTrustKeys.targetId, sshTrustTargets.id))
    .where(
      and(
        inArray(sshTrustTargets.kind, EXE_KINDS),
        ne(sshTrustTargets.id, targetId),
        eq(sshTrustKeys.status, 'trusted')
      )
    )
  return new Map(rows.map((r) => [`${r.keyType} ${r.publicKey}`, r.label]))
}

/**
 * Fetch an endpoint's keys and record them. A failed fetch is recorded on the
 * endpoint and returned, never thrown.
 */
export async function refreshTrustTarget(
  target: TrustTarget,
  scanner: HostKeyScanner = defaultHostKeyScanner
): Promise<{ ok: boolean; error?: string }> {
  try {
    const keys = await scanner({ sshHost: target.sshHost, sshPort: target.sshPort })
    await recordPresentedKeys(target, keys)
    await db
      .update(sshTrustTargets)
      .set({ checkedAt: new Date(), checkError: null })
      .where(eq(sshTrustTargets.id, target.id))
    return { ok: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.warn(`host key fetch failed for ${target.scope}: ${error}`)
    await db
      .update(sshTrustTargets)
      .set({ checkedAt: new Date(), checkError: error })
      .where(eq(sshTrustTargets.id, target.id))
    return { ok: false, error }
  }
}

// ── Rollout adoption ────────────────────────────────────────────────────────

/** A file an existing trusted key may be recorded in. `read` returns null when it could not be read. */
export interface AdoptionSource {
  label: string
  read: () => string | null
}

function localFile(label: string, path: string): AdoptionSource {
  return {
    label,
    read: () => {
      try {
        return fs.readFileSync(path, 'utf-8')
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT' ? '' : null
      }
    },
  }
}

/**
 * Where each kind of endpoint recorded keys while ssh used `accept-new`:
 * machines in Core's machines known_hosts, the exe.dev API in the Core user's
 * own known_hosts (that ssh call named no file), memory git in the squad's
 * Core ssh dir known_hosts.
 */
export function adoptionSources(target: Pick<TrustTarget, 'kind' | 'squadId'>): AdoptionSource[] {
  const machinesKnownHosts = localFile('Core machine connections', join(getHomeDir(), 'machines', 'known_hosts'))
  switch (target.kind) {
    case 'machine':
    case 'exe-machine':
      return [machinesKnownHosts]
    case 'exe-api':
      return [
        localFile('Core user known_hosts', join(homedir(), '.ssh', 'known_hosts')),
        localFile('Core user known_hosts2', join(homedir(), '.ssh', 'known_hosts2')),
      ]
    case 'memory-git': {
      if (!target.squadId) return []
      return [localFile('squad ssh directory', join(getSquadSshPath(target.squadId), 'known_hosts'))]
    }
    default:
      return []
  }
}

export type AdoptionOutcome = 'adopted' | 'conflict' | 'needs-confirmation' | 'unreadable'

/**
 * Adopt an endpoint's existing trust: one key per type found → trusted
 * (`adopted`, no person); two keys of one type → every candidate pending
 * (`adoption-conflict`); nothing found → fetched and pending like a new
 * endpoint. An unreadable source leaves the endpoint adopting (and refused).
 */
export async function adoptTrustTarget(
  target: TrustTarget,
  deps: { sources?: AdoptionSource[]; scanner?: HostKeyScanner } = {}
): Promise<AdoptionOutcome> {
  const name = knownHostsName(target.sshHost, target.sshPort)
  const found = new Map<string, { keyType: string; publicKey: string; sources: Set<string> }>()
  let unreadable = 0
  for (const source of deps.sources ?? adoptionSources(target)) {
    const content = source.read()
    if (content === null) {
      unreadable++
      continue
    }
    for (const k of findKnownHostKeys(content, name)) {
      const id = `${k.keyType} ${k.key}`
      const entry = found.get(id) ?? { keyType: k.keyType, publicKey: k.key, sources: new Set<string>() }
      entry.sources.add(source.label)
      found.set(id, entry)
    }
  }
  const candidates = [...found.values()]
  const note = (c: (typeof candidates)[number]) => [...c.sources].sort().join(', ')

  if (!candidates.length) {
    if (unreadable) {
      log.warn(`${target.scope}: existing known_hosts unreadable; host key adoption deferred`)
      return 'unreadable'
    }
    await db.update(sshTrustTargets).set({ adoptionPending: false }).where(eq(sshTrustTargets.id, target.id))
    await refreshTrustTarget({ ...target, adoptionPending: false }, deps.scanner)
    return 'needs-confirmation'
  }

  const perType = new Map<string, number>()
  for (const c of candidates) perType.set(c.keyType, (perType.get(c.keyType) ?? 0) + 1)
  if ([...perType.values()].some((n) => n > 1)) {
    for (const c of candidates) {
      await recordPresentedKeys(
        target,
        [{ keyType: c.keyType, publicKey: c.publicKey }],
        'adoption-conflict',
        `conflicting existing trust; seen in: ${note(c)}`
      )
    }
    await db.update(sshTrustTargets).set({ adoptionPending: false }).where(eq(sshTrustTargets.id, target.id))
    log.warn(`${target.scope}: conflicting existing host keys; a person must choose`)
    return 'conflict'
  }

  const now = new Date()
  await db.transaction(async (tx) => {
    for (const c of candidates) {
      const decision = {
        status: 'trusted',
        origin: 'adopted',
        decisionNote: `adopted from existing trust (${note(c)})`,
        decidedByUserId: null,
        decidedAt: now,
        lastSeenAt: now,
      }
      await tx
        .insert(sshTrustKeys)
        .values({
          targetId: target.id,
          keyType: c.keyType,
          publicKey: c.publicKey,
          fingerprint: hostKeyFingerprint(c.publicKey),
          firstSeenAt: now,
          ...decision,
        })
        // Never overrides a person's rejection.
        .onConflictDoUpdate({
          target: [sshTrustKeys.targetId, sshTrustKeys.keyType, sshTrustKeys.publicKey],
          set: decision,
          setWhere: eq(sshTrustKeys.status, 'pending'),
        })
    }
    await tx.update(sshTrustTargets).set({ adoptionPending: false }).where(eq(sshTrustTargets.id, target.id))
  })
  log.info(`${target.scope}: adopted ${candidates.length} existing trusted host key(s)`)
  return 'adopted'
}

// ── Pinning ─────────────────────────────────────────────────────────────────

/** Write `content` atomically at `path` (0600) unless it is already there. */
function writePinFile(path: string, content: string): void {
  fs.mkdirSync(pinDir(), { recursive: true, mode: 0o700 })
  try {
    if (fs.readFileSync(path, 'utf-8') === content) return
  } catch {
    // missing: write it
  }
  const tmp = join(pinDir(), `.${randomUUID()}.tmp`)
  fs.writeFileSync(tmp, content, { mode: 0o600 })
  fs.renameSync(tmp, path)
}

const firstUse = new Map<string, Promise<unknown>>()

/** Run `work` once per endpoint at a time (concurrent first connections share one adoption/fetch). */
async function once(targetId: string, work: () => Promise<unknown>): Promise<void> {
  let inflight = firstUse.get(targetId)
  if (!inflight) {
    inflight = work().finally(() => firstUse.delete(targetId))
    firstUse.set(targetId, inflight)
  }
  await inflight
}

/**
 * The pin for a connection to `spec`'s endpoint: a Core-written known_hosts
 * holding exactly its trusted keys under its alias. On first use an adopting
 * endpoint adopts its existing trust, and a new endpoint has its keys fetched
 * (pending for a person). Throws {@link HostKeyNotTrustedError} when no key is
 * trusted: callers must not connect.
 */
export async function hostKeyPinFor(
  spec: TrustTargetSpec,
  deps: { scanner?: HostKeyScanner; sources?: AdoptionSource[] } = {}
): Promise<HostKeyPin> {
  let target = await ensureTrustTarget(spec)
  let keys = await listTrustKeys(target.id)
  if (!trustedHostKeys(keys).length && (target.adoptionPending || (!keys.length && !target.checkedAt))) {
    const current = target
    await once(target.id, () =>
      current.adoptionPending ? adoptTrustTarget(current, deps) : refreshTrustTarget(current, deps.scanner)
    )
    target = (await getTrustTarget(target.id)) ?? target
    keys = await listTrustKeys(target.id)
  }
  const trusted = trustedHostKeys(keys)
  if (!trusted.length) throw new HostKeyNotTrustedError(target, trustTargetState(target, keys))
  const alias = trustAlias(target.scope)
  const knownHostsPath = pinFilePath(target.scope)
  writePinFile(knownHostsPath, trusted.map((k) => `${alias} ${k.keyType} ${k.publicKey}\n`).join(''))
  return { knownHostsPath, alias }
}

/** The pin for a machine connection (BYO or exe.dev VM). */
export function machineHostKeyPin(machine: Parameters<typeof machineTrustSpec>[0]): Promise<HostKeyPin> {
  return hostKeyPinFor(machineTrustSpec(machine))
}

// ── Human decisions ─────────────────────────────────────────────────────────

export class TrustDecisionError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409
  ) {
    super(message)
  }
}

/**
 * A person trusts a key: it becomes pinned, another pinned key of the same
 * type is `replaced` and other pending keys of that type are rejected. Ends
 * adoption. Callers MUST have established that `userId` is a signed-in person.
 */
export async function trustTrustKey(targetId: string, keyId: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [key] = await tx
      .select()
      .from(sshTrustKeys)
      .where(and(eq(sshTrustKeys.id, keyId), eq(sshTrustKeys.targetId, targetId)))
      .for('update')
    if (!key) throw new TrustDecisionError('Host key not found', 404)
    if (key.status !== 'pending' && key.status !== 'rejected') {
      throw new TrustDecisionError(`Host key is already ${key.status}`, 409)
    }
    const now = new Date()
    const sameTypeOthers = and(
      eq(sshTrustKeys.targetId, targetId),
      eq(sshTrustKeys.keyType, key.keyType),
      ne(sshTrustKeys.id, key.id)
    )
    await tx
      .update(sshTrustKeys)
      .set({
        status: 'replaced',
        decidedByUserId: userId,
        decidedAt: now,
        decisionNote: `replaced by ${key.fingerprint}`,
      })
      .where(and(sameTypeOthers, eq(sshTrustKeys.status, 'trusted')))
    await tx
      .update(sshTrustKeys)
      .set({
        status: 'rejected',
        decidedByUserId: userId,
        decidedAt: now,
        decisionNote: `not chosen: ${key.fingerprint} was trusted`,
      })
      .where(and(sameTypeOthers, eq(sshTrustKeys.status, 'pending')))
    await tx
      .update(sshTrustKeys)
      .set({ status: 'trusted', decidedByUserId: userId, decidedAt: now, decisionNote: 'trusted by a person' })
      .where(eq(sshTrustKeys.id, key.id))
    await tx
      .update(sshTrustTargets)
      .set({ adoptionPending: false, updatedAt: now })
      .where(eq(sshTrustTargets.id, targetId))
  })
}

/** A person rejects a pending key; it is never pinned. */
export async function rejectTrustKey(targetId: string, keyId: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [key] = await tx
      .select()
      .from(sshTrustKeys)
      .where(and(eq(sshTrustKeys.id, keyId), eq(sshTrustKeys.targetId, targetId)))
      .for('update')
    if (!key) throw new TrustDecisionError('Host key not found', 404)
    if (key.status !== 'pending') throw new TrustDecisionError(`Host key is already ${key.status}`, 409)
    await tx
      .update(sshTrustKeys)
      .set({ status: 'rejected', decidedByUserId: userId, decidedAt: new Date(), decisionNote: 'rejected by a person' })
      .where(eq(sshTrustKeys.id, key.id))
  })
}
