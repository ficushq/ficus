import { and, asc, desc, eq, gt, inArray, InferSelectModel, isNotNull, isNull, lte, sql, type SQL } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { agents, db, messages } from '../db'
import { ADDRESSABLE_AGENT_STATUSES, AgentStatus, LIVE_AGENT_STATUSES, Message } from '@ficus/shared'
import { AmbiguousPrefixError, uuidPrefixCondition } from '../db/prefix-match'
import { validateModelSpecList } from '../lib/utils/model-spec'
import { mapMessage } from './message-mapper'
import { createPublicKey } from 'crypto'

/**
 * Leaf module below `Agent`: owns the entity's static CRUD/query DB
 * statements (row-level selects, inserts, updates). `Agent`'s static
 * methods delegate to these functions — see Agent.ts for the public API
 * surface, doc comments, instance construction, eager-loading, and event
 * emission that wrap these row-level operations.
 *
 * Must not import from './Agent' — this module sits below Agent so Agent
 * can safely import from it without creating a module cycle.
 */

export type AgentRow = InferSelectModel<typeof agents>

export type AgentLifecycleSweepKind =
  | 'legacy-terminated'
  | 'pending'
  | 'dormancy-completion'
  | 'dormant-retention'
  | 'final-cleanup'

/**
 * Read only the durable fields needed by lifecycle fences and polling loops.
 * Unlike Agent.find(), this does not project message-derived fields or hydrate
 * squad/agent-type relations.
 */
export type AgentLifecycleState = {
  id: string
  status: AgentStatus
  metadata: Record<string, unknown> | null
  dormantAt: Date | null
  terminatedAt: Date | null
}

function isMetadataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizeAgentMetadata(value: unknown): Record<string, unknown> | null {
  return isMetadataRecord(value) ? value : null
}

export async function findAgentLifecycleState(id: string): Promise<AgentLifecycleState | null> {
  const rows = await db
    .select({
      id: agents.id,
      status: agents.status,
      metadata: agents.metadata,
      dormantAt: agents.dormantAt,
      terminatedAt: agents.terminatedAt,
    })
    .from(agents)
    .where(id.length < 36 ? uuidPrefixCondition(agents.id, id) : eq(agents.id, id))
    .limit(2)
  if (rows.length > 1) throw new AmbiguousPrefixError('agent', id)
  const row = rows[0]
  return row ? { ...row, metadata: normalizeAgentMetadata(row.metadata) } : null
}

/** Converge the generation a dormant setup-retirement retry must fence. */
export async function convergeDormancyResourceGeneration(
  agentId: string,
  expectedGeneration: string | null,
  actualGeneration: string | null
): Promise<boolean> {
  const [updated] = await db
    .update(agents)
    .set({
      metadata: sql`jsonb_set(COALESCE(${agents.metadata}, '{}'::jsonb), '{dormancyResourceGeneration}', ${JSON.stringify(actualGeneration)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.status, 'dormant'),
        sql`${agents.metadata}->>'dormancyResourceGeneration' IS NOT DISTINCT FROM ${expectedGeneration}`
      )
    )
    .returning({ id: agents.id })
  return Boolean(updated)
}

/**
 * Persistently rotate a bounded lifecycle batch before effects begin.
 * SKIP LOCKED prevents concurrent janitors from claiming the same candidates.
 */
type LifecycleSweepClaimInput = {
  kind: AgentLifecycleSweepKind
  maxCandidates: number
  dormantCutoff?: Date
}

async function claimAgentLifecycleSweepCandidatesScoped(
  input: LifecycleSweepClaimInput & { agentIds?: readonly string[] }
): Promise<string[]> {
  const marker =
    input.kind === 'legacy-terminated'
      ? 'legacyTerminationSweepAt'
      : input.kind === 'pending'
        ? 'pendingLifecycleSweepAt'
        : input.kind === 'dormancy-completion'
          ? 'dormancyCompletionSweepAt'
          : input.kind === 'dormant-retention'
            ? 'dormantSweepAt'
            : 'finalCleanupSweepAt'
  const predicate =
    input.kind === 'legacy-terminated'
      ? and(
          inArray(agents.status, [...LIVE_AGENT_STATUSES]),
          sql`(${agents.terminatedAt} IS NOT NULL OR ${agents.metadata}->>'finalCleanupPending' = 'true')`
        )!
      : input.kind === 'pending'
        ? sql`${agents.metadata}->>'pendingLifecycleTarget' IN ('dormant', 'terminated')`
        : input.kind === 'dormancy-completion'
          ? sql`${agents.status} = 'dormant' AND (${agents.metadata}->>'dormancyCompletionPending' = 'true' OR ${agents.metadata}->>'pendingInboxRedelivery' IS NOT NULL)`
          : input.kind === 'dormant-retention'
            ? and(eq(agents.status, 'dormant'), lte(agents.dormantAt, input.dormantCutoff ?? new Date(0)))!
            : sql`${agents.status} = 'terminated' AND ${agents.metadata}->>'finalCleanupPending' = 'true'`
  const scopedPredicate = input.agentIds ? and(predicate, inArray(agents.id, [...input.agentIds]))! : predicate
  const rows = await db.execute<{ id: string }>(sql`
    WITH candidates AS (
      SELECT ${agents.id}
      FROM ${agents}
      WHERE ${scopedPredicate}
      ORDER BY
        CASE
          WHEN jsonb_typeof(${agents.metadata}->${marker}) = 'number'
            THEN (${agents.metadata}->>${marker})::numeric
          ELSE 0
        END,
        ${agents.id}
      FOR UPDATE SKIP LOCKED
      LIMIT ${Math.max(1, input.maxCandidates)}
    )
    UPDATE ${agents} AS selected
    SET metadata = jsonb_set(
      COALESCE(selected.metadata, '{}'::jsonb),
      ARRAY[${marker}]::text[],
      to_jsonb(GREATEST(
        CASE
          WHEN jsonb_typeof(selected.metadata->${marker}) = 'number'
            THEN (selected.metadata->>${marker})::numeric + 1
          ELSE 1
        END,
        EXTRACT(EPOCH FROM clock_timestamp())
      )),
      true
    )
    FROM candidates
    WHERE selected.id = candidates.id
    RETURNING selected.id
  `)
  return rows.map((row) => row.id)
}

export function claimAgentLifecycleSweepCandidates(input: LifecycleSweepClaimInput): Promise<string[]> {
  return claimAgentLifecycleSweepCandidatesScoped(input)
}

/** Test-only exact scope for destructive lifecycle repair; empty scope is rejected. */
export function claimAgentLifecycleSweepCandidatesForTest(
  input: LifecycleSweepClaimInput,
  agentIds: readonly string[]
): Promise<string[]> {
  if (agentIds.length === 0) throw new Error('Lifecycle sweep test scope must not be empty')
  return claimAgentLifecycleSweepCandidatesScoped({ ...input, agentIds })
}

export interface ListAgentsFilters {
  squadId?: string | null
  terminatedAt?: null | 'NOT_NULL'
  /** Filter by lifecycle liveness. Prefer this over timestamp predicates. */
  live?: boolean
  /** Include live and dormant agents, excluding only final termination. */
  addressable?: boolean
  /** Filter agents terminated within the last N days */
  terminatedWithinDays?: number
  agentTypeId?: string
  status?: AgentStatus
  scopeType?: string
  scopeId?: string
  taskId?: string
  olderThan?: Date
  topLevelOnly?: boolean
  parentAgentId?: string
  limit?: number
  offset?: number
}

/**
 * The conversation summary is READ from denormalized columns, not computed.
 *
 * These three were correlated subqueries over `messages`, evaluated once per
 * agent row on every agent select. On a live tenant that meant 5.5 BILLION
 * tuples read from a 2,474-row table, ~163ms per call at 96 rows returned, and
 * roughly 18.6 hours of cumulative database time — with both core processes
 * pinned near 90% of a single thread while the box sat 85% idle. It was an N+1
 * that lived INSIDE one statement, so it never looked like an N+1 in a trace.
 *
 * Indexing was not an option: the sort expression casts
 * metadata->>'consumedAt' to timestamptz and date_truncs a timestamptz, both
 * STABLE, so Postgres rejects an index on it outright ("functions in index
 * expression must be marked IMMUTABLE" — tested against the live schema).
 *
 * services/agents/activity-summary.ts maintains the columns on every write
 * that can change them, and explains why it recomputes rather than updating
 * in place.
 */

/** Column map for agent select queries. See Agent.selectColumns. */
export const agentSelectColumns = Object.freeze({
  id: agents.id,
  agentTypeId: agents.agentTypeId,
  squadId: agents.squadId,
  ownerUserId: agents.ownerUserId,
  parentAgentId: agents.parentAgentId,
  status: agents.status,
  persist: agents.persist,
  modelOverride: agents.modelOverride,
  selectedModel: agents.selectedModel,
  metadata: agents.metadata,
  context: agents.context,
  questionData: agents.questionData,
  sessionUsage: agents.sessionUsage,
  dormantAt: agents.dormantAt,
  terminatedAt: agents.terminatedAt,
  pendingDormancyAt: agents.pendingDormancyAt,
  amtpHandle: agents.amtpHandle,
  identityPublicKey: agents.identityPublicKey,
  inboundOpen: agents.inboundOpen,
  cardJson: agents.cardJson,
  machineId: agents.machineId,
  createdAt: agents.createdAt,
  updatedAt: agents.updatedAt,
  lastMessageAt: agents.lastMessageAt,
  lastHumanMessageAt: agents.lastHumanMessageAt,
  lastMessagePreview: agents.lastMessagePreview,
})

/** Names taken in a squad. See Agent.takenNamesInSquad. */
export async function takenNamesInSquad(squadId: string): Promise<string[]> {
  const rows = await db
    .select({ name: sql<string | null>`${agents.metadata}->>'name'` })
    .from(agents)
    .where(eq(agents.squadId, squadId))
  return rows.map((row) => row.name).filter((name): name is string => !!name)
}

/** See Agent.validateModelOverrides. */
export async function validateModelOverrides(input: {
  agentTypeId: string
  modelOverride?: string | null
}): Promise<void> {
  if (input.modelOverride == null) {
    return
  }

  validateModelSpecList(input.modelOverride)
}

/** Row-level select behind Agent.find (no construction/eager-load). */
export async function findAgentRow(id: string): Promise<AgentRow | null> {
  const agentRows = await db
    .select(agentSelectColumns)
    .from(agents)
    .where(id.length < 36 ? uuidPrefixCondition(agents.id, id) : eq(agents.id, id))
    .limit(2)
  if (agentRows.length === 0) return null
  if (agentRows.length > 1) throw new AmbiguousPrefixError('agent', id)

  return agentRows[0]
}

/** The three columns the background activity predicates actually read. */
export interface AgentActivityRow {
  id: string
  /** Denormalized column, maintained by refreshAgentActivity(). */
  lastMessageAt: Date | null
  status: AgentStatus
}

/**
 * Set-based activity lookup for a KNOWN set of agent ids — one query for the
 * whole set, selecting only the columns the keep-warm/idle predicates read.
 *
 * This exists for the background sweeps (the 60s vm-sandbox-lifecycle tick),
 * which used to resolve membership with one `Agent.find` per member — each of
 * those being a row select PLUS an eager load of the agent's squad and agent
 * type. Ids must be whole ids (not prefixes): unlike {@link findAgentRow} this
 * is an exact `IN (...)` match, which is exactly what work-stream membership
 * stores (see `validateAgentIds`, which resolves to whole ids on write).
 *
 * Missing ids are simply absent from the result — callers treat "no row" the
 * same as they did a `null` from `Agent.find`.
 */
export async function listAgentActivityRows(ids: string[]): Promise<AgentActivityRow[]> {
  if (ids.length === 0) return []
  const rows = await db
    .select({
      id: agents.id,
      lastMessageAt: agentSelectColumns.lastMessageAt,
      status: agents.status,
    })
    .from(agents)
    .where(inArray(agents.id, [...new Set(ids)]))
  return rows
}

/** See Agent.findMessage. */
export async function findMessageById(messageId: string): Promise<Message | null> {
  const results = await db.select().from(messages).where(uuidPrefixCondition(messages.id, messageId)).limit(2)
  if (results.length > 1) throw new AmbiguousPrefixError('message', messageId)
  return results[0] ? mapMessage(results[0]) : null
}

/** Row-level select behind Agent.findByThreadId (no construction). */
export async function findAgentRowByThreadId(
  provider: string,
  threadId: string,
  instanceId?: string,
  channelId?: string
): Promise<AgentRow | null> {
  const [row] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.agentTypeId, 'consultant'),
        instanceId ? sql`${agents.context}->'channelInstance'->>'id' = ${instanceId}` : undefined,
        channelId
          ? sql`(${agents.context}->'thread'->>'channelId' = ${channelId} OR ${agents.context}->'thread'->>'id' = ${channelId})`
          : undefined,
        inArray(agents.status, [...ADDRESSABLE_AGENT_STATUSES]),
        sql`${agents.context}->'channelInstance'->>'provider' = ${provider}`,
        sql`${agents.context}->'thread'->>'id' = ${threadId}`
      )
    )
    .limit(1)

  return row ?? null
}

/** Row-level select behind Agent.findByFederationHandle (no construction/eager-load). */
export async function findAgentRowByFederationHandle(handle: string): Promise<AgentRow | null> {
  const [row] = await db
    .select(agentSelectColumns)
    .from(agents)
    .where(and(eq(agents.amtpHandle, handle), inArray(agents.status, [...ADDRESSABLE_AGENT_STATUSES])))
    .limit(1)

  return row ?? null
}

/** See Agent.listFederationHandles. */
export async function listFederationHandles(): Promise<string[]> {
  const rows = await db
    .select({ handle: agents.amtpHandle })
    .from(agents)
    .where(and(isNotNull(agents.amtpHandle), inArray(agents.status, [...ADDRESSABLE_AGENT_STATUSES])))
    .orderBy(agents.amtpHandle)
  return rows.map((r) => r.handle as string)
}

export function isValidFederationIdentityPublicKey(value: string | null): value is string {
  if (!value) return false
  try {
    return createPublicKey(value).asymmetricKeyType === 'ed25519'
  } catch {
    return false
  }
}

/** See Agent.listFederationHandleRecords — §11 discovery listing with unsigned card hints. */
export async function listFederationHandleRecords(): Promise<
  Array<{ handle: string; name?: string; description?: string }>
> {
  const rows = await db
    .select({ handle: agents.amtpHandle, identityPublicKey: agents.identityPublicKey, cardJson: agents.cardJson })
    .from(agents)
    .where(
      and(
        isNotNull(agents.amtpHandle),
        isNotNull(agents.identityPublicKey),
        inArray(agents.status, [...ADDRESSABLE_AGENT_STATUSES])
      )
    )
    .orderBy(agents.amtpHandle)

  return rows.flatMap((r) => {
    if (!isValidFederationIdentityPublicKey(r.identityPublicKey)) return []
    const record: { handle: string; name?: string; description?: string } = { handle: r.handle as string }
    const name = r.cardJson?.card.name
    if (typeof name === 'string' && name.length > 0) record.name = name
    const description = r.cardJson?.card.description
    if (typeof description === 'string' && description.length > 0) record.description = description
    return [record]
  })
}

/** Trusted lifecycle sets are SQL literals so generic plans can estimate their selective statuses. */
function agentLifecycleSetSql(statuses: ReadonlySet<AgentStatus>) {
  return sql`${agents.status} IN (${sql.join(
    [...statuses].map((status) => sql.raw(`'${status}'`)),
    sql`, `
  )})`
}

/** See Agent.list / Agent.count. */
export function buildAgentListConditions(filters?: ListAgentsFilters): SQL[] {
  const conditions: SQL[] = []

  if (filters?.squadId !== undefined) {
    conditions.push(filters.squadId === null ? isNull(agents.squadId) : eq(agents.squadId, filters.squadId))
  }
  if (filters?.topLevelOnly) {
    conditions.push(isNull(agents.parentAgentId))
  }
  if (filters?.parentAgentId !== undefined) {
    conditions.push(eq(agents.parentAgentId, filters.parentAgentId))
  }
  if (filters?.terminatedAt === 'NOT_NULL') {
    conditions.push(isNotNull(agents.terminatedAt))
  } else if (filters?.terminatedAt === null) {
    conditions.push(isNull(agents.terminatedAt))
  }
  if (filters?.live === true) conditions.push(agentLifecycleSetSql(LIVE_AGENT_STATUSES))
  if (filters?.live === false) conditions.push(sql`NOT (${agentLifecycleSetSql(LIVE_AGENT_STATUSES)})`)
  if (filters?.addressable === true) conditions.push(agentLifecycleSetSql(ADDRESSABLE_AGENT_STATUSES))
  if (filters?.terminatedWithinDays !== undefined) {
    // Filter agents terminated within the last N days
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - filters.terminatedWithinDays)
    conditions.push(isNotNull(agents.terminatedAt))
    conditions.push(gt(agents.terminatedAt, cutoffDate))
  }
  if (filters?.agentTypeId) {
    conditions.push(eq(agents.agentTypeId, filters.agentTypeId))
  }
  if (filters?.status) {
    conditions.push(eq(agents.status, filters.status))
  }
  if (filters?.scopeType) {
    conditions.push(sql`${agents.context}->'scope'->>'type' = ${filters.scopeType}`)
  }
  if (filters?.scopeId) {
    conditions.push(sql`${agents.context}->'scope'->>'id' = ${filters.scopeId}`)
  }
  if (filters?.taskId) {
    conditions.push(sql`${agents.context}->>'taskId' = ${filters.taskId}`)
  }
  if (filters?.olderThan) {
    conditions.push(lte(agents.createdAt, filters.olderThan))
  }

  return conditions
}

/** See Agent.count. Whole move — never constructs an Agent. */
export async function countAgents(filters?: ListAgentsFilters): Promise<number> {
  const conditions = buildAgentListConditions(filters)
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
  return result?.count ?? 0
}

/** Row-level select(s) behind Agent.list (no construction/eager-load). */
export async function listAgentRows(
  filters?: ListAgentsFilters,
  order: 'latestMessage' | 'recentlyCreated' | 'earliestCreated' | 'recentlyTerminated' = 'earliestCreated'
): Promise<AgentRow[]> {
  return agentListQuery(filters, order)
}

/** Keep query construction available for EXPLAIN under custom and generic prepared plans. */
export function agentListQuery(
  filters?: ListAgentsFilters,
  order: 'latestMessage' | 'recentlyCreated' | 'earliestCreated' | 'recentlyTerminated' = 'earliestCreated'
) {
  const conditions = buildAgentListConditions(filters)

  const orderBy =
    order === 'latestMessage'
      ? // Was the correlated subquery AGAIN, evaluated per row in ORDER BY on
        // top of the three in the select list. Now a plain column sort, which
        // an index can serve if this list ever needs one.
        [desc(sql`COALESCE(${agents.lastMessageAt}, ${agents.createdAt})`), asc(agents.id)]
      : order === 'recentlyTerminated'
        ? [desc(agents.terminatedAt), asc(agents.id)]
        : order === 'earliestCreated'
          ? [asc(agents.createdAt), asc(agents.id)]
          : [desc(agents.createdAt), asc(agents.id)]

  return db
    .select(agentSelectColumns)
    .from(agents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(...orderBy)
    .limit(filters?.limit ?? 2_147_483_647)
    .offset(filters?.offset ?? 0)
}

/**
 * See Agent.validateAgentIds. Whole move — uses findAgentRow (not Agent.find)
 * to resolve ids without constructing Agent instances; validateAgentIds only
 * ever used the resolved id, so this is behavior-identical.
 */
export async function validateAgentIds(agentIds: string[]): Promise<string[]> {
  const validIds: string[] = []
  for (const agentId of agentIds) {
    const row = await findAgentRow(agentId)
    if (!row) throw new Error(`Agent not found: ${agentId}`)
    validIds.push(row.id)
  }
  return validIds
}

/**
 * DB insert statement behind Agent.create. See Agent.ts for id/name/metadata
 * assembly, validation, construction (via mustFind), and event emission.
 */
export async function insertAgent(values: typeof agents.$inferInsert): Promise<void> {
  await db.insert(agents).values(values)
}

/**
 * DB update statement behind Agent.update. See Agent.ts for the surrounding
 * guard/validation logic, construction (via mustFind), and event emission.
 */
export async function updateAgentRow(id: string, set: PgUpdateSetSource<typeof agents>): Promise<void> {
  await db.update(agents).set(set).where(eq(agents.id, id))
}
