import { and, eq } from 'drizzle-orm'
import { db, githubFeedbackSources } from '../../../db'
import { authorized } from '../outputs/authority'

/** Bounded scan: a revision's recorded sources, not an enumeration API. */
const MAX_SOURCES_CHECKED = 20

/**
 * Exact-resource gate for disclosure: at least one recorded source must still come from a connection
 * that is enabled, healthy, assigned to THIS squad and on the same material revision. A rotated or
 * revoked connection withholds the body (decision metadata stays visible so a human can still deny).
 */
export async function hasCurrentSourceAccess(
  revisionId: string,
  squadId: string,
  executor: Pick<typeof db, 'select'> = db
): Promise<boolean> {
  const sources = await executor
    .select({ authority: githubFeedbackSources.authority })
    .from(githubFeedbackSources)
    .where(and(eq(githubFeedbackSources.revisionId, revisionId), eq(githubFeedbackSources.squadId, squadId)))
    .limit(MAX_SOURCES_CHECKED)
  for (const source of sources)
    if (
      source.authority.kind === 'connection' &&
      (await authorized(executor as typeof db, 'github', source.authority, squadId))
    )
      return true
  return false
}
