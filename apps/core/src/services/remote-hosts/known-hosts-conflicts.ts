import { and, asc, eq, notInArray, sql } from 'drizzle-orm'
import { hostKeyFingerprint, removeConflictingHostKeys, type KnownHostsConflict } from '@ficus/shared/known-hosts'
import { db, knownHostsConflicts } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import type { SandboxClient } from '../sandbox/client/http-client'

/**
 * Box-vs-Core known_hosts conflicts (packages/shared/src/known-hosts.ts): a
 * box's own `~/.ssh/known_hosts` pins a different key than a Core-managed
 * entry for the same host and key type, so the managed entry was left out of
 * that box. Core performs that merge for vm boxes and records each box's
 * current conflicts after every merge (`vm/file-sync.ts`).
 *
 * A person resolves each conflict, never an agent (routes enforce it):
 * - "Keep box key": the box key stays and the managed entry stays out. That
 *   exact pair of keys is no longer reported; a different box or Core key is a
 *   new conflict.
 * - "Use Core key": the conflicting box line(s) for that host and key type are
 *   removed (plain and hashed; a comma-listed line keeps its other hosts) and
 *   the managed entry is written, through the same compare-and-swap 0600 write
 *   as every sync. A conflicting WILDCARD line is never edited — it may cover
 *   other hosts — so that resolution is refused and the line must be edited by
 *   hand (or the box key kept).
 */

const log = createLogger('known-hosts-conflicts')

export type KnownHostsConflictRow = typeof knownHostsConflicts.$inferSelect

/**
 * Replace a box's recorded conflicts with `conflicts` (the full current list
 * from a merge). New pairs are recorded `open`; a pair a person kept stays
 * `kept-box` (silenced); a pair previously resolved with Core's key that is
 * back reopens. Open pairs no longer present are cleared.
 */
export async function recordBoxKnownHostsConflicts(
  sandboxId: string,
  squadId: string | null,
  conflicts: KnownHostsConflict[]
): Promise<void> {
  const now = new Date()
  const keep: string[] = []
  await db.transaction(async (tx) => {
    for (const c of squadId === null ? [] : conflicts) {
      const [row] = await tx
        .insert(knownHostsConflicts)
        .values({
          squadId: squadId!,
          sandboxId,
          host: c.host,
          keyType: c.keyType,
          boxKey: c.boxKey,
          boxFingerprint: hostKeyFingerprint(c.boxKey),
          coreKey: c.key,
          coreFingerprint: hostKeyFingerprint(c.key),
          boxLine: c.line,
          wildcard: c.wildcard,
          status: 'open',
          detectedAt: now,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: [
            knownHostsConflicts.sandboxId,
            knownHostsConflicts.host,
            knownHostsConflicts.keyType,
            knownHostsConflicts.boxKey,
            knownHostsConflicts.coreKey,
          ],
          set: {
            squadId: squadId!,
            boxLine: c.line,
            wildcard: c.wildcard,
            lastSeenAt: now,
            status: sql`CASE WHEN ${knownHostsConflicts.status} = 'kept-box' THEN 'kept-box' ELSE 'open' END`,
          },
        })
        .returning({ id: knownHostsConflicts.id })
      keep.push(row.id)
    }
    await tx
      .delete(knownHostsConflicts)
      .where(
        and(
          eq(knownHostsConflicts.sandboxId, sandboxId),
          eq(knownHostsConflicts.status, 'open'),
          ...(keep.length ? [notInArray(knownHostsConflicts.id, keep)] : [])
        )
      )
  })
}

/** A squad's open and kept conflicts across its boxes. */
export async function listSquadKnownHostsConflicts(squadId: string): Promise<KnownHostsConflictRow[]> {
  return db
    .select()
    .from(knownHostsConflicts)
    .where(and(eq(knownHostsConflicts.squadId, squadId), sql`${knownHostsConflicts.status} <> 'resolved-core'`))
    .orderBy(asc(knownHostsConflicts.host), asc(knownHostsConflicts.sandboxId))
}

/** The API view of a conflict: fingerprints, not key blobs. */
export function toPublicKnownHostsConflict(row: KnownHostsConflictRow) {
  return {
    id: row.id,
    squadId: row.squadId,
    sandboxId: row.sandboxId,
    host: row.host,
    keyType: row.keyType,
    boxFingerprint: row.boxFingerprint,
    coreFingerprint: row.coreFingerprint,
    boxLine: row.boxLine,
    wildcard: row.wildcard,
    status: row.status,
    detectedAt: row.detectedAt,
    lastSeenAt: row.lastSeenAt,
    resolvedAt: row.resolvedAt,
    resolvedByUserId: row.resolvedByUserId,
  }
}

export class ConflictResolutionError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409
  ) {
    super(message)
  }
}

async function getOpenConflict(squadId: string, conflictId: string): Promise<KnownHostsConflictRow> {
  const [row] = await db
    .select()
    .from(knownHostsConflicts)
    .where(and(eq(knownHostsConflicts.id, conflictId), eq(knownHostsConflicts.squadId, squadId)))
  if (!row) throw new ConflictResolutionError('Conflict not found', 404)
  if (row.status !== 'open') throw new ConflictResolutionError(`Conflict is already resolved (${row.status})`, 409)
  return row
}

/** A person keeps the box key. Callers MUST have established `userId` is a signed-in person. */
export async function keepBoxKey(squadId: string, conflictId: string, userId: string): Promise<KnownHostsConflictRow> {
  await getOpenConflict(squadId, conflictId)
  const [row] = await db
    .update(knownHostsConflicts)
    .set({ status: 'kept-box', resolvedAt: new Date(), resolvedByUserId: userId })
    .where(and(eq(knownHostsConflicts.id, conflictId), eq(knownHostsConflicts.status, 'open')))
    .returning()
  if (!row) throw new ConflictResolutionError('Conflict is already resolved', 409)
  log.info(`known_hosts conflict ${conflictId} (${row.host} ${row.keyType} on ${row.sandboxId}): box key kept by ${userId}`)
  return row
}

export interface UseCoreKeyDeps {
  getClient?: (sandboxId: string) => Promise<SandboxClient | null>
  boxHome?: (sandboxId: string) => string
  /** The squad's managed known_hosts source (Core's squad `known_hosts`). */
  managedKnownHosts?: (squadId: string) => string
}

/**
 * A person replaces the box key with Core's (see module doc). Callers MUST
 * have established `userId` is a signed-in person. Refused (409) for a
 * wildcard line or an unreachable box; nothing is written then.
 */
export async function useCoreKey(
  squadId: string,
  conflictId: string,
  userId: string,
  deps: UseCoreKeyDeps = {}
): Promise<KnownHostsConflictRow> {
  const conflict = await getOpenConflict(squadId, conflictId)
  if (conflict.wildcard) throw wildcardRefusal(conflict.host, [conflict.boxLine])

  const fileSync = await import('../sandbox/vm/file-sync')
  const client = await (deps.getClient ?? fileSync.defaultGetClient)(conflict.sandboxId)
  if (!client) {
    throw new ConflictResolutionError('The box is not reachable right now; try again once it is running.', 409)
  }
  const managed =
    deps.managedKnownHosts?.(squadId) ?? (await import('../squad/ssh')).getKnownHosts(squadId) ?? ''

  const remaining = await fileSync.editAndMergeKnownHostsOnBox(
    client,
    (deps.boxHome ?? fileSync.defaultBoxHome)(conflict.sandboxId),
    managed,
    (existing) => {
      const removal = removeConflictingHostKeys(existing, conflict.host, conflict.keyType, conflict.coreKey)
      if (removal.wildcardLines.length) throw wildcardRefusal(conflict.host, removal.wildcardLines)
      return removal.content
    }
  )

  const [row] = await db
    .update(knownHostsConflicts)
    .set({ status: 'resolved-core', resolvedAt: new Date(), resolvedByUserId: userId })
    .where(
      and(
        eq(knownHostsConflicts.sandboxId, conflict.sandboxId),
        eq(knownHostsConflicts.host, conflict.host),
        eq(knownHostsConflicts.keyType, conflict.keyType),
        eq(knownHostsConflicts.status, 'open')
      )
    )
    .returning()
  await recordBoxKnownHostsConflicts(conflict.sandboxId, squadId, remaining)
  log.info(
    `known_hosts conflict ${conflictId} (${conflict.host} ${conflict.keyType} on ${conflict.sandboxId}): Core key applied by ${userId}`
  )
  return row ?? conflict
}

function wildcardRefusal(host: string, lines: number[]): ConflictResolutionError {
  return new ConflictResolutionError(
    `The box pins ${host} through a wildcard known_hosts line (line ${lines.join(', ')}) that may cover other hosts, ` +
      'so Ficus will not edit it. Edit that line by hand on the box, or keep the box key.',
    409
  )
}
