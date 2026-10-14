import { and, eq } from 'drizzle-orm'
import { db, githubFeedbackRevisions, githubFeedbackSources, integrationOutputEvents, type DbTx } from '../../../db'
import { readOutputEvent, readFeedbackRevision } from './feedback-pass-read'
import { authorized } from '../outputs/authority'
import { githubContentHash } from './feedback-envelope'
import { isGitHubOutputAdmitted } from './feedback-routing'
import { isTrustedGitHubFeedbackContent } from './feedback-trust'
import { releaseGitHubFeedback, type GitHubFeedbackReleaseDependencies } from './feedback-release'
import { renewKnownGitHubOutputs } from './feedback-renewal'
import { readGitHubResource, reserveGitHubEvent, withGitHubOutputPass } from './feedback-pass'

type Event = typeof integrationOutputEvents.$inferSelect
type Store = typeof db | DbTx
const snapshot = (event: Event) => githubContentHash([event.fact, event.authority, event.sourceKey, event.eventKey])

/** Production adapter: provider preparation and immutable LOCAL factory callbacks are separate. */
export async function reconcileGitHubFeedbackRelease(route: GitHubFeedbackReleaseDependencies['route']) {
  return withGitHubOutputPass(async () => {
    const witnesses = new Map<string, { hash: string; expiresAt: number }>()
    async function sourceReason(event: Event, store: Store) {
      if (
        event.authority.kind !== 'connection' ||
        !(await authorized(store, 'github', event.authority, event.authority.squadId))
      )
        return 'source_unavailable' as const
      const [row] = await store
        .select({ revisionId: githubFeedbackRevisions.id })
        .from(githubFeedbackSources)
        .innerJoin(githubFeedbackRevisions, eq(githubFeedbackRevisions.id, githubFeedbackSources.revisionId))
        .where(
          and(eq(githubFeedbackSources.eventId, event.id), eq(githubFeedbackSources.squadId, event.authority.squadId))
        )
      const revision = row ? await readFeedbackRevision(store, row.revisionId) : undefined
      if (
        !revision ||
        !['automatic', 'allow_once', 'allow_trust', 'screened'].includes(revision.decision) ||
        (revision.decision === 'automatic' &&
          !(await isTrustedGitHubFeedbackContent(store, revision.squadId, revision)))
      )
        return 'source_unavailable' as const
      return null
    }
    return releaseGitHubFeedback({
      async prepareSource(event) {
        if (!reserveGitHubEvent(event.id)) return false
        if (event.fact.github?.revisionId) {
          if (
            event.authority.kind !== 'connection' ||
            !(await authorized(db, 'github', event.authority, event.authority.squadId))
          )
            return false
          await renewKnownGitHubOutputs([event.id])
          return isGitHubOutputAdmitted(db, event)
        }
        if (await sourceReason(event, db)) return false
        const access = await readGitHubResource(event)
        if (!access?.nativeAuthorized) return false
        witnesses.set(event.id, { hash: snapshot(event), expiresAt: access.checkedAt.getTime() + 60_000 })
        return true
      },
      async authorizeSource(event, store = db) {
        if (event.fact.github?.revisionId) return isGitHubOutputAdmitted(store, event)
        const witness = witnesses.get(event.id)
        if (!witness || witness.expiresAt <= Date.now() || witness.hash !== snapshot(event)) return false
        const current = await readOutputEvent(store, event.id)
        return !!current && snapshot(current) === witness.hash && (await sourceReason(current, store)) === null
      },
      route,
    })
  })
}
