import { worktreeAttachmentPaths } from '../services/work-streams/worktree-cleanup-attachments'
import {
  assertWorktreeCleanupMutable,
  assertOwnedWorktreeBindingUnchanged,
  assertWorktreeAttachmentsAvailable,
  prepareWorktreeAttachmentCheck,
  enqueueWorktreeCleanup,
} from '../services/work-streams/worktree-cleanup-store'
import { isDeepStrictEqual } from 'node:util'
import {
  RepositorySetupError,
  setupWorkStreamRepository,
  type WorktreeOwnership,
} from '../services/work-streams/repository-setup'
import { validateAssignedReviewers } from '../services/workflows/reviewers'
import { parseTrackedMetadata, validateTrackedMetadata } from '../services/work-streams/tracked-resources'
import { resolveCreationWorkflow } from '../services/workflows/creation-source'
import { notifyFlowWaitResolution } from '../services/work-streams/wait-scope'
import { eq, desc, and, sql, inArray, type SQL } from 'drizzle-orm'
import { db, squads, workStreams, uuidPrefixCondition, AmbiguousPrefixError } from '../db'
import { executions, workStreamWaits, workStreamFlowRuns, workStreamWorktrees, worktreeCleanupJobs } from '../db/schema'
import { describeCodeHostReference, WORK_STREAM_ADMITTED_STATUSES, workStreamSourceLinkKindSchema } from '@ficus/shared'
import type {
  WorkStream as WorkStreamJson,
  WorktreeCleanupSummary,
  WorkStreamStatus,
  WorkStreamPriority,
  WorkStreamCompletionMode,
  WorkStreamWaitCreatedBy,
  WorkStreamWaitCallerResolution,
  CreateWorkStreamInput,
  UpdateWorkStreamInput,
  WorkStreamMetrics,
  WorkStreamRuntime,
  WorkStreamSourceLink,
} from '@ficus/shared'
import { eventEmitter } from '../lib/infra/event-emitter'
import { listWorkStreamSubscriberIds } from '../services/work-streams/subscriptions'
import { BaseEntity } from './base'
import type { InferSelectModel } from 'drizzle-orm'
import { Agent } from './Agent'
import { IndexingService } from '../services/memory/indexer/IndexingService'
import {
  notifyWorkStreamAssigned,
  notifyWorkStreamBlocked,
  notifyWorkStreamCanceled,
  notifyWorkStreamDone,
  notifyWorkStreamOwnerOfNewStream,
  notifyWorkStreamReopened,
  notifyWorkStreamResponded,
  notifyWorkStreamReview,
} from '../services/squad/work-stream-notifications'
import { cleanupAgentsForTerminalWorkStream, cleanupRemovedAgent } from '../services/agents/cleanup'
import { markCrewForDormancy } from '../services/agents/crew-dormancy'
import { invalidateContinuationCycle, resetContinuationCycle } from '../services/work-streams/continuation-state'
import {
  closeDependencyWaitsForCompletedStream,
  closeOpenWaits,
  listOpenWaits,
  openWait,
  syncDependencyWaits,
  type WorkStreamWaitRow,
} from '../services/work-streams/waits'
import { deepMergeMetadata } from './metadata'

import { Squad } from './Squad'

export type WorkStreamRow = InferSelectModel<typeof workStreams>

export type WorkStreamWaitResolveErrorCode =
  | 'wait_not_found' // no such wait, or it belongs to another stream
  | 'wait_already_closed'
  | 'work_stream_terminal'
  | 'invalid_resolution' // resolution not valid for the wait's type (or missing required note)

/** Typed failure from {@link WorkStream.resolveWait} so routes can map codes to HTTP statuses. */
export class WorkStreamWaitResolveError extends Error {
  constructor(
    public readonly code: WorkStreamWaitResolveErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'WorkStreamWaitResolveError'
  }
}

/**
 * `done` no longer vaporizes conversations: completing a stream with ANY open
 * wait is rejected (spec §5). Routes map this to 409.
 */
export class WorkStreamOpenWaitsError extends Error {
  constructor(public readonly openWaits: { id: string; type: string }[]) {
    super(
      'Cannot mark this work stream done — resolve or cancel the open waits first ' +
        '(approve/send back the review, clear the input request, or complete/detach dependencies): ' +
        openWaits.map((w) => `${w.type} ${w.id}`).join(', ')
    )
    this.name = 'WorkStreamOpenWaitsError'
  }
}

/**
 * Terminal states are symmetric and exit ONLY through reopen (spec §6): a raw
 * status PATCH out of `done`/`canceled` is rejected. Routes map this to 409.
 */
export class WorkStreamTerminalTransitionError extends Error {
  constructor(
    public readonly fromStatus: WorkStreamStatus,
    public readonly toStatus: WorkStreamStatus
  ) {
    super(
      `Cannot change the status of a ${fromStatus} work stream (requested: ${toStatus}). ` +
        'Use reopen to re-enter admission.'
    )
    this.name = 'WorkStreamTerminalTransitionError'
  }
}

/** reopen() is only valid from `done` or `canceled`. Routes map this to 409. */
export class WorkStreamNotReopenableError extends Error {
  constructor(public readonly status: WorkStreamStatus) {
    super(`Only done or canceled work streams can be reopened (status: ${status})`)
    this.name = 'WorkStreamNotReopenableError'
  }
}

/** One observed integration event owns at most one live work stream. Routes map this to a 200 reuse. */
export class WorkStreamEventAlreadyHandledError extends Error {
  constructor(public readonly workStreamId: string) {
    super(`This integration event is already tracked by work stream ${workStreamId}`)
    this.name = 'WorkStreamEventAlreadyHandledError'
  }
}

export interface ListWorkStreamsFilters {
  squadId?: string
  status?: WorkStreamStatus
  statuses?: WorkStreamStatus[]
}

export interface TerminalWorkStreamCursorKey {
  completedAt: Date | null
  priority: WorkStreamPriority
  createdAt: Date
  id: string
}

export interface NonTerminalOrderCandidate {
  id: string
  title: string
  squadId: string
  status: WorkStreamStatus
  priority: WorkStreamPriority
  assigneeAgentId: string | null
  agentIds: string[] | null
  dependsOn: string[]
  metadata: unknown
  createdAt: Date
  updatedAt: Date
}

export interface TerminalWorkStreamPage {
  items: WorkStream[]
  totalCount: number
  hasMore: boolean
}

const terminalCompletionTimeSql = sql<Date | null>`date_trunc('milliseconds', CASE
  WHEN ${workStreams.metadata}->'completion' ? 'completedAt' THEN
    CASE
      WHEN jsonb_typeof(${workStreams.metadata}->'completion'->'completedAt') = 'string'
        AND pg_input_is_valid(${workStreams.metadata}->'completion'->>'completedAt', 'timestamp with time zone')
      THEN ((${workStreams.metadata}->'completion'->>'completedAt')::timestamptz AT TIME ZONE 'UTC')
      ELSE NULL
    END
  ELSE ${workStreams.updatedAt}
END)`

const terminalPriorityRankSql = sql<number>`CASE ${workStreams.priority}
  WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3
END`

const terminalCreatedAtSql = sql<Date>`date_trunc('milliseconds', ${workStreams.createdAt})`

function terminalCursorCondition(cursor: TerminalWorkStreamCursorKey): SQL {
  const priorityRank = { critical: 0, high: 1, normal: 2, low: 3 }[cursor.priority]
  const ordinaryAfter = sql`(
    ${terminalPriorityRankSql} > ${priorityRank}
    OR (${terminalPriorityRankSql} = ${priorityRank} AND ${terminalCreatedAtSql} > ${cursor.createdAt.toISOString()}::timestamp)
    OR (${terminalPriorityRankSql} = ${priorityRank} AND ${terminalCreatedAtSql} = ${cursor.createdAt.toISOString()}::timestamp AND ${workStreams.id} > ${cursor.id}::uuid)
  )`
  if (cursor.completedAt === null) {
    return sql`${terminalCompletionTimeSql} IS NULL AND ${ordinaryAfter}`
  }
  return sql`(
    ${terminalCompletionTimeSql} < ${cursor.completedAt.toISOString()}::timestamptz
    OR ${terminalCompletionTimeSql} IS NULL
    OR (${terminalCompletionTimeSql} = ${cursor.completedAt.toISOString()}::timestamptz AND ${ordinaryAfter})
  )`
}

export interface WorkStreamCancellationStopResult {
  agentId: string
  stopped: boolean
  reason?: string
}

export interface WorkStreamCancellationResult {
  workStream: WorkStream
  stopResults: WorkStreamCancellationStopResult[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(link: Record<string, unknown>, field: keyof WorkStreamSourceLink, kind: string): void {
  if (typeof link[field] !== 'string' || link[field].length === 0) {
    throw new Error(`metadata.sources ${kind} source link requires ${String(field)}`)
  }
}

interface WorkStreamSourceWarning {
  code: 'memory_document_not_found'
  message: string
  sourceIndex: number
  sourceKind: 'memory_document'
  sourceSquadId: string
  path: string
}

function validateSourceLinks(sources: unknown): WorkStreamSourceLink[] {
  if (!Array.isArray(sources)) {
    throw new Error('metadata.sources must be an array')
  }

  return sources.map((source, index) => {
    if (!isPlainObject(source)) {
      throw new Error(`metadata.sources[${index}] must be an object`)
    }

    const kindResult = workStreamSourceLinkKindSchema.safeParse(source.kind)
    if (!kindResult.success) {
      throw new Error(`metadata.sources[${index}] has invalid kind`)
    }

    const link: Record<string, unknown> & { kind: WorkStreamSourceLink['kind'] } = { ...source, kind: kindResult.data }
    if (link.addedAt !== undefined && typeof link.addedAt !== 'string') {
      throw new Error(`metadata.sources[${index}].addedAt must be an ISO8601 string`)
    }

    switch (link.kind) {
      case 'memory_document':
        requireString(link, 'sourceSquadId', link.kind)
        requireString(link, 'path', link.kind)
        break
      case 'slack_thread':
      case 'github_issue':
      case 'linear_issue':
        if (typeof link.url !== 'string' && typeof link.sourceId !== 'string') {
          throw new Error(`metadata.sources ${link.kind} source link requires url or sourceId`)
        }
        break
      case 'url':
        requireString(link, 'url', link.kind)
        break
    }

    return {
      ...link,
      addedAt: typeof link.addedAt === 'string' && link.addedAt.length > 0 ? link.addedAt : new Date().toISOString(),
    } as WorkStreamSourceLink
  })
}

async function validateMemoryDocumentSources(
  sources: WorkStreamSourceLink[],
  executor?: Pick<typeof db, 'select'>
): Promise<WorkStreamSourceWarning[]> {
  const warnings: WorkStreamSourceWarning[] = []
  const indexer = IndexingService.instance()

  // Sequential on purpose: when `executor` is an open transaction, parallel
  // reads would fan out onto the shared pool (hold-and-wait); a handful of
  // sources on an admin edit does not need parallelism.
  for (const [sourceIndex, source] of sources.entries()) {
    if (source.kind !== 'memory_document') continue

    const sourceSquadId = source.sourceSquadId
    const path = source.path
    if (!sourceSquadId || !path) continue

    const document = await indexer.getDocumentByPath(sourceSquadId, path, executor)
    if (document) continue

    warnings.push({
      code: 'memory_document_not_found',
      message: `Memory document source not found: ${sourceSquadId} ${path}`,
      sourceIndex,
      sourceKind: 'memory_document',
      sourceSquadId,
      path,
    })
  }

  return warnings.sort((a, b) => a.sourceIndex - b.sourceIndex)
}

async function validateMetadataSources(
  metadata: Record<string, unknown>,
  executor?: Pick<typeof db, 'select'>
): Promise<void> {
  if (metadata.sources === undefined) {
    delete metadata.sourceWarnings
    return
  }

  const sources = validateSourceLinks(metadata.sources)
  metadata.sources = sources

  const warnings = await validateMemoryDocumentSources(sources, executor)
  if (warnings.length > 0) {
    metadata.sourceWarnings = warnings
  } else {
    delete metadata.sourceWarnings
  }
}

/** The live stream that already handles an observed integration event, if any. */
async function streamHandlingEvent(
  store: Pick<typeof db, 'select'>,
  squadId: string,
  eventId: string
): Promise<string | undefined> {
  const [existing] = await store
    .select({ id: workStreams.id })
    .from(workStreams)
    .where(
      and(
        eq(workStreams.squadId, squadId),
        inArray(workStreams.status, ['active', 'queued']),
        sql`${workStreams.metadata}->'tracked' @> ${JSON.stringify([{ origin: { eventId } }])}::jsonb`
      )
    )
    .limit(1)
  return existing?.id
}

function isWorkContinuingUpdate(input: UpdateWorkStreamInput): boolean {
  return (
    (input.status !== undefined && input.status !== 'canceled') ||
    input.assigneeAgentId !== undefined ||
    input.agentIds !== undefined ||
    input.handoffMessage !== undefined
  )
}

function isTerminalStatus(status: WorkStreamStatus): boolean {
  return status === 'done' || status === 'canceled'
}

function withTerminalCompletion(
  metadata: Record<string, unknown>,
  previousMetadata: Record<string, unknown>,
  previousStatus: WorkStreamStatus,
  nextStatus: WorkStreamStatus,
  previousUpdatedAt: Date,
  now: Date
): Record<string, unknown> {
  const next = { ...metadata }
  const completion = { ...((next.completion as Record<string, unknown> | undefined) ?? {}) }
  const previousCompletion = previousMetadata.completion as Record<string, unknown> | undefined
  const wasTerminal = isTerminalStatus(previousStatus)
  const isTerminal = isTerminalStatus(nextStatus)

  if (!wasTerminal && isTerminal) {
    completion.completedAt = now.toISOString()
  } else if (wasTerminal && isTerminal) {
    completion.completedAt =
      typeof previousCompletion?.completedAt === 'string'
        ? previousCompletion.completedAt
        : previousUpdatedAt.toISOString()
  } else if (wasTerminal && !isTerminal) {
    delete completion.completedAt
  }

  if (Object.keys(completion).length > 0) next.completion = completion
  else delete next.completion
  return next
}

export class WorkStream extends BaseEntity<WorkStreamJson, UpdateWorkStreamInput> implements WorkStreamRow {
  // Row fields
  declare number: number
  declare id: string
  declare squadId: string
  declare title: string
  declare description: string
  declare pause: WorkStreamRow['pause']
  declare status: WorkStreamStatus
  declare priority: WorkStreamPriority
  declare assigneeAgentId: string | null
  declare ownerAgentId: string | null
  declare creatorAgentId: string | null
  worktreeCleanup: WorktreeCleanupSummary | null = null
  declare autoCleanupWorktree: boolean
  declare assignedReviewerIds: string[]
  declare requestingUserId: string | null
  declare agentIds: string[] | null
  declare dependsOn: string[]
  /** Computed inverse edges within this stream's squad; never persisted. */
  dependedOnBy: string[] = []
  declare handoffMessage: string | null
  declare files: string[]
  declare metadata: Record<string, unknown>
  declare createdAt: Date
  declare updatedAt: Date

  // Relation cache
  private _squad?: Squad | null
  private _assignee?: Agent | null
  private _agents?: Agent[]

  constructor(data: WorkStreamRow) {
    super()
    Object.assign(this, data)

    // Normalize jsonb fields
    this.files = (data.files as string[]) ?? []
    this.metadata = (data.metadata as Record<string, unknown>) ?? {}
    this.assignedReviewerIds = data.assignedReviewerIds ?? []
    this.dependsOn = data.dependsOn ?? []
    this.agentIds = data.agentIds ?? null
  }

  /** Populate inverse dependency edges from authoritative same-squad forward edges. */
  private static async hydrateDependedOnBy(streams: WorkStream[]): Promise<WorkStream[]> {
    if (streams.length === 0) return streams
    const squadIds = [...new Set(streams.map((stream) => stream.squadId))]
    const rows = await db
      .select({ id: workStreams.id, squadId: workStreams.squadId, dependsOn: workStreams.dependsOn })
      .from(workStreams)
      .where(inArray(workStreams.squadId, squadIds))
    const requestedIds = new Set(streams.map((stream) => stream.id))
    const inverse = new Map<string, string[]>()
    for (const row of rows) {
      for (const dependencyId of row.dependsOn ?? []) {
        if (!requestedIds.has(dependencyId)) continue
        const dependency = streams.find((stream) => stream.id === dependencyId && stream.squadId === row.squadId)
        if (dependency) inverse.set(dependencyId, [...(inverse.get(dependencyId) ?? []), row.id])
      }
    }
    for (const stream of streams) stream.dependedOnBy = inverse.get(stream.id) ?? []
    const cleanupRows = await db
      .select()
      .from(worktreeCleanupJobs)
      .where(inArray(worktreeCleanupJobs.workStreamId, [...requestedIds]))
    const cleanups = new Map(cleanupRows.map((row) => [row.workStreamId, row]))
    for (const stream of streams) {
      const cleanup = cleanups.get(stream.id)
      stream.worktreeCleanup = cleanup
        ? {
            status: cleanup.status,
            reason: cleanup.reason,
            attempts: cleanup.attempts,
            operationId: cleanup.operationId,
            nextAttemptAt: cleanup.nextAttemptAt.toISOString(),
            updatedAt: cleanup.updatedAt.toISOString(),
          }
        : null
    }
    return streams
  }

  /** Apply a returned mutation row and refresh its authoritative inverse edges. */
  private async assignMutationRow(row: WorkStreamRow): Promise<void> {
    Object.assign(this, new WorkStream(row))
    await WorkStream.hydrateDependedOnBy([this])
  }

  /** Immutable terminal transition instant, with updatedAt fallback for legacy rows. */
  get completedAt(): Date | undefined {
    if (!isTerminalStatus(this.status)) return undefined
    const completion = this.metadata?.completion as Record<string, unknown> | undefined
    if (completion && Object.prototype.hasOwnProperty.call(completion, 'completedAt')) {
      const raw = completion.completedAt
      if (typeof raw === 'string') {
        const parsed = new Date(raw)
        if (Number.isFinite(parsed.getTime())) return parsed
      }
      return new Date(Number.NaN)
    }
    return this.updatedAt
  }

  /**
   * Resolved completion mode for this work stream. Defaults to 'pr-merge' if unset
   * or if the stored value is unrecognized.
   */
  get completionMode(): WorkStreamCompletionMode {
    const stored = (this.metadata?.completion as Record<string, unknown> | undefined)?.mode
    if (
      stored === 'pr-merge' ||
      stored === 'pr-auto-merge' ||
      stored === 'review-approval' ||
      stored === 'direct-merge' ||
      stored === 'deliverable'
    ) {
      return stored
    }
    return 'pr-merge'
  }

  get branch(): string | undefined {
    const value = (this.metadata?.git as Record<string, unknown> | undefined)?.branch
    return typeof value === 'string' ? value : undefined
  }

  get worktree(): string | undefined {
    const value = (this.metadata?.git as Record<string, unknown> | undefined)?.worktree
    return typeof value === 'string' ? value : undefined
  }

  get baseBranch(): string | undefined {
    const value = (this.metadata?.git as Record<string, unknown> | undefined)?.baseBranch
    return typeof value === 'string' ? value : undefined
  }

  static get selectColumns() {
    return {
      id: workStreams.id,
      autoCleanupWorktree: workStreams.autoCleanupWorktree,
      number: workStreams.number,
      squadId: workStreams.squadId,
      title: workStreams.title,
      description: workStreams.description,
      status: workStreams.status,
      pause: workStreams.pause,
      priority: workStreams.priority,
      assigneeAgentId: workStreams.assigneeAgentId,
      ownerAgentId: workStreams.ownerAgentId,
      creatorAgentId: workStreams.creatorAgentId,
      requestingUserId: workStreams.requestingUserId,
      assignedReviewerIds: workStreams.assignedReviewerIds,
      agentIds: workStreams.agentIds,
      dependsOn: workStreams.dependsOn,
      handoffMessage: workStreams.handoffMessage,
      files: workStreams.files,
      metadata: workStreams.metadata,
      createdAt: workStreams.createdAt,
      updatedAt: workStreams.updatedAt,
    }
  }

  /**
   * Merge typed next-steps/completion/git fields into a metadata object.
   * Returns a new object; does not mutate input.
   */
  private static mergeTypedFieldsIntoMetadata(
    input: {
      nextSteps?: string
      completionMode?: WorkStreamCompletionMode
      branch?: string
      worktree?: string
      baseBranch?: string
    },
    existingMetadata: Record<string, unknown> = {}
  ): Record<string, unknown> {
    const metadata: Record<string, unknown> = { ...existingMetadata }

    if (input.nextSteps !== undefined) {
      metadata.nextSteps = input.nextSteps
    }

    if (input.completionMode !== undefined) {
      const completion = { ...((metadata.completion as Record<string, unknown>) ?? {}) }
      completion.mode = input.completionMode
      metadata.completion = completion
    }

    if (input.branch !== undefined || input.worktree !== undefined || input.baseBranch !== undefined) {
      const git = { ...((metadata.git as Record<string, unknown>) ?? {}) }
      if (input.branch !== undefined) git.branch = input.branch
      if (input.worktree !== undefined) git.worktree = input.worktree
      if (input.baseBranch !== undefined) git.baseBranch = input.baseBranch
      metadata.git = git
    }

    return metadata
  }

  // ---------------------------------------------------------------------------
  // Static Methods
  // ---------------------------------------------------------------------------

  /**
   * Find a work stream by ID (supports prefix matching).
   */
  static async find(id: string): Promise<WorkStream | null> {
    id = String(id).trim().toLowerCase()
    const numeric = id.replace(/^#/, '')
    if (/^[1-9]\d*$/.test(numeric) && Number(numeric) <= 2147483647) {
      const [row] = await db
        .select(WorkStream.selectColumns)
        .from(workStreams)
        .where(eq(workStreams.number, Number(numeric)))
        .limit(1)
      if (row) return (await WorkStream.hydrateDependedOnBy([new WorkStream(row)]))[0]
      if (id.startsWith('#')) return null
    }
    const template = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
    if (!id || id.length > 36 || [...id].some((c, i) => (template[i] === '-' ? c !== '-' : !/[0-9a-f]/.test(c))))
      return null
    const rows = await db
      .select(WorkStream.selectColumns)
      .from(workStreams)
      .where(id.length < 36 ? uuidPrefixCondition(workStreams.id, id) : eq(workStreams.id, id))
      .limit(2)

    if (rows.length === 0) return null
    if (rows.length > 1) throw new AmbiguousPrefixError('workStream', id)

    return (await WorkStream.hydrateDependedOnBy([new WorkStream(rows[0])]))[0]
  }

  /**
   * Find a work stream by ID, throwing if not found.
   */
  static async mustFind(id: string): Promise<WorkStream> {
    const ws = await this.find(id)
    if (!ws) throw new Error(`Work stream ${id} not found`)
    return ws
  }

  /**
   * Create a new work stream.
   */
  static async create(input: CreateWorkStreamInput): Promise<WorkStream> {
    if (input.dependsOn)
      input = {
        ...input,
        dependsOn: await Promise.all(input.dependsOn.map(async (id) => (await WorkStream.mustFind(id)).id)),
      }
    // Creation has one path. Stored legacy streams retain their existing lifecycle.
    if (
      input.agents !== undefined ||
      input.agentIds !== undefined ||
      input.assigneeAgentId !== undefined ||
      input.assigneeAgentIndex !== undefined ||
      input.agentModelOverrides !== undefined ||
      input.completionMode !== undefined
    )
      throw new Error(
        'Legacy work-stream creation is no longer supported. Use a workflow or ephemeral flow for participants, models, and delivery policy.'
      )
    const squad = await Squad.mustFind(input.squadId)
    await validateAssignedReviewers(input.assignedReviewerIds ?? [], squad.id)
    const source = await resolveCreationWorkflow(input.workflow, squad)
    input = { ...input, workflow: source }
    let mergedMetadata = WorkStream.mergeTypedFieldsIntoMetadata(input, input.metadata)
    await validateMetadataSources(mergedMetadata)
    await validateTrackedMetadata(input.squadId, mergedMetadata, undefined, {
      allowOriginEventId: input.integrationEventId,
    })
    // Settle the replay before provisioning anything: the in-transaction check below rolls back,
    // but a worktree created by setupWorkStreamRepository would already be on disk.
    if (input.integrationEventId) {
      const handled = await streamHandlingEvent(db, input.squadId, input.integrationEventId)
      if (handled) throw new WorkStreamEventAlreadyHandledError(handled)
    }
    if (input.gitRemote && !input.repository) throw new RepositorySetupError('gitRemote requires repository')
    const streamId = crypto.randomUUID()
    let ownership: WorktreeOwnership | undefined
    if (input.repository)
      mergedMetadata = await setupWorkStreamRepository(input.squadId, input, streamId, mergedMetadata, (receipt) => {
        ownership = receipt
      })

    const attachmentCheck = await prepareWorktreeAttachmentCheck(input.squadId, streamId, mergedMetadata)

    // An ownerless stream notifies NOBODY at creation (the owner notice below
    // requires an owner), so it sits idle until someone happens to look — the
    // consultant flow only worked because consultants pass the manager
    // explicitly. Default the owner to the squad manager so every creation
    // path (CLI, API, agent tools) routes to a responsible agent. A
    // manager-created stream defaults to themselves, and the creator==owner
    // guard in notifyWorkStreamOwnerOfNewStream keeps that from self-
    // notifying. Squads without a manager keep a null owner as before.
    let ownerAgentId = input.ownerAgentId ?? null
    if (!ownerAgentId) {
      const [squadRow] = await db
        .select({ managerAgentId: squads.managerAgentId })
        .from(squads)
        .where(eq(squads.id, input.squadId))
      ownerAgentId = squadRow?.managerAgentId ?? null
    }

    const row = await db.transaction(async (tx) => {
      await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, input.squadId)).for('update')
      // One live stream per observed event: concurrent creates serialize on the squad lock.
      if (input.integrationEventId) {
        const handled = await streamHandlingEvent(tx, input.squadId, input.integrationEventId)
        if (handled) throw new WorkStreamEventAlreadyHandledError(handled)
      }
      await assertWorktreeAttachmentsAvailable(tx, {
        id: streamId,
        squadId: input.squadId,
        metadata: mergedMetadata,
        resolved: attachmentCheck,
        dependsOn: input.dependsOn ?? [],
      })
      const [created] = await tx
        .insert(workStreams)
        .values({
          id: streamId,
          autoCleanupWorktree: input.autoCleanupWorktree ?? true,
          squadId: input.squadId,
          title: input.title,
          description: input.description ?? '',
          assigneeAgentId: null,
          ownerAgentId,
          creatorAgentId: input.creatorAgentId ?? null,
          requestingUserId: input.requestingUserId ?? null,
          assignedReviewerIds: input.assignedReviewerIds ?? [],
          agentIds: null,
          handoffMessage: input.handoffMessage ?? null,
          dependsOn: input.dependsOn ?? [],
          priority: input.priority ?? 'normal',
          metadata: mergedMetadata,
        })
        .returning()
      if (ownership)
        await tx.insert(workStreamWorktrees).values({ workStreamId: created.id, squadId: created.squadId, ownership })
      // System-maintained dependency waits: one open record per unsatisfied
      // dependency, in the same transaction as the edge write.
      if (created.dependsOn?.length) {
        await syncDependencyWaits(tx, created.id, created.dependsOn)
      }
      const { attachFlow } = await import('../services/workflows/execution')
      await attachFlow(tx, created, source)
      // Reserve admission before any participant starts. A full squad retains
      // the flow snapshot in the queue without spawning its workers.
      const { admitOrQueueAtCreation } = await import('../services/work-streams/admission')
      const outcome = await admitOrQueueAtCreation(tx, { squadId: created.squadId, streamId: created.id })
      return outcome === 'queued' ? { ...created, status: 'queued' as const } : created
    })

    const ws = new WorkStream(row)
    const { ensureFlowDispatch } = await import('../services/workflows/execution')
    await ensureFlowDispatch(ws.id)
    eventEmitter.emit('workStream.created', { workStreamId: ws.id, squadId: ws.squadId })
    await notifyWorkStreamOwnerOfNewStream(ws)
    return WorkStream.mustFind(ws.id)
  }

  /**
   * List work streams with optional filters.
   */
  static async list(filters?: ListWorkStreamsFilters): Promise<WorkStream[]> {
    const conditions: SQL[] = []

    if (filters?.squadId) {
      conditions.push(uuidPrefixCondition(workStreams.squadId, filters.squadId))
    }
    if (filters?.statuses && filters.statuses.length > 0) {
      conditions.push(inArray(workStreams.status, filters.statuses))
    } else if (filters?.status) {
      conditions.push(eq(workStreams.status, filters.status))
    }

    const results = await db
      .select(WorkStream.selectColumns)
      .from(workStreams)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(workStreams.createdAt))

    return WorkStream.hydrateDependedOnBy(results.map((row) => new WorkStream(row)))
  }

  /** Load lightweight fields needed to order a frozen non-terminal snapshot. */
  static async listNonTerminalOrderCandidates(options: {
    squadId?: string
    squadIds?: string[]
    statuses: WorkStreamStatus[]
    createdBefore: Date
  }): Promise<NonTerminalOrderCandidate[]> {
    const conditions: SQL[] = [
      inArray(workStreams.status, options.statuses),
      sql`date_trunc('milliseconds', ${workStreams.createdAt}) <= ${options.createdBefore.toISOString()}::timestamptz`,
    ]
    if (options.squadId) conditions.push(uuidPrefixCondition(workStreams.squadId, options.squadId))
    if (options.squadIds) conditions.push(inArray(workStreams.squadId, options.squadIds))
    return (
      db
        .select({
          id: workStreams.id,
          title: workStreams.title,
          squadId: workStreams.squadId,
          status: workStreams.status,
          pause: workStreams.pause,
          priority: workStreams.priority,
          assigneeAgentId: workStreams.assigneeAgentId,
          agentIds: workStreams.agentIds,
          dependsOn: workStreams.dependsOn,
          metadata: workStreams.metadata,
          createdAt: workStreams.createdAt,
          updatedAt: workStreams.updatedAt,
        })
        .from(workStreams)
        .where(and(...conditions))
        // Raw order is deliberately the opposite of canonical id ties so tests
        // cannot pass accidentally when the canonical ordering seam is bypassed.
        .orderBy(desc(workStreams.createdAt), desc(workStreams.id))
    )
  }

  /** Count an authorized status-filtered list without loading rows or runtime annotations. */
  static async countList(options: {
    squadId?: string
    squadIds?: string[]
    statuses?: WorkStreamStatus[]
    status?: WorkStreamStatus
    completedAfter?: Date
    completedBefore?: Date
  }): Promise<number> {
    const conditions: SQL[] = []
    if (options.statuses && options.statuses.length > 0) conditions.push(inArray(workStreams.status, options.statuses))
    else if (options.status) conditions.push(eq(workStreams.status, options.status))
    if (options.squadId) conditions.push(uuidPrefixCondition(workStreams.squadId, options.squadId))
    if (options.squadIds) conditions.push(inArray(workStreams.squadId, options.squadIds))
    if (options.completedAfter)
      conditions.push(sql`${terminalCompletionTimeSql} > ${options.completedAfter.toISOString()}::timestamptz`)
    if (options.completedBefore)
      conditions.push(sql`${terminalCompletionTimeSql} <= ${options.completedBefore.toISOString()}::timestamptz`)
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(workStreams)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
    return rows[0]?.count ?? 0
  }

  /** Load a bounded frozen snapshot page without volatile status predicates. */
  static async listSnapshotRowsByIds(ids: string[]): Promise<WorkStream[]> {
    if (ids.length === 0) return []
    const rows = await db.select(WorkStream.selectColumns).from(workStreams).where(inArray(workStreams.id, ids))
    return WorkStream.hydrateDependedOnBy(rows.map((row) => new WorkStream(row)))
  }

  /**
   * Keyset-page terminal history without resolving the cursor row through the
   * current status filter. The cursor key therefore survives reopen/removal.
   */
  static async listTerminalPage(options: {
    squadId?: string
    squadIds?: string[]
    statuses: WorkStreamStatus[]
    limit: number
    cursor?: TerminalWorkStreamCursorKey
    completedBefore?: Date
    completedAfter?: Date
  }): Promise<TerminalWorkStreamPage> {
    const conditions: SQL[] = [inArray(workStreams.status, options.statuses)]
    if (options.squadId) conditions.push(uuidPrefixCondition(workStreams.squadId, options.squadId))
    if (options.squadIds) conditions.push(inArray(workStreams.squadId, options.squadIds))
    if (options.completedBefore)
      conditions.push(sql`${terminalCompletionTimeSql} <= ${options.completedBefore.toISOString()}::timestamptz`)
    if (options.completedAfter)
      conditions.push(sql`${terminalCompletionTimeSql} > ${options.completedAfter.toISOString()}::timestamptz`)
    const countWhere = and(...conditions)
    if (options.cursor) conditions.push(terminalCursorCondition(options.cursor))

    const [rows, countRows] = await Promise.all([
      db
        .select(WorkStream.selectColumns)
        .from(workStreams)
        .where(and(...conditions))
        .orderBy(
          sql`${terminalCompletionTimeSql} DESC NULLS LAST`,
          terminalPriorityRankSql,
          terminalCreatedAtSql,
          workStreams.id
        )
        .limit(options.limit + 1),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(workStreams)
        .where(countWhere),
    ])
    return {
      items: await WorkStream.hydrateDependedOnBy(rows.slice(0, options.limit).map((row) => new WorkStream(row))),
      totalCount: countRows[0]?.count ?? 0,
      hasMore: rows.length > options.limit,
    }
  }

  /**
   * List work streams assigned to an agent.
   */
  static async findByAgent(agentId: string): Promise<WorkStream[]> {
    const results = await db
      .select(WorkStream.selectColumns)
      .from(workStreams)
      .where(sql`${agentId} = ANY(${workStreams.agentIds})`)
      .orderBy(desc(workStreams.createdAt))

    return WorkStream.hydrateDependedOnBy(results.map((row) => new WorkStream(row)))
  }

  /**
   * List work streams where the agent is the assignee OR a member of agentIds,
   * optionally filtered to the given statuses. Backs the sandbox keepalive/idle
   * checks, which must consider both assignment shapes.
   */
  static async listForAgent(agentId: string, statuses?: WorkStreamStatus[]): Promise<WorkStream[]> {
    const conditions: SQL[] = [
      sql`(${workStreams.assigneeAgentId} = ${agentId} OR ${agentId} = ANY(${workStreams.agentIds}))`,
    ]
    if (statuses && statuses.length > 0) {
      conditions.push(inArray(workStreams.status, statuses))
    }
    const results = await db
      .select(WorkStream.selectColumns)
      .from(workStreams)
      .where(and(...conditions))
      .orderBy(desc(workStreams.createdAt))
    return WorkStream.hydrateDependedOnBy(results.map((row) => new WorkStream(row)))
  }

  /**
   * Find work streams whose metadata matches all given key-value pairs.
   * Keys support dot notation for nested paths (e.g. "github.pr.number").
   */
  static async findByMetadata(
    matches: Record<string, string>,
    options?: { status?: WorkStreamStatus }
  ): Promise<WorkStream[]> {
    const conditions = Object.entries(matches).map(([path, value]) => {
      // Convert dot notation to Postgres jsonb path: "github.pr.number" -> metadata->'github'->'pr'->>'number'
      const parts = path.split('.')
      const lastPart = parts.pop()!
      let accessor = 'metadata'
      for (const part of parts) {
        accessor += `->'${part}'`
      }
      accessor += `->>'${lastPart}'`
      return sql.raw(`${accessor} = '${value.replace(/'/g, "''")}'`)
    })

    if (options?.status) {
      conditions.push(eq(workStreams.status, options.status))
    }

    const results = await db
      .select(WorkStream.selectColumns)
      .from(workStreams)
      .where(and(...conditions))
      .orderBy(desc(workStreams.createdAt))

    return WorkStream.hydrateDependedOnBy(results.map((row) => new WorkStream(row)))
  }

  /**
   * Update a work stream by ID.
   */
  static async update(id: string, input: UpdateWorkStreamInput): Promise<WorkStream> {
    const ws = await WorkStream.mustFind(id)
    return ws.update(input)
  }

  // ---------------------------------------------------------------------------
  // Instance Methods
  // ---------------------------------------------------------------------------

  /**
   * Update this work stream.
   */
  /**
   * `opts.actorAgentId` — the agent performing this mutation, when one is
   * known. It is NOT a column: it exists only so the notifications this
   * transition fires can decline to tell that agent what it just did
   * (services/squad/work-stream-notifications.ts). Absent = user/system/unknown
   * and everyone is notified, which is the historical behavior.
   */
  override async update(
    input: UpdateWorkStreamInput,
    opts: {
      actorAgentId?: string | null
      flowCompletion?: { version: number; metadataHash: string; deliveredHead?: string }
    } = {}
  ): Promise<this> {
    const safe = {
      title: input.title,
      description: input.description,
      handoffMessage: input.handoffMessage,
      metadata: input.metadata,
      nextSteps: input.nextSteps,
    }
    input = { ...input, ...safe }
    if (this.status === 'canceled' && isWorkContinuingUpdate(input)) {
      throw new Error('Cannot continue or assign a canceled work stream')
    }

    if (input.dependsOn)
      input = {
        ...input,
        dependsOn: await Promise.all(input.dependsOn.map(async (id) => (await WorkStream.mustFind(id)).id)),
      }
    // dependsOn writes must keep the squad's dependency graph a DAG (cycles
    // would break effective-priority computation and admission eligibility).
    if (input.dependsOn !== undefined && input.dependsOn.length > 0) {
      const { assertNoDependencyCycle } = await import('../services/work-streams/dependency-graph')
      const squadStreams = await db
        .select({ id: workStreams.id, title: workStreams.title, dependsOn: workStreams.dependsOn })
        .from(workStreams)
        .where(eq(workStreams.squadId, this.squadId))
      assertNoDependencyCycle(
        squadStreams.map((s) => ({ ...s, dependsOn: s.dependsOn ?? [] })),
        this.id,
        input.dependsOn
      )
    }

    if (input.assignedReviewerIds !== undefined)
      await validateAssignedReviewers(input.assignedReviewerIds, this.squadId)
    if (input.agentIds?.length) {
      input.agentIds = await Agent.validateAgentIds(input.agentIds)
    }

    if (input.gitRemote && !input.repository) throw new RepositorySetupError('gitRemote requires repository')
    const assertSetupAllowed = (stream: {
      agentIds: string[] | null
      assigneeAgentId: string | null
      status: string
      pause: unknown
    }) => {
      if (
        ['done', 'canceled'].includes(stream.status) ||
        stream.agentIds?.length ||
        stream.assigneeAgentId ||
        (stream.status !== 'queued' && !stream.pause)
      )
        throw new Error('Repository setup requires a queued or paused work stream whose agents have not started')
    }
    const repositoryMetadataBeforeSetup = { git: this.metadata?.git, codeHost: this.metadata?.codeHost }
    let prepared: Record<string, unknown> | undefined
    let preparedOwnership: WorktreeOwnership | undefined
    if (input.repository) {
      assertSetupAllowed(this)
      prepared = await setupWorkStreamRepository(
        this.squadId,
        input,
        this.id,
        deepMergeMetadata(this.metadata ?? {}, input.metadata ?? {}),
        (receipt) => {
          preparedOwnership = receipt
        }
      )
    }

    const hasTypedFields =
      input.nextSteps !== undefined ||
      input.completionMode !== undefined ||
      input.branch !== undefined ||
      input.worktree !== undefined ||
      input.baseBranch !== undefined

    // Strip typed fields from input so drizzle doesn't try to write them as columns
    const {
      repository: _repository,
      gitRemote: _gitRemote,
      nextSteps: _nextSteps,
      completionMode: _completionMode,
      branch: _branch,
      worktree: _worktree,
      baseBranch: _baseBranch,
      ...dbInput
    } = input

    const prospectiveMetadata =
      prepared ??
      WorkStream.mergeTypedFieldsIntoMetadata(input, deepMergeMetadata(this.metadata ?? {}, input.metadata ?? {}))
    // Authorize tracked links before the transaction: the provider lookup opens its own
    // transaction and locks this squad's row, which would hang against the lock taken below.
    if (input.metadata && Object.prototype.hasOwnProperty.call(input.metadata, 'tracked'))
      await validateTrackedMetadata(this.squadId, prospectiveMetadata, this.metadata ?? {})
    // Reject a malformed code host binding where it is written, not at flow finish. Only writes that
    // touch codeHost are checked, so unrelated metadata edits never trip over pre-existing shapes.
    if (input.metadata && Object.prototype.hasOwnProperty.call(input.metadata, 'codeHost')) {
      const described = describeCodeHostReference({ codeHost: prospectiveMetadata.codeHost })
      if (described.status === 'invalid')
        throw new Error(
          `codeHost metadata is invalid: ${described.issues.join('; ')}. Keep verification evidence outside codeHost (for example metadata.delivery).`
        )
    }
    const attachmentCheck = isDeepStrictEqual(
      worktreeAttachmentPaths(this.metadata ?? {}),
      worktreeAttachmentPaths(prospectiveMetadata)
    )
      ? undefined
      : await prepareWorktreeAttachmentCheck(this.squadId, this.id, prospectiveMetadata)

    const previousStatus = this.status
    const now = new Date()
    // Assigned inside the transaction, read after commit so the fast path
    // acts on exactly the agents the durable request accepted. Deriving the
    // eligible set twice would let the two paths disagree about who may sleep.
    let crewMarkedForDormancy: string[] = []
    const row = await db.transaction(async (tx) => {
      // Global lock order: transactions that may touch both rows always lock
      // squad before work_stream. Promotion/admission uses the same order.
      await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, this.squadId)).for('update')

      const [locked] = await tx.select().from(workStreams).where(eq(workStreams.id, this.id)).for('update')
      if (!locked) throw new Error(`Work stream ${this.id} not found`)
      await assertWorktreeCleanupMutable(tx, this.id)
      if (locked.pause && input.status === 'done') throw new Error('Resume the work stream before completing it')

      const { guardFlowMutation } = await import('../services/workflows/execution')
      await guardFlowMutation(tx, locked, input as Record<string, unknown>, false, opts.flowCompletion)

      // Terminal states exit only through reopen (spec §6): reject any raw
      // status write OUT of done/canceled (same-status writes stay no-ops).
      if (input.status !== undefined && input.status !== locked.status && isTerminalStatus(locked.status)) {
        throw new WorkStreamTerminalTransitionError(locked.status, input.status)
      }

      // Manual queued → admitted status writes must obey the squad concurrency
      // cap (same locked count as scheduler admission), or a direct PATCH /
      // `ws update --status` / handoff silently over-admits past the cap —
      // and nothing ever corrects it (the reconciler only promotes).
      if (
        input.status !== undefined &&
        locked.status === 'queued' &&
        (WORK_STREAM_ADMITTED_STATUSES as string[]).includes(input.status)
      ) {
        const { assertManualAdmissionAllowed } = await import('../services/work-streams/admission')
        await assertManualAdmissionAllowed(tx, { squadId: this.squadId, streamId: this.id, title: this.title })
      }

      if (input.status === 'queued' && WORK_STREAM_ADMITTED_STATUSES.includes(locked.status)) {
        const { guardManualWorkStreamDemotion } = await import('../services/work-streams/admission')
        await guardManualWorkStreamDemotion(tx, locked)
      }

      const currentMetadata = (locked.metadata as Record<string, unknown> | null) ?? {}
      let mergedMetadata: Record<string, unknown> | undefined
      if (input.metadata !== undefined || hasTypedFields || prepared) {
        const mergedBase = input.metadata ? deepMergeMetadata(currentMetadata, input.metadata) : currentMetadata
        mergedMetadata = hasTypedFields ? WorkStream.mergeTypedFieldsIntoMetadata(input, mergedBase) : mergedBase
        if (prepared) {
          assertSetupAllowed(locked)
          if (
            !isDeepStrictEqual(repositoryMetadataBeforeSetup, {
              git: currentMetadata.git,
              codeHost: currentMetadata.codeHost,
            })
          )
            throw new Error('Repository metadata changed during setup; read the work stream and retry')
          const [flow] = await tx
            .select({ bindings: workStreamFlowRuns.attemptAgents })
            .from(workStreamFlowRuns)
            .where(eq(workStreamFlowRuns.workStreamId, this.id))
          if (flow && Object.keys(flow.bindings).length)
            throw new Error('Repository setup cannot replace a workspace after workflow agents have started')
          if (preparedOwnership)
            await tx
              .insert(workStreamWorktrees)
              .values({ workStreamId: this.id, squadId: this.squadId, ownership: preparedOwnership })
          mergedMetadata = {
            ...mergedMetadata,
            git: prepared.git,
            ...(prepared.codeHost ? { codeHost: prepared.codeHost } : {}),
          }
        }
        if (input.metadata && Object.prototype.hasOwnProperty.call(input.metadata, 'sources')) {
          // Pass the open transaction: pool reads while holding tx = hold-and-wait.
          await validateMetadataSources(mergedMetadata, tx)
        }
        // Shape only: authorization already ran above, outside this transaction's locks.
        if (input.metadata && Object.prototype.hasOwnProperty.call(input.metadata, 'tracked'))
          parseTrackedMetadata(mergedMetadata)
      }
      // A new provisioning receipt was inserted above; only existing ownership is immutable.
      if (!preparedOwnership)
        await assertOwnedWorktreeBindingUnchanged(tx, this.id, currentMetadata, mergedMetadata ?? currentMetadata)
      await assertWorktreeAttachmentsAvailable(tx, {
        id: this.id,
        squadId: this.squadId,
        metadata: mergedMetadata ?? currentMetadata,
        checkPaths: !isDeepStrictEqual(
          worktreeAttachmentPaths(currentMetadata),
          worktreeAttachmentPaths(mergedMetadata ?? currentMetadata)
        ),
        resolved: attachmentCheck,
        dependsOn: input.dependsOn ?? locked.dependsOn ?? [],
      })
      const nextStatus = input.status ?? locked.status

      // `done` requires a settled conversation ledger (spec §5): any open wait
      // — review, manual, question, dependency — blocks completion. `cancel`
      // remains the force-clear path (abandonment discards conversations).
      if (nextStatus === 'done' && locked.status !== 'done') {
        const openWaits = await listOpenWaits(tx, this.id)
        if (openWaits.length > 0) {
          throw new WorkStreamOpenWaitsError(openWaits.map((w) => ({ id: w.id, type: w.type })))
        }
      }

      let completionNow = now
      if (!isTerminalStatus(locked.status) && isTerminalStatus(nextStatus)) {
        const [clock] = await tx.execute<{ now: string }>(
          sql`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`
        )
        if (!clock) throw new Error('Unable to read the work-stream completion database clock')
        completionNow = new Date(clock.now)
      }
      if (locked.status !== nextStatus || isTerminalStatus(locked.status)) {
        mergedMetadata = withTerminalCompletion(
          mergedMetadata ?? currentMetadata,
          currentMetadata,
          locked.status,
          nextStatus,
          locked.updatedAt,
          completionNow
        )
      }

      const [updated] = await tx
        .update(workStreams)
        .set({
          ...dbInput,
          ...(mergedMetadata !== undefined ? { metadata: mergedMetadata } : {}),
          updatedAt: now,
        })
        .where(eq(workStreams.id, this.id))
        .returning()

      if (updated.status === 'active' && (input.assigneeAgentId !== undefined || previousStatus !== 'active')) {
        await resetContinuationCycle(tx, this.id, updated.assigneeAgentId)
      } else if (previousStatus === 'active' && updated.status !== 'active') {
        await invalidateContinuationCycle(tx, this.id)
      }

      // Keep the system-maintained dependency waits in lockstep with the
      // authoritative dependsOn edge list (same transaction as the write).
      if (input.dependsOn !== undefined) {
        await syncDependencyWaits(tx, this.id, updated.dependsOn ?? [])
      }

      // Terminal transitions settle waits transactionally:
      // - done closes dependent streams' dependency waits (`satisfied`) — the
      //   spec's crash-window non-event: there is no between. The stream's OWN
      //   waits are already settled (the open-waits guard above).
      // - canceled force-clears the stream's remaining open waits (abandonment
      //   discards conversations by design — spec §5).
      if (updated.status === 'done' && input.autoCleanupWorktree !== undefined && locked.status === 'done') {
        await tx.insert(worktreeCleanupJobs).values({ workStreamId: this.id }).onConflictDoNothing()
        await tx
          .update(worktreeCleanupJobs)
          .set({
            generation: crypto.randomUUID(),
            status: input.autoCleanupWorktree ? 'pending' : 'skipped',
            reason: input.autoCleanupWorktree ? null : 'Automatic cleanup is disabled; worktree retained.',
            nextAttemptAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(worktreeCleanupJobs.workStreamId, this.id),
              inArray(worktreeCleanupJobs.status, ['pending', 'skipped', 'deferred', 'error']),
              sql`${worktreeCleanupJobs.operationId} IS NULL`
            )
          )
      }
      if (updated.status === 'done' && locked.status !== 'done') {
        await enqueueWorktreeCleanup(
          tx,
          this.id,
          updated.metadata as Record<string, unknown>,
          opts.flowCompletion?.deliveredHead
        )
        await closeDependencyWaitsForCompletedStream(tx, this.id)
      }
      if (updated.status === 'canceled' && previousStatus !== 'canceled') {
        await closeOpenWaits(tx, { workStreamId: this.id }, 'cleared', {
          note: 'stream canceled',
          closedAt: now,
        })
      }
      // Durable crew teardown. The post-commit cleanup below is the fast path;
      // this request is what survives a restart between commit and that call.
      if (
        (updated.status === 'done' && previousStatus !== 'done') ||
        (updated.status === 'canceled' && previousStatus !== 'canceled')
      ) {
        crewMarkedForDormancy = await markCrewForDormancy(tx, updated.agentIds ?? [])
      }
      return updated
    })

    await this.assignMutationRow(row)

    const payload = { workStreamId: this.id, squadId: this.squadId }

    // Emit status-specific events
    if (input.status === 'done' && previousStatus !== 'done') {
      await notifyWorkStreamDone(this, { actorAgentId: opts.actorAgentId })
      await cleanupAgentsForTerminalWorkStream(crewMarkedForDormancy)
      eventEmitter.emit('workStream.done', {
        ...payload,
        agentIds: this.agentIds ?? [],
        actorAgentId: opts.actorAgentId ?? null,
      })
    }

    // Emit assignment events
    if (input.assigneeAgentId && this.status !== 'queued') {
      await notifyWorkStreamAssigned(this, input.assigneeAgentId, opts.actorAgentId)
      eventEmitter.emit('workStream.assigned', {
        ...payload,
        agentId: input.assigneeAgentId,
        actorAgentId: opts.actorAgentId ?? null,
      })
    }

    eventEmitter.emit('workStream.updated', payload)

    // Demotion to 'queued' (parking via PATCH) releases the slot: stop the
    // crew's sandboxes (files stay; nothing terminated/archived) and admit the
    // next eligible queued stream.
    if (
      input.status === 'queued' &&
      previousStatus !== 'queued' &&
      (WORK_STREAM_ADMITTED_STATUSES as string[]).includes(previousStatus)
    ) {
      const { handleStreamDemotedToQueued } = await import('../services/work-streams/admission')
      await handleStreamDemotedToQueued(this)
    }

    return this
  }

  /**
   * Request stops for active executions on all agents bound to this work stream.
   */
  async requestStopForActiveAgentExecutions(): Promise<WorkStreamCancellationStopResult[]> {
    const stopResults: WorkStreamCancellationStopResult[] = []

    for (const agentId of this.agentIds ?? []) {
      const agent = await Agent.find(agentId)
      if (!agent) {
        stopResults.push({ agentId, stopped: false, reason: 'agent not found' })
        continue
      }

      const execution = await agent.getActiveExecution()
      if (!execution) {
        stopResults.push({ agentId: agent.id, stopped: false, reason: 'no active execution' })
        continue
      }

      const stopped = await execution.requestStopWithSignal()
      stopResults.push({
        agentId: agent.id,
        stopped,
        ...(stopped ? {} : { reason: `execution ${execution.status} cannot be stopped` }),
      })
    }

    return stopResults
  }

  /**
   * Cancel this work stream, requesting stops for active assigned executions first.
   */
  async cancelWithSideEffects(opts: { actorAgentId?: string | null } = {}): Promise<WorkStreamCancellationResult> {
    if (this.status === 'done') {
      throw new Error('Cannot cancel a completed work stream')
    }

    if (this.status === 'canceled') {
      return { workStream: this, stopResults: [] }
    }

    await this.cancel(opts)
    const stopResults = await this.requestStopForActiveAgentExecutions()

    return { workStream: this, stopResults }
  }

  /**
   * Cancel this work stream and prevent future continuation.
   */
  async cancel(opts: { actorAgentId?: string | null } = {}): Promise<this> {
    if (this.status === 'canceled') return this
    if (this.status === 'done') {
      throw new Error('Cannot cancel a completed work stream')
    }

    const capturedAgentIds = this.agentIds ?? []

    await this.update(
      {
        status: 'canceled',
        assigneeAgentId: null,
      },
      opts
    )

    await notifyWorkStreamCanceled(this, capturedAgentIds, opts.actorAgentId)
    await cleanupAgentsForTerminalWorkStream(capturedAgentIds)
    eventEmitter.emit('workStream.canceled', {
      workStreamId: this.id,
      squadId: this.squadId,
      agentIds: capturedAgentIds,
      actorAgentId: opts.actorAgentId ?? null,
    })

    return this
  }

  /**
   * Reopen a terminal stream (spec §6): from `done` OR `canceled` back into
   * ADMISSION. In one transaction: status → `queued`, the completion instant
   * clears (reverse of the terminal transition), and dependency waits
   * re-sync (a dependency that is no longer done reopens its wait). After
   * commit: `workStream.reopened` event + notification, then best-effort
   * promotion — the stream goes `active` when a slot is free and stays
   * `queued` under a full cap.
   */
  async reopen(opts: { actorAgentId?: string | null } = {}): Promise<this> {
    const { row, previousStatus } = await db.transaction(async (tx) => {
      // Global lock order: squad before work_stream (matches update/admission).
      await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, this.squadId)).for('update')
      const [locked] = await tx.select().from(workStreams).where(eq(workStreams.id, this.id)).for('update')
      if (!locked) throw new Error(`Work stream ${this.id} not found`)
      await assertWorktreeCleanupMutable(tx, this.id, true)
      if (!isTerminalStatus(locked.status)) {
        throw new WorkStreamNotReopenableError(locked.status)
      }
      const { reopenFlow } = await import('../services/workflows/execution')
      await reopenFlow(tx, this.id)
      const now = new Date()
      const currentMetadata = (locked.metadata as Record<string, unknown> | null) ?? {}
      // Reverse of the terminal transition: drop completion.completedAt
      // (withTerminalCompletion's terminal → non-terminal branch).
      const metadata = withTerminalCompletion(
        currentMetadata,
        currentMetadata,
        locked.status,
        'queued',
        locked.updatedAt,
        now
      )
      const [updated] = await tx
        .update(workStreams)
        .set({ status: 'queued', pause: null, metadata, updatedAt: now })
        .where(eq(workStreams.id, this.id))
        .returning()
      // Invalidate in-flight non-destructive decisions from the prior delivery.
      await tx
        .update(worktreeCleanupJobs)
        .set({
          generation: crypto.randomUUID(),
          status: 'skipped',
          reason: 'Work stream reopened; awaiting a new delivery.',
          updatedAt: now,
        })
        .where(
          and(
            eq(worktreeCleanupJobs.workStreamId, this.id),
            sql`${worktreeCleanupJobs.operationId} IS NULL`,
            sql`${worktreeCleanupJobs.status} <> 'succeeded'`
          )
        )
      // Dependencies may have changed while this stream was terminal (or been
      // reopened themselves): re-open one dependency wait per not-done dep.
      await syncDependencyWaits(tx, this.id, updated.dependsOn ?? [])
      return { row: updated, previousStatus: locked.status as 'done' | 'canceled' }
    })
    await this.assignMutationRow(row)

    const payload = { workStreamId: this.id, squadId: this.squadId }
    eventEmitter.emit('workStream.reopened', {
      ...payload,
      previousStatus,
      actorAgentId: opts.actorAgentId ?? null,
    })
    eventEmitter.emit('workStream.updated', payload)
    await notifyWorkStreamReopened(this, opts.actorAgentId)
    // Re-enter ADMISSION: promoted to `active` right away when a slot is
    // free; otherwise it queues and the reconciler converges it later.
    await this.promoteSquadBestEffort()
    await this.reload()
    return this
  }

  /**
   * Reload this work stream from the database.
   */
  override async reload(): Promise<this> {
    const fresh = await WorkStream.mustFind(this.id)
    Object.assign(this, fresh)
    return this
  }

  /** The stream's open wait records, newest first. */
  async getOpenWaits(): Promise<WorkStreamWaitRow[]> {
    return listOpenWaits(db, this.id)
  }

  private assertNotTerminal(action: string): void {
    if (this.status === 'canceled') throw new Error('Work stream has been canceled')
    if (this.status === 'done') throw new Error(`Cannot ${action} a completed work stream`)
  }

  /**
   * Hand this stream off for review: opens the (unique) review wait.
   * Idempotent — a second handoff while a review wait is open is a no-op that
   * returns `alreadyOpen: true` (pinned; no 409).
   */
  async handoffForReview(
    opts: {
      message?: string | null
      createdBy?: WorkStreamWaitCreatedBy
      createdByAgentId?: string | null
      createdByUserId?: string | null
      /**
       * Default true: approving this review completes the stream in one
       * transaction. False = mid-work checkpoint review — approval resolves
       * the wait only and the stream continues (spec §4).
       */
      completesOnApproval?: boolean
    } = {}
  ): Promise<{ wait: WorkStreamWaitRow; alreadyOpen: boolean }> {
    this.assertNotTerminal('hand off')
    const safeMessage = opts.message ?? null
    const now = new Date()
    const result = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(workStreams).where(eq(workStreams.id, this.id)).for('update')
      if (!locked) throw new Error(`Work stream ${this.id} not found`)
      if (locked.status === 'done' || locked.status === 'canceled') {
        throw new Error(`Cannot hand off a ${locked.status} work stream`)
      }
      const opened = await openWait(tx, {
        workStreamId: this.id,
        type: 'review',
        message: safeMessage,
        createdBy: opts.createdBy ?? 'agent',
        createdByAgentId: opts.createdByAgentId ?? null,
        createdByUserId: opts.createdByUserId ?? null,
        completesOnApproval: opts.completesOnApproval ?? true,
      })
      if (!opened.alreadyOpen) {
        // Bump updatedAt so direct + event-fallback notifications share one
        // transition identity (the inbox dedupe key).
        await tx
          .update(workStreams)
          .set({
            ...(opts.message !== undefined && opts.message !== null ? { handoffMessage: safeMessage } : {}),
            updatedAt: now,
          })
          .where(eq(workStreams.id, this.id))
      }
      return opened
    })
    await this.reload()
    if (!result.alreadyOpen) {
      const actionId = `workstream-review:${this.id}:${result.wait.id}`
      // The wait's creator IS the actor: an assignee handing off for review
      // does not need its own handoff announced back to it.
      const actorAgentId = opts.createdByAgentId ?? null
      await notifyWorkStreamReview(this, { waitId: result.wait.id, actionId }, actorAgentId)
      const payload = { workStreamId: this.id, squadId: this.squadId, waitId: result.wait.id, actorAgentId }
      eventEmitter.emit('workStream.review', payload)
      eventEmitter.emit('workStream.updated', payload)
    }
    return result
  }

  /**
   * Approve the open review, closing the review wait (`approved`). What
   * happens next depends on the wait's `completesOnApproval` flag (spec §4):
   *
   * - true (default): the stream transitions to `done` in the SAME
   *   transaction — an abort between the two leaves neither.
   * - false (checkpoint review): the wait resolves and the stream continues
   *   unchanged — the assignee gets the resolution note (like a cleared
   *   input request) and a fresh continuation retry budget.
   *
   * Throws when no review wait is open. Pass `waitId` to close exactly that
   * wait (typed resolve); omitted, it closes the stream's open review wait.
   */
  async approveReview(
    opts: {
      waitId?: string
      note?: string
      actorAgentId?: string | null
      testHooks?: { beforeCommit?: () => Promise<void> }
    } = {}
  ): Promise<this> {
    this.assertNotTerminal('approve')
    const note = opts.note && opts.note.trim().length > 0 ? opts.note : undefined
    const result = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(workStreams).where(eq(workStreams.id, this.id)).for('update')
      if (!locked) throw new Error(`Work stream ${this.id} not found`)
      const { guardFlowMutation } = await import('../services/workflows/execution')
      await guardFlowMutation(tx, locked, {}, true)
      if (locked.status === 'done' || locked.status === 'canceled') {
        if (opts.waitId) {
          throw new WorkStreamWaitResolveError(
            'work_stream_terminal',
            `Cannot resolve a wait on a ${locked.status} work stream`
          )
        }
        throw new Error(`Cannot approve a ${locked.status} work stream`)
      }
      const [clock] = await tx.execute<{ now: string }>(
        sql`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`
      )
      if (!clock) throw new Error('Unable to read the work-stream completion database clock')
      const now = new Date(clock.now)
      const closed = await closeOpenWaits(
        tx,
        { workStreamId: this.id, type: 'review', ...(opts.waitId ? { waitId: opts.waitId } : {}) },
        'approved',
        { note: note ?? null, closedAt: now }
      )
      if (closed.length === 0) {
        if (opts.waitId) {
          throw new WorkStreamWaitResolveError('wait_already_closed', `Wait ${opts.waitId} was closed concurrently`)
        }
        throw new Error('Work stream has no open review wait to approve')
      }

      if (!closed[0].completesOnApproval) {
        // Checkpoint review (spec §4): the wait resolves; status is untouched.
        const [updated] = await tx
          .update(workStreams)
          .set({ updatedAt: now })
          .where(eq(workStreams.id, this.id))
          .returning()
        if (!updated) throw new Error(`Work stream ${this.id} not found`)
        // Work resumes with a fresh continuation retry budget (same as
        // send-back/unblock).
        if (updated.status === 'active' && updated.assigneeAgentId) {
          await resetContinuationCycle(tx, this.id, updated.assigneeAgentId)
        }
        if (opts.testHooks?.beforeCommit) await opts.testHooks.beforeCommit()
        return { row: updated, completed: false as const }
      }

      const lockedMetadata = (locked.metadata as Record<string, unknown> | null) ?? {}
      const metadata = withTerminalCompletion(
        lockedMetadata,
        lockedMetadata,
        locked.status,
        'done',
        locked.updatedAt,
        now
      )
      const [updated] = await tx
        .update(workStreams)
        .set({ status: 'done', metadata, updatedAt: now })
        .where(and(eq(workStreams.id, this.id), inArray(workStreams.status, ['active', 'queued'])))
        .returning()
      if (!updated) {
        if (opts.waitId) {
          throw new WorkStreamWaitResolveError(
            'work_stream_terminal',
            'Work stream became terminal while resolving its review wait'
          )
        }
        throw new Error('Work stream status changed concurrently; approval aborted')
      }
      await enqueueWorktreeCleanup(tx, this.id, updated.metadata as Record<string, unknown>)
      if (locked.status === 'active') {
        await invalidateContinuationCycle(tx, this.id)
      }
      // Transactional with the terminal transition: dependents' dependency
      // waits close (`satisfied`) and any remaining own waits clear.
      await closeDependencyWaitsForCompletedStream(tx, this.id)
      await closeOpenWaits(tx, { workStreamId: this.id }, 'cleared', { note: 'stream done', closedAt: now })
      // Same durable request as update()'s terminal path — approve completes
      // the stream in this transaction, so the crew teardown commits with it.
      await markCrewForDormancy(tx, updated.agentIds ?? [])
      // Deterministic crash-window boundary for the transactional-approve test.
      if (opts.testHooks?.beforeCommit) await opts.testHooks.beforeCommit()
      return { row: updated, completed: true as const }
    })
    await this.assignMutationRow(result.row)

    const payload = { workStreamId: this.id, squadId: this.squadId }
    eventEmitter.emit('workStream.responded', {
      ...payload,
      resolvedWaitType: 'review',
      reviewResolution: 'approved',
      actorAgentId: opts.actorAgentId ?? null,
    })
    if (result.completed) {
      // The approval note rides the completion notice (spec §4b): recorded on
      // the wait row AND delivered, so approve is no longer context-free.
      await notifyWorkStreamDone(this, { approvalNote: note, actorAgentId: opts.actorAgentId })
      await cleanupAgentsForTerminalWorkStream(this.agentIds ?? [])
      eventEmitter.emit('workStream.done', {
        ...payload,
        agentIds: this.agentIds ?? [],
        actorAgentId: opts.actorAgentId ?? null,
      })
      eventEmitter.emit('workStream.updated', payload)
    } else {
      // Notify like a resolved wait: the assignee learns the checkpoint
      // passed (with the reviewer's note, if any) and work continues.
      await notifyWorkStreamResponded(this, 'review', note, 'approved', opts.actorAgentId)
      eventEmitter.emit('workStream.updated', payload)
      await this.promoteSquadBestEffort()
    }
    return this
  }

  /**
   * Send the open review back with required feedback: closes the review wait
   * (`sent_back`, note = feedback); the stream stays `active` (or `queued`
   * if parked) and is again schedulable. Closed review waits are the round
   * history. Pass `waitId` to close exactly that wait (typed resolve);
   * omitted, it closes the stream's open review wait as before.
   */
  async sendBackReview(note: string, opts: { waitId?: string; actorAgentId?: string | null } = {}): Promise<this> {
    this.assertNotTerminal('send back')
    if (!note || note.trim().length === 0) {
      throw new Error('Send-back requires a feedback note')
    }
    const now = new Date()
    await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(workStreams).where(eq(workStreams.id, this.id)).for('update')
      if (!locked) throw new Error(`Work stream ${this.id} not found`)
      if (locked.status === 'done' || locked.status === 'canceled') {
        if (opts.waitId) {
          throw new WorkStreamWaitResolveError(
            'work_stream_terminal',
            `Cannot resolve a wait on a ${locked.status} work stream`
          )
        }
        throw new Error(`Cannot send back a ${locked.status} work stream`)
      }
      const closed = await closeOpenWaits(
        tx,
        { workStreamId: this.id, type: 'review', ...(opts.waitId ? { waitId: opts.waitId } : {}) },
        'sent_back',
        { note, closedAt: now }
      )
      if (closed.length === 0) {
        if (opts.waitId) {
          throw new WorkStreamWaitResolveError('wait_already_closed', `Wait ${opts.waitId} was closed concurrently`)
        }
        throw new Error('Work stream has no open review wait to send back')
      }
      const [updated] = await tx
        .update(workStreams)
        .set({ updatedAt: now })
        .where(eq(workStreams.id, this.id))
        .returning()
      // The assignee resumes with a fresh continuation retry budget (the old
      // review -> in_progress bounce did this via the status transition).
      if (updated?.status === 'active' && updated.assigneeAgentId) {
        await resetContinuationCycle(tx, this.id, updated.assigneeAgentId)
      }
    })
    await this.reload()

    const payload = { workStreamId: this.id, squadId: this.squadId }
    await notifyWorkStreamResponded(this, 'review', note, 'sent_back', opts.actorAgentId)
    eventEmitter.emit('workStream.responded', {
      ...payload,
      resolvedWaitType: 'review',
      reviewResolution: 'sent_back',
      actorAgentId: opts.actorAgentId ?? null,
    })
    eventEmitter.emit('workStream.updated', payload)
    await this.promoteSquadBestEffort()
    return this
  }

  /**
   * Open a manual wait (block): the stream needs attention and cannot
   * proceed. Status does NOT change — auto-park moves it to `queued` after
   * the squad grace.
   */
  async block(opts: {
    scope?: 'stream' | 'attempt'
    flowAttemptId?: number
    message: string
    createdBy?: WorkStreamWaitCreatedBy
    createdByAgentId?: string | null
    createdByUserId?: string | null
  }): Promise<WorkStreamWaitRow> {
    this.assertNotTerminal('block')
    const now = new Date()
    const { wait } = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(workStreams).where(eq(workStreams.id, this.id)).for('update')
      if (!locked) throw new Error(`Work stream ${this.id} not found`)
      if (locked.status === 'done' || locked.status === 'canceled') {
        throw new Error(`Cannot block a ${locked.status} work stream`)
      }
      const opened = await openWait(tx, {
        workStreamId: this.id,
        type: 'manual',
        scope: opts.scope,
        flowAttemptId: opts.flowAttemptId,
        message: opts.message,
        createdBy: opts.createdBy ?? 'system',
        createdByAgentId: opts.createdByAgentId ?? null,
        createdByUserId: opts.createdByUserId ?? null,
      })
      // Bump updatedAt so direct + event-fallback notifications share one
      // transition identity (the inbox dedupe key).
      await tx.update(workStreams).set({ updatedAt: now }).where(eq(workStreams.id, this.id))
      return opened
    })
    await this.reload()
    const actionId = `workstream-blocked:${this.id}:${wait.id}`
    // The wait's creator IS the actor here — no separate parameter needed.
    const actorAgentId = opts.createdByAgentId ?? null
    await notifyWorkStreamBlocked(this, { waitId: wait.id, actionId }, actorAgentId)
    const payload = { workStreamId: this.id, squadId: this.squadId, waitId: wait.id, actorAgentId }
    eventEmitter.emit('workStream.blocked', payload)
    eventEmitter.emit('workStream.updated', payload)
    const { ensureFlowDispatch } = await import('../services/workflows/execution')
    await ensureFlowDispatch(this.id)
    return wait
  }

  /**
   * Close every open manual wait (`cleared`). Wait resolution never changes
   * status by itself: a queued stream becomes admissible in place and
   * competes by effective priority (the post-close promotion pass picks it
   * up).
   */
  async unblock(opts: { note?: string; actorAgentId?: string | null } = {}): Promise<WorkStreamWaitRow[]> {
    if (this.status === 'canceled') throw new Error('Work stream has been canceled')
    const now = new Date()
    const closed = await db.transaction(async (tx) => {
      await tx.select({ id: workStreams.id }).from(workStreams).where(eq(workStreams.id, this.id)).for('update')
      const { guardFlowWaitResolution } = await import('../services/workflows/execution')
      await guardFlowWaitResolution(tx, this.id)
      const rows = await closeOpenWaits(tx, { workStreamId: this.id, type: 'manual' }, 'cleared', {
        note: opts.note ?? null,
        closedAt: now,
      })
      if (rows.length > 0) {
        const [updated] = await tx
          .update(workStreams)
          .set({ updatedAt: now })
          .where(eq(workStreams.id, this.id))
          .returning()
        // Unblocking hands the assignee a fresh continuation retry budget
        // (the old blocked -> in_progress bounce did this via the transition).
        if (updated?.status === 'active' && updated.assigneeAgentId) {
          await resetContinuationCycle(tx, this.id, updated.assigneeAgentId)
        }
      }
      return rows
    })
    if (closed.length > 0) {
      await this.reload()
      const payload = { workStreamId: this.id, squadId: this.squadId }
      // Deliver the operator's resolution note to the assignee (the note lives
      // on the just-closed wait, NOT in the legacy `response` column). Without
      // this the unblocked steer arrived with an empty body and the operator's
      // `-m` note was silently lost.
      if (!(await notifyFlowWaitResolution(this.id, closed, opts.actorAgentId)))
        await notifyWorkStreamResponded(this, 'manual', opts.note ?? undefined, 'sent_back', opts.actorAgentId)
      eventEmitter.emit('workStream.responded', {
        ...payload,
        resolvedWaitType: 'manual',
        actorAgentId: opts.actorAgentId ?? null,
      })
      eventEmitter.emit('workStream.updated', payload)
      await this.promoteSquadBestEffort()
    }
    return closed
  }

  private async promoteSquadBestEffort(): Promise<void> {
    try {
      const { promoteEligibleQueuedStreams } = await import('../services/work-streams/admission')
      await promoteEligibleQueuedStreams(this.squadId)
    } catch {
      // The periodic admission reconciler converges anything missed.
    }
  }

  /**
   * Typed wait resolution (replaces the legacy free-text `respond`): resolve
   * exactly ONE open wait of this stream by id. Validity per wait type:
   * review → `approved` (delegates to {@link approveReview}) or `sent_back`
   * (requires a non-empty note; delegates to {@link sendBackReview});
   * manual → `cleared` (closes that wait, delivers the note like unblock).
   * Question waits resolve via the answer flow and dependency waits are
   * system-resolved — both are rejected here. Throws
   * {@link WorkStreamWaitResolveError} on bad wait ids / combos.
   *
   * Returns the closed wait row.
   */
  async resolveWait(
    waitId: string,
    input: { resolution: WorkStreamWaitCallerResolution; note?: string; actorAgentId?: string | null }
  ): Promise<WorkStreamWaitRow> {
    const [current] = await db
      .select({ status: workStreams.status })
      .from(workStreams)
      .where(eq(workStreams.id, this.id))
    if (current?.status === 'done' || current?.status === 'canceled') {
      throw new WorkStreamWaitResolveError(
        'work_stream_terminal',
        `Cannot resolve a wait on a ${current.status} work stream`
      )
    }
    const [wait] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.id, waitId))
    if (!wait || wait.workStreamId !== this.id) {
      throw new WorkStreamWaitResolveError('wait_not_found', `Wait ${waitId} not found on this work stream`)
    }
    if (wait.closedAt !== null) {
      throw new WorkStreamWaitResolveError(
        'wait_already_closed',
        `Wait ${waitId} is already closed (${wait.resolution ?? 'no resolution'})`
      )
    }

    const note = input.note && input.note.trim().length > 0 ? input.note : undefined
    switch (wait.type) {
      case 'review': {
        if (input.resolution === 'approved') {
          await this.approveReview({ waitId: wait.id, note })
        } else if (input.resolution === 'sent_back') {
          if (!note) {
            throw new WorkStreamWaitResolveError(
              'invalid_resolution',
              "Resolution 'sent_back' requires a non-empty note"
            )
          }
          await this.sendBackReview(note, { waitId: wait.id })
        } else {
          throw new WorkStreamWaitResolveError(
            'invalid_resolution',
            `Review waits resolve with 'approved' or 'sent_back', not '${input.resolution}'`
          )
        }
        break
      }
      case 'manual': {
        if (input.resolution !== 'cleared') {
          throw new WorkStreamWaitResolveError(
            'invalid_resolution',
            `Input-request (manual) waits resolve with 'cleared', not '${input.resolution}'`
          )
        }
        await this.clearManualWait(wait.id, note, input.actorAgentId)
        break
      }
      case 'question':
        throw new WorkStreamWaitResolveError(
          'invalid_resolution',
          'Question waits resolve through the question answer flow, not this endpoint'
        )
      default:
        throw new WorkStreamWaitResolveError(
          'invalid_resolution',
          `${wait.type} waits are system-resolved and cannot be resolved manually`
        )
    }

    const [closed] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.id, wait.id))
    return closed
  }

  /**
   * Close exactly one open manual wait (`cleared`), delivering the note to
   * the assignee and resetting the continuation cycle — the targeted
   * counterpart of {@link unblock} (which clears ALL open manual waits).
   */
  private async clearManualWait(waitId: string, note?: string, actorAgentId?: string | null): Promise<void> {
    const now = new Date()
    const closed = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ status: workStreams.status })
        .from(workStreams)
        .where(eq(workStreams.id, this.id))
        .for('update')
      if (locked?.status === 'done' || locked?.status === 'canceled') {
        throw new WorkStreamWaitResolveError(
          'work_stream_terminal',
          `Cannot resolve a wait on a ${locked.status} work stream`
        )
      }
      const { guardFlowWaitResolution } = await import('../services/workflows/execution')
      await guardFlowWaitResolution(tx, this.id, waitId)
      const rows = await closeOpenWaits(tx, { workStreamId: this.id, type: 'manual', waitId }, 'cleared', {
        note: note ?? null,
        closedAt: now,
      })
      if (rows.length > 0) {
        const [updated] = await tx
          .update(workStreams)
          .set({ updatedAt: now })
          .where(eq(workStreams.id, this.id))
          .returning()
        // Clearing hands the assignee a fresh continuation retry budget
        // (same as unblock).
        if (updated?.status === 'active' && updated.assigneeAgentId) {
          await resetContinuationCycle(tx, this.id, updated.assigneeAgentId)
        }
      }
      return rows
    })
    if (closed.length === 0) {
      throw new WorkStreamWaitResolveError('wait_already_closed', `Wait ${waitId} was closed concurrently`)
    }
    await this.reload()
    const payload = { workStreamId: this.id, squadId: this.squadId }
    if (!(await notifyFlowWaitResolution(this.id, closed, actorAgentId)))
      await notifyWorkStreamResponded(this, 'manual', note, 'sent_back', actorAgentId)
    eventEmitter.emit('workStream.responded', {
      ...payload,
      resolvedWaitType: 'manual',
      actorAgentId: actorAgentId ?? null,
    })
    eventEmitter.emit('workStream.updated', payload)
    await this.promoteSquadBestEffort()
  }

  /**
   * Delete this work stream.
   */
  async delete(): Promise<void> {
    // Capture direct interest before FK cascade removes subscription rows.
    const directSubscriberIds = await listWorkStreamSubscriberIds(this.id)
    await db.transaction(async (tx) => {
      await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, this.squadId)).for('update')
      await tx.select({ id: workStreams.id }).from(workStreams).where(eq(workStreams.id, this.id)).for('update')
      await assertWorktreeCleanupMutable(tx, this.id)
      await tx.delete(workStreams).where(eq(workStreams.id, this.id))
    })
    eventEmitter.emit('workStream.deleted', { workStreamId: this.id, squadId: this.squadId })
    for (const userId of directSubscriberIds) {
      eventEmitter.emit('liveActivity.interestChanged', { userId })
    }
  }

  /**
   * Add an agent to this work stream.
   */
  async addAgent(agentId: string): Promise<this> {
    const { getFlow } = await import('../services/workflows/execution')
    if ((await getFlow(this.id))?.activated) throw new Error('Use a flow revision to change participants')
    if (this.status === 'canceled') {
      throw new Error('Work stream has been canceled')
    }

    agentId = (await Agent.validateAgentIds([agentId]))[0]

    const currentIds = this.agentIds ?? []
    if (currentIds.includes(agentId)) return this // Already added

    const newIds = [...currentIds, agentId]

    await this.update({ agentIds: newIds })
    eventEmitter.emit('workStream.agentAdded', {
      workStreamId: this.id,
      squadId: this.squadId,
      agentId,
    })
    return this
  }

  /**
   * Remove an agent from this work stream.
   */
  async removeAgent(agentId: string): Promise<this> {
    const { getFlow } = await import('../services/workflows/execution')
    if ((await getFlow(this.id))?.activated) throw new Error('Use a flow revision to change participants')
    // Resolve full UUID, fallback to original value if validation fails (in case agent was deleted)
    agentId = (await Agent.validateAgentIds([agentId]).catch(() => [agentId]))[0]

    const currentIds = this.agentIds ?? []
    if (!currentIds.includes(agentId)) return this // Not present

    const newIds = currentIds.filter((id) => id !== agentId)

    if (this.status === 'active' && this.assigneeAgentId === agentId) {
      throw new Error('Cannot leave an active work stream without an assignee')
    }

    // Clear assignee if it was this agent
    const updates: UpdateWorkStreamInput = { agentIds: newIds }
    if (this.assigneeAgentId === agentId) {
      updates.assigneeAgentId = null
    }

    await this.update(updates)
    await cleanupRemovedAgent(agentId)
    eventEmitter.emit('workStream.agentRemoved', {
      workStreamId: this.id,
      squadId: this.squadId,
      agentId,
    })
    return this
  }

  /**
   * Check if this work stream's dependencies are all done.
   */
  async areDependenciesMet(): Promise<boolean> {
    if (this.dependsOn.length === 0) return true

    const deps = await Promise.all(this.dependsOn.map((id) => WorkStream.find(id)))
    return deps.every((dep) => dep?.status === 'done')
  }

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------

  /**
   * Compute aggregated agent runtime for a batch of work streams.
   * Returns a Map keyed by work stream id.
   */
  static async computeRuntimes(streams: WorkStream[]): Promise<Map<string, WorkStreamRuntime>> {
    const result = new Map<string, WorkStreamRuntime>()
    if (streams.length === 0) return result

    const pairs: { wsId: string; agentId: string }[] = []
    for (const ws of streams) {
      for (const agentId of ws.agentIds ?? []) {
        pairs.push({ wsId: ws.id, agentId })
      }
    }

    let computedAtIso = new Date().toISOString()

    if (pairs.length > 0) {
      const rows = (await db.execute(workStreamRuntimesSql(pairs))) as unknown as Array<{
        ws_id: string
        computed_at: string | Date
        total_ms: string | number
        active_count: number
      }>

      for (const row of rows) {
        const iso = new Date(row.computed_at).toISOString()
        result.set(row.ws_id, {
          totalMs: Number(row.total_ms),
          activeCount: Number(row.active_count),
          computedAt: iso,
        })
        computedAtIso = iso
      }
    }

    for (const ws of streams) {
      if (!result.has(ws.id)) {
        result.set(ws.id, { totalMs: 0, activeCount: 0, computedAt: computedAtIso })
      }
    }

    return result
  }

  async getRuntime(): Promise<WorkStreamRuntime> {
    const map = await WorkStream.computeRuntimes([this])
    return map.get(this.id)!
  }

  /**
   * Get aggregated metrics for this work stream.
   * Computes on-read from executions table.
   *
   * ## Why this is not a plain SUM
   *
   * `executions.usage.stats` is CUMULATIVE for the agent's session, not for the
   * one execution it is stored on (see SessionUsage). Summing it across an
   * agent's executions counts every earlier turn again on every later row — a
   * live work stream with 151 engineer executions reported 185.3B tokens and a
   * proportionally absurd cost when the truth was ~1.6B.
   *
   * Executions written since per-execution deltas exist carry `usage.delta`,
   * their own consumption, which sums correctly. For older rows the only
   * truthful figure available is the LAST cumulative snapshot, and because that
   * snapshot already equals the sum of every delta up to it, the two combine
   * exactly: per agent, `MAX(legacy cumulative) + SUM(delta)`. Mixing the two
   * eras for one agent therefore stays correct rather than double counting.
   *
   * Casts are `bigint`: a cumulative session total above 2^31 overflows `int`
   * and makes the whole query throw.
   */
  async getMetrics(): Promise<WorkStreamMetrics | null> {
    if (!this.agentIds?.length) {
      return null
    }

    // The typed `TokenField` parameter is the signature boundary — an arbitrary
    // string is now a type error — and `field` is bound as a parameter on the
    // right-hand side of `->>` rather than string-interpolated via sql.raw.
    type TokenField = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'total'

    const legacyCumulative = (field: TokenField) =>
      sql`MAX(CASE WHEN ${executions.usage} -> 'delta' IS NULL THEN (${executions.usage} -> 'stats' -> 'tokens' ->> ${field})::bigint END)`
    const deltaSum = (field: TokenField) =>
      sql`SUM(CASE WHEN ${executions.usage} -> 'delta' IS NOT NULL THEN (${executions.usage} -> 'delta' -> 'tokens' ->> ${field})::bigint END)`
    const tokenTotal = (field: TokenField) =>
      sql<number>`COALESCE(${legacyCumulative(field)}, 0) + COALESCE(${deltaSum(field)}, 0)`

    // Grouped by agent: the legacy/delta reconciliation above is only valid per
    // agent (each has its own cumulative session), so overall totals are summed
    // from these rows rather than aggregated again in SQL.
    const perAgent = await db
      .select({
        agentId: executions.agentId,
        inputTokens: tokenTotal('input'),
        outputTokens: tokenTotal('output'),
        cacheReadTokens: tokenTotal('cacheRead'),
        cacheWriteTokens: tokenTotal('cacheWrite'),
        totalTokens: tokenTotal('total'),
        totalCost: sql<number>`COALESCE(MAX(CASE WHEN ${executions.usage} -> 'delta' IS NULL THEN (${executions.usage} -> 'stats' ->> 'cost')::decimal END), 0)
          + COALESCE(SUM(CASE WHEN ${executions.usage} -> 'delta' IS NOT NULL THEN (${executions.usage} -> 'delta' ->> 'cost')::decimal END), 0)`,
        totalExecutions: sql<number>`COUNT(*)`,
        completedExecutions: sql<number>`COUNT(*) FILTER (WHERE ${executions.status} = 'completed')`,
        failedExecutions: sql<number>`COUNT(*) FILTER (WHERE ${executions.status} = 'failed')`,
        totalDurationMs: sql<number>`COALESCE(SUM(
          CASE
            WHEN ${executions.status} = 'queued' THEN 0
            WHEN ${executions.endedAt} IS NOT NULL THEN
              GREATEST(0, EXTRACT(EPOCH FROM (${executions.endedAt} - ${executions.startedAt})) * 1000)
            WHEN ${executions.status} IN ('running', 'stopping') THEN
              GREATEST(0, EXTRACT(EPOCH FROM (NOW() - ${executions.startedAt})) * 1000)
            ELSE 0
          END
        ), 0)`,
        firstStartedAt: sql<string | null>`MIN(${executions.startedAt})`,
        lastEndedAt: sql<string | null>`MAX(${executions.endedAt})`,
      })
      .from(executions)
      .where(inArray(executions.agentId, this.agentIds))
      .groupBy(executions.agentId)

    // No executions yet is zeroed metrics, NOT null: null means "this stream has
    // no crew at all", which callers render differently.
    const byAgent: Record<string, { tokens: number; cost: number; executions: number }> = {}
    const totals = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      cost: 0,
      executions: 0,
      completed: 0,
      failed: 0,
      durationMs: 0,
    }
    let firstStartedAt: number | null = null
    let lastEndedAt: number | null = null

    for (const row of perAgent) {
      totals.input += Number(row.inputTokens)
      totals.output += Number(row.outputTokens)
      totals.cacheRead += Number(row.cacheReadTokens)
      totals.cacheWrite += Number(row.cacheWriteTokens)
      totals.total += Number(row.totalTokens)
      totals.cost += Number(row.totalCost)
      totals.executions += Number(row.totalExecutions)
      totals.completed += Number(row.completedExecutions)
      totals.failed += Number(row.failedExecutions)
      totals.durationMs += Number(row.totalDurationMs)
      if (row.firstStartedAt) {
        const at = new Date(row.firstStartedAt).getTime()
        if (firstStartedAt === null || at < firstStartedAt) firstStartedAt = at
      }
      if (row.lastEndedAt) {
        const at = new Date(row.lastEndedAt).getTime()
        if (lastEndedAt === null || at > lastEndedAt) lastEndedAt = at
      }
      byAgent[row.agentId] = {
        tokens: Number(row.totalTokens),
        cost: Number(row.totalCost),
        executions: Number(row.totalExecutions),
      }
    }

    return {
      tokens: {
        input: totals.input,
        output: totals.output,
        cacheRead: totals.cacheRead,
        cacheWrite: totals.cacheWrite,
        total: totals.total,
      },
      cost: totals.cost,
      executions: {
        total: totals.executions,
        completed: totals.completed,
        failed: totals.failed,
      },
      duration: {
        totalMs: totals.durationMs,
        firstStartedAt: firstStartedAt === null ? null : new Date(firstStartedAt).toISOString(),
        lastEndedAt: lastEndedAt === null ? null : new Date(lastEndedAt).toISOString(),
      },
      byAgent,
    }
  }

  // ---------------------------------------------------------------------------
  // Relation Loaders
  // ---------------------------------------------------------------------------

  /**
   * Load the squad for this work stream.
   */
  async getSquad(): Promise<Squad | null> {
    if (this._squad === undefined) {
      // Dynamic import to avoid circular dependency
      const { Squad } = await import('./Squad')
      this._squad = await Squad.find(this.squadId)
    }
    return this._squad
  }

  /**
   * Load the squad, throwing if not found.
   */
  async mustGetSquad(): Promise<Squad> {
    const squad = await this.getSquad()
    if (!squad) throw new Error(`Squad ${this.squadId} not found`)
    return squad
  }

  /**
   * Load the assignee agent for this work stream.
   */
  async getAssignee(): Promise<Agent | null> {
    if (!this.assigneeAgentId) return null
    if (this._assignee === undefined) {
      this._assignee = await Agent.find(this.assigneeAgentId)
    }
    return this._assignee
  }

  /**
   * Load all agents assigned to this work stream.
   */
  async getAgents(): Promise<Agent[]> {
    if (!this.agentIds?.length) return []
    if (this._agents === undefined) {
      const agents = await Promise.all(this.agentIds.map((id) => Agent.find(id)))
      this._agents = agents.filter((a): a is Agent => a !== null)
    }
    return this._agents
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  toJson(): WorkStreamJson {
    return {
      id: this.id,
      autoCleanupWorktree: this.autoCleanupWorktree,
      worktreeCleanup: this.worktreeCleanup,
      number: this.number,
      squadId: this.squadId,
      title: this.title,
      description: this.description,
      status: this.status,
      pause: this.pause,
      priority: this.priority,
      assigneeAgentId: this.assigneeAgentId,
      ownerAgentId: this.ownerAgentId,
      creatorAgentId: this.creatorAgentId,
      requestingUserId: this.requestingUserId,
      assignedReviewerIds: this.assignedReviewerIds,
      agentIds: this.agentIds,
      dependsOn: this.dependsOn,
      dependedOnBy: this.dependedOnBy,
      handoffMessage: this.handoffMessage,
      files: this.files,
      metadata: this.metadata,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      completedAt: this.completedAt,
      // Derived from metadata (see getters above)
      completionMode: this.completionMode,
      branch: this.branch,
      worktree: this.worktree,
      baseBranch: this.baseBranch,
    }
  }
}

/** SQL shared by runtime reads and their plan regression tests. */
export function workStreamRuntimesSql(pairs: readonly { wsId: string; agentId: string }[]) {
  return sql`
        WITH pairs(ws_id, agent_id) AS (
          VALUES ${sql.join(
            pairs.map((p) => sql`(${p.wsId}::uuid, ${p.agentId}::uuid)`),
            sql`, `
          )}
        ),
        computed AS (
          SELECT NOW() AS now_ts
        )
        SELECT
          p.ws_id AS ws_id,
          (SELECT now_ts FROM computed) AS computed_at,
          COALESCE(SUM(
            CASE
              WHEN e.status IN ('queued', 'waiting-sandbox') THEN 0
              WHEN e.ended_at IS NOT NULL THEN
                GREATEST(0, EXTRACT(EPOCH FROM (e.ended_at - e.started_at)) * 1000)
              WHEN e.status IN ('running', 'stopping') THEN
                GREATEST(0, EXTRACT(EPOCH FROM ((SELECT now_ts FROM computed) - e.started_at)) * 1000)
              ELSE 0
            END
          ), 0)::bigint AS total_ms,
          COUNT(*) FILTER (WHERE e.status IN ('waiting-sandbox', 'running', 'stopping'))::int AS active_count
        FROM pairs p
        LEFT JOIN ${executions} e ON e.agent_id = p.agent_id
        GROUP BY p.ws_id
      `
}
