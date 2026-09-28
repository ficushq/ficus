import { and, desc, eq, sql } from 'drizzle-orm'
import type { MessageMetadata } from '@ficus/shared'
import { db, messages } from '../../db'
import { Agent } from '../../entities/Agent'
import { WorkStream } from '../../entities/WorkStream'

/**
 * Resolve the human user an agent should address when it needs to reach "the human":
 *   1. the agent's owner user (system-manager / user-spawned agents), else
 *   2. the requesting user of one of the agent's active work streams.
 * Returns null when no human can be attributed — callers should fall back to the shared
 * system inbox (SYSTEM_RECIPIENT_ID) rather than silently dropping the message.
 */
export async function resolveAgentRequestingUserId(agentId: string): Promise<string | null> {
  const agent = await Agent.find(agentId)
  if (agent?.ownerUserId) return agent.ownerUserId

  const workStreams = await WorkStream.findByAgent(agentId)
  const requested = workStreams.find((ws) => ws.requestingUserId && ws.status !== 'done' && ws.status !== 'canceled')
  return requested?.requestingUserId ?? null
}

/**
 * The user an agent is currently "talking to": the most recent human chat message that carries a
 * user sender (set by the chat message route). Used to auto-attribute work streams the agent creates
 * on a user's behalf. Returns null if the agent has no attributed chat messages.
 *
 * Filtered entirely in the DB (role='human' + a real user sender) so it stays cheap even after a long
 * run with many assistant turns and unattributed human rows (e.g. inbox deliveries, which have no
 * `metadata.sender`). Backed by the `idx_messages_agent_chat_sender` partial index.
 */
export async function resolveAgentChatSenderUserId(agentId: string): Promise<string | null> {
  const [row] = await db
    .select({ metadata: messages.metadata })
    .from(messages)
    .where(
      and(
        eq(messages.agentId, agentId),
        eq(messages.role, 'human'),
        sql`${messages.metadata}->'sender'->>'userId' IS NOT NULL`
      )
    )
    .orderBy(desc(messages.createdAt))
    .limit(1)
  return (row?.metadata as MessageMetadata | null)?.sender?.userId ?? null
}
