import { addWorkReferences } from '../squad-activity/work-references'
import { sql } from 'drizzle-orm'
import { db } from '../../db'
import { coerceSquadActivityRef } from '@ficus/shared'
import type { SquadActivityItem, SquadActivityKind, SquadActivityPage } from '@ficus/shared'
import {
  ActivityCursorExpiredError,
  decodeActivityCursor,
  encodeActivityCursor,
  type ActivityCursorContext,
} from './activity-cursor'
export { firstLineSummary } from '../squad-activity/extractors'

export interface SquadActivityAccess {
  agentsRead: boolean
  workstreamsRead: boolean
  inbox: { mode: 'all' } | { mode: 'own'; recipientId: string } | { mode: 'none' }
}
export interface ProjectSquadActivityInput extends ActivityCursorContext {
  limit: number
  access: SquadActivityAccess
  cursor?: string | null
}
type Row = Record<string, unknown> & {
  retention_floor: Date | string
  lane: number | null
  row_id: string | null
  at: Date | string | null
  agent_id: string | null
  agent_type_id: string | null
  kind: SquadActivityKind
  summary: string
  preview: SquadActivityItem['preview']
  ref: SquadActivityItem['ref']
}

interface RawActivityRow {
  retention_floor: Date | string
  lane: number | null
  row_id: string | null
  at: Date | string | null
}

/**
 * Shared pagination trailer for the indexed activity projections (per-squad and
 * global — see services/squad-activity/global-activity.ts): validates the
 * cursor's retention floor hasn't rolled forward since it was issued (the "LEFT
 * JOIN page ON true" query shape always yields exactly one row even with zero
 * matches, so `rows[0]` is always present), slices the fetched rows to the page
 * limit, and reports whether more remain. Both callers still build/execute
 * their own SQL — the WHERE clause differs (a scalar access check vs a joined
 * per-squad VALUES table) — this is the row-shaping tail they share byte-for-byte.
 */
export function shapeActivityPage<R extends RawActivityRow>(
  rows: R[],
  limit: number,
  cursorRetentionFloor?: Date | null
): {
  retentionFloor: Date
  selected: (R & { lane: number; row_id: string; at: Date | string })[]
  hasMore: boolean
} {
  const retentionFloor = new Date(rows[0].retention_floor)
  if (cursorRetentionFloor && cursorRetentionFloor.toISOString() !== retentionFloor.toISOString())
    throw new ActivityCursorExpiredError('activity-cursor-expired')
  const pageRows = rows.filter(
    (row): row is R & { lane: number; row_id: string; at: Date | string } =>
      row.row_id !== null && row.lane !== null && row.at !== null
  )
  const hasMore = pageRows.length > limit
  const selected = pageRows.slice(0, limit)
  return { retentionFloor, selected, hasMore }
}

/** One indexed projection query. Source tables are never consulted by the serving path. */
export async function projectSquadActivity(input: ProjectSquadActivityInput): Promise<SquadActivityPage> {
  if (!input.access) throw new Error('Squad activity access is required')
  const cursor = input.cursor !== undefined && input.cursor !== null ? decodeActivityCursor(input.cursor, input) : null
  const inboxAll = input.access.inbox.mode === 'all'
  const ownRecipient = input.access.inbox.mode === 'own' ? input.access.inbox.recipientId : null
  const rows = await db.execute<Row>(sql`
    WITH params AS (
      SELECT date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        - interval '30 days' retention_floor
    ), page AS (
      SELECT lane,row_id,date_trunc('milliseconds',at) at,
        agent_id,CASE WHEN agent_type_requires_agents_read AND NOT ${input.access.agentsRead} THEN NULL ELSE agent_type_id END agent_type_id,
        kind,summary,preview,ref
      FROM squad_activity,params
      WHERE squad_id=${input.squadId}::uuid AND at>=params.retention_floor
        AND ((access_scope='agents' AND ${input.access.agentsRead})
          OR (access_scope='workstreams' AND ${input.access.workstreamsRead})
          OR (access_scope='inbox' AND (${inboxAll} OR inbox_recipient_id=${ownRecipient}::uuid))
          OR (access_scope='workstreams_inbox' AND ${input.access.workstreamsRead} AND (${inboxAll} OR inbox_recipient_id=${ownRecipient}::uuid)))
        AND (${input.verbose} OR quiet_eligible)
        AND ${
          input.kinds.length === 0
            ? sql`TRUE`
            : sql`kind IN (${sql.join(
                input.kinds.map((kind) => sql`${kind}`),
                sql`,`
              )})`
        }
        AND ${
          input.agentIds.length === 0
            ? sql`TRUE`
            : sql`agent_id IN (${sql.join(
                input.agentIds.map((id) => sql`${id}::uuid`),
                sql`,`
              )})`
        }
        AND ${!cursor ? sql`TRUE` : sql`(at<${cursor.at.toISOString()}::timestamptz OR (at=${cursor.at.toISOString()}::timestamptz AND (lane<${cursor.lane} OR (lane=${cursor.lane} AND row_id<${cursor.rowId}::uuid))))`}
      ORDER BY at DESC NULLS LAST,lane DESC NULLS LAST,row_id DESC NULLS LAST LIMIT ${input.limit + 1}
    )
    SELECT params.retention_floor,page.* FROM params LEFT JOIN page ON true
    ORDER BY page.at DESC NULLS LAST,page.lane DESC NULLS LAST,page.row_id DESC NULLS LAST
  `)
  const { retentionFloor, selected, hasMore } = shapeActivityPage(rows, input.limit, cursor?.retentionFloor)
  const items: SquadActivityItem[] = selected.map((row) => ({
    id: `${row.lane}:${row.row_id}`,
    at: new Date(row.at).toISOString(),
    agentId: row.agent_id,
    agentTypeId: row.agent_type_id,
    kind: row.kind,
    summary: row.summary,
    preview: row.preview,
    ref: coerceSquadActivityRef(row.ref),
  }))
  const last = selected.at(-1)
  return {
    items: await addWorkReferences(items),
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeActivityCursor(
            { at: new Date(last.at), lane: last.lane as any, rowId: last.row_id, retentionFloor },
            input
          )
        : null,
  }
}
