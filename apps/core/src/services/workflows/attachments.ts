import { and, asc, count, eq } from 'drizzle-orm'
import {
  WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT,
  workflowAttachmentContentType,
  type WorkflowAttemptAttachment,
} from '@ficus/shared'
import { db, workflowAttemptAttachments, workStreamFlowRuns } from '../../db'
import {
  deleteWorkflowAttachmentBlob,
  readVerifiedWorkflowAttachmentBlob,
  sha256Hex,
  writeWorkflowAttachmentBlob,
} from '../attachments/blob-storage'
import { getSettingsStore } from '../settings'
import type { Identity } from '../rbac'
import { WorkflowError } from './catalog'
import { isAttemptAgent } from './execution'

type Row = typeof workflowAttemptAttachments.$inferSelect
type Run = typeof workStreamFlowRuns.$inferSelect

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
 * Attaching follows completing: only the agent bound to the attempt, and only while it is still open,
 * so a review gate opens with exactly the files its source attempt handed off.
 */
export function assertCanAttach(run: Run | undefined, attemptId: number, identity: Identity): string {
  if (!run?.activated) throw new WorkflowError('Flow not found', 404)
  const attempt = run.state.attempts.find((entry) => entry.id === attemptId)
  if (!attempt) throw new WorkflowError('Attempt not found', 404)
  if (identity.type !== 'agent' || !isAttemptAgent(run, attemptId, identity))
    throw new WorkflowError('Only the agent working on this attempt can attach files to it', 403)
  if (attempt.status !== 'running') throw new WorkflowError('This attempt is no longer open', 409)
  return identity.agentId
}

export async function uploadWorkflowAttachment(input: {
  workStreamId: string
  attemptId: number
  identity: Identity
  filename: string
  path: string
  bytes: Uint8Array
}): Promise<WorkflowAttemptAttachment> {
  if (input.bytes.byteLength === 0) throw new WorkflowError('Attachment is empty', 400)
  if (input.bytes.byteLength > workflowAttachmentMaxBytes()) throw new WorkflowError('ATTACHMENT_TOO_LARGE', 413)
  const id = crypto.randomUUID()
  let written = false
  try {
    return await db.transaction(async (tx) => {
      // The run lock orders uploads against completion, which takes the same lock.
      const [run] = await tx
        .select()
        .from(workStreamFlowRuns)
        .where(eq(workStreamFlowRuns.workStreamId, input.workStreamId))
        .for('update')
      const agentId = assertCanAttach(run, input.attemptId, input.identity)
      const [existing] = await tx
        .select({ total: count() })
        .from(workflowAttemptAttachments)
        .where(
          and(
            eq(workflowAttemptAttachments.workStreamId, input.workStreamId),
            eq(workflowAttemptAttachments.attemptId, input.attemptId)
          )
        )
      if ((existing?.total ?? 0) >= WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT)
        throw new WorkflowError(`An attempt can attach at most ${WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT} files`, 409)
      const storagePath = await writeWorkflowAttachmentBlob(input.workStreamId, id, input.bytes)
      written = true
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
          sha256: sha256Hex(input.bytes),
          storagePath,
          uploadedByAgentId: agentId,
        })
        .returning()
      return toJson(row!)
    })
  } catch (error) {
    if (written) await deleteWorkflowAttachmentBlob(input.workStreamId, id).catch(() => {})
    throw error
  }
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
  const bytes = await readVerifiedWorkflowAttachmentBlob(workStreamId, row.id, row.byteSize, row.sha256)
  return { attachment: toJson(row), bytes }
}
