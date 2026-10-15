/**
 * The prune watermark: the UTC day before which per-call rows have been rolled up and deleted. Spend reads
 * daily totals for days before it and per-call rows from it on. Stored in the settings table and written
 * only by retention.ts, in the same transaction as the day it seals. See retention.ts.
 */
import { sql, type SQL } from 'drizzle-orm'
import { db } from '../../db'

export const PRUNED_BEFORE_KEY = 'INFERENCE_USAGE_PRUNED_BEFORE'

export type Executor = Pick<typeof db, 'execute'>

/** The watermark as SQL (a date; `-infinity` before the first prune), read in the caller's snapshot. */
export const PRUNED_BEFORE_SQL: SQL = sql`coalesce(
  (SELECT nullif(value, '')::date FROM settings WHERE key = ${PRUNED_BEFORE_KEY}), '-infinity'::date)`

/** The current watermark day (`YYYY-MM-DD`), or null before the first prune. */
export async function prunedBefore(executor: Executor = db): Promise<string | null> {
  const [row] = [
    ...(await executor.execute<{ day: string | null }>(
      sql`SELECT nullif(value, '') AS day FROM settings WHERE key = ${PRUNED_BEFORE_KEY}`
    )),
  ]
  return row?.day ?? null
}
