import { sql } from 'drizzle-orm'
import { messages } from '../db'
import { Message, MessageMetadata } from '@ficus/shared'

/** Select alongside message columns on queue delivery paths. Date truncates
 * PostgreSQL microseconds, so never reconstruct this ordering key in JS. */
export const messageDeliveryOrder = sql<string>`to_char(${messages.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US') || ':' || lpad(COALESCE(${messages.enqueueOrder}, 0)::text, 20, '0')`

/** Map a database row for internal delivery and state-management paths. */
export function mapMessage(
  row: typeof messages.$inferSelect & { deliveryOrder?: string }
): Message & { deliveryOrder?: string } {
  return {
    id: row.id,
    ...(row.deliveryOrder === undefined ? {} : { deliveryOrder: row.deliveryOrder }),
    agentId: row.agentId,
    role: row.role,
    content: row.content,
    metadata: (row.metadata as MessageMetadata) ?? null,
    pending: row.pending,
    injectedAt: row.injectedAt,
    createdAt: row.createdAt,
  }
}
