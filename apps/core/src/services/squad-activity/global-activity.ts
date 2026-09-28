import { addWorkReferences } from './work-references'
import { sql } from 'drizzle-orm'
import { db } from '../../db'
import { coerceSquadActivityRef } from '@ficus/shared'
import type { GlobalSquadActivityItem, SquadActivityKind } from '@ficus/shared'
import { shapeActivityPage, type SquadActivityAccess } from '../squad/activity'
import {
  decodeGlobalActivityCursor,
  encodeGlobalActivityCursor,
  type GlobalActivityCursorContext,
} from '../squad/activity-cursor'

export interface GlobalActivitySquadAccess {
  squadId: string
  access: SquadActivityAccess
}

export interface ProjectGlobalActivityInput {
  limit: number
  verbose: boolean
  agentIds: string[]
  kinds: readonly SquadActivityKind[]
  cursor?: string | null
  /** Every squad the caller may see rows from, with that squad's own resolved access. */
  squadAccess: GlobalActivitySquadAccess[]
}

export interface ProjectGlobalActivityResult {
  items: GlobalSquadActivityItem[]
  hasMore: boolean
  nextCursor: string | null
}

type GlobalRow = Record<string, unknown> & {
  retention_floor: Date | string
  squad_id: string | null
  lane: number | null
  row_id: string | null
  at: Date | string | null
  agent_id: string | null
  agent_type_id: string | null
  kind: SquadActivityKind
  summary: string
  preview: GlobalSquadActivityItem['preview']
  ref: GlobalSquadActivityItem['ref']
}

/**
 * Cross-squad sibling of projectSquadActivity (services/squad/activity.ts):
 * same indexed `squad_activity` projection, generalized to many
 * {squadId, access} pairs at once via a joined VALUES table instead of a
 * single scalar access input. Shares that function's row-shaping tail
 * (`shapeActivityPage`) byte-for-byte — retention-floor expiry, hasMore, page
 * slicing all behave identically; only the WHERE clause (and the
 * squad_id-tiebroken ORDER BY / cursor) differ, because access here is
 * per-squad rather than a single scalar.
 */
export async function projectGlobalActivity(input: ProjectGlobalActivityInput): Promise<ProjectGlobalActivityResult> {
  const context: GlobalActivityCursorContext = {
    squadIds: input.squadAccess.map((entry) => entry.squadId),
    verbose: input.verbose,
    agentIds: input.agentIds,
    kinds: input.kinds,
  }
  // Cursor validation always runs, even with zero accessible squads — an
  // invalid/malformed cursor is a client error regardless of what the caller
  // can see, mirroring the per-squad route's error-before-access-check order.
  const cursor =
    input.cursor !== undefined && input.cursor !== null ? decodeGlobalActivityCursor(input.cursor, context) : null
  if (input.squadAccess.length === 0) return { items: [], hasMore: false, nextCursor: null }

  const accessRows = input.squadAccess.map(({ squadId, access }) => {
    const inboxAll = access.inbox.mode === 'all'
    const ownRecipient = access.inbox.mode === 'own' ? access.inbox.recipientId : null
    return sql`(${squadId}::uuid,${access.agentsRead},${access.workstreamsRead},${inboxAll},${ownRecipient}::uuid)`
  })

  const rows = await db.execute<GlobalRow>(sql`
    WITH params AS (
      SELECT date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        - interval '30 days' retention_floor
    ), squad_access(squad_id,agents_read,workstreams_read,inbox_all,own_recipient_id) AS (
      VALUES ${sql.join(accessRows, sql`,`)}
    ), page AS (
      SELECT squad_activity.squad_id,lane,row_id,date_trunc('milliseconds',at) at,
        agent_id,CASE WHEN agent_type_requires_agents_read AND NOT squad_access.agents_read THEN NULL ELSE agent_type_id END agent_type_id,
        kind,summary,preview,ref
      FROM squad_activity
      JOIN squad_access ON squad_activity.squad_id=squad_access.squad_id
      CROSS JOIN params
      WHERE at>=params.retention_floor
        AND ((access_scope='agents' AND squad_access.agents_read)
          OR (access_scope='workstreams' AND squad_access.workstreams_read)
          OR (access_scope='inbox' AND (squad_access.inbox_all OR inbox_recipient_id=squad_access.own_recipient_id))
          OR (access_scope='workstreams_inbox' AND squad_access.workstreams_read AND (squad_access.inbox_all OR inbox_recipient_id=squad_access.own_recipient_id)))
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
        AND ${
          !cursor
            ? sql`TRUE`
            : sql`(at<${cursor.at.toISOString()}::timestamptz OR (at=${cursor.at.toISOString()}::timestamptz AND (squad_activity.squad_id<${cursor.squadId}::uuid OR (squad_activity.squad_id=${cursor.squadId}::uuid AND (lane<${cursor.lane} OR (lane=${cursor.lane} AND row_id<${cursor.rowId}::uuid))))))`
        }
      ORDER BY at DESC NULLS LAST,squad_activity.squad_id DESC NULLS LAST,lane DESC NULLS LAST,row_id DESC NULLS LAST
      LIMIT ${input.limit + 1}
    )
    SELECT params.retention_floor,page.* FROM params LEFT JOIN page ON true
    ORDER BY page.at DESC NULLS LAST,page.squad_id DESC NULLS LAST,page.lane DESC NULLS LAST,page.row_id DESC NULLS LAST
  `)

  const { retentionFloor, selected, hasMore } = shapeActivityPage(rows, input.limit, cursor?.retentionFloor)
  const items: GlobalSquadActivityItem[] = selected.map((row) => ({
    id: `${row.lane}:${row.row_id}`,
    at: new Date(row.at).toISOString(),
    agentId: row.agent_id,
    agentTypeId: row.agent_type_id,
    kind: row.kind,
    summary: row.summary,
    preview: row.preview,
    ref: coerceSquadActivityRef(row.ref),
    squadId: row.squad_id as string,
  }))
  const last = selected.at(-1)
  return {
    items: await addWorkReferences(items),
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeGlobalActivityCursor(
            {
              at: new Date(last.at),
              squadId: last.squad_id as string,
              lane: last.lane as any,
              rowId: last.row_id,
              retentionFloor,
            },
            context
          )
        : null,
  }
}
