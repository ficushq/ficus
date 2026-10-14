import { sql } from 'drizzle-orm'
import type { DbTx } from '../../../db'

/**
 * Serializes infrequent human trust and API RBAC writes, including links whose
 * subjects do not yet appear in the dynamic-trust scan. Always acquire BEFORE
 * user/proof/trust row locks; transaction-scoped, with no provider I/O inside.
 *
 * GitHub output effects take it too (`lockGitHubOutputAuthority`), and deliberately in the
 * same exclusive mode: effect transactions lock the squad row FOR SHARE and some later upgrade
 * it, so two effects running concurrently under a shared advisory lock deadlock on that row.
 * Relaxing this needs those upgrades removed first.
 */
export async function lockGitHubTrustAuthority(tx: DbTx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(438, 5)`)
}
