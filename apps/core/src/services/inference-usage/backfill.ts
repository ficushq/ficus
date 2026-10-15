/**
 * The one-time import of usage recorded before the ledger existed: execution usage deltas, gaps in an
 * agent's session total, and decision_log costs. Rows are marked `source.backfilled`, have no provider or
 * model when unknown, and carry a dedupe key, so running it again writes nothing new.
 *
 * Only usage from before the ledger went live is imported (the cutoff is the first live ledger row, saved
 * in the backfill state), so nothing is counted twice: afterwards the same calls are recorded live.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import type { ExecutionStatus, SessionUsage } from '@ficus/shared'
import { agents, db, decisionLog, executions, inferenceUsage } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import { listDecisionProviders } from '../decisions/store'
import { isActiveExecutionStatus } from '../execution/status'
import { planAgentUsageBackfill, type UsageBackfillRow } from '../execution/usage-backfill'
import { getSettingsStore } from '../settings'
import { insertInferenceUsageRows, type InferenceUsageRow } from './record'
import { pruneInferenceUsage } from './retention'
import { attributionFromSource, uuidOrNull } from './types'

const log = createLogger('inference-usage-backfill')
const STATE_KEY = 'INFERENCE_USAGE_BACKFILL_STATE'
const INSERT_BATCH = 500

export interface InferenceUsageBackfillSummary {
  cutoff: string
  agentsScanned: number
  executionRows: number
  sessionGapRows: number
  decisionRows: number
  /** Rows actually written (0 on a dry run or a repeat run). */
  inserted: number
}

interface BackfillState {
  cutoff?: string
  done?: boolean
  /** Agents are processed in id order; a restart resumes after this one. */
  lastAgentId?: string
}

function readState(): BackfillState {
  try {
    const raw = getSettingsStore().get(STATE_KEY)
    return raw ? (JSON.parse(raw) as BackfillState) : {}
  } catch {
    return {}
  }
}

async function writeState(state: BackfillState): Promise<void> {
  await getSettingsStore().set(STATE_KEY, JSON.stringify(state), 'system:inference-usage-backfill')
}

/** When the ledger started recording live: its first live row, else now. */
async function liveSince(): Promise<Date> {
  const [row] = await db
    .select({ first: sql<string | null>`min(${inferenceUsage.occurredAt})` })
    .from(inferenceUsage)
    .where(isNull(inferenceUsage.dedupeKey))
  return row?.first ? new Date(row.first) : new Date()
}

function baseRow(): Omit<InferenceUsageRow, 'occurredAt' | 'feature' | 'dedupeKey' | 'source'> {
  return {
    provider: null,
    model: null,
    accountId: null,
    billing: 'unknown',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    units: null,
    costNanodollars: 0,
    listCostNanodollars: null,
    costEstimated: true,
    squadId: null,
    workStreamId: null,
    attemptId: null,
    stepId: null,
    agentId: null,
    executionId: null,
    parentAgentId: null,
    parentExecutionId: null,
    userId: null,
  }
}

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
const nanodollars = (usd: unknown) => Math.round(count(usd) * 1e9)

/** One agent's execution rows and (when it has no live usage) its session-total gap. */
async function agentRows(
  agent: { id: string; squadId: string | null; parentAgentId: string | null; sessionUsage: unknown; updatedAt: Date },
  cutoff: Date,
  hasLiveRows: boolean
): Promise<{ executions: InferenceUsageRow[]; gap: InferenceUsageRow | null }> {
  const rows = await db
    .select({
      id: executions.id,
      usage: executions.usage,
      status: executions.status,
      startedAt: executions.startedAt,
      endedAt: executions.endedAt,
      flowContext: executions.flowContext,
    })
    .from(executions)
    .where(and(eq(executions.agentId, agent.id), isNotNull(executions.usage)))
    .orderBy(asc(executions.startedAt), asc(executions.id))

  // The series stops at the first live execution (its usage is not final yet).
  const settled: Array<(typeof rows)[number]> = []
  for (const row of rows) {
    if (isActiveExecutionStatus(row.status as ExecutionStatus)) break
    settled.push(row)
  }
  const planned = new Map(
    planAgentUsageBackfill(
      settled.map(
        (row): UsageBackfillRow => ({ id: row.id, usage: row.usage as SessionUsage, startedAt: row.startedAt })
      )
    ).map((update) => [update.id, update.usage.delta])
  )

  const result: InferenceUsageRow[] = []
  const summed: Tokens = { ...ZERO }
  let summedCost = 0
  for (const row of settled) {
    const ended = row.endedAt ?? row.startedAt
    // Executions that ended after the ledger went live are (at least partly) recorded live.
    if (ended >= cutoff) continue
    const delta = (row.usage as SessionUsage | null)?.delta ?? planned.get(row.id)
    if (!delta?.tokens) continue
    const tokens = delta.tokens as Partial<Tokens>
    for (const key of Object.keys(summed) as Array<keyof Tokens>) summed[key] += count(tokens[key])
    summedCost += count(delta.cost)
    if (count(tokens.total) === 0 && count(delta.cost) === 0) continue
    const cost = nanodollars(delta.cost)
    const flow = row.flowContext
    result.push({
      ...baseRow(),
      occurredAt: ended,
      feature: 'agent-turn',
      inputTokens: count(tokens.input),
      outputTokens: count(tokens.output),
      cacheReadTokens: count(tokens.cacheRead),
      cacheWriteTokens: count(tokens.cacheWrite),
      costNanodollars: cost,
      listCostNanodollars: cost,
      squadId: agent.squadId,
      agentId: agent.id,
      executionId: row.id,
      parentAgentId: agent.parentAgentId,
      workStreamId: uuidOrNull(flow?.workStreamId),
      attemptId: Number.isInteger(flow?.attemptId) ? flow!.attemptId : null,
      stepId: flow?.stepId ?? null,
      source: { backfilled: true, from: 'executions' },
      dedupeKey: `exec:${row.id}`,
    })
  }

  // What the session total holds beyond its executions (e.g. a manual compaction, which only updated the
  // session total). Only for agents with no live usage: their session total is entirely pre-ledger.
  let gap: InferenceUsageRow | null = null
  const stats = (agent.sessionUsage as SessionUsage | null)?.stats
  const settledAll = settled.length === rows.length && settled.every((row) => (row.endedAt ?? row.startedAt) < cutoff)
  if (!hasLiveRows && settledAll && stats?.tokens && agent.updatedAt < cutoff) {
    const remainder = (key: keyof Tokens) => Math.max(0, count(stats.tokens[key]) - summed[key])
    const extraCost = Math.max(0, count(stats.cost) - summedCost)
    if (remainder('total') > 0) {
      const cost = nanodollars(extraCost)
      gap = {
        ...baseRow(),
        occurredAt: agent.updatedAt,
        feature: 'agent-turn',
        inputTokens: remainder('input'),
        outputTokens: remainder('output'),
        cacheReadTokens: remainder('cacheRead'),
        cacheWriteTokens: remainder('cacheWrite'),
        costNanodollars: cost,
        listCostNanodollars: cost,
        squadId: agent.squadId,
        agentId: agent.id,
        parentAgentId: agent.parentAgentId,
        source: { backfilled: true, from: 'agents.session_usage' },
        dedupeKey: `agent-gap:${agent.id}`,
      }
    }
  }
  return { executions: result, gap }
}

/** Every pre-ledger decision_log row that cost something (answered calls). */
async function decisionRows(cutoff: Date): Promise<InferenceUsageRow[]> {
  const kinds = new Map(listDecisionProviders().map((provider) => [provider.id, provider.kind]))
  const rows = await db
    .select()
    .from(decisionLog)
    .where(
      and(
        lt(decisionLog.createdAt, cutoff),
        eq(decisionLog.outcome, 'answered'),
        sql`(${decisionLog.inputTokens} IS NOT NULL OR ${decisionLog.costNanodollars} IS NOT NULL)`
      )
    )
  return rows.map((row) => {
    const kind = row.providerId ? (kinds.get(row.providerId) ?? null) : null
    const cost = row.costNanodollars
    const billing = cost === null ? 'unknown' : kind === 'systemone' && cost === 0 ? 'self-hosted' : 'api'
    return {
      ...baseRow(),
      ...attributionColumns(row.source),
      occurredAt: row.createdAt,
      feature: `decision:${row.purpose}`.slice(0, 64),
      provider: kind,
      model: row.model,
      accountId: row.providerId,
      billing,
      inputTokens: count(row.inputTokens),
      costNanodollars: cost ?? 0,
      listCostNanodollars: billing === 'self-hosted' ? null : cost,
      costEstimated: row.costEstimated || cost === null,
      source: { backfilled: true, from: 'decision_log', decisionLogId: row.id, purpose: row.purpose },
      dedupeKey: `decision_log:${row.id}`,
    }
  })
}

function attributionColumns(source: Record<string, string> | null) {
  const attribution = attributionFromSource(source)
  return {
    squadId: attribution.squadId ?? null,
    workStreamId: attribution.workStreamId ?? null,
    agentId: attribution.agentId ?? null,
    executionId: attribution.executionId ?? null,
    userId: attribution.userId ?? null,
  }
}

async function insertAll(rows: InferenceUsageRow[], apply: boolean): Promise<number> {
  if (!apply) return 0
  let inserted = 0
  for (let index = 0; index < rows.length; index += INSERT_BATCH)
    inserted += await insertInferenceUsageRows(rows.slice(index, index + INSERT_BATCH))
  return inserted
}

/**
 * Import pre-ledger usage. Without `apply` it only counts what it would write. Idempotent: every row
 * has a dedupe key. `cutoff` defaults to when the ledger went live.
 */
export async function backfillInferenceUsage(options: {
  apply: boolean
  squadId?: string
  agentIds?: string[]
  cutoff?: Date
  /** Resume after this agent id (agents are processed in id order). */
  afterAgentId?: string
  onAgentDone?: (agentId: string) => Promise<void>
}): Promise<InferenceUsageBackfillSummary> {
  const cutoff = options.cutoff ?? (await liveSince())
  const summary: InferenceUsageBackfillSummary = {
    cutoff: cutoff.toISOString(),
    agentsScanned: 0,
    executionRows: 0,
    sessionGapRows: 0,
    decisionRows: 0,
    inserted: 0,
  }
  const scope = options.agentIds?.length
    ? inArray(agents.id, options.agentIds)
    : options.squadId
      ? eq(agents.squadId, options.squadId)
      : undefined
  const targets = await db
    .select({
      id: agents.id,
      squadId: agents.squadId,
      parentAgentId: agents.parentAgentId,
      sessionUsage: agents.sessionUsage,
      updatedAt: agents.updatedAt,
    })
    .from(agents)
    .where(and(scope, options.afterAgentId ? gt(agents.id, options.afterAgentId) : undefined))
    .orderBy(asc(agents.id))

  const live = new Set(
    (
      await db
        .selectDistinct({ agentId: inferenceUsage.agentId })
        .from(inferenceUsage)
        .where(and(isNull(inferenceUsage.dedupeKey), isNotNull(inferenceUsage.agentId)))
    ).map((row) => row.agentId!)
  )

  for (const agent of targets) {
    const { executions: rows, gap } = await agentRows(agent, cutoff, live.has(agent.id))
    summary.agentsScanned += 1
    summary.executionRows += rows.length
    if (gap) summary.sessionGapRows += 1
    summary.inserted += await insertAll(gap ? [...rows, gap] : rows, options.apply)
    if (options.apply) await options.onAgentDone?.(agent.id)
  }

  // decision_log rows are not scoped to agents; import them on unscoped runs only.
  if (!scope) {
    const decisions = await decisionRows(cutoff)
    summary.decisionRows = decisions.length
    summary.inserted += await insertAll(decisions, options.apply)
  }
  // Rows older than the retention window are read from daily rollups: roll them up and prune.
  if (options.apply && summary.inserted > 0) await pruneInferenceUsage()
  return summary
}

/** The worker's one-time run: resumes after a restart and records when it is done. */
export async function runInferenceUsageBackfillOnce(): Promise<void> {
  const state = readState()
  if (state.done) return
  const cutoff = state.cutoff ? new Date(state.cutoff) : await liveSince()
  await writeState({ ...state, cutoff: cutoff.toISOString() })
  let lastAgentId = state.lastAgentId
  const summary = await backfillInferenceUsage({
    apply: true,
    cutoff,
    afterAgentId: lastAgentId,
    onAgentDone: async (agentId) => {
      lastAgentId = agentId
      // Checkpoint now and then, not after every agent.
      if (Math.random() < 0.05) await writeState({ cutoff: cutoff.toISOString(), lastAgentId })
    },
  })
  await writeState({ cutoff: cutoff.toISOString(), lastAgentId, done: true })
  log.info('Inference usage backfill finished', summary)
}
