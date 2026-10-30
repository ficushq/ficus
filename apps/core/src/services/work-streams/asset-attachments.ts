/**
 * Work-stream references to stored chat images and chat files.
 *
 * Attaching an existing image or chat file shares it with everyone who can read the work stream,
 * without copying its bytes into a workspace or a new blob. The bytes stay where the source stored
 * them; a `retained_assets` row keeps them alive if the source row is later deleted, and the last
 * share to go releases them. Two checks gate every attach: the caller must legitimately hold the
 * source (an agent: an image or file in its own conversation scope; a person: one they may read,
 * with private conversations owner-only) and must be allowed to write the target stream. A shared
 * source must belong to the stream's squad unless it is the caller's own private conversation.
 *
 * Retention and source deletion share one lock per source, `hashtext(sourceId)`, the same advisory
 * lock Image.deleteMany and AgentFileAttachment take, so a reference and a deletion never race.
 */
import { createHash } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { and, asc, count, eq, inArray, isNotNull, isNull, or, sql, notExists } from 'drizzle-orm'
import {
  WORK_STREAM_INPUT_ASSET_LIMIT,
  WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT,
  workflowAttachmentContentType,
  workflowCurrentAttachmentIds,
  type WorkflowAttempt,
  type WorkStreamAssetAttachment,
  type WorkStreamAssetAttachments,
  type WorkStreamAssetSource,
} from '@ficus/shared'
import {
  agentFileAttachments,
  db,
  images,
  retainedAssets,
  squads,
  workflowAttemptAttachments,
  workStreamAssetAttachments,
  workStreamFlowRuns,
  workStreams,
} from '../../db'
import { Agent } from '../../entities/Agent'
import { AgentFileAttachment } from '../../entities/AgentFileAttachment'
import { getImagePath, Image } from '../../entities/Image'
import { createLogger } from '../../lib/infra/logger'
import { deleteAgentAttachmentBlob, readVerifiedAgentAttachmentBlob } from '../attachments/blob-storage'
import { assertAttachmentInScope, resolveAttachmentScope } from '../attachments/agent-scope'
import { canReadImage } from '../images/access'
import { hasAgentResourcePermission, hasPermission, identityUserId, type Identity } from '../rbac'
import { assertCanAttach, attemptSlotsUsed } from '../workflows/attachments'
import { assetManifestLines, type AssignmentAssets } from '../workflows/handoff-prompt'

const log = createLogger('work-stream-assets')

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type ShareRow = typeof workStreamAssetAttachments.$inferSelect
type AssetRow = typeof retainedAssets.$inferSelect
type StreamRow = typeof workStreams.$inferSelect

/** A refused or failed asset operation; `status` is the HTTP answer. */
export class AssetAttachmentError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409
  ) {
    super(message)
    this.name = 'AssetAttachmentError'
  }
}

/** The same answer for a source that does not exist and one the caller may not share. */
const SOURCE_UNAVAILABLE = 'Image or file not found, or you cannot share it'

/** The stored bytes are missing or no longer match their recorded size and digest. */
export class AssetUnavailableError extends Error {
  constructor() {
    super('Attachment unavailable')
    this.name = 'AssetUnavailableError'
  }
}

/** `<uuid>.<ext>`: the only shape Image.create gives a stored image's filename. */
const IMAGE_FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,16}$/

function shareJson(row: ShareRow): WorkStreamAssetAttachment {
  return {
    id: row.id,
    workStreamId: row.workStreamId,
    attemptId: row.attemptId,
    source:
      row.sourceKind === 'image'
        ? { kind: 'image', imageId: row.sourceId }
        : { kind: 'agent-file', attachmentId: row.sourceId },
    filename: row.filename,
    contentType: row.contentType,
    byteSize: row.byteSize,
    createdAt: row.createdAt.toISOString(),
  }
}

/** The identity a share records as its creator (provenance only). */
function creator(identity: Identity): { createdByType: string; createdById: string } {
  if (identity.type === 'agent') return { createdByType: 'agent', createdById: identity.agentId }
  const userId = identityUserId(identity)
  return userId ? { createdByType: 'user', createdById: userId } : { createdByType: identity.type, createdById: '' }
}

async function lockSource(tx: DbTx, sourceId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${sourceId}))`)
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/** Whether the caller may read the work stream (and so its shared assets). */
export async function canReadStreamAssets(identity: Identity, stream: Pick<StreamRow, 'squadId'>): Promise<boolean> {
  return hasPermission(identity, 'workstreams:read', stream.squadId)
}

/**
 * Whether the caller may change a stream's inputs: the same rule as editing the stream (squad
 * `workstreams:update`, or an agent bound to the stream holding `workstreams:respond`).
 */
export async function canWriteStreamInputs(
  identity: Identity,
  stream: Pick<StreamRow, 'squadId' | 'assigneeAgentId' | 'ownerAgentId' | 'agentIds'>
): Promise<boolean> {
  if (await hasPermission(identity, 'workstreams:update', stream.squadId)) return true
  if (identity.type !== 'agent' || !(await hasPermission(identity, 'workstreams:respond', stream.squadId))) return false
  return (
    stream.assigneeAgentId === identity.agentId ||
    stream.ownerAgentId === identity.agentId ||
    (stream.agentIds ?? []).includes(identity.agentId)
  )
}

interface ResolvedSource {
  kind: WorkStreamAssetSource['kind']
  sourceId: string
  /** The image's filename, or the chat file's owning agent. */
  blobOwner: string
  /** The agent whose conversation holds the source, rechecked under the lock. */
  ownerAgentId: string
  filename: string
  contentType: string
  byteSize: number
  sha256: string
}

async function callerScopeIncludes(identity: Identity, record: { agentId: string; sandboxId?: string }) {
  if (identity.type !== 'agent') return false
  const caller = await Agent.find(identity.agentId)
  if (!caller) return false
  try {
    const scope = await resolveAttachmentScope(caller)
    if (record.sandboxId !== undefined)
      assertAttachmentInScope({ agentId: record.agentId, sandboxId: record.sandboxId }, scope)
    else if (!scope.ownerAgentIds.includes(record.agentId)) return false
    return true
  } catch {
    return false
  }
}

/**
 * Resolve a source the caller may share into `stream`, or throw the one non-enumerating error.
 * Reads run outside any transaction; the attach transaction rechecks the source under its lock.
 */
async function resolveShareableSource(
  identity: Identity,
  source: WorkStreamAssetSource,
  stream: Pick<StreamRow, 'squadId'>
): Promise<ResolvedSource> {
  const unavailable = () => new AssetAttachmentError(SOURCE_UNAVAILABLE, 404)
  let resolved: ResolvedSource
  let owner: Agent | null
  if (source.kind === 'image') {
    const image = await Image.find(source.imageId.toLowerCase())
    // Only images delivered in a conversation: never staged uploads, avatars or failed sends.
    if (!image?.agentId || image.status !== 'used' || !IMAGE_FILENAME.test(image.filename)) throw unavailable()
    owner = await Agent.find(image.agentId, { eager: false })
    if (!owner) throw unavailable()
    const allowed =
      identity.type === 'agent'
        ? await callerScopeIncludes(identity, { agentId: image.agentId })
        : await canReadImage(identity, image)
    if (!allowed) throw unavailable()
    let bytes: Buffer
    try {
      bytes = await image.getBuffer()
    } catch {
      throw unavailable()
    }
    if (bytes.length !== image.size) throw unavailable()
    resolved = {
      kind: 'image',
      sourceId: image.id,
      blobOwner: image.filename,
      ownerAgentId: image.agentId,
      filename: image.filename,
      contentType: image.mimeType,
      byteSize: image.size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  } else {
    const file = await AgentFileAttachment.findById(source.attachmentId)
    // Only files actually sent in a message.
    if (!file || file.status !== 'used') throw unavailable()
    owner = await Agent.find(file.agentId, { eager: false })
    if (!owner) throw unavailable()
    const allowed =
      identity.type === 'agent'
        ? await callerScopeIncludes(identity, { agentId: file.agentId, sandboxId: file.sandboxId })
        : await hasAgentResourcePermission(identity, owner, 'agents:read')
    if (!allowed) throw unavailable()
    resolved = {
      kind: 'agent-file',
      sourceId: file.id,
      blobOwner: file.agentId,
      ownerAgentId: file.agentId,
      filename: file.storedName,
      // Previews follow the name, as for handoff files, never the uploader's declared type.
      contentType: workflowAttachmentContentType(file.storedName),
      byteSize: file.byteSize,
      sha256: file.sha256,
    }
  }
  // A squad conversation's asset stays in its squad. A private conversation's asset may be shared
  // only by its owner (or the owner's own agent), and only into a stream that owner can write.
  if (owner.squadId) {
    if (owner.squadId !== stream.squadId) throw unavailable()
  } else if (!owner.ownerUserId || identityUserId(identity) !== owner.ownerUserId) {
    throw unavailable()
  }
  return resolved
}

/** Under the source lock: the source still exists, unchanged, in the same conversation. */
async function sourceStillShareable(tx: DbTx, source: ResolvedSource): Promise<boolean> {
  if (source.kind === 'image') {
    const [row] = await tx
      .select({ agentId: images.agentId, status: images.status })
      .from(images)
      .where(eq(images.id, source.sourceId))
    return row?.agentId === source.ownerAgentId && row.status === 'used'
  }
  const [row] = await tx
    .select({ agentId: agentFileAttachments.agentId, status: agentFileAttachments.status })
    .from(agentFileAttachments)
    .where(eq(agentFileAttachments.id, source.sourceId))
  return row?.agentId === source.ownerAgentId && row.status === 'used'
}

/** The retained-asset row for a source, created on first use. Call holding the source lock. */
async function retainSource(tx: DbTx, source: ResolvedSource, squadId: string): Promise<AssetRow> {
  const [existing] = await tx
    .select()
    .from(retainedAssets)
    .where(and(eq(retainedAssets.sourceKind, source.kind), eq(retainedAssets.sourceId, source.sourceId)))
  if (existing) {
    if (existing.deleteRequestedAt) throw new AssetAttachmentError(SOURCE_UNAVAILABLE, 404)
    return existing
  }
  const [created] = await tx
    .insert(retainedAssets)
    .values({
      sourceKind: source.kind,
      sourceId: source.sourceId,
      blobOwner: source.blobOwner,
      filename: source.filename,
      contentType: source.contentType,
      byteSize: source.byteSize,
      sha256: source.sha256,
      squadId,
    })
    .returning()
  return created!
}

function activeShare(streamId: string, attemptId: number | null) {
  return and(
    eq(workStreamAssetAttachments.workStreamId, streamId),
    attemptId === null
      ? isNull(workStreamAssetAttachments.attemptId)
      : eq(workStreamAssetAttachments.attemptId, attemptId),
    isNull(workStreamAssetAttachments.removedAt)
  )
}

/** Insert the share (or return the identical active one) holding the source lock. */
async function insertShare(
  tx: DbTx,
  identity: Identity,
  stream: StreamRow,
  attemptId: number | null,
  source: ResolvedSource,
  checkCapacity: () => Promise<void>,
  createdAt?: Date
): Promise<{ attachment: WorkStreamAssetAttachment; created: boolean }> {
  await lockSource(tx, source.sourceId)
  if (!(await sourceStillShareable(tx, source))) throw new AssetAttachmentError(SOURCE_UNAVAILABLE, 404)
  const [same] = await tx
    .select()
    .from(workStreamAssetAttachments)
    .where(
      and(
        activeShare(stream.id, attemptId),
        eq(workStreamAssetAttachments.sourceKind, source.kind),
        eq(workStreamAssetAttachments.sourceId, source.sourceId)
      )
    )
  if (same) return { attachment: shareJson(same), created: false }
  await checkCapacity()
  const asset = await retainSource(tx, source, stream.squadId)
  const [row] = await tx
    .insert(workStreamAssetAttachments)
    .values({
      workStreamId: stream.id,
      attemptId,
      retainedAssetId: asset.id,
      sourceKind: source.kind,
      sourceId: source.sourceId,
      filename: asset.filename,
      contentType: asset.contentType,
      byteSize: asset.byteSize,
      ...creator(identity),
      ...(createdAt ? { createdAt } : {}),
    })
    .returning()
  return { attachment: shareJson(row!), created: true }
}

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

/**
 * Share a stored asset with a work stream as an input. Identical repeats return the existing share.
 * The caller has already resolved the stream; `notify` tells running workers about the new input.
 */
export async function attachStreamAsset(input: {
  identity: Identity
  streamId: string
  source: WorkStreamAssetSource
  notify?: boolean
}): Promise<{ attachment: WorkStreamAssetAttachment; created: boolean }> {
  const [stream] = await db.select().from(workStreams).where(eq(workStreams.id, input.streamId))
  if (!stream) throw new AssetAttachmentError('Work stream not found', 404)
  if (!(await canReadStreamAssets(input.identity, stream)) || !(await canWriteStreamInputs(input.identity, stream)))
    throw new AssetAttachmentError('Forbidden', 403)
  const source = await resolveShareableSource(input.identity, input.source, stream)
  const result = await db.transaction(async (tx) => {
    await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, stream.squadId)).for('update')
    const [locked] = await tx.select().from(workStreams).where(eq(workStreams.id, stream.id)).for('update')
    if (!locked) throw new AssetAttachmentError('Work stream not found', 404)
    if (['done', 'canceled'].includes(locked.status))
      throw new AssetAttachmentError('This work stream is finished; its inputs can no longer change', 409)
    return insertShare(tx, input.identity, locked, null, source, async () => {
      const [inputs] = await tx
        .select({ total: count() })
        .from(workStreamAssetAttachments)
        .where(activeShare(stream.id, null))
      if ((inputs?.total ?? 0) >= WORK_STREAM_INPUT_ASSET_LIMIT)
        throw new AssetAttachmentError(
          `A work stream can hold at most ${WORK_STREAM_INPUT_ASSET_LIMIT} stored inputs; remove one first`,
          409
        )
    })
  })
  if (result.created && input.notify !== false) await notifyRunningWorkers(stream.id, input.identity, result.attachment)
  return result
}

/** Sources checked for a stream that is about to be created (creating it is the write permission). */
export type PreparedCreationAssets = ResolvedSource[]

export async function prepareCreationAssets(
  identity: Identity,
  sources: WorkStreamAssetSource[],
  squadId: string
): Promise<PreparedCreationAssets> {
  const keys = sources.map((source) =>
    `${source.kind}:${source.kind === 'image' ? source.imageId : source.attachmentId}`.toLowerCase()
  )
  if (new Set(keys).size !== keys.length) throw new AssetAttachmentError('Each image or file can be attached once', 400)
  if (sources.length > WORK_STREAM_INPUT_ASSET_LIMIT)
    throw new AssetAttachmentError(`A work stream can hold at most ${WORK_STREAM_INPUT_ASSET_LIMIT} stored inputs`, 400)
  const resolved: ResolvedSource[] = []
  for (const source of sources) resolved.push(await resolveShareableSource(identity, source, { squadId }))
  return resolved
}

/** Insert prepared inputs inside the creation transaction, so the first assignment already has them. */
export async function insertCreationAssets(
  tx: DbTx,
  identity: Identity,
  created: StreamRow,
  prepared: PreparedCreationAssets
): Promise<void> {
  // Take every source lock in one order first (no deadlock with another multi-source create), then
  // insert in the caller's order: explicit timestamps keep that order, as all rows share one transaction.
  for (const id of prepared.map((source) => source.sourceId).sort()) await lockSource(tx, id)
  const base = Date.now()
  for (const [index, source] of prepared.entries())
    await insertShare(tx, identity, created, null, source, async () => {}, new Date(base + index))
}

/**
 * Attach a stored asset to an open flow attempt's results, under the same rule and locks as
 * uploading a handoff file: only the attempt's own agent, while it is running.
 */
export async function attachAttemptAsset(input: {
  identity: Identity
  streamId: string
  attemptId: number
  source: WorkStreamAssetSource
}): Promise<{ attachment: WorkStreamAssetAttachment; created: boolean }> {
  const [stream] = await db.select().from(workStreams).where(eq(workStreams.id, input.streamId))
  if (!stream) throw new AssetAttachmentError('Work stream not found', 404)
  const [run] = await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, stream.id))
  assertCanAttach(stream, run, input.attemptId, input.identity)
  const source = await resolveShareableSource(input.identity, input.source, stream)
  return db.transaction(async (tx) => {
    // advanceFlow's lock order (squad, stream, run), as handoff uploads take.
    await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, stream.squadId)).for('update')
    const [locked] = await tx.select().from(workStreams).where(eq(workStreams.id, stream.id)).for('update')
    const [lockedRun] = await tx
      .select()
      .from(workStreamFlowRuns)
      .where(eq(workStreamFlowRuns.workStreamId, stream.id))
      .for('update')
    assertCanAttach(locked, lockedRun, input.attemptId, input.identity)
    return insertShare(tx, input.identity, locked!, input.attemptId, source, async () => {
      // References and the attempt's current uploaded handoff files share its limit.
      const attempt = lockedRun!.state.attempts.find((entry) => entry.id === input.attemptId)!
      if ((await attemptSlotsUsed(tx, stream.id, attempt)) >= WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT)
        throw new AssetAttachmentError(`An attempt can attach at most ${WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT} files`, 409)
    })
  })
}

/**
 * Tell the agents working the stream's running attempts that an input arrived. Best effort and never
 * a wake-up through a pause, an open wait or dormancy: the next assignment lists inputs anyway.
 */
async function notifyRunningWorkers(
  streamId: string,
  identity: Identity,
  attachment: WorkStreamAssetAttachment
): Promise<void> {
  try {
    const [stream] = await db.select().from(workStreams).where(eq(workStreams.id, streamId))
    if (!stream || stream.status !== 'active' || stream.pause) return
    const { listOpenWaits } = await import('./waits')
    if ((await listOpenWaits(db, streamId)).length) return
    const [run] = await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, streamId))
    if (!run?.activated) return
    const running = run.state.attempts.filter((attempt) => attempt.status === 'running')
    const agentIds = [...new Set(running.map((attempt) => run.attemptAgents[String(attempt.id)]).filter(Boolean))]
    const { InboxMessage } = await import('../../entities/InboxMessage')
    const { workStreamLabel } = await import('@ficus/shared')
    for (const agentId of agentIds) {
      if (identity.type === 'agent' && identity.agentId === agentId) continue
      await InboxMessage.send({
        recipientType: 'agent',
        recipientId: agentId!,
        senderType: 'system',
        subject: `New input on work stream ${workStreamLabel(stream)}`,
        content: `${assetManifestLines([attachment]).join('\n')}\n\nList every input with: ficus workstream attachment list ${stream.id}`,
        metadata: { workStreamId: stream.id, assetAttachmentId: attachment.id },
        deliveryMode: 'follow-up',
        refuseDormantRecipient: true,
      }).catch((error: unknown) => log.warn(`Could not tell agent ${agentId} about a new input`, error))
    }
  } catch (error) {
    log.warn(`Could not notify workers of work stream ${streamId} about a new input`, error)
  }
}

// ---------------------------------------------------------------------------
// List, read, remove
// ---------------------------------------------------------------------------

/** A stream's active shares: inputs, and each attempt's results, in attach order. */
export async function listStreamAssets(
  streamId: string,
  executor: Pick<typeof db, 'select'> = db
): Promise<WorkStreamAssetAttachments> {
  const rows = await executor
    .select()
    .from(workStreamAssetAttachments)
    .where(
      and(
        eq(workStreamAssetAttachments.workStreamId, streamId),
        isNull(workStreamAssetAttachments.removedAt),
        isNotNull(workStreamAssetAttachments.retainedAssetId)
      )
    )
    .orderBy(asc(workStreamAssetAttachments.createdAt), asc(workStreamAssetAttachments.id))
  const result: WorkStreamAssetAttachments = { inputs: [], attempts: {} }
  for (const row of rows) {
    if (row.attemptId === null) result.inputs.push(shareJson(row))
    else (result.attempts[String(row.attemptId)] ??= []).push(shareJson(row))
  }
  return result
}

/** Several streams' inputs at once (for list views); absent streams have none. */
export async function listStreamInputsFor(streamIds: string[]): Promise<Map<string, WorkStreamAssetAttachment[]>> {
  const result = new Map<string, WorkStreamAssetAttachment[]>()
  if (!streamIds.length) return result
  const rows = await db
    .select()
    .from(workStreamAssetAttachments)
    .where(
      and(
        inArray(workStreamAssetAttachments.workStreamId, streamIds),
        isNull(workStreamAssetAttachments.attemptId),
        isNull(workStreamAssetAttachments.removedAt),
        isNotNull(workStreamAssetAttachments.retainedAssetId)
      )
    )
    .orderBy(asc(workStreamAssetAttachments.createdAt), asc(workStreamAssetAttachments.id))
  for (const row of rows) {
    const list = result.get(row.workStreamId) ?? []
    list.push(shareJson(row))
    result.set(row.workStreamId, list)
  }
  return result
}

/** A retained asset's bytes, verified against their recorded size and digest. */
async function readRetainedBytes(asset: AssetRow): Promise<Buffer> {
  try {
    if (asset.sourceKind === 'agent-file')
      return await readVerifiedAgentAttachmentBlob(asset.blobOwner, asset.sourceId, asset.byteSize, asset.sha256)
    if (!IMAGE_FILENAME.test(asset.blobOwner)) throw new Error('Invalid stored image name')
    const bytes = await readFile(getImagePath(asset.blobOwner))
    if (bytes.length !== asset.byteSize || createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
      throw new Error('ATTACHMENT_BLOB_CORRUPT')
    return bytes
  } catch {
    throw new AssetUnavailableError()
  }
}

/**
 * One active share of this stream and its verified bytes; null when the stream has no such active
 * share. The caller has authorized reading the stream.
 */
export async function readStreamAsset(
  streamId: string,
  shareId: string
): Promise<{ attachment: WorkStreamAssetAttachment; bytes: Buffer } | null> {
  const [row] = await db
    .select({ share: workStreamAssetAttachments, asset: retainedAssets })
    .from(workStreamAssetAttachments)
    .innerJoin(retainedAssets, eq(retainedAssets.id, workStreamAssetAttachments.retainedAssetId))
    .where(
      and(
        eq(workStreamAssetAttachments.id, shareId),
        eq(workStreamAssetAttachments.workStreamId, streamId),
        isNull(workStreamAssetAttachments.removedAt)
      )
    )
  if (!row || row.asset.deleteRequestedAt) return null
  return { attachment: shareJson(row.share), bytes: await readRetainedBytes(row.asset) }
}

/**
 * Remove a share. An input needs the stream-edit rule; an attempt's result can be removed only by
 * that attempt's agent while it is open (closed results are reviewed evidence). Idempotent.
 */
export async function removeStreamAsset(input: {
  identity: Identity
  streamId: string
  shareId: string
}): Promise<void> {
  const [stream] = await db.select().from(workStreams).where(eq(workStreams.id, input.streamId))
  if (!stream) throw new AssetAttachmentError('Work stream not found', 404)
  if (!(await canReadStreamAssets(input.identity, stream))) throw new AssetAttachmentError('Forbidden', 403)
  const [share] = await db
    .select()
    .from(workStreamAssetAttachments)
    .where(
      and(eq(workStreamAssetAttachments.id, input.shareId), eq(workStreamAssetAttachments.workStreamId, stream.id))
    )
  if (!share) throw new AssetAttachmentError('Attachment not found', 404)
  if (share.attemptId === null) {
    if (!(await canWriteStreamInputs(input.identity, stream))) throw new AssetAttachmentError('Forbidden', 403)
  } else {
    const [run] = await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, stream.id))
    assertCanAttach(stream, run, share.attemptId, input.identity)
  }
  if (share.removedAt) return
  const released = await db.transaction(async (tx) => {
    await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, stream.squadId)).for('update')
    const [locked] = await tx.select().from(workStreams).where(eq(workStreams.id, stream.id)).for('update')
    if (share.attemptId !== null) {
      const [run] = await tx
        .select()
        .from(workStreamFlowRuns)
        .where(eq(workStreamFlowRuns.workStreamId, stream.id))
        .for('update')
      assertCanAttach(locked, run, share.attemptId, input.identity)
    }
    const [row] = await tx
      .update(workStreamAssetAttachments)
      .set({ removedAt: new Date() })
      .where(and(eq(workStreamAssetAttachments.id, share.id), isNull(workStreamAssetAttachments.removedAt)))
      .returning({ retainedAssetId: workStreamAssetAttachments.retainedAssetId })
    return row?.retainedAssetId ?? null
  })
  if (released)
    await releaseRetainedAsset(released).catch((error) => log.warn('Asset release deferred to cleanup', error))
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** The retained assets a stream's shares hold, for release once the stream is deleted. */
export async function retainedAssetIdsForStream(streamId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: workStreamAssetAttachments.retainedAssetId })
    .from(workStreamAssetAttachments)
    .where(
      and(eq(workStreamAssetAttachments.workStreamId, streamId), isNotNull(workStreamAssetAttachments.retainedAssetId))
    )
  return rows.flatMap((row) => (row.id ? [row.id] : []))
}

async function sourceRowExists(tx: DbTx, asset: AssetRow): Promise<boolean> {
  const table = asset.sourceKind === 'image' ? images : agentFileAttachments
  const [row] = await tx.select({ id: table.id }).from(table).where(eq(table.id, asset.sourceId))
  return Boolean(row)
}

function isMissingFile(error: unknown): boolean {
  const failure = error as { code?: string; errno?: number }
  return failure?.code === 'ENOENT' || failure?.errno === 2
}

/**
 * Release a retained asset no active share uses. While its source row exists the source owns the
 * bytes, so only the bookkeeping goes; once the source is gone too, its exact blob is unlinked. A
 * failed unlink leaves `deleteRequestedAt` set for the cleanup sweep to retry. Never removes a
 * directory, and an already missing blob counts as removed.
 */
export async function releaseRetainedAsset(assetId: string): Promise<'kept' | 'released' | 'deleted' | 'pending'> {
  const decision = await db.transaction(async (tx) => {
    const [found] = await tx.select().from(retainedAssets).where(eq(retainedAssets.id, assetId))
    if (!found) return { kind: 'released' as const }
    await lockSource(tx, found.sourceId)
    const [asset] = await tx.select().from(retainedAssets).where(eq(retainedAssets.id, assetId)).for('update')
    if (!asset) return { kind: 'released' as const }
    if (!asset.deleteRequestedAt) {
      const [active] = await tx
        .select({ total: count() })
        .from(workStreamAssetAttachments)
        .where(
          and(eq(workStreamAssetAttachments.retainedAssetId, asset.id), isNull(workStreamAssetAttachments.removedAt))
        )
      if ((active?.total ?? 0) > 0) return { kind: 'kept' as const }
      if (await sourceRowExists(tx, asset)) {
        await tx.delete(retainedAssets).where(eq(retainedAssets.id, asset.id))
        return { kind: 'released' as const }
      }
      await tx.update(retainedAssets).set({ deleteRequestedAt: new Date() }).where(eq(retainedAssets.id, asset.id))
    }
    return { kind: 'unlink' as const, asset }
  })
  if (decision.kind !== 'unlink') return decision.kind
  const { asset } = decision
  try {
    if (asset.sourceKind === 'agent-file') await deleteAgentAttachmentBlob(asset.blobOwner, asset.sourceId)
    else if (IMAGE_FILENAME.test(asset.blobOwner)) await unlink(getImagePath(asset.blobOwner))
  } catch (error) {
    if (!isMissingFile(error)) {
      log.warn(`Could not remove the bytes of retained asset ${asset.id}; cleanup will retry`, error)
      return 'pending'
    }
  }
  await db
    .delete(retainedAssets)
    .where(and(eq(retainedAssets.id, asset.id), isNotNull(retainedAssets.deleteRequestedAt)))
  return 'deleted'
}

/**
 * The bounded cleanup sweep: retry pending deletions and release assets whose last share went
 * without a release (a deleted squad's streams, a release that failed after its commit).
 */
export async function runRetainedAssetCleanup(options: { maxAssets?: number } = {}): Promise<number> {
  const unused = notExists(
    db
      .select({ id: workStreamAssetAttachments.id })
      .from(workStreamAssetAttachments)
      .where(
        and(
          eq(workStreamAssetAttachments.retainedAssetId, retainedAssets.id),
          isNull(workStreamAssetAttachments.removedAt)
        )
      )
  )
  const candidates = await db
    .select({ id: retainedAssets.id })
    .from(retainedAssets)
    .where(or(isNotNull(retainedAssets.deleteRequestedAt), unused))
    .orderBy(asc(retainedAssets.createdAt))
    .limit(Math.max(1, options.maxAssets ?? 25))
  let done = 0
  for (const { id } of candidates) {
    try {
      const outcome = await releaseRetainedAsset(id)
      if (outcome === 'released' || outcome === 'deleted') done++
    } catch (error) {
      log.warn(`Retained asset ${id} cleanup will retry`, error)
    }
  }
  return done
}

// ---------------------------------------------------------------------------
// Assignment manifests
// ---------------------------------------------------------------------------

/** The manifest an assignment shows: the stream's inputs and the incoming attempts' results. */
export async function loadAssignmentAssets(
  executor: Pick<typeof db, 'select'>,
  streamId: string,
  incomingAttemptIds: number[],
  /** The incoming attempts; an amended attempt lists only its current revision's files. */
  attempts: WorkflowAttempt[] = []
): Promise<AssignmentAssets> {
  const all = await listStreamAssets(streamId, executor)
  const files = incomingAttemptIds.length
    ? await executor
        .select()
        .from(workflowAttemptAttachments)
        .where(
          and(
            eq(workflowAttemptAttachments.workStreamId, streamId),
            inArray(workflowAttemptAttachments.attemptId, incomingAttemptIds)
          )
        )
        .orderBy(asc(workflowAttemptAttachments.createdAt), asc(workflowAttemptAttachments.id))
    : []
  // Each incoming attempt's current revision, in its display order (an amend keeps a replaced
  // file's place); files of superseded revisions or never-published staging are not listed.
  const json = files.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))
  const byId = new Map(files.map((row) => [row.id, row]))
  const current = incomingAttemptIds.flatMap((id) => {
    const attempt = attempts.find((entry) => entry.id === id)
    const ids = attempt
      ? workflowCurrentAttachmentIds(attempt, json)
      : json.filter((row) => row.attemptId === id && row.revision === 1).map((row) => row.id)
    return ids.flatMap((fileId) => byId.get(fileId) ?? [])
  })
  return {
    inputs: all.inputs,
    incoming: incomingAttemptIds.flatMap((id) => all.attempts[String(id)] ?? []),
    incomingFiles: current.map((row) => ({
      id: row.id,
      attemptId: row.attemptId,
      filename: row.filename,
      path: row.path,
      contentType: row.contentType,
      byteSize: row.byteSize,
      createdAt: row.createdAt.toISOString(),
    })),
  }
}
