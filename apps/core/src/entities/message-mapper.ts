import { messages } from '../db'
import { Message, MessageMetadata } from '@ficus/shared'

/** Map a database row for internal delivery and state-management paths. */
export function mapMessage(row: typeof messages.$inferSelect): Message {
  return {
    id: row.id,
    agentId: row.agentId,
    role: row.role,
    content: row.content,
    metadata: (row.metadata as MessageMetadata) ?? null,
    pending: row.pending,
    injectedAt: row.injectedAt,
    createdAt: row.createdAt,
  }
}
