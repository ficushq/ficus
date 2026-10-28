import { createHash } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db, slotPools, squads } from '../../db'
import {
  SLOT_KEY_PATTERN,
  SlotServiceError,
  type SlotHistoryItem,
  type SlotHistoryPage,
  type SlotViewer,
} from './types'

export const DEFAULT_SLOT_HISTORY_LIMIT = 50
export const MAX_SLOT_HISTORY_LIMIT = 100
const MIN_SORT_AT = new Date('0001-01-01T00:00:00.000Z')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX_64 = /^[0-9a-f]{64}$/

type SlotHistoryKind = SlotHistoryItem['kind']
type Visibility = `agent:${string}` | 'diagnostics' | 'none'
interface CursorKeyset {
  sortAt: Date
  kind: SlotHistoryKind
  id: string
}
interface HistoryRow extends Record<string, unknown> {
  kind: SlotHistoryKind
  kind_order: number
  id: string
  owner_agent_id: string
  status: string
  reason: string | null
  ended_at: Date | string | null
  sort_at: Date | string
}

function visibilityFor(viewer: SlotViewer): Visibility {
  if (viewer.diagnostics) return 'diagnostics'
  return viewer.agentId ? `agent:${viewer.agentId}` : 'none'
}

function cursorDigest(poolId: string, visibility: Visibility): string {
  return createHash('sha256').update(JSON.stringify({ poolId, visibility })).digest('hex')
}

function invalidCursor(): SlotServiceError {
  return new SlotServiceError('invalid_cursor', 'Invalid slot history cursor.', 400)
}

function encodeCursor(keyset: CursorKeyset, poolId: string, visibility: Visibility): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      sortAt: keyset.sortAt.toISOString(),
      kind: keyset.kind,
      id: keyset.id,
      context: cursorDigest(poolId, visibility),
    })
  ).toString('base64url')
}

function decodeCursor(encoded: string, poolId: string, visibility: Visibility): CursorKeyset {
  if (!encoded || encoded.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw invalidCursor()
  let decoded: Buffer
  let value: unknown
  try {
    decoded = Buffer.from(encoded, 'base64url')
    if (decoded.toString('base64url') !== encoded) throw invalidCursor()
    value = JSON.parse(decoded.toString('utf8'))
  } catch {
    throw invalidCursor()
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidCursor()
  const cursor = value as Record<string, unknown>
  if (
    Object.keys(cursor).sort().join(',') !== 'context,id,kind,sortAt,v' ||
    cursor.v !== 1 ||
    typeof cursor.sortAt !== 'string' ||
    typeof cursor.kind !== 'string' ||
    (cursor.kind !== 'claim' && cursor.kind !== 'waiter') ||
    typeof cursor.id !== 'string' ||
    !UUID.test(cursor.id) ||
    typeof cursor.context !== 'string' ||
    !HEX_64.test(cursor.context)
  ) {
    throw invalidCursor()
  }
  const sortAt = new Date(cursor.sortAt)
  if (
    Number.isNaN(sortAt.valueOf()) ||
    sortAt.toISOString() !== cursor.sortAt ||
    cursor.context !== cursorDigest(poolId, visibility)
  ) {
    throw invalidCursor()
  }
  return { sortAt, kind: cursor.kind, id: cursor.id }
}

function validatedLimit(limit: number | undefined): number {
  const result = limit ?? DEFAULT_SLOT_HISTORY_LIMIT
  if (!Number.isInteger(result) || result < 1 || result > MAX_SLOT_HISTORY_LIMIT) {
    throw new SlotServiceError(
      'invalid_history_limit',
      `Slot history limit must be between 1 and ${MAX_SLOT_HISTORY_LIMIT}.`,
      400
    )
  }
  return result
}

export async function listSlotHistory(
  squadId: string,
  key: string,
  viewer: SlotViewer,
  options: { limit?: number; cursor?: string } = {}
): Promise<SlotHistoryPage> {
  const normalizedKey = key.trim().toLowerCase()
  if (!SLOT_KEY_PATTERN.test(normalizedKey)) {
    throw new SlotServiceError('invalid_slot_key', 'Invalid slot pool key.', 400)
  }
  const limit = validatedLimit(options.limit)
  const [pool] = await db
    .select({ id: slotPools.id })
    .from(slotPools)
    .innerJoin(squads, and(eq(squads.id, slotPools.squadId), isNull(squads.archivedAt)))
    .where(and(eq(slotPools.squadId, squadId), eq(slotPools.key, normalizedKey), isNull(slotPools.unregisteredAt)))
    .limit(1)
  if (!pool) throw new SlotServiceError('pool_not_found', `Slot pool "${normalizedKey}" was not found.`, 404)

  const visibility = visibilityFor(viewer)
  const cursor = options.cursor ? decodeCursor(options.cursor, pool.id, visibility) : null
  if (visibility === 'none') return { items: [], hasMore: false, nextCursor: null }
  const ownerAgentId = viewer.diagnostics ? null : viewer.agentId!
  const cursorKindOrder = cursor?.kind === 'claim' ? 1 : 0

  const rows = await db.execute<HistoryRow>(sql`
    WITH terminal_history AS (
      SELECT 'claim'::text kind, 1 kind_order, id, owner_agent_id, status::text status,
        terminal_reason reason, ended_at,
        COALESCE(ended_at, TIMESTAMPTZ '0001-01-01T00:00:00Z') sort_at
      FROM slot_claims
      WHERE pool_id=${pool.id}::uuid AND status<>'active'
        AND ${ownerAgentId ? sql`owner_agent_id=${ownerAgentId}::uuid` : sql`TRUE`}
      UNION ALL
      SELECT 'waiter'::text kind, 0 kind_order, id, owner_agent_id, status::text status,
        terminal_reason reason, ended_at,
        COALESCE(ended_at, TIMESTAMPTZ '0001-01-01T00:00:00Z') sort_at
      FROM slot_waiters
      WHERE pool_id=${pool.id}::uuid AND status<>'queued'
        AND ${ownerAgentId ? sql`owner_agent_id=${ownerAgentId}::uuid` : sql`TRUE`}
    )
    SELECT kind,kind_order,id::text id,owner_agent_id::text owner_agent_id,status,reason,ended_at,sort_at
    FROM terminal_history
    WHERE ${
      cursor
        ? sql`(sort_at<${cursor.sortAt.toISOString()}::timestamptz OR
          (sort_at=${cursor.sortAt.toISOString()}::timestamptz AND
            (kind_order<${cursorKindOrder} OR (kind_order=${cursorKindOrder} AND id<${cursor.id}::uuid))))`
        : sql`TRUE`
    }
    ORDER BY sort_at DESC,kind_order DESC,id DESC
    LIMIT ${limit + 1}
  `)
  const hasMore = rows.length > limit
  const selected = rows.slice(0, limit)
  const items = selected.map((row): SlotHistoryItem => ({
    kind: row.kind,
    id: row.id,
    ownerAgentId: row.owner_agent_id,
    ownerShortId: row.owner_agent_id.slice(0, 8),
    status: row.status,
    reason: row.reason,
    endedAt: row.ended_at === null ? null : new Date(row.ended_at),
  }))
  const last = selected.at(-1)
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor(
            { sortAt: last.sort_at ? new Date(last.sort_at) : MIN_SORT_AT, kind: last.kind, id: last.id },
            pool.id,
            visibility
          )
        : null,
  }
}
