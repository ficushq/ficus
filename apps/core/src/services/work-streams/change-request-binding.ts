import { eq } from 'drizzle-orm'
import { db, squads, workStreams, type DbTx } from '../../db'

/** Canonical shape, shared with query-only future-subscription planning. No metadata is persisted here. */
export function changeRequestBindingMetadata(
  metadata: unknown,
  reference: { integration: string; repository: string; connectionId?: string },
  chosen: { number: number; url?: string }
) {
  const record = (metadata as Record<string, unknown> | null) ?? {}
  const url =
    chosen.url ??
    (reference.integration === 'github'
      ? `https://github.com/${reference.repository}/pull/${chosen.number}`
      : undefined)
  return {
    ...record,
    codeHost: {
      integration: reference.integration,
      repository: reference.repository,
      ...(reference.connectionId ? { connectionId: reference.connectionId } : {}),
      changeRequest: { number: chosen.number, ...(url ? { url } : {}) },
    },
  }
}

/**
 * Persist a resolved delivery change request binding.
 *
 * Two callers resolve the delivery pull request from the stream's branch when
 * `codeHost.changeRequest` is missing: code-host events for a pull request opened from that
 * branch (as soon as it is observed), and `finishFlow` (the fallback). This records the outcome
 * so the binding survives (and every later read shows what was actually verified). The write is
 * canonical `codeHost` (which legitimately shadows a legacy `github` shape), row-locked in the
 * codebase's squad-before-stream order, and never overwrites an existing binding: a manual
 * binding written concurrently always wins over the resolution. `stillMatches` re-checks, under
 * the lock, that the stream metadata still identifies this pull request.
 */
export async function recordChangeRequestBinding(
  streamId: string,
  reference: { integration: string; repository: string; connectionId?: string },
  chosen: { number: number; url?: string },
  stillMatches?: (metadata: unknown) => boolean,
  admit?: (tx: DbTx) => Promise<boolean>
): Promise<boolean> {
  const changed = await db.transaction(async (tx) => {
    if (admit && !(await admit(tx))) return false
    // Global lock order: squad before work stream.
    const [owner] = await tx
      .select({ squadId: workStreams.squadId })
      .from(workStreams)
      .where(eq(workStreams.id, streamId))
    if (!owner) return false
    await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, owner.squadId)).for('update')
    const [locked] = await tx.select().from(workStreams).where(eq(workStreams.id, streamId)).for('update')
    if (!locked || ['done', 'canceled'].includes(locked.status)) return false
    const record = (locked.metadata as Record<string, unknown> | null) ?? {}
    const codeHost = (record.codeHost ?? {}) as Record<string, unknown>
    const existing = codeHost.changeRequest as { number?: number } | undefined
    // Re-resolving what is already bound, or losing a race to a manual binding, changes nothing.
    if (existing?.number != null) return existing.number === chosen.number
    if (stillMatches && !stillMatches(locked.metadata)) return false
    await tx
      .update(workStreams)
      .set({
        metadata: changeRequestBindingMetadata(locked.metadata, reference, chosen),
        updatedAt: new Date(),
      })
      .where(eq(workStreams.id, streamId))
    return true
  })
  return changed
}
