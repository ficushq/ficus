/**
 * Daily rollups and retention for the ledger (worker only). Each UTC day is rolled up whole — delete its
 * rollup rows, insert its GROUP BY — so rebuilding a day is idempotent. Per-call rows older than the
 * retention setting are deleted only after their day is rolled up, so long-range totals survive.
 */
import { sql } from 'drizzle-orm'
import { db } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import { detailCutoff, inferenceRetentionDays } from './query'

const log = createLogger('inference-usage')
const DAY_MS = 24 * 60 * 60 * 1000
const PRUNE_BATCH = 10_000

function isoDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

/** Rebuilds the rollup rows of whole UTC days (`YYYY-MM-DD`) from the per-call rows. */
export async function rollupInferenceUsageDays(days: string[]): Promise<void> {
  for (const day of [...new Set(days)].sort()) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM inference_usage_daily WHERE day = ${day}::date`)
      await tx.execute(sql`
        INSERT INTO inference_usage_daily (
          day, feature, provider, model, account_id, billing, squad_id, work_stream_id, agent_id, user_id,
          calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          cost_nanodollars, list_cost_nanodollars, list_unknown_calls, estimated_calls
        )
        SELECT ${day}::date, feature, provider, model, account_id, billing, squad_id, work_stream_id, agent_id, user_id,
          count(*), sum(input_tokens), sum(output_tokens), sum(cache_read_tokens), sum(cache_write_tokens),
          sum(cost_nanodollars), coalesce(sum(list_cost_nanodollars), 0),
          count(*) FILTER (WHERE list_cost_nanodollars IS NULL), count(*) FILTER (WHERE cost_estimated)
        FROM inference_usage
        WHERE occurred_at >= ${day}::date::timestamp AT TIME ZONE 'UTC'
          AND occurred_at < (${day}::date + 1)::timestamp AT TIME ZONE 'UTC'
        GROUP BY feature, provider, model, account_id, billing, squad_id, work_stream_id, agent_id, user_id
      `)
    })
  }
}

/** Days that have per-call rows before `before` (UTC), oldest first. */
async function detailDaysBefore(before: Date): Promise<string[]> {
  const rows = await db.execute<{ day: string }>(sql`
    SELECT DISTINCT (occurred_at AT TIME ZONE 'UTC')::date::text AS day
    FROM inference_usage WHERE occurred_at < ${before.toISOString()}::timestamptz ORDER BY 1
  `)
  return [...rows].map((row) => row.day)
}

/** How far back the hourly job looks for rows written after their day was rolled up (long turns). */
const LATE_WINDOW_DAYS = 7

/**
 * Hourly: keep yesterday's and today's rollups current, and re-roll any recent day that got rows after
 * its rollup was built. The first run rolls up every day that has rows. Backfills roll up their own days.
 */
export async function runInferenceUsageRollup(now = new Date()): Promise<void> {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS
  const [latest] = [
    ...(await db.execute<{ day: string | null }>(sql`SELECT max(day)::text AS day FROM inference_usage_daily`)),
  ]
  const days = new Set([isoDay(today - DAY_MS), isoDay(today)])
  if (latest?.day) {
    const late = await db.execute<{ day: string }>(sql`
      SELECT DISTINCT (u.occurred_at AT TIME ZONE 'UTC')::date::text AS day
      FROM inference_usage u
      WHERE u.occurred_at >= ${new Date(today - LATE_WINDOW_DAYS * DAY_MS).toISOString()}::timestamptz
        AND u.occurred_at < ${new Date(today - DAY_MS).toISOString()}::timestamptz
        AND u.created_at > coalesce(
          (SELECT max(d.updated_at) FROM inference_usage_daily d
            WHERE d.day = (u.occurred_at AT TIME ZONE 'UTC')::date),
          '-infinity'::timestamptz
        )
    `)
    for (const row of late) days.add(row.day)
  } else {
    for (const day of await detailDaysBefore(new Date(today))) days.add(day)
  }
  await rollupInferenceUsageDays([...days])
}

/**
 * Daily: roll up every day before the retention cutoff that still has per-call rows, then delete those
 * rows in batches. Returns how many rows were deleted.
 */
export async function pruneInferenceUsage(options: { now?: Date; retentionDays?: number } = {}): Promise<number> {
  const now = options.now ?? new Date()
  const cutoff = detailCutoff(now, options.retentionDays ?? inferenceRetentionDays())
  const days = await detailDaysBefore(cutoff)
  if (days.length === 0) return 0
  await rollupInferenceUsageDays(days)
  let deleted = 0
  for (;;) {
    const rows = await db.execute<{ id: string }>(sql`
      DELETE FROM inference_usage WHERE id IN (
        SELECT id FROM inference_usage WHERE occurred_at < ${cutoff.toISOString()}::timestamptz LIMIT ${PRUNE_BATCH}
      ) RETURNING id
    `)
    const count = [...rows].length
    deleted += count
    if (count < PRUNE_BATCH) break
  }
  if (deleted > 0) log.info(`Pruned ${deleted} inference usage rows before ${cutoff.toISOString().slice(0, 10)}`)
  return deleted
}
