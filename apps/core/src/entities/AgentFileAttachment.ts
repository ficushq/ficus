import { and, eq, sql } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { agentAttachmentRoot, buildAgentAttachmentPath, sanitizeAgentAttachmentName } from '@ficus/shared'
import { db } from '../db'
import { agentFileAttachments, inboxAttachments } from '../db/schema'
import { getSettingsStore } from '../services/settings'
import { resolveWorkspaceLayout } from '../services/sandbox/workspace-layout'
import {
  deleteAgentAttachmentBlob,
  readVerifiedAgentAttachmentBlob,
  sha256Hex,
  writeAgentAttachmentBlob,
} from '../services/attachments/blob-storage'

export type AgentFileAttachmentRow = InferSelectModel<typeof agentFileAttachments>
type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

export interface CreateAgentFileAttachmentInput {
  id: string
  agentId: string
  sandboxId: string
  uploadedByType: string
  uploadedById: string
  originalName: string
  contentType: string
  bytes: Uint8Array
}

/**
 * The agent-visible path an attachment will have on the ACTIVE runtime:
 * `/private` on the container runtimes, the box's `~/.private` on vm, and the
 * core's own `<HOME_DIR>/private/<sandboxId>` on host (where nothing is
 * mounted at `/private` at all). The upload route computes it up-front to
 * validate it, and {@link AgentFileAttachment.createWithDisposition} stores
 * exactly this string — they must not drift.
 */
export function agentVisibleAttachmentPath(sandboxId: string, id: string, originalName: string): string {
  return buildAgentAttachmentPath(
    id,
    originalName,
    agentAttachmentRoot(resolveWorkspaceLayout({ sandboxId }).privateMount)
  )
}

export class AgentFileAttachment {
  id!: string
  agentId!: string
  sandboxId!: string
  uploadedByType!: string
  uploadedById!: string
  originalName!: string
  storedName!: string
  privatePath!: string
  contentType!: string
  byteSize!: number
  sha256!: string
  status!: 'uploading' | 'pending' | 'used'
  uploadAttemptId!: string | null
  usedAt!: Date | null
  createdAt!: Date

  constructor(row: AgentFileAttachmentRow) {
    Object.assign(this, row)
  }

  toJson() {
    return {
      id: this.id,
      path: this.privatePath,
      displayName: this.originalName,
      contentType: this.contentType,
      byteSize: this.byteSize,
      sha256: this.sha256,
    }
  }

  static async create(input: CreateAgentFileAttachmentInput): Promise<AgentFileAttachment> {
    return (await this.createWithDisposition(input)).attachment
  }

  static async createWithDisposition(
    input: CreateAgentFileAttachmentInput,
    finalize?: (result: { attachment: AgentFileAttachment; created: boolean; recovered: boolean }) => Promise<void>
  ): Promise<{ attachment: AgentFileAttachment; created: boolean; recovered: boolean }> {
    const normalizedInput = { ...input, id: input.id.toLowerCase(), agentId: input.agentId.toLowerCase() }
    // The stored path is what the composer inserts and the agent then opens, so
    // it must name the file as the ACTIVE runtime lays it out; materializeForTarget
    // writes the same bytes to the corresponding backing directory.
    const privatePath = agentVisibleAttachmentPath(
      normalizedInput.sandboxId,
      normalizedInput.id,
      normalizedInput.originalName
    )
    const storedName = sanitizeAgentAttachmentName(normalizedInput.originalName)
    const attemptId = crypto.randomUUID()
    const lifecycle = {
      created: null as AgentFileAttachment | null,
      stale: null as AgentFileAttachment | null,
    }
    try {
      const result = await db.transaction(async (tx) => {
        // Instance-global quota is correct only while each deployment serves one tenant.
        // Replace this with a tenant-scoped lock/accounting key before multi-tenant hosting.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('attachment-storage-quota'))`)
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${normalizedInput.id}))`)
        const byteSize = normalizedInput.bytes.byteLength
        const sha256 = sha256Hex(normalizedInput.bytes)
        const existing = await this.findById(normalizedInput.id, tx)
        if (existing) {
          const sameUpload =
            existing.agentId === normalizedInput.agentId &&
            existing.sandboxId === normalizedInput.sandboxId &&
            existing.uploadedByType === normalizedInput.uploadedByType &&
            existing.uploadedById === normalizedInput.uploadedById &&
            existing.originalName === normalizedInput.originalName &&
            existing.contentType === normalizedInput.contentType &&
            existing.byteSize === byteSize &&
            existing.sha256 === sha256
          if (!sameUpload) throw new Error('ATTACHMENT_ID_CONFLICT')
          const stale = existing.status === 'uploading' && Date.now() - existing.createdAt.getTime() > 5 * 60_000
          if (!stale) return { attachment: existing, created: false, recovered: false }
          await tx.delete(agentFileAttachments).where(eq(agentFileAttachments.id, existing.id))
          lifecycle.stale = existing
        }
        const store = getSettingsStore()
        if (byteSize > Number(store.getTyped('INBOX_MAX_ATTACHMENT_BYTES'))) throw new Error('ATTACHMENT_TOO_LARGE')
        if ((await this.totalStorageBytes(tx)) + byteSize > Number(store.getTyped('INBOX_MAX_TOTAL_STORAGE_BYTES'))) {
          throw new Error('INBOX_STORAGE_QUOTA_EXCEEDED')
        }
        const { bytes: _, ...values } = normalizedInput
        const [row] = await tx
          .insert(agentFileAttachments)
          .values({
            ...values,
            byteSize,
            sha256,
            storedName,
            privatePath,
            status: 'uploading',
            uploadAttemptId: attemptId,
          })
          .returning()
        lifecycle.created = new AgentFileAttachment(row)
        return { attachment: lifecycle.created, created: true, recovered: lifecycle.stale !== null }
      })
      if (result.created) {
        if (lifecycle.stale) {
          await deleteAgentAttachmentBlob(lifecycle.stale.agentId, lifecycle.stale.id).catch(() => {})
        }
        await writeAgentAttachmentBlob(normalizedInput.agentId, normalizedInput.id, normalizedInput.bytes)
        await finalize?.(result)
        const ready = await this.markUploadReady(result.attachment.id, attemptId)
        if (!ready) throw new Error('ATTACHMENT_UPLOAD_STATE_CONFLICT')
        return { attachment: ready, created: true, recovered: result.recovered }
      }
      if (result.attachment.status === 'uploading') {
        let ready: AgentFileAttachment | null = null
        for (let attempt = 0; attempt < 400 && !ready; attempt++) {
          await Bun.sleep(25)
          const current = await this.findById(result.attachment.id)
          if (!current) throw new Error('ATTACHMENT_UPLOAD_FAILED')
          if (current.status !== 'uploading') ready = current
        }
        if (!ready) throw new Error('ATTACHMENT_UPLOAD_IN_PROGRESS')
        const settled = { attachment: ready, created: false, recovered: false }
        await finalize?.(settled)
        return settled
      }
      await finalize?.(result)
      return result
    } catch (error) {
      if (lifecycle.created) {
        const deleted = await this.deleteUploadReservation(lifecycle.created.id, attemptId).catch(() => false)
        if (deleted) {
          await deleteAgentAttachmentBlob(lifecycle.created.agentId, lifecycle.created.id).catch(() => {})
        }
      }
      throw error
    }
  }

  static async markUploadReady(id: string, attemptId: string): Promise<AgentFileAttachment | null> {
    const [row] = await db
      .update(agentFileAttachments)
      .set({ status: 'pending', uploadAttemptId: null })
      .where(
        and(
          eq(agentFileAttachments.id, id),
          eq(agentFileAttachments.status, 'uploading'),
          eq(agentFileAttachments.uploadAttemptId, attemptId)
        )
      )
      .returning()
    return row ? new AgentFileAttachment(row) : null
  }

  static async deleteUploadReservation(id: string, attemptId: string): Promise<boolean> {
    const deleted = await db
      .delete(agentFileAttachments)
      .where(
        and(
          eq(agentFileAttachments.id, id),
          eq(agentFileAttachments.status, 'uploading'),
          eq(agentFileAttachments.uploadAttemptId, attemptId)
        )
      )
      .returning({ id: agentFileAttachments.id })
    return deleted.length > 0
  }

  static async withAttachmentLock<T>(id: string, operation: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id.toLowerCase()}))`)
      return operation(tx)
    })
  }

  static async findById(id: string, executor: DbExecutor = db): Promise<AgentFileAttachment | null> {
    const [row] = await executor
      .select()
      .from(agentFileAttachments)
      .where(eq(agentFileAttachments.id, id.toLowerCase()))
      .limit(1)
    return row ? new AgentFileAttachment(row) : null
  }

  static async totalStorageBytes(executor: DbExecutor = db): Promise<number> {
    const [[agent], [inbox]] = await Promise.all([
      executor
        .select({ total: sql<number>`coalesce(sum(${agentFileAttachments.byteSize}), 0)` })
        .from(agentFileAttachments),
      executor.select({ total: sql<number>`coalesce(sum(${inboxAttachments.byteSize}), 0)` }).from(inboxAttachments),
    ])
    return Number(agent?.total ?? 0) + Number(inbox?.total ?? 0)
  }

  async readVerifiedBlob(): Promise<Buffer> {
    return readVerifiedAgentAttachmentBlob(this.agentId, this.id, this.byteSize, this.sha256)
  }

  async deletePending(): Promise<boolean> {
    const deleted = await AgentFileAttachment.withAttachmentLock(this.id, async (tx) => {
      return tx
        .delete(agentFileAttachments)
        .where(and(eq(agentFileAttachments.id, this.id), eq(agentFileAttachments.status, 'pending')))
        .returning({ id: agentFileAttachments.id })
    })
    if (!deleted.length) return false
    await deleteAgentAttachmentBlob(this.agentId, this.id).catch(() => {})
    return true
  }
}
