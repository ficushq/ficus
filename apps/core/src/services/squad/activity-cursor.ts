import { createHash } from 'node:crypto'
import { SQUAD_ACTIVITY_LANES, type SquadActivityKind, type SquadActivityLane } from '@ficus/shared'

export class InvalidActivityCursorError extends Error {}
export class ActivityCursorExpiredError extends Error {}

export interface ActivityCursorContext {
  squadId: string
  verbose: boolean
  agentIds: string[]
  kinds: readonly (SquadActivityKind | string)[]
}
export interface ActivityCursorKeyset {
  at: Date
  lane: SquadActivityLane
  rowId: string
  retentionFloor: Date
}
const HEX_64 = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const lanes = new Set<number>(SQUAD_ACTIVITY_LANES)
const unique = (values: readonly string[]) => [...new Set(values)].sort()

export function activityRetentionFloor(now: Date): Date {
  const floor = new Date(now)
  floor.setUTCDate(floor.getUTCDate() - 30)
  floor.setUTCHours(0, 0, 0, 0)
  return floor
}
const digest = (context: ActivityCursorContext, floor: Date) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        squadId: context.squadId,
        verbose: context.verbose,
        agentIds: unique(context.agentIds),
        kinds: unique(context.kinds),
        retentionFloor: floor.toISOString(),
      })
    )
    .digest('hex')

export function encodeActivityCursor(keyset: ActivityCursorKeyset, context: ActivityCursorContext): string {
  return Buffer.from(
    JSON.stringify({
      v: 2,
      at: keyset.at.toISOString(),
      lane: keyset.lane,
      rowId: keyset.rowId,
      retentionFloor: keyset.retentionFloor.toISOString(),
      queryDigest: digest(context, keyset.retentionFloor),
    })
  ).toString('base64url')
}
/**
 * Global (cross-squad) cursor context/keyset: same shape as the per-squad cursor
 * plus `squadIds` (the accessible-squad set the caller resolved, standing in for
 * `squadId`) and `squadId` as an extra keyset tiebreaker column (global rows are
 * ordered `at, squad_id, lane, row_id`). A distinct key set (`v:1`, adds
 * `squadId`) means a per-squad cursor can never decode here and vice versa —
 * decode fails closed on `invalid-cursor` rather than silently misreading fields.
 */
export interface GlobalActivityCursorContext {
  squadIds: string[]
  verbose: boolean
  agentIds: string[]
  kinds: readonly (SquadActivityKind | string)[]
}
export interface GlobalActivityCursorKeyset {
  at: Date
  squadId: string
  lane: SquadActivityLane
  rowId: string
  retentionFloor: Date
}
const globalDigest = (context: GlobalActivityCursorContext, floor: Date) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        squadIds: unique(context.squadIds),
        verbose: context.verbose,
        agentIds: unique(context.agentIds),
        kinds: unique(context.kinds),
        retentionFloor: floor.toISOString(),
      })
    )
    .digest('hex')

export function encodeGlobalActivityCursor(
  keyset: GlobalActivityCursorKeyset,
  context: GlobalActivityCursorContext
): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      at: keyset.at.toISOString(),
      squadId: keyset.squadId,
      lane: keyset.lane,
      rowId: keyset.rowId,
      retentionFloor: keyset.retentionFloor.toISOString(),
      queryDigest: globalDigest(context, keyset.retentionFloor),
    })
  ).toString('base64url')
}

export function decodeGlobalActivityCursor(
  encoded: string,
  context: GlobalActivityCursorContext
): GlobalActivityCursorKeyset {
  if (!encoded || encoded.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(encoded))
    throw new InvalidActivityCursorError('invalid-cursor')
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new InvalidActivityCursorError('invalid-cursor')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InvalidActivityCursorError('invalid-cursor')
  const cursor = value as Record<string, unknown>
  if (
    Object.keys(cursor).sort().join(',') !== 'at,lane,queryDigest,retentionFloor,rowId,squadId,v' ||
    cursor.v !== 1 ||
    typeof cursor.at !== 'string' ||
    typeof cursor.retentionFloor !== 'string' ||
    typeof cursor.squadId !== 'string' ||
    !UUID.test(cursor.squadId) ||
    typeof cursor.lane !== 'number' ||
    !Number.isInteger(cursor.lane) ||
    !lanes.has(cursor.lane) ||
    typeof cursor.rowId !== 'string' ||
    !UUID.test(cursor.rowId) ||
    typeof cursor.queryDigest !== 'string' ||
    !HEX_64.test(cursor.queryDigest)
  )
    throw new InvalidActivityCursorError('invalid-cursor')
  const at = new Date(cursor.at),
    retentionFloor = new Date(cursor.retentionFloor)
  if (
    Number.isNaN(at.valueOf()) ||
    at.toISOString() !== cursor.at ||
    Number.isNaN(retentionFloor.valueOf()) ||
    retentionFloor.toISOString() !== cursor.retentionFloor ||
    retentionFloor.getUTCHours() !== 0 ||
    cursor.queryDigest !== globalDigest(context, retentionFloor)
  )
    throw new InvalidActivityCursorError('invalid-cursor')
  return {
    at,
    squadId: cursor.squadId,
    lane: cursor.lane as SquadActivityLane,
    rowId: cursor.rowId,
    retentionFloor,
  }
}

export function decodeActivityCursor(
  encoded: string,
  context: ActivityCursorContext,
  currentFloor?: Date
): ActivityCursorKeyset {
  if (!encoded || encoded.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(encoded))
    throw new InvalidActivityCursorError('invalid-cursor')
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new InvalidActivityCursorError('invalid-cursor')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InvalidActivityCursorError('invalid-cursor')
  const cursor = value as Record<string, unknown>
  if (
    Object.keys(cursor).sort().join(',') !== 'at,lane,queryDigest,retentionFloor,rowId,v' ||
    cursor.v !== 2 ||
    typeof cursor.at !== 'string' ||
    typeof cursor.retentionFloor !== 'string' ||
    typeof cursor.lane !== 'number' ||
    !Number.isInteger(cursor.lane) ||
    !lanes.has(cursor.lane) ||
    typeof cursor.rowId !== 'string' ||
    !UUID.test(cursor.rowId) ||
    typeof cursor.queryDigest !== 'string' ||
    !HEX_64.test(cursor.queryDigest)
  )
    throw new InvalidActivityCursorError('invalid-cursor')
  const at = new Date(cursor.at),
    retentionFloor = new Date(cursor.retentionFloor)
  if (
    Number.isNaN(at.valueOf()) ||
    at.toISOString() !== cursor.at ||
    Number.isNaN(retentionFloor.valueOf()) ||
    retentionFloor.toISOString() !== cursor.retentionFloor ||
    retentionFloor.getUTCHours() !== 0 ||
    cursor.queryDigest !== digest(context, retentionFloor)
  )
    throw new InvalidActivityCursorError('invalid-cursor')
  if (currentFloor && currentFloor.toISOString() !== retentionFloor.toISOString())
    throw new ActivityCursorExpiredError('activity-cursor-expired')
  return { at, lane: cursor.lane as SquadActivityLane, rowId: cursor.rowId, retentionFloor }
}
