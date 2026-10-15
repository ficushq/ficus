/**
 * Daily rollups and retention for the ledger (worker only).
 *
 * The prune watermark (`INFERENCE_USAGE_PRUNED_BEFORE`, a UTC day kept in the settings table) is the read
 * boundary for every spend query: days before it are read from `inference_usage_daily`, days from it on
 * from the per-call rows. It moves only when pruning has rolled a day up and deleted its rows, in the same
 * transaction, so changing the retention setting never hides or double counts a day.
 *
 * A day at or after the watermark is complete in the per-call table, so its rollup is rebuilt whole
 * (delete, insert). A day before it has already lost its per-call rows: any rows that turn up there later
 * (a long turn, a first backfill) are flushed instead, added to the rollup and deleted in one transaction.
 * Each day is processed under an advisory lock so concurrent jobs cannot double a day.
 */
import { sql } from 'drizzle-orm'
import { db } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import { detailCutoff, inferenceRetentionDays } from './query'
import { PRUNED_BEFORE_KEY, prunedBefore, type Executor } from './watermark'

const log = createLogger('inference-usage')
const DAY_MS = 24 * 60 * 60 * 1000
function isoDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

async function setPrunedBefore(executor: Executor, day: string): Promise<void> {
  await executor.execute(sql`
    INSERT INTO settings (key, value, updated_by) VALUES (${PRUNED_BEFORE_KEY}, ${day}, 'system:inference-usage')
    ON CONFLICT (key) DO UPDATE SET value = GREATEST(settings.value, EXCLUDED.value), updated_at = now(),
      updated_by = EXCLUDED.updated_by
  `)
}

const dayRows = (day: string) => sql`occurred_at >= ${day}::date::timestamp AT TIME ZONE 'UTC'
  AND occurred_at < (${day}::date + 1)::timestamp AT TIME ZONE 'UTC'`

async function insertTotals(executor: Executor, day: string): Promise<void> {
  await executor.execute(sql`
    INSERT INTO inference_usage_daily (
      day, feature, provider, model, account_id, billing, squad_id, work_stream_id, agent_id, user_id,
      calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cost_nanodollars, list_cost_nanodollars, list_unknown_calls, estimated_calls
    )
    SELECT ${day}::date, feature, provider, model, account_id, billing, squad_id, work_stream_id, agent_id, user_id,
      count(*), sum(input_tokens), sum(output_tokens), sum(cache_read_tokens), sum(cache_write_tokens),
      sum(cost_nanodollars), coalesce(sum(list_cost_nanodollars), 0),
      count(*) FILTER (WHERE list_cost_nanodollars IS NULL), count(*) FILTER (WHERE cost_estimated)
    FROM inference_usage WHERE ${dayRows(day)}
    GROUP BY feature, provider, model, account_id, billing, squad_id, work_stream_id, agent_id, user_id
  `)
}

/**
 * Brings one day's rollup up to date in one transaction. `prune` also deletes the day's per-call rows and,
 * for a day at or after the watermark, moves the watermark past it.
 */
async function processDay(day: string, prune: boolean): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`inference_usage_daily:${day}`}))`)
    const watermark = await prunedBefore(tx)
    const sealed = watermark !== null && day < watermark
    if (sealed) {
      // Already pruned: add the stray rows to the rollup, then remove them so they are never added twice.
      await insertTotals(tx, day)
      await tx.execute(sql`DELETE FROM inference_usage WHERE ${dayRows(day)}`)
      return
    }
    await tx.execute(sql`DELETE FROM inference_usage_daily WHERE day = ${day}::date`)
    await insertTotals(tx, day)
    if (prune) {
      await tx.execute(sql`DELETE FROM inference_usage WHERE ${dayRows(day)}`)
      await setPrunedBefore(tx, isoDay(Date.parse(`${day}T00:00:00Z`) + DAY_MS))
    }
  })
}

/** Brings the rollups of whole UTC days (`YYYY-MM-DD`) up to date from the per-call rows. */
export async function rollupInferenceUsageDays(days: string[]): Promise<void> {
  for (const day of [...new Set(days)].sort()) await processDay(day, false)
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
 * Hourly: keep yesterday's and today's rollups current, and bring any recent day that got rows after its
 * rollup was built up to date. The first run rolls up every day that has rows.
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
 * Rolls up and deletes the per-call rows of every day before the retention cutoff, oldest first, one day
 * per transaction, moving the watermark with them. Returns how many days were processed.
 */
export async function pruneInferenceUsage(options: { now?: Date; retentionDays?: number } = {}): Promise<number> {
  const now = options.now ?? new Date()
  const cutoff = detailCutoff(now, options.retentionDays ?? inferenceRetentionDays())
  // After retention is raised the watermark can be past the cutoff: rows that land before it still get flushed.
  const watermark = await prunedBefore()
  const before =
    watermark && Date.parse(`${watermark}T00:00:00Z`) > cutoff.getTime() ? new Date(`${watermark}T00:00:00Z`) : cutoff
  const days = await detailDaysBefore(before)
  for (const day of days) await processDay(day, true)
  if (days.length > 0)
    log.info(`Pruned inference usage rows for ${days.length} day(s) before ${isoDay(cutoff.getTime())}`)
  return days.length
}
