import { listedAssistantConversation } from './assistant-conversation-query'
import { sql, type SQL } from 'drizzle-orm'
import { entitySearchQuerySchema, type EntitySearchResult } from '@ficus/shared'
import { db, squads, workStreams, agents, assistantConversations } from '../db'
import {
  getAccessibleSquadIds,
  hasPermission,
  resolveActingUser,
  resolvePermissionSquadScope,
  type Identity,
  type PermissionSquadScope,
} from './rbac'

export function withinScope(column: SQL, scope: PermissionSquadScope): SQL {
  if (scope.kind === 'some')
    return scope.squadIds.length
      ? sql`${column} IN (${sql.join(
          scope.squadIds.map((id) => sql`${id}::uuid`),
          sql`, `
        )})`
      : sql`false`
  return scope.excludedSquadIds.length
    ? sql`${column} NOT IN (${sql.join(
        scope.excludedSquadIds.map((id) => sql`${id}::uuid`),
        sql`, `
      )})`
    : sql`true`
}
const literalLike = (value: string) => value.replace(/[\\%_]/g, '\\$&')

export async function searchEntities(identity: Identity, request: unknown) {
  const input = entitySearchQuerySchema.parse(request)
  const actingUser = await resolveActingUser(identity)
  const effectiveIdentity = actingUser ?? identity
  const [accessible, squadScope, workScope, agentScope, canReadChats] = await Promise.all([
    getAccessibleSquadIds(identity),
    resolvePermissionSquadScope(effectiveIdentity, 'squads:read'),
    resolvePermissionSquadScope(effectiveIdentity, 'workstreams:read'),
    resolvePermissionSquadScope(effectiveIdentity, 'agents:read'),
    actingUser ? hasPermission(identity, 'chat:send') : false,
  ])
  const visible =
    accessible === 'all' ? sql`true` : withinScope(sql`${squads.id}`, { kind: 'some', squadIds: accessible })
  const squadFilter = input.squadId ? sql`${squads.id} = ${input.squadId}::uuid` : sql`true`
  const parts = [
    sql`SELECT 'squad'::text AS kind, ${squads.id} AS id, ${squads.name}::text AS label,
      ${squads.purpose} AS detail, ${squads.id} AS "squadId", ${squads.name}::text AS "squadName",
      ${squads.status}::text AS status, ${squads.updatedAt}::timestamptz AS "updatedAt", NULL::integer AS number
      FROM ${squads} WHERE ${visible} AND ${squadFilter} AND ${withinScope(sql`${squads.id}`, squadScope)}`,
    sql`SELECT 'work_stream', ${workStreams.id}, ${workStreams.title}::text, ${workStreams.description},
      ${squads.id}, ${squads.name}::text, ${workStreams.status}::text, ${workStreams.updatedAt}::timestamptz, ${workStreams.number}
      FROM ${workStreams} JOIN ${squads} ON ${squads.id} = ${workStreams.squadId}
      WHERE ${visible} AND ${squadFilter} AND ${withinScope(sql`${squads.id}`, workScope)}`,
    sql`SELECT 'consultant_conversation', ${agents.id},
      COALESCE(NULLIF(trim(${agents.metadata}->>'purpose'), ''), NULLIF(trim(${agents.metadata}->>'name'), ''), 'Consultant'),
      COALESCE(${agents.metadata}->>'name', ''), ${squads.id}, ${squads.name}::text,
      ${agents.status}::text, ${agents.updatedAt}::timestamptz, NULL::integer
      FROM ${agents} JOIN ${squads} ON ${squads.id} = ${agents.squadId}
      WHERE ${agents.agentTypeId} = 'consultant' AND ${agents.status} NOT IN ('dormant', 'terminated')
      AND (${agents.ownerUserId} IS NULL OR ${agents.ownerUserId} = ${actingUser?.userId ?? null}::uuid)
      AND ${visible} AND ${squadFilter} AND ${withinScope(sql`${squads.id}`, agentScope)}`,
    sql`SELECT 'assistant_conversation', ${assistantConversations.id}, ${assistantConversations.title},
      ''::text, NULL::uuid, NULL::text, NULL::text, ${assistantConversations.updatedAt}, NULL::integer
      FROM ${assistantConversations} WHERE ${canReadChats} AND ${!input.squadId} AND (${listedAssistantConversation()})
      AND ${assistantConversations.ownerUserId} = ${actingUser?.userId ?? null}::uuid`,
  ]
  const terms = input.q.toLowerCase().split(/\s+/)
  const words = terms.map((term) => sql`haystack ILIKE ${`%${literalLike(term)}%`}`)
  const labelWords = terms.map((term) => sql`label ILIKE ${`%${literalLike(term)}%`}`)
  const rows = await db.execute<EntitySearchResult & Record<string, unknown>>(sql`
    WITH candidates AS (${sql.join(parts, sql` UNION ALL `)}), searchable AS (
      SELECT *, concat_ws(' ', label, detail, id::text, number::text, '#' || number::text, "squadName", status, replace(kind, '_', ' ')) AS haystack FROM candidates
    ), ranked AS (
      SELECT kind, id, number, label, left(detail, 500) AS detail, "squadId", "squadName", status, "updatedAt",
        (CASE WHEN lower(label) = ${input.q.toLowerCase()} OR id::text = ${input.q.toLowerCase()} OR number::text = ${input.q.replace(/^#/, '')} THEN 100
          WHEN label ILIKE ${`${literalLike(input.q)}%`} THEN 80
          WHEN label ILIKE ${`%${literalLike(input.q)}%`} THEN 60
          WHEN ${sql.join(labelWords, sql` AND `)} THEN 40 ELSE 20 END
        + CASE WHEN kind = 'work_stream' AND status NOT IN ('done', 'canceled') THEN 8 ELSE 0 END
        + CASE WHEN "updatedAt" >= now() - interval '7 days' THEN 4
          WHEN "updatedAt" >= now() - interval '30 days' THEN 2 ELSE 0 END) AS score
      FROM searchable WHERE ${sql.join(words, sql` AND `)}
        AND ${input.kind ? sql`kind = ${input.kind}` : sql`true`}
    ) SELECT * FROM ranked ORDER BY score DESC, "updatedAt" DESC, kind, id LIMIT ${input.limit}
  `)
  return { results: [...rows] }
}

export async function listVisibleSquads(identity: Identity, limit = 50) {
  const scope = await resolvePermissionSquadScope(identity, 'squads:read')
  const accessible = await getAccessibleSquadIds(identity)
  return db
    .select({
      id: squads.id,
      name: squads.name,
      purpose: squads.purpose,
      status: squads.status,
      managerAgentId: squads.managerAgentId,
    })
    .from(squads)
    .where(
      sql`${withinScope(sql`${squads.id}`, scope)} AND ${accessible === 'all' ? sql`true` : withinScope(sql`${squads.id}`, { kind: 'some', squadIds: accessible })}`
    )
    .orderBy(squads.name, squads.id)
    .limit(Math.max(1, Math.min(limit, 100)))
}
