import { and, asc, count, eq, isNull } from 'drizzle-orm'
import {
  WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT,
  workflowAmendEligibility,
  workflowAttachmentContentType,
  workflowCurrentAttachmentIds,
  workflowResultRevision,
  type WorkflowAttempt,
  type WorkflowAttemptAttachment,
  type WorkflowRun,
} from '@ficus/shared'
import {
  db,
  squads,
  workflowAttemptAttachments,
  workStreamAssetAttachments,
  workStreamFlowRuns,
  workStreams,
  type DbTx,
} from '../../db'
import { rm } from 'node:fs/promises'
import { createLogger } from '../../lib/infra/logger'
import {
  deleteWorkflowAttachmentBlob,
  workflowAttachmentBlobPath,
  workflowAttachmentDirectory,
  readVerifiedWorkflowAttachmentBlob,
  sha256Hex,
  writeWorkflowAttachmentBlob,
} from '../attachments/blob-storage'
import { getSettingsStore } from '../settings'
import { reserveAttachmentStorage } from '../attachments/storage-quota'
import type { Identity } from '../rbac'
import { WorkflowError } from './catalog'
import { assertStreamAcceptsHandoffs, isAttemptAgent } from './execution'

const log = createLogger('workflow-attachments')

type Row = typeof workflowAttemptAttachments.$inferSelect
type Run = typeof workStreamFlowRuns.$inferSelect
type Stream = typeof workStreams.$inferSelect

/** The per-file cap shared with agent chat files and inbox attachments. */
export function workflowAttachmentMaxBytes(): number {
  return Number(getSettingsStore().getTyped('INBOX_MAX_ATTACHMENT_BYTES'))
}

function toJson(row: Row): WorkflowAttemptAttachment {
  return {
    id: row.id,
    attemptId: row.attemptId,
    filename: row.filename,
    path: row.path,
    contentType: row.contentType,
    byteSize: row.byteSize,
    createdAt: row.createdAt.toISOString(),
    revision: row.revision,
  }
}

/**
 * Attaching follows completing: only the agent bound to the attempt, on a stream that accepts handoffs,
 * and only while the attempt is still open, so a review gate opens with exactly the files its source
 * attempt handed off. A completed attempt that may still be amended (the human approval gate it feeds
 * is open) stages files for its next result revision; they become current only when the amend lands.
 */
export function assertCanAttach(
  stream: Pick<Stream, 'pause' | 'status'> | undefined,
  run: Run | undefined,
  attemptId: number,
  identity: Identity,
  /**
   * Whether a completed attempt may stage uploaded files for an amend. Stored references attached
   * by ID are not revisioned, so they attach to (and detach from) a running attempt only.
   */
  { amendStaging = false }: { amendStaging?: boolean } = {}
): { agentId: string; revision: number } {
  if (!stream || !run?.activated) throw new WorkflowError('Flow not found', 404)
  const attempt = run.state.attempts.find((entry) => entry.id === attemptId)
  if (!attempt) throw new WorkflowError('Attempt not found', 404)
  if (identity.type !== 'agent' || !isAttemptAgent(run, attemptId, identity))
    throw new WorkflowError('Only the agent working on this attempt can attach files to it', 403)
  assertStreamAcceptsHandoffs(stream)
  if (attempt.status === 'running') return { agentId: identity.agentId, revision: 1 }
  if (!amendStaging || !workflowAmendEligibility(run.state, attemptId).ok)
    throw new WorkflowError('This attempt is no longer open', 409)
  return { agentId: identity.agentId, revision: workflowResultRevision(attempt) + 1 }
}

/** Stored chat images and files attached to the attempt by ID; they share its file slots. */
async function activeAttemptReferenceCount(tx: DbTx, workStreamId: string, attemptId: number): Promise<number> {
  const [references] = await tx
    .select({ total: count() })
    .from(workStreamAssetAttachments)
    .where(
      and(
        eq(workStreamAssetAttachments.workStreamId, workStreamId),
        eq(workStreamAssetAttachments.attemptId, attemptId),
        isNull(workStreamAssetAttachments.removedAt)
      )
    )
  return references?.total ?? 0
}

/**
 * The file slots an attempt's current result uses: its current revision's uploaded files plus its
 * active stored references. Files of superseded revisions and staged files do not count.
 */
export async function attemptSlotsUsed(tx: DbTx, workStreamId: string, attempt: WorkflowAttempt): Promise<number> {
  const rows = (await tx.select().from(workflowAttemptAttachments).where(attemptRows(workStreamId, attempt.id))).map(
    toJson
  )
  return (
    workflowCurrentAttachmentIds(attempt, rows).length +
    (await activeAttemptReferenceCount(tx, workStreamId, attempt.id))
  )
}

const attemptRows = (workStreamId: string, attemptId: number) =>
  and(eq(workflowAttemptAttachments.workStreamId, workStreamId), eq(workflowAttemptAttachments.attemptId, attemptId))

/**
 * Store a handoff file. Files are keyed by (attempt, revision, path): sending the same bytes again
 * returns the stored file (`created: false`, so a retried handoff is harmless), and new bytes for a
 * path replace the old file of the same revision. Only a new path takes one of the revision's slots.
 * A file staged for an amend that matches the current revision's file at that path returns the
 * current file, so an unchanged file keeps its ID across revisions. Files of a recorded revision
 * are never replaced or deleted.
 */
export async function uploadWorkflowAttachment(input: {
  workStreamId: string
  squadId: string
  attemptId: number
  identity: Identity
  filename: string
  path: string
  bytes: Uint8Array
}): Promise<{ attachment: WorkflowAttemptAttachment; created: boolean }> {
  if (input.bytes.byteLength === 0) throw new WorkflowError('Attachment is empty', 400)
  if (input.bytes.byteLength > workflowAttachmentMaxBytes()) throw new WorkflowError('ATTACHMENT_TOO_LARGE', 413)
  const id = crypto.randomUUID()
  const sha256 = sha256Hex(input.bytes)
  const samePath = and(
    attemptRows(input.workStreamId, input.attemptId),
    eq(workflowAttemptAttachments.path, input.path)
  )
  // A retried handoff usually finds its file already stored: answer it without writing or locking.
  // Only the agent bound to the open attempt reaches this (the route checks before reading the body).
  // `rows` are this path's files of every revision. Bytes equal to the file already staged for this
  // revision are that file. For an amend, bytes equal to the current revision's file are that file, so
  // an unchanged file keeps its ID across revisions; a different file staged earlier for the same path
  // is then discarded, or the amend would publish it instead of the restored original.
  const unchanged = (rows: Row[], state: WorkflowRun | undefined, revision: number) => {
    const staged = rows.find((row) => row.revision === revision)
    if (staged?.sha256 === sha256) return { row: staged }
    const attempt = state?.attempts.find((entry) => entry.id === input.attemptId)
    const current = new Set(revision > 1 && attempt ? workflowCurrentAttachmentIds(attempt, rows.map(toJson)) : [])
    const restored = rows.find((row) => row.sha256 === sha256 && current.has(row.id))
    return restored ? { row: restored, discard: staged } : {}
  }
  const targetRevision = (state: WorkflowRun | undefined) => {
    const attempt = state?.attempts.find((entry) => entry.id === input.attemptId)
    return !attempt || attempt.status === 'running' ? 1 : workflowResultRevision(attempt) + 1
  }
  const [unlocked] = await db
    .select({ state: workStreamFlowRuns.state })
    .from(workStreamFlowRuns)
    .where(eq(workStreamFlowRuns.workStreamId, input.workStreamId))
  const stored = unchanged(
    await db.select().from(workflowAttemptAttachments).where(samePath),
    unlocked?.state,
    targetRevision(unlocked?.state)
  )
  if (stored.row && !stored.discard) return { attachment: toJson(stored.row), created: false }
  // Write the bytes under their own new id before taking any lock, so no lock is held during file I/O.
  // Every outcome but a committed insert of this id removes them again.
  await writeWorkflowAttachmentBlob(input.workStreamId, id, input.bytes)
  const after = { kept: false, replaced: null as string | null }
  try {
    const result = await db.transaction(async (tx) => {
      // Lock in advanceFlow's order (squad, stream, then run) so an upload racing the attempt's
      // completion waits for it instead of deadlocking; completion takes the same run lock.
      await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, input.squadId)).for('update')
      const [stream] = await tx.select().from(workStreams).where(eq(workStreams.id, input.workStreamId)).for('update')
      const [run] = await tx
        .select()
        .from(workStreamFlowRuns)
        .where(eq(workStreamFlowRuns.workStreamId, input.workStreamId))
        .for('update')
      const { agentId, revision } = assertCanAttach(stream, run, input.attemptId, input.identity, {
        amendStaging: true,
      })
      const stored = unchanged(await tx.select().from(workflowAttemptAttachments).where(samePath), run!.state, revision)
      if (stored.row) {
        if (stored.discard) {
          await tx.delete(workflowAttemptAttachments).where(eq(workflowAttemptAttachments.id, stored.discard.id))
          after.replaced = stored.discard.id
        }
        return { attachment: toJson(stored.row), created: false }
      }
      const sameRevision = and(samePath, eq(workflowAttemptAttachments.revision, revision))
      const [existing] = await tx.select().from(workflowAttemptAttachments).where(sameRevision)
      if (existing) {
        await tx.delete(workflowAttemptAttachments).where(eq(workflowAttemptAttachments.id, existing.id))
      } else {
        const [files] = await tx
          .select({ total: count() })
          .from(workflowAttemptAttachments)
          .where(
            and(attemptRows(input.workStreamId, input.attemptId), eq(workflowAttemptAttachments.revision, revision))
          )
        // Only the files of the revision being written count, plus the attempt's active stored
        // references (they carry into every revision); superseded revisions never use up slots.
        const references = await activeAttemptReferenceCount(tx, input.workStreamId, input.attemptId)
        if ((files?.total ?? 0) + references >= WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT)
          throw new WorkflowError(
            revision > 1
              ? `An amend can stage at most ${WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT} files, including the attempt's stored references`
              : `An attempt can attach at most ${WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT} files`,
            409
          )
      }
      // A replacement's old row is already gone, so only the size change counts against the quota.
      await reserveAttachmentStorage(tx, input.bytes.byteLength).catch((error: unknown) => {
        if (error instanceof Error && error.message === 'INBOX_STORAGE_QUOTA_EXCEEDED')
          throw new WorkflowError(error.message, 400)
        throw error
      })
      const [row] = await tx
        .insert(workflowAttemptAttachments)
        .values({
          id,
          workStreamId: input.workStreamId,
          attemptId: input.attemptId,
          filename: input.filename,
          path: input.path,
          contentType: workflowAttachmentContentType(input.filename),
          byteSize: input.bytes.byteLength,
          sha256,
          storagePath: workflowAttachmentBlobPath(input.workStreamId, id),
          uploadedByAgentId: agentId,
          revision,
          // A replacement keeps the original's place (attachments list in creation order).
          ...(existing ? { createdAt: existing.createdAt } : {}),
        })
        .returning()
      after.replaced = existing?.id ?? null
      return { attachment: toJson(row!), created: true }
    })
    after.kept = result.created
    // The replaced bytes go only once the row that named them is gone for good.
    if (after.replaced) await deleteWorkflowAttachmentBlob(input.workStreamId, after.replaced).catch(() => {})
    return result
  } finally {
    if (!after.kept) await deleteWorkflowAttachmentBlob(input.workStreamId, id).catch(() => {})
  }
}

/** The stored bytes are missing or no longer match their recorded size and digest. */
export class WorkflowAttachmentUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Attachment unavailable', { cause })
  }
}

function isUnavailableBlob(error: unknown): boolean {
  const failure = error as { message?: string; code?: string; errno?: number }
  return (
    failure?.message === 'ATTACHMENT_BLOB_CORRUPT' ||
    failure?.code === 'ENOENT' ||
    // openat(2) reports ENOENT by number.
    failure?.errno === 2
  )
}

/**
 * A run's attachments by attempt id. `attachments` is each attempt's current result revision, in
 * display order; `earlierAttachments` holds files only an earlier revision used, in upload order.
 * Files staged for an amend that never landed are in neither (they stay downloadable by id).
 */
export async function listWorkflowAttachments(
  workStreamId: string,
  state: Pick<WorkflowRun, 'attempts'>
): Promise<{
  attachments: Record<string, WorkflowAttemptAttachment[]>
  earlierAttachments: Record<string, WorkflowAttemptAttachment[]>
}> {
  const rows = await db
    .select()
    .from(workflowAttemptAttachments)
    .where(eq(workflowAttemptAttachments.workStreamId, workStreamId))
    .orderBy(asc(workflowAttemptAttachments.createdAt), asc(workflowAttemptAttachments.id))
  const byAttempt = new Map<number, WorkflowAttemptAttachment[]>()
  for (const row of rows) byAttempt.set(row.attemptId, [...(byAttempt.get(row.attemptId) ?? []), toJson(row)])
  const attachments: Record<string, WorkflowAttemptAttachment[]> = {}
  const earlierAttachments: Record<string, WorkflowAttemptAttachment[]> = {}
  for (const [attemptId, files] of byAttempt) {
    const attempt = state.attempts.find((entry) => entry.id === attemptId)
    const byId = new Map(files.map((file) => [file.id, file]))
    const currentIds = attempt
      ? workflowCurrentAttachmentIds(attempt, files)
      : files.filter((file) => (file.revision ?? 1) === 1).map((file) => file.id)
    const current = currentIds.flatMap((id) => byId.get(id) ?? [])
    if (current.length) attachments[String(attemptId)] = current
    const earlierIds = new Set(attempt?.earlierResults?.flatMap((result) => result.attachmentIds) ?? [])
    const earlier = files.filter((file) => earlierIds.has(file.id) && !currentIds.includes(file.id))
    if (earlier.length) earlierAttachments[String(attemptId)] = earlier
  }
  return { attachments, earlierAttachments }
}

/**
 * The attachment manifest of an amend: the current revision's files, with the files the amend names
 * (staged for the new revision) replacing same-path files or appended, minus the removed paths. Returns the current
 * manifest (recorded with the superseded revision) and the new one. Runs inside advanceFlow's lock.
 */
export async function amendAttachmentManifest(
  tx: DbTx,
  workStreamId: string,
  attempt: WorkflowAttempt,
  { attachPaths = [], removePaths = [] }: { attachPaths?: string[]; removePaths?: string[] } = {}
): Promise<{ previous: string[]; next: string[] }> {
  const rows = (
    await tx
      .select()
      .from(workflowAttemptAttachments)
      .where(attemptRows(workStreamId, attempt.id))
      .orderBy(asc(workflowAttemptAttachments.createdAt), asc(workflowAttemptAttachments.id))
  ).map(toJson)
  const previous = workflowCurrentAttachmentIds(attempt, rows)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const manifest = new Map(previous.flatMap((id) => (byId.get(id) ? [[byId.get(id)!.path, id] as const] : [])))
  // Only the files this amend names are published. A file staged for an amend that was refused, and
  // not named again, is never published by a later one.
  const staged = workflowResultRevision(attempt) + 1
  for (const path of attachPaths) {
    const row = rows.find((entry) => entry.revision === staged && entry.path === path)
    if (row) manifest.set(path, row.id)
    else if (!manifest.has(path))
      throw new WorkflowError(
        `No file was uploaded for '${path}' for this amend of attempt ${attempt.id}; attach it, then amend again`,
        409
      )
  }
  for (const path of removePaths) {
    if (!manifest.has(path))
      throw new WorkflowError(
        `No attachment '${path}' in revision ${workflowResultRevision(attempt)} of attempt ${attempt.id}`,
        409
      )
    manifest.delete(path)
  }
  if (
    manifest.size + (await activeAttemptReferenceCount(tx, workStreamId, attempt.id)) >
    WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT
  )
    throw new WorkflowError(`An attempt revision can attach at most ${WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT} files`, 409)
  return { previous, next: [...manifest.values()] }
}

/** The attachment and its digest-verified bytes; null when this work stream has no such attachment. */
export async function readWorkflowAttachment(
  workStreamId: string,
  id: string
): Promise<{ attachment: WorkflowAttemptAttachment; bytes: Buffer } | null> {
  const [row] = await db
    .select()
    .from(workflowAttemptAttachments)
    .where(and(eq(workflowAttemptAttachments.id, id), eq(workflowAttemptAttachments.workStreamId, workStreamId)))
  if (!row) return null
  try {
    const bytes = await readVerifiedWorkflowAttachmentBlob(workStreamId, row.id, row.byteSize, row.sha256)
    return { attachment: toJson(row), bytes }
  } catch (error) {
    throw isUnavailableBlob(error) ? new WorkflowAttachmentUnavailableError(error) : error
  }
}

/**
 * Remove a deleted work stream's handoff directory, which holds nothing but that stream's files.
 * Called after the delete commits; a failure is logged and left behind, never thrown into the delete.
 */
export async function removeWorkflowAttachmentDirectory(workStreamId: string): Promise<void> {
  try {
    // rm does not follow symbolic links inside the tree; force makes an absent directory a no-op.
    await rm(workflowAttachmentDirectory(workStreamId), { recursive: true, force: true })
  } catch (error) {
    log.warn(`Could not remove the attachment directory of work stream ${workStreamId}:`, error)
  }
}
