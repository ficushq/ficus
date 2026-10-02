import { sql } from 'drizzle-orm'
import type { DbTx } from '../../../db'

/**
 * Serializes infrequent human trust and API RBAC writes, including links whose
 * subjects do not yet appear in the dynamic-trust scan. Always acquire BEFORE
 * user/proof/trust row locks; transaction-scoped, with no provider I/O inside.
 */
export async function lockGitHubTrustAuthority(tx: DbTx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(438, 5)`)
}
