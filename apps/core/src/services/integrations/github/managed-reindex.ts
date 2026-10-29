import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db, memoryDocuments } from '../../../db'
import type { MemorySourceAdapter } from '../../memory/sources/adapter'
import type { IndexResult } from '../../memory/sources/types'

export type GitHubReindexReason = 'stale' | 'legacy' | 'filter_changed' | 'decision_changed'
export const GITHUB_REINDEX_READ_LIMIT = 25
const pending = sql`${memoryDocuments.frontmatter}->'githubReindex'`

/** Durable deduplication on the document, not an API-process timer or a new job type. */
export async function enqueueGitHubMemoryReindex(
  candidates: Array<{ id: string; contentHash: string; reason: GitHubReindexReason; callerSquadId: string }>,
  executor: Pick<typeof db, 'update'> = db
): Promise<void> {
  const bounded = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()]
    .slice(0, GITHUB_REINDEX_READ_LIMIT)
    .map((candidate) => ({ ...candidate, requestedAt: new Date().toISOString() }))
  if (!bounded.length) return
  // One bounded update, rather than one round-trip per result.
  await executor
    .update(memoryDocuments)
    .set({
      frontmatter: sql`jsonb_set(${memoryDocuments.frontmatter}, '{githubReindex}',
    (select item - 'id' from jsonb_array_elements(${JSON.stringify(bounded)}::jsonb) item where item->>'id' = ${memoryDocuments.id}::text))`,
    })
    .where(
      and(
        eq(memoryDocuments.sourceType, 'github_issue'),
        inArray(
          memoryDocuments.id,
          bounded.map((candidate) => candidate.id)
        ),
        sql`exists (
      select 1 from jsonb_array_elements(${JSON.stringify(bounded)}::jsonb) item
      where item->>'id' = ${memoryDocuments.id}::text and item->>'contentHash' = ${memoryDocuments.contentHash}
        and (${pending}->>'contentHash') is distinct from ${memoryDocuments.contentHash})`
      )
    )
}

export async function githubMemoryReindexStatus(squadId: string) {
  const [row] = await db
    .select({
      stale: sql<number>`count(*) filter (where ${pending}->>'reason' = 'stale')::int`,
      filter_changed: sql<number>`count(*) filter (where ${pending}->>'reason' = 'filter_changed')::int`,
      decision_changed: sql<number>`count(*) filter (where ${pending}->>'reason' = 'decision_changed')::int`,
      legacy: sql<number>`count(*) filter (where ${pending}->>'reason' = 'legacy')::int`,
    })
    .from(memoryDocuments)
    .where(and(eq(memoryDocuments.squadId, squadId), eq(memoryDocuments.sourceType, 'github_issue')))
  const stale = row?.stale ?? 0,
    legacy = row?.legacy ?? 0
  const filter_changed = row?.filter_changed ?? 0,
    decision_changed = row?.decision_changed ?? 0
  return {
    hiddenPendingReindex: stale + legacy + filter_changed + decision_changed,
    reasons: { stale, legacy, filter_changed, decision_changed },
  }
}

/** Called by the existing external-source service BEFORE its ordinary discovery window. */
export async function reindexPendingGitHubMemory(
  squadId: string,
  adapter: MemorySourceAdapter
): Promise<IndexResult[]> {
  const documents = await db
    .select({
      id: memoryDocuments.id,
      sourceId: memoryDocuments.sourceId,
      generation: sql<string>`${memoryDocuments.updatedAt}::text`,
      marker: pending,
    })
    .from(memoryDocuments)
    .where(
      and(
        eq(memoryDocuments.squadId, squadId),
        eq(memoryDocuments.sourceType, 'github_issue'),
        sql`${pending}->>'reason' IN ('stale', 'legacy', 'filter_changed', 'decision_changed')`,
        sql`coalesce(${pending}->>'nextAttemptAt', '') <= ${new Date().toISOString()}`
      )
    )
    .orderBy(sql`coalesce(${pending}->>'attemptedAt', '')`, asc(memoryDocuments.id))
    .limit(GITHUB_REINDEX_READ_LIMIT)
  const results: IndexResult[] = []
  for (const document of documents) {
    let result: IndexResult
    try {
      result = await adapter.index(squadId, document.sourceId)
    } catch {
      result = { success: false, chunksCreated: 0, linksCreated: 0, error: 'GitHub recovery fetch failed' }
    }
    results.push(result)
    if (['out_of_scope', 'not_found'].includes(result.reason ?? '')) {
      // Explicit provider denial or current scope exclusion cannot be repaired by retrying.
      await db
        .delete(memoryDocuments)
        .where(
          and(
            eq(memoryDocuments.id, document.id),
            sql`${memoryDocuments.updatedAt}::text = ${document.generation}`,
            sql`${pending} = ${JSON.stringify(document.marker)}::jsonb`
          )
        )
      continue
    }
    const prior = document.marker as { attempts?: number }
    const attempts = Math.min(16, (typeof prior.attempts === 'number' ? prior.attempts : 0) + 1)
    const marker = {
      ...prior,
      attempts,
      attemptedAt: new Date().toISOString(),
      nextAttemptAt: new Date(Date.now() + Math.min(24 * 60, 30 * 2 ** (attempts - 1)) * 60_000).toISOString(),
    }
    // Success normally cleared the marker. Failed/unprovable recaptures back off, never clearing a newer request.
    await db
      .update(memoryDocuments)
      .set({
        frontmatter: sql`jsonb_set(${memoryDocuments.frontmatter}, '{githubReindex}', ${JSON.stringify(marker)}::jsonb)`,
      })
      .where(and(eq(memoryDocuments.id, document.id), sql`${pending} = ${JSON.stringify(document.marker)}::jsonb`))
  }
  return results
}

/** Clear only the validated generation, never a concurrently replaced snapshot/marker. */
export async function clearGitHubMemoryReindex(documentId: string, contentHash: string, expected: unknown) {
  if (!expected) return
  await db
    .update(memoryDocuments)
    .set({ frontmatter: sql`${memoryDocuments.frontmatter} - 'githubReindex'` })
    .where(
      and(
        eq(memoryDocuments.id, documentId),
        eq(memoryDocuments.contentHash, contentHash),
        sql`${pending} = ${JSON.stringify(expected)}::jsonb`
      )
    )
}
