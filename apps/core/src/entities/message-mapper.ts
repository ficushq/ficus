import { messages } from '../db'
import { Message, MessageMetadata } from '@ficus/shared'

/** Map a database row for internal delivery and state-management paths. */
export function mapMessage(row: typeof messages.$inferSelect): Message & { deliveryOrder: string } {
  return {
    id: row.id,
    deliveryOrder: `${row.createdAt.toISOString()}:${String(row.enqueueOrder ?? 0).padStart(20, '0')}`,
    agentId: row.agentId,
    role: row.role,
    content: row.content,
    metadata: (row.metadata as MessageMetadata) ?? null,
    pending: row.pending,
    injectedAt: row.injectedAt,
    createdAt: row.createdAt,
  }
}
