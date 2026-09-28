import { and, desc, eq, inArray, lt, notInArray, or } from 'drizzle-orm'
import {
  OPERATIONS_RECOMMENDATION_TRANSITIONS,
  type OperationsRecommendationDetail,
  OperationsRecommendationPage,
  OperationsRecommendationStatus,
  OperationsRemediation,
} from '@ficus/shared'
import { db } from '../../db'
import {
  operationsExecutionAnalyses,
  operationsRecommendationEvidence,
  operationsRecommendationEvents,
  operationsRecommendations,
} from '../../db/schema'
import { ALGORITHM_VERSION, fingerprintFor } from './heuristics'
import { REDACTION_VERSION, redactEvidence } from './redaction'
import type { ExtractedSignal } from './types'
import type { PermissionSquadScope } from '../rbac/permission-scope'
import { evidenceSummaryFor, recommendationSummaryFor, targetOf, titleFor } from './presentation'
import { decodeRecommendationCursor, encodeRecommendationCursor, type RecommendationCursorContext } from './cursor'

export interface AnalysisInput {
  executionId: string
  squadId: string | null
  agentId: string
  signals: ExtractedSignal[]
  toolCallCount: number
  failedToolCallCount: number
  durationMs: number
  tokenCount: number
}
const baseline = (rows: (typeof operationsRecommendationEvidence.$inferSelect)[]) => ({
  sampleSize: rows.length,
  avgDurationMs: rows.length ? Math.round(rows.reduce((n, r) => n + r.durationMs, 0) / rows.length) : 0,
  avgTokens: rows.length ? Math.round(rows.reduce((n, r) => n + r.tokenCount, 0) / rows.length) : 0,
  failedToolCalls: rows.reduce((n, r) => n + r.failedToolCallCount, 0),
  estimatedAvoidableRetries: rows.reduce((n, r) => n + r.estimatedAvoidableRetries, 0),
})

export async function persistAnalysis(
  input: AnalysisInput,
  deps: { beforeAggregateLock?: (recommendationId: string) => Promise<void> } = {}
): Promise<'analyzed' | 'skipped' | 'already-analyzed'> {
  return db.transaction(async (tx) => {
    const result = input.squadId ? 'analyzed' : 'skipped'
    const claimed = await tx
      .insert(operationsExecutionAnalyses)
      .values({
        executionId: input.executionId,
        squadId: input.squadId,
        algorithmVersion: ALGORITHM_VERSION,
        redactionVersion: REDACTION_VERSION,
        result,
        skipReason: input.squadId ? null : 'squad-less',
        signalCount: input.signals.length,
        toolCallCount: input.toolCallCount,
        failedToolCallCount: input.failedToolCallCount,
        estimatedAvoidableRetries: input.signals.reduce((n, s) => n + s.estimatedAvoidableRetries, 0),
        durationMs: input.durationMs,
        tokenCount: input.tokenCount,
      })
      .onConflictDoNothing()
      .returning({ id: operationsExecutionAnalyses.executionId })
    if (!claimed.length) return 'already-analyzed'
    if (!input.squadId) return 'skipped'
    const groups = new Map<string, ExtractedSignal[]>()
    for (const s of input.signals) {
      const f = fingerprintFor(input.squadId, s.remediation)
      groups.set(f, [...(groups.get(f) ?? []), s])
    }
    for (const [fingerprint, signals] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const r = signals[0].remediation,
        target = targetOf(r),
        observedAt = new Date(Math.max(...signals.map((s) => s.observedAt.getTime()))),
        recommendationSummary = recommendationSummaryFor(r),
        evidenceSummary = evidenceSummaryFor(signals)
      const created = await tx
        .insert(operationsRecommendations)
        .values({
          squadId: input.squadId,
          fingerprint,
          remediationType: r.type,
          target,
          proposedRemediation: r,
          title: titleFor(r),
          summary: recommendationSummary,
          firstSeenAt: observedAt,
          lastSeenAt: observedAt,
          baseline: { sampleSize: 0, avgDurationMs: 0, avgTokens: 0, failedToolCalls: 0, estimatedAvoidableRetries: 0 },
          algorithmVersion: ALGORITHM_VERSION,
          redactionVersion: REDACTION_VERSION,
        })
        .onConflictDoNothing()
        .returning()
      const rec =
        created[0] ??
        (
          await tx
            .select()
            .from(operationsRecommendations)
            .where(
              and(
                eq(operationsRecommendations.squadId, input.squadId),
                eq(operationsRecommendations.fingerprint, fingerprint)
              )
            )
            .limit(1)
        )[0]
      if (created.length)
        await tx
          .insert(operationsRecommendationEvents)
          .values({ recommendationId: rec.id, action: 'created', actor: 'system' })
      const inserted = await tx
        .insert(operationsRecommendationEvidence)
        .values({
          recommendationId: rec.id,
          executionId: input.executionId,
          agentId: input.agentId,
          messageId: signals.find((s) => s.messageId)?.messageId ?? null,
          signalTypes: [...new Set(signals.map((s) => s.type))],
          occurrenceCount: signals.reduce((n, s) => n + s.occurrenceCount, 0),
          summary: evidenceSummary,
          failedToolCallCount: signals.reduce((n, s) => n + s.failedToolCalls, 0),
          estimatedAvoidableRetries: signals.reduce((n, s) => n + s.estimatedAvoidableRetries, 0),
          durationMs: input.durationMs,
          tokenCount: input.tokenCount,
          observedAt,
        })
        .onConflictDoNothing()
        .returning({ id: operationsRecommendationEvidence.id })
      if (inserted.length)
        await tx
          .insert(operationsRecommendationEvents)
          .values({ recommendationId: rec.id, action: 'evidence_added', actor: 'system', metadata: { count: 1 } })
      await deps.beforeAggregateLock?.(rec.id)
      await tx
        .select({ id: operationsRecommendations.id })
        .from(operationsRecommendations)
        .where(eq(operationsRecommendations.id, rec.id))
        // Evidence inserts hold FK KEY SHARE locks on this row. A non-key
        // aggregate update must not upgrade them to conflicting FOR UPDATE
        // locks in two concurrent transactions.
        .for('no key update')
      const evidence = await tx
        .select()
        .from(operationsRecommendationEvidence)
        .where(eq(operationsRecommendationEvidence.recommendationId, rec.id))
      const agents = new Set(evidence.map((e) => e.agentId).filter(Boolean)).size,
        executions = evidence.length,
        occurrences = evidence.reduce((n, e) => n + e.occurrenceCount, 0),
        confidence = executions >= 3 && agents >= 2 ? 'high' : executions >= 2 ? 'medium' : 'low'
      await tx
        .update(operationsRecommendations)
        .set({
          recurrenceCount: occurrences,
          executionCount: executions,
          affectedAgentCount: agents,
          confidence,
          lastSeenAt: new Date(Math.max(...evidence.map((e) => e.observedAt.getTime()))),
          firstSeenAt: new Date(Math.min(...evidence.map((e) => e.observedAt.getTime()))),
          baseline: baseline(evidence),
          updatedAt: new Date(),
        })
        .where(eq(operationsRecommendations.id, rec.id))
    }
    return 'analyzed'
  })
}
function mapSummary(r: typeof operationsRecommendations.$inferSelect) {
  return {
    id: r.id,
    squadId: r.squadId,
    policy: 'recommendation-only' as const,
    status: r.status,
    confidence: r.confidence as 'low' | 'medium' | 'high',
    title: r.title,
    summary: String(redactEvidence(r.summary, [])),
    proposedRemediation: r.proposedRemediation as OperationsRemediation,
    recurrence: { occurrences: r.recurrenceCount, executions: r.executionCount, agents: r.affectedAgentCount },
    baseline: r.baseline as any,
    comparison: null,
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    resolvedAt: r.resolvedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}
export async function listRecommendations(o: {
  squadScope: PermissionSquadScope
  status?: OperationsRecommendationStatus
  limit: number
  cursor?: string
  cursorContext: RecommendationCursorContext
}): Promise<OperationsRecommendationPage> {
  const where = []
  if (o.squadScope.kind === 'some') {
    where.push(inArray(operationsRecommendations.squadId, o.squadScope.squadIds))
  } else if (o.squadScope.excludedSquadIds.length) {
    where.push(notInArray(operationsRecommendations.squadId, o.squadScope.excludedSquadIds))
  }
  if (o.status) where.push(eq(operationsRecommendations.status, o.status))
  if (o.cursor) {
    const cursor = decodeRecommendationCursor(o.cursor, o.cursorContext)
    const at = cursor.lastSeenAt
    where.push(
      or(
        lt(operationsRecommendations.lastSeenAt, at),
        and(eq(operationsRecommendations.lastSeenAt, at), lt(operationsRecommendations.id, cursor.id))
      )!
    )
  }
  if (o.squadScope.kind === 'some' && !o.squadScope.squadIds.length) return { items: [], nextCursor: null }
  const rows = await db
    .select()
    .from(operationsRecommendations)
    .where(and(...where))
    .orderBy(desc(operationsRecommendations.lastSeenAt), desc(operationsRecommendations.id))
    .limit(o.limit + 1)
  const last = rows[o.limit - 1]
  return {
    items: rows.slice(0, o.limit).map(mapSummary),
    nextCursor:
      rows.length > o.limit
        ? encodeRecommendationCursor({ lastSeenAt: last.lastSeenAt, id: last.id }, o.cursorContext)
        : null,
  }
}
export async function getRecommendationDetail(id: string): Promise<OperationsRecommendationDetail | null> {
  const r = (await db.select().from(operationsRecommendations).where(eq(operationsRecommendations.id, id)).limit(1))[0]
  if (!r) return null
  const ev = await db
    .select()
    .from(operationsRecommendationEvidence)
    .where(eq(operationsRecommendationEvidence.recommendationId, id))
    .orderBy(desc(operationsRecommendationEvidence.observedAt))
    .limit(50)
  const events = await db
    .select()
    .from(operationsRecommendationEvents)
    .where(eq(operationsRecommendationEvents.recommendationId, id))
    .orderBy(desc(operationsRecommendationEvents.createdAt))
    .limit(100)
  return {
    ...mapSummary(r),
    evidence: ev.map((e) => ({
      id: e.id,
      executionId: e.executionId,
      messageId: e.messageId,
      signalTypes: e.signalTypes as any,
      occurrenceCount: e.occurrenceCount,
      summary: String(redactEvidence(e.summary, [])),
      failedToolCalls: e.failedToolCallCount,
      estimatedAvoidableRetries: e.estimatedAvoidableRetries,
      observedAt: e.observedAt,
    })),
    events: events.map((e) => ({
      id: e.id,
      action: e.action,
      actor: e.actor,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      createdAt: e.createdAt,
    })),
  }
}
export async function recommendationSquadId(
  id: string,
  deps: { findSquadId?: (id: string) => Promise<string | null> } = {}
) {
  const findSquadId =
    deps.findSquadId ??
    (async (recommendationId: string) =>
      (
        await db
          .select({ squadId: operationsRecommendations.squadId })
          .from(operationsRecommendations)
          .where(eq(operationsRecommendations.id, recommendationId))
          .limit(1)
      )[0]?.squadId ?? null)
  return findSquadId(id)
}
export async function updateRecommendationStatus(
  id: string,
  status: OperationsRecommendationStatus,
  actor: string,
  deps: { beforeSelect?: () => Promise<void> } = {}
) {
  return db.transaction(async (tx) => {
    await deps.beforeSelect?.()
    const r = (
      await tx.select().from(operationsRecommendations).where(eq(operationsRecommendations.id, id)).limit(1)
    )[0]
    if (!r) return 'not-found' as const
    if (r.status === status) return 'ok' as const
    if (!OPERATIONS_RECOMMENDATION_TRANSITIONS[r.status].includes(status)) return 'conflict' as const
    const updated = await tx
      .update(operationsRecommendations)
      .set({ status, resolvedAt: status === 'resolved' ? new Date() : null, updatedAt: new Date() })
      .where(and(eq(operationsRecommendations.id, id), eq(operationsRecommendations.status, r.status)))
      .returning({ status: operationsRecommendations.status })
    if (!updated.length) {
      const current = (
        await tx
          .select({ status: operationsRecommendations.status })
          .from(operationsRecommendations)
          .where(eq(operationsRecommendations.id, id))
          .limit(1)
      )[0]
      return current?.status === status ? ('ok' as const) : ('conflict' as const)
    }
    await tx
      .insert(operationsRecommendationEvents)
      .values({ recommendationId: id, action: 'status_changed', actor, fromStatus: r.status, toStatus: status })
    return 'ok' as const
  })
}
