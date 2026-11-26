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
 * estimated: a question whose answering agent was not recorded (before migration 0264, or closed by
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

/** The `squad_activity` rows behind one settled count, from `since` on. */
export function settledRowSql(kind: ActivitySettledKind, since: Date): SQL {
  const from = sql`squad_activity.at>=${since.toISOString()}::timestamptz`
  if (kind === 'reviews') return sql`(squad_activity.lane=32 AND ${from})`
  if (kind === 'questions')
    return sql`(squad_activity.lane=41 AND ${from} AND EXISTS (SELECT 1 FROM work_stream_waits settled_wait
      WHERE settled_wait.id=squad_activity.row_id AND ${settledQuestionWaitSql(sql`settled_wait`)}))`
  return sql`(squad_activity.lane=31 AND ${from} AND EXISTS (SELECT 1 FROM inbox settled_notice
    WHERE settled_notice.id=squad_activity.row_id AND settled_notice.metadata->>'event'='done'))`
}

/** Counts for the Feed's line, over the squads and row scopes the viewer may read. */
export async function countSettledActivity(
  squadAccess: GlobalActivitySquadAccess[],
  requestedSince: Date,
  now = new Date()
): Promise<ActivitySettledSummary> {
  const { since, clamped } = settledPeriodStart(requestedSince, now)
  const counts = { questions: 0, reviews: 0, completed: 0 }
  if (squadAccess.length > 0) {
    const [row] = await db.execute<{ questions: number; reviews: number; completed: number }>(sql`
      WITH squad_access(squad_id,agents_read,workstreams_read,inbox_all,own_recipient_id) AS (
        VALUES ${globalActivityAccessRowsSql(squadAccess)}
      )
      SELECT count(*) FILTER (WHERE ${settledRowSql('questions', since)})::int questions,
        count(*) FILTER (WHERE ${settledRowSql('reviews', since)})::int reviews,
        count(DISTINCT squad_activity.work_stream_id) FILTER (WHERE ${settledRowSql('completed', since)})::int completed
      FROM squad_activity JOIN squad_access ON squad_activity.squad_id=squad_access.squad_id
      WHERE squad_activity.lane IN (31,32,41) AND squad_activity.at>=${since.toISOString()}::timestamptz
        AND ${globalActivityAccessPredicateSql}`)
    Object.assign(counts, row)
  }
  return { since: since.toISOString(), clamped, counts }
}
