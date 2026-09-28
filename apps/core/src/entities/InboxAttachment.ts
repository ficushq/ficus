import { eq, inArray, sql } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { db } from '../db'
import { agentFileAttachments, inboxAttachments } from '../db/schema'
import { getSettingsStore } from '../services/settings'
import { deleteAttachmentFile, sha256Hex, writeAttachmentFile } from '../services/inbox/attachment-storage'
import type { InboxAttachment as InboxAttachmentJson } from '@ficus/shared'

export type InboxAttachmentRow = InferSelectModel<typeof inboxAttachments>

export interface CreateInboxAttachmentInput {
  messageId: string
  filename: string
  contentType: string
  bytes: Uint8Array
}

export class InboxAttachment {
  id!: string
  messageId!: string
  filename!: string
  contentType!: string
  byteSize!: number
  sha256!: string
  storagePath!: string
  createdAt!: Date

  constructor(row: InboxAttachmentRow) {
    Object.assign(this, row)
  }

  toJson(): InboxAttachmentJson {
    return {
      id: this.id,
      messageId: this.messageId,
      filename: this.filename,
      contentType: this.contentType,
      byteSize: this.byteSize,
      sha256: this.sha256,
      createdAt: this.createdAt,
    }
  }

  static async create(input: CreateInboxAttachmentInput): Promise<InboxAttachment> {
    const store = getSettingsStore()
    const maxAttachment = store.getTyped('INBOX_MAX_ATTACHMENT_BYTES') as number
    const maxTotal = store.getTyped('INBOX_MAX_TOTAL_STORAGE_BYTES') as number
    const size = input.bytes.byteLength

    if (size > maxAttachment) throw new Error('ATTACHMENT_TOO_LARGE')
    const id = crypto.randomUUID()
    let storagePath: string | undefined
    try {
      return await db.transaction(async (tx) => {
        // Instance-global quota is correct only while each deployment serves one tenant.
        // Replace this with a tenant-scoped lock/accounting key before multi-tenant hosting.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('attachment-storage-quota'))`)
        const [[inboxTotal], [agentTotal]] = await Promise.all([
          tx.select({ total: sql<number>`coalesce(sum(${inboxAttachments.byteSize}), 0)` }).from(inboxAttachments),
          tx
            .select({ total: sql<number>`coalesce(sum(${agentFileAttachments.byteSize}), 0)` })
            .from(agentFileAttachments),
        ])
        if (Number(inboxTotal?.total ?? 0) + Number(agentTotal?.total ?? 0) + size > maxTotal) {
          throw new Error('INBOX_STORAGE_QUOTA_EXCEEDED')
        }
        storagePath = await writeAttachmentFile(input.messageId, id, input.bytes)
        const [row] = await tx
          .insert(inboxAttachments)
          .values({
            id,
            messageId: input.messageId,
            filename: input.filename,
            contentType: input.contentType,
            byteSize: size,
            sha256: sha256Hex(input.bytes),
            storagePath,
          })
          .returning()
        return new InboxAttachment(row)
      })
    } catch (err) {
      if (storagePath) await deleteAttachmentFile(storagePath).catch(() => {})
      throw err
    }
  }

  static async findById(id: string): Promise<InboxAttachment | null> {
    const [row] = await db.select().from(inboxAttachments).where(eq(inboxAttachments.id, id)).limit(1)
    return row ? new InboxAttachment(row) : null
  }

  static async listForMessage(messageId: string): Promise<InboxAttachment[]> {
    const rows = await db
      .select()
      .from(inboxAttachments)
      .where(eq(inboxAttachments.messageId, messageId))
      .orderBy(inboxAttachments.createdAt)
    return rows.map((r) => new InboxAttachment(r))
  }

  static async listForMessages(messageIds: string[]): Promise<Map<string, InboxAttachment[]>> {
    const map = new Map<string, InboxAttachment[]>()
    if (messageIds.length === 0) return map
    const rows = await db
      .select()
      .from(inboxAttachments)
      .where(inArray(inboxAttachments.messageId, messageIds))
      .orderBy(inboxAttachments.createdAt)
    for (const r of rows) {
      const list = map.get(r.messageId) ?? []
      list.push(new InboxAttachment(r))
      map.set(r.messageId, list)
    }
    return map
  }

  static async totalStorageBytes(): Promise<number> {
    const [row] = await db
      .select({ total: sql<number>`coalesce(sum(${inboxAttachments.byteSize}), 0)` })
      .from(inboxAttachments)
    return Number(row?.total ?? 0)
  }

  static async attachTo(messages: { id: string; attachments?: InboxAttachment[] }[]): Promise<void> {
    const map = await InboxAttachment.listForMessages(messages.map((m) => m.id))
    for (const m of messages) m.attachments = map.get(m.id) ?? []
  }

  async delete(): Promise<void> {
    await db.delete(inboxAttachments).where(eq(inboxAttachments.id, this.id))
    await deleteAttachmentFile(this.storagePath).catch(() => {})
  }
}
