import { and, asc, count, eq } from 'drizzle-orm'
import {
  WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT,
  workflowAttachmentContentType,
  type WorkflowAttemptAttachment,
} from '@ficus/shared'
import { db, squads, workflowAttemptAttachments, workStreamFlowRuns, workStreams } from '../../db'
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
  }
}

/**
 * Attaching follows completing: only the agent bound to the attempt, on a stream that accepts handoffs,
 * and only while the attempt is still open, so a review gate opens with exactly the files its source
 * attempt handed off.
 */
export function assertCanAttach(
  stream: Pick<Stream, 'pause' | 'status'> | undefined,
  run: Run | undefined,
  attemptId: number,
  identity: Identity
): string {
  if (!stream || !run?.activated) throw new WorkflowError('Flow not found', 404)
  const attempt = run.state.attempts.find((entry) => entry.id === attemptId)
  if (!attempt) throw new WorkflowError('Attempt not found', 404)
  if (identity.type !== 'agent' || !isAttemptAgent(run, attemptId, identity))
    throw new WorkflowError('Only the agent working on this attempt can attach files to it', 403)
  assertStreamAcceptsHandoffs(stream)
  if (attempt.status !== 'running') throw new WorkflowError('This attempt is no longer open', 409)
  return identity.agentId
}

/**
 * Store a handoff file. Files are keyed by (attempt, path): sending the same bytes again returns the
 * stored file (`created: false`, so a retried handoff is harmless), and new bytes for a path replace
 * the old file. Only a new path takes one of the attempt's slots.
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
    eq(workflowAttemptAttachments.workStreamId, input.workStreamId),
    eq(workflowAttemptAttachments.attemptId, input.attemptId),
    eq(workflowAttemptAttachments.path, input.path)
  )
  // A retried handoff usually finds its file already stored: answer it without writing or locking.
  // Only the agent bound to the open attempt reaches this (the route checks before reading the body).
  const [stored] = await db.select().from(workflowAttemptAttachments).where(samePath)
  if (stored?.sha256 === sha256) return { attachment: toJson(stored), created: false }
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
      const agentId = assertCanAttach(stream, run, input.attemptId, input.identity)
      const [existing] = await tx.select().from(workflowAttemptAttachments).where(samePath)
      if (existing?.sha256 === sha256) return { attachment: toJson(existing), created: false }
      if (existing) {
        await tx.delete(workflowAttemptAttachments).where(eq(workflowAttemptAttachments.id, existing.id))
      } else {
        const [files] = await tx
          .select({ total: count() })
          .from(workflowAttemptAttachments)
          .where(
            and(
              eq(workflowAttemptAttachments.workStreamId, input.workStreamId),
              eq(workflowAttemptAttachments.attemptId, input.attemptId)
            )
          )
        if ((files?.total ?? 0) >= WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT)
          throw new WorkflowError(`An attempt can attach at most ${WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT} files`, 409)
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

/** Every attachment of a run, by attempt id, in upload order. */
export async function listWorkflowAttachments(
  workStreamId: string
): Promise<Record<string, WorkflowAttemptAttachment[]>> {
  const rows = await db
    .select()
    .from(workflowAttemptAttachments)
    .where(eq(workflowAttemptAttachments.workStreamId, workStreamId))
    .orderBy(asc(workflowAttemptAttachments.createdAt), asc(workflowAttemptAttachments.id))
  const byAttempt: Record<string, WorkflowAttemptAttachment[]> = {}
  for (const row of rows) (byAttempt[String(row.attemptId)] ??= []).push(toJson(row))
  return byAttempt
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
