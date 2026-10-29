import { and, asc, eq, sql } from 'drizzle-orm'
import { db, memoryDocuments } from '../../../db'
import type { MemorySourceAdapter } from '../../memory/sources/adapter'
import type { IndexResult } from '../../memory/sources/types'

export type GitHubReindexReason = 'stale' | 'legacy'
export const GITHUB_REINDEX_READ_LIMIT = 25
const pending = sql`${memoryDocuments.frontmatter}->'githubReindex'`

/** Durable deduplication on the document, not an API-process timer or a new job type. */
export async function enqueueGitHubMemoryReindex(
  candidates: Array<{ id: string; contentHash: string; reason: GitHubReindexReason; callerSquadId: string }>,
  executor: Pick<typeof db, 'update'> = db
): Promise<void> {
  for (const candidate of candidates.slice(0, GITHUB_REINDEX_READ_LIMIT))
    await executor
      .update(memoryDocuments)
      .set({
        frontmatter: sql`jsonb_set(${memoryDocuments.frontmatter}, '{githubReindex}', ${JSON.stringify({
          reason: candidate.reason,
          callerSquadId: candidate.callerSquadId,
          contentHash: candidate.contentHash,
          requestedAt: new Date().toISOString(),
        })}::jsonb)`,
      })
      .where(
        and(
          eq(memoryDocuments.id, candidate.id),
          eq(memoryDocuments.sourceType, 'github_issue'),
          eq(memoryDocuments.contentHash, candidate.contentHash),
          sql`(${pending}->>'contentHash') IS DISTINCT FROM ${candidate.contentHash}`
        )
      )
}

export async function githubMemoryReindexStatus(squadId: string) {
  const [row] = await db
    .select({
      stale: sql<number>`count(*) filter (where ${pending}->>'reason' = 'stale')::int`,
      legacy: sql<number>`count(*) filter (where ${pending}->>'reason' = 'legacy')::int`,
    })
    .from(memoryDocuments)
    .where(and(eq(memoryDocuments.squadId, squadId), eq(memoryDocuments.sourceType, 'github_issue')))
  const stale = row?.stale ?? 0,
    legacy = row?.legacy ?? 0
  return { hiddenPendingReindex: stale + legacy, reasons: { stale, legacy } }
}

/** Called by the existing external-source service BEFORE its ordinary discovery window. */
export async function reindexPendingGitHubMemory(
  squadId: string,
  adapter: MemorySourceAdapter
): Promise<IndexResult[]> {
  const documents = await db
    .select({ id: memoryDocuments.id, sourceId: memoryDocuments.sourceId })
    .from(memoryDocuments)
    .where(
      and(
        eq(memoryDocuments.squadId, squadId),
        eq(memoryDocuments.sourceType, 'github_issue'),
        sql`${pending}->>'reason' IN ('stale', 'legacy')`
      )
    )
    .orderBy(sql`coalesce(${pending}->>'attemptedAt', '')`, asc(memoryDocuments.id))
    .limit(GITHUB_REINDEX_READ_LIMIT)
  const results: IndexResult[] = []
  for (const document of documents) {
    // Rotate failures behind unattempted documents on the next existing periodic tick.
    await db
      .update(memoryDocuments)
      .set({
        frontmatter: sql`jsonb_set(${memoryDocuments.frontmatter}, '{githubReindex,attemptedAt}', to_jsonb(${new Date().toISOString()}::text))`,
      })
      .where(and(eq(memoryDocuments.id, document.id), sql`${pending} IS NOT NULL`))
    try {
      results.push(await adapter.index(squadId, document.sourceId))
    } catch (error) {
      results.push({
        success: false,
        chunksCreated: 0,
        linksCreated: 0,
        error: error instanceof Error ? error.message : 'Reindex failed',
      })
    }
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
