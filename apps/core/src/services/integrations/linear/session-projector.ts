import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm'
import {
  effectiveLinearSettings,
  integrationValueAt,
  resolveCodeHostReference,
  resolveQuestionAnswers,
  resolveTrackedResources,
  trackedResourceUrl,
  type QuestionData,
} from '@ficus/shared'
import {
  agentQuestions,
  agentQuestionWorkStreamOrigins,
  db,
  integrationConnectionAssignments,
  linearAgentSessions,
  linearQuestionMirrors,
  squads,
  workStreamFlowRuns,
  workStreams,
  workStreamWaits,
  type DbTx,
} from '../../../db'
import { createLogger } from '../../../lib/infra/logger'
import { resolvePublicAppUrl } from '../../../lib/public-app-url'
import { linearActivityId } from './app-api'
import { enqueueLinearWrites } from './outbox'
import { linearOpenInFicusUrl } from './session-binding'
import {
  linearElicitation,
  projectionAttemptFloor,
  projectLinearSession,
  type LinearProjectionItem,
  type LinearProjectionSnapshot,
  type ProjectionQuestion,
} from './session-projection'

const log = createLogger('linear-session-projector')

type Store = typeof db | DbTx
type StreamRow = typeof workStreams.$inferSelect
type SessionRow = typeof linearAgentSessions.$inferSelect

/** The instance's public `https:` base URL, or undefined (decision 9.5: no links without one). */
export function linearPublicBaseUrl(): string | undefined {
  const base = resolvePublicAppUrl()
  if (!base) return undefined
  try {
    return new URL(base).protocol === 'https:' ? base.replace(/\/+$/, '') : undefined
  } catch {
    return undefined
  }
}

/** Where a Linear user links their Ficus account (Linear's `auth` signal), with a public URL only. */
export function linearAccountLinkUrl(): string | undefined {
  const base = linearPublicBaseUrl()
  return base ? `${base}/settings?setting=linear-account` : undefined
}

/** The bound stream's delivery pull request, from `metadata.codeHost.changeRequest`. */
export function streamPullRequest(metadata: unknown): { url: string; label: string } | undefined {
  const reference = resolveCodeHostReference(metadata)
  if (!reference?.changeRequest) return undefined
  const url =
    reference.changeRequest.url ??
    trackedResourceUrl({
      integration: reference.integration,
      repository: reference.repository,
      kind: 'pull_request',
      number: reference.changeRequest.number,
    })
  if (!url || reference.integration !== 'github') return undefined
  return { url, label: `${reference.repository}#${reference.changeRequest.number}` }
}

function answerLabel(data: QuestionData, answer: string | null): string | undefined {
  // Only option labels are shown in Linear; free text written in Ficus stays in Ficus.
  const choices = resolveQuestionAnswers(data, answer)?.flatMap((entry) => entry.choices) ?? []
  const labels = choices.filter((choice) => choice.value !== undefined).map((choice) => choice.label)
  return labels.length && labels.length === choices.length ? labels.join(', ') : undefined
}

async function loadQuestions(streamId: string, sessionId: string): Promise<ProjectionQuestion[]> {
  const rows = await db
    .select({
      id: agentQuestions.id,
      status: agentQuestions.status,
      data: agentQuestions.questionData,
      answer: agentQuestions.answer,
      provenance: agentQuestions.answerProvenance,
      mirrorSession: linearQuestionMirrors.sessionId,
      mirrorState: linearQuestionMirrors.state,
    })
    .from(agentQuestionWorkStreamOrigins)
    .innerJoin(agentQuestions, eq(agentQuestions.id, agentQuestionWorkStreamOrigins.questionId))
    .leftJoin(linearQuestionMirrors, eq(linearQuestionMirrors.questionId, agentQuestions.id))
    .where(eq(agentQuestionWorkStreamOrigins.workStreamId, streamId))
  return rows.flatMap((row): ProjectionQuestion[] => {
    const data = row.data as QuestionData
    if (!Array.isArray(data?.questions) || !data.questions.length) return []
    // A question already posted to another session of this stream is never posted twice.
    if (row.mirrorSession && row.mirrorSession !== sessionId) return []
    if (!row.mirrorSession && row.status !== 'open') return []
    const answeredInLinear = row.provenance?.integration === 'linear'
    return [
      {
        id: row.id,
        status: row.status,
        data,
        ...(row.status === 'answered' ? { answerLabel: answerLabel(data, row.answer) } : {}),
        ...(row.mirrorState
          ? {
              mirrorState: answeredInLinear
                ? 'answered_in_linear'
                : (row.mirrorState as NonNullable<ProjectionQuestion['mirrorState']>),
            }
          : {}),
      },
    ]
  })
}

async function streamFailed(streamId: string) {
  // Recovery exhausted: a structured manual wait is open for a person to decide.
  const [wait] = await db
    .select({ id: workStreamWaits.id })
    .from(workStreamWaits)
    .where(
      and(
        eq(workStreamWaits.workStreamId, streamId),
        eq(workStreamWaits.type, 'manual'),
        isNull(workStreamWaits.closedAt),
        isNotNull(workStreamWaits.structured)
      )
    )
    .limit(1)
  return !!wait
}

/** Snapshot of the stream as the session should see it, plus the run version it was taken at. */
async function sessionSnapshot(stream: StreamRow, session: SessionRow, now: Date) {
  const [run] = await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, stream.id))
  const state = run?.activated ? run.state : undefined
  const steps = (state?.definition.steps ?? []).map((step) => ({ id: step.id, kind: step.kind ?? 'agent' }))
  const snapshot: LinearProjectionSnapshot = {
    stream: { status: stream.status, pause: stream.pause ? { id: stream.pause.id } : null },
    steps,
    attempts: (state?.attempts ?? []).map((attempt) => ({
      id: attempt.id,
      stepId: attempt.stepId,
      status: attempt.status,
      ...(attempt.step?.kind ? { kind: attempt.step.kind } : {}),
    })),
    attemptFloor: session.projectionAttemptFloor ?? projectionAttemptFloor(state),
    pullRequest: streamPullRequest(stream.metadata),
    failed: await streamFailed(stream.id),
    questions: await loadQuestions(stream.id, session.id),
    streamUrl: linearOpenInFicusUrl(stream),
    authLinkUrl: session.authLinkRequested ? linearAccountLinkUrl() : undefined,
    lastActivityAt: session.lastActivityAt ?? session.updatedAt,
    now,
  }
  return { snapshot, version: run?.version ?? null }
}

/** Enqueues the session's missing writes and records question mirrors for new elicitations. */
async function projectSession(stream: StreamRow, session: SessionRow, now: Date) {
  const { snapshot, version } = await sessionSnapshot(stream, session, now)
  const items = projectLinearSession(snapshot)
  const added = await db.transaction(async (tx) => {
    const keys = await enqueueLinearWrites(
      {
        connectionId: session.connectionId,
        scopeKey: session.id,
        sessionId: session.id,
        workStreamId: stream.id,
        items,
      },
      tx
    )
    for (const question of snapshot.questions) {
      const key = `question:${question.id}:asked`
      if (!keys.includes(key)) continue
      await tx
        .insert(linearQuestionMirrors)
        .values({
          questionId: question.id,
          sessionId: session.id,
          activityId: linearActivityId(session.id, key),
          options: linearElicitation(question).options,
        })
        .onConflictDoNothing()
    }
    // A question resolved in Ficus moves its open mirror on; a later Linear reply is an ordinary prompt.
    for (const question of snapshot.questions) {
      if (question.status === 'open' || question.mirrorState !== 'open') continue
      await tx
        .update(linearQuestionMirrors)
        .set({ state: question.status === 'answered' ? 'answered_in_ficus' : 'dismissed', updatedAt: now })
        .where(and(eq(linearQuestionMirrors.questionId, question.id), eq(linearQuestionMirrors.state, 'open')))
    }
    await tx
      .update(linearAgentSessions)
      .set({
        ...(session.projectionAttemptFloor === null ? { projectionAttemptFloor: snapshot.attemptFloor } : {}),
        ...(version !== null ? { lastFlowVersion: version } : {}),
        // The account link rides on the next elicitation only.
        ...(snapshot.authLinkUrl && keys.some((key) => key.startsWith('question:'))
          ? { authLinkRequested: false }
          : {}),
        lastProjectedAt: now,
        updatedAt: now,
      })
      .where(eq(linearAgentSessions.id, session.id))
    return keys
  })
  return added.length
}

/** The tracked Linear issues of a stream that get the delivery pull request, with their connections. */
async function attachmentTargets(stream: StreamRow, session: SessionRow | undefined) {
  const metadata = stream.metadata
  const [squad] = await db.select({ metadata: squads.metadata }).from(squads).where(eq(squads.id, stream.squadId))
  const assignments = await db
    .select({
      connectionId: integrationConnectionAssignments.connectionId,
      isDefault: integrationConnectionAssignments.isDefault,
    })
    .from(integrationConnectionAssignments)
    .where(
      and(
        eq(integrationConnectionAssignments.squadId, stream.squadId),
        eq(integrationConnectionAssignments.providerKey, 'linear')
      )
    )
  const assigned = new Set(assignments.map((row) => row.connectionId))
  const defaultConnection = assignments.find((row) => row.isDefault)?.connectionId ?? assignments[0]?.connectionId
  const sourceEventId = integrationValueAt(metadata, 'integrationSource.eventId')
  const issues = new Map<string, { issueId: string; connectionId: string; origin: boolean }>()
  for (const resource of resolveTrackedResources(metadata)) {
    if (resource.source !== 'tracked' || resource.integration !== 'linear' || resource.kind !== 'issue') continue
    if (!resource.externalId) continue
    const connectionId = resource.connectionId ?? defaultConnection
    // The squad's own assignment is the authority; a link never grants access by itself.
    if (!connectionId || !assigned.has(connectionId)) continue
    issues.set(resource.externalId, {
      issueId: resource.externalId,
      connectionId,
      origin: typeof sourceEventId === 'string' && resource.origin?.eventId === sourceEventId,
    })
  }
  if (session?.issueId && assigned.has(session.connectionId) && !issues.has(session.issueId))
    issues.set(session.issueId, { issueId: session.issueId, connectionId: session.connectionId, origin: false })
  // At most one origin: the issue the triggering fact named, or else the primary session's issue.
  if (![...issues.values()].some((issue) => issue.origin) && session?.issueId) {
    const issue = issues.get(session.issueId)
    if (issue) issue.origin = true
  }
  return { issues: [...issues.values()], settings: effectiveLinearSettings(squad?.metadata) }
}

/** 6.7: the delivery pull request is attached to every tracked Linear issue, in either connection mode. */
async function projectAttachments(stream: StreamRow, session: SessionRow | undefined) {
  const pullRequest = streamPullRequest(stream.metadata)
  if (!pullRequest) return 0
  const { issues, settings } = await attachmentTargets(stream, session)
  let added = 0
  for (const issue of issues) {
    // The link kind is resolved now and stored, so a retry sends the same value.
    const linkKind = issue.origin ? settings.pullRequestLinks.origin : settings.pullRequestLinks.tracked
    const item: LinearProjectionItem = {
      projectionKey: `pr:${pullRequest.url}`,
      kind: 'attachment',
      payload: { issueId: issue.issueId, url: pullRequest.url, linkKind, title: pullRequest.label },
      collapsible: false,
    }
    added += (
      await enqueueLinearWrites({
        connectionId: issue.connectionId,
        scopeKey: `issue:${issue.issueId}`,
        workStreamId: stream.id,
        items: [item],
      })
    ).length
  }
  return added
}

/** The session that receives a stream's progress: its primary, still-writable bound session. */
export async function primaryLinearSession(workStreamId: string, store: Store = db) {
  const [session] = await store
    .select()
    .from(linearAgentSessions)
    .where(
      and(
        eq(linearAgentSessions.workStreamId, workStreamId),
        eq(linearAgentSessions.primary, true),
        ne(linearAgentSessions.disposition, 'inaccessible')
      )
    )
    .orderBy(desc(linearAgentSessions.updatedAt))
    .limit(1)
  return session
}

/**
 * Projects one stream into Linear: progress for its primary session (6.3) and the delivery pull
 * request for its tracked issues (6.7). Returns how many new writes were enqueued.
 */
export async function projectLinearWriteBack(workStreamId: string, now = new Date()): Promise<number> {
  const [stream] = await db.select().from(workStreams).where(eq(workStreams.id, workStreamId))
  if (!stream) return 0
  const session = await primaryLinearSession(stream.id)
  let added = 0
  try {
    if (session) added += await projectSession(stream, session, now)
    added += await projectAttachments(stream, session)
  } catch (error) {
    log.warn(`Linear write-back projection failed for a stream: ${error instanceof Error ? error.message : 'error'}`)
  }
  return added
}

/** Whether a stream has anything to project into Linear, cheaply, before a full projection. */
export async function streamHasLinearWriteBack(workStreamId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: workStreams.id })
    .from(workStreams)
    .where(
      and(
        eq(workStreams.id, workStreamId),
        or(
          sql`EXISTS (SELECT 1 FROM ${linearAgentSessions} s WHERE s.work_stream_id = ${workStreams.id})`,
          sql`EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${workStreams.metadata}->'tracked')='array' THEN ${workStreams.metadata}->'tracked' ELSE '[]'::jsonb END) t WHERE t->>'integration'='linear')`
        )
      )
    )
  return !!row
}

/**
 * The reconcile sweep's candidates: streams with a bound session that are unfinished or changed in
 * the last hour, and unfinished streams tracking a Linear issue with a delivery pull request.
 */
export async function linearWriteBackSweepCandidates(now = new Date(), limit = 200): Promise<string[]> {
  const since = new Date(now.getTime() - 3_600_000)
  const bound = await db
    .selectDistinct({ id: workStreams.id })
    .from(linearAgentSessions)
    .innerJoin(workStreams, eq(workStreams.id, linearAgentSessions.workStreamId))
    .where(
      and(
        eq(linearAgentSessions.primary, true),
        ne(linearAgentSessions.disposition, 'inaccessible'),
        or(inArray(workStreams.status, ['active', 'queued']), gte(workStreams.updatedAt, since))
      )
    )
    .limit(limit)
  const tracking = await db
    .select({ id: workStreams.id })
    .from(workStreams)
    .where(
      and(
        or(inArray(workStreams.status, ['active', 'queued']), gte(workStreams.updatedAt, since)),
        sql`${workStreams.metadata}->'codeHost'->'changeRequest' IS NOT NULL`,
        sql`EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${workStreams.metadata}->'tracked')='array' THEN ${workStreams.metadata}->'tracked' ELSE '[]'::jsonb END) t WHERE t->>'integration'='linear')`
      )
    )
    .limit(limit)
  return [...new Set([...bound, ...tracking].map((row) => row.id))]
}
