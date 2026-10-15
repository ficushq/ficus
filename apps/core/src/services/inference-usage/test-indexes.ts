import { sql } from 'drizzle-orm'
import { db } from '../../db'

/**
 * The test database is push-built, and `drizzle-kit push` skips partial indexes; install the ledger's
 * dedupe index exactly as the migration defines it so tests exercise the real at-most-once backstop.
 */
export async function ensureInferenceUsageDedupeIndex(): Promise<void> {
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "idx_inference_usage_dedupe_key" ON "inference_usage" USING btree ("dedupe_key") WHERE "inference_usage"."dedupe_key" IS NOT NULL`
  )
}
