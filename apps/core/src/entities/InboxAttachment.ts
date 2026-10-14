import { eq, inArray } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { db } from '../db'
import { inboxAttachments } from '../db/schema'
import { getSettingsStore } from '../services/settings'
import { deleteAttachmentFile, sha256Hex, writeAttachmentFile } from '../services/inbox/attachment-storage'
import { reserveAttachmentStorage, totalAttachmentStorageBytes } from '../services/attachments/storage-quota'
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
    const size = input.bytes.byteLength

    if (size > maxAttachment) throw new Error('ATTACHMENT_TOO_LARGE')
    const id = crypto.randomUUID()
    let storagePath: string | undefined
    try {
      return await db.transaction(async (tx) => {
        await reserveAttachmentStorage(tx, size)
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

  /** Every stored attachment's bytes (inbox, chat files and workflow handoff files share one quota). */
  static async totalStorageBytes(): Promise<number> {
    return totalAttachmentStorageBytes()
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
