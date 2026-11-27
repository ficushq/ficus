import { sql, type SQL } from 'drizzle-orm'
import type { ActivitySettledKind, ActivitySettledSummary } from '@ficus/shared'
import { db } from '../../db'
import { activityRetentionFloor } from '../squad/activity-cursor'
import {
  globalActivityAccessRowsSql,
  globalActivityAccessPredicateSql,
  type GlobalActivitySquadAccess,
} from './global-activity'

/**
 * Work settled without a person, counted only from recorded Activity rows, so each count is exactly
 * the rows `GET /api/activity?settled=<kind>&since=<time>` lists for the same viewer. Nothing is
 * estimated: a question whose answering agent was not recorded (before migration 0265, or closed by
 * any path other than the owner's input decision) is not counted.
 */

/** The period actually counted: the requested start, raised to the oldest day Activity still keeps. */
export function settledPeriodStart(requested: Date, now = new Date()): { since: Date; clamped: boolean } {
  const floor = activityRetentionFloor(now)
  return requested < floor ? { since: floor, clamped: true } : { since: requested, clamped: false }
}

/**
 * A task input an agent asked of its stream owner (`request-input` with `actor: owner`) and a
 * different agent answered through the input decision. Only the owner agent (the squad manager when
 * the stream has none) can answer such a wait, and it never reaches a person's Needs you; a wait
 * whose actor was ever corrected to or from `human` may have, so it is left out.
 */
export function settledQuestionWaitSql(wait: SQL): SQL {
  return sql`${wait}.type='manual' AND ${wait}.structured IS NOT NULL
    AND ${wait}.structured->'request'->>'kind'<>'continue'
    AND ${wait}.actor='owner' AND ${wait}.closed_at IS NOT NULL
    AND ${wait}.created_by_agent_id IS NOT NULL AND ${wait}.resolved_by_agent_id IS NOT NULL
    AND ${wait}.resolved_by_agent_id<>${wait}.created_by_agent_id
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${wait}.actor_changes)='array'
        THEN ${wait}.actor_changes ELSE '[]'::jsonb END) change
      WHERE change->>'from'='human' OR change->>'to'='human')`
}

/**
 * The `squad_activity` rows behind one settled count, from `since` on. Each kind names its row
 * `kind` as well as its lane, so the scan seeks `idx_squad_activity_kind` (squad, kind, time) rather
 * than walking every row of the period in `idx_squad_activity_feed`.
 */
export function settledRowSql(kind: ActivitySettledKind, since: Date): SQL {
  const from = sql`squad_activity.at>=${since.toISOString()}::timestamptz`
  if (kind === 'reviews') return sql`(squad_activity.kind='workstream' AND squad_activity.lane=32 AND ${from})`
  return sql`(squad_activity.kind='wait' AND squad_activity.lane=41 AND ${from} AND EXISTS (SELECT 1 FROM work_stream_waits settled_wait
      WHERE settled_wait.id=squad_activity.row_id AND ${settledQuestionWaitSql(sql`settled_wait`)}))`
}

/**
 * The count query, exported for its scan-cost test. It counts up to `through`, the database clock
 * when it ran (to the millisecond, so the ISO string round-trips exactly) and returns that time: a
 * Feed visit records it, so the next visit starts where these counts ended, with nothing counted
 * twice and nothing skipped.
 */
export function settledCountSql(squadAccess: GlobalActivitySquadAccess[], since: Date): SQL {
  // In the counts' filters rather than the scan's WHERE: an upper bound the planner cannot see
  // until the query runs makes it misjudge the period and walk it through the feed index.
  const before = sql`squad_activity.at<(SELECT through FROM params)`
  return sql`
    WITH params AS MATERIALIZED (
      SELECT date_trunc('milliseconds',clock_timestamp()) through
    ), squad_access(squad_id,agents_read,workstreams_read,inbox_all,own_recipient_id) AS (
      VALUES ${globalActivityAccessRowsSql(squadAccess)}
    )
    SELECT to_char((SELECT through FROM params) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') through,
      count(*) FILTER (WHERE ${settledRowSql('questions', since)} AND ${before})::int questions,
      count(*) FILTER (WHERE ${settledRowSql('reviews', since)} AND ${before})::int reviews
    FROM squad_activity JOIN squad_access ON squad_activity.squad_id=squad_access.squad_id
    WHERE squad_activity.kind IN ('wait','workstream') AND squad_activity.lane IN (32,41)
      AND squad_activity.at>=${since.toISOString()}::timestamptz
      AND ${globalActivityAccessPredicateSql}`
}

/** Counts for the Feed's line, over the squads and row scopes the viewer may read. */
export async function countSettledActivity(
  squadAccess: GlobalActivitySquadAccess[],
  requestedSince: Date,
  now = new Date()
): Promise<ActivitySettledSummary> {
  const { since, clamped } = settledPeriodStart(requestedSince, now)
  if (squadAccess.length === 0) {
    return { since: since.toISOString(), clamped, through: now.toISOString(), counts: { questions: 0, reviews: 0 } }
  }
  const [row] = await db.execute<{ through: string; questions: number; reviews: number }>(
    settledCountSql(squadAccess, since)
  )
  return {
    since: since.toISOString(),
    clamped,
    through: row!.through,
    counts: { questions: row!.questions, reviews: row!.reviews },
  }
}
