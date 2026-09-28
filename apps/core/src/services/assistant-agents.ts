import { and, eq, isNull } from 'drizzle-orm'
import type { AssistantConversationKind, AssistantEditorState } from '@ficus/shared'
import { assistantConversationAgents, assistantConversations, agents, db } from '../db'
import { Agent } from '../entities/Agent'
import { generateAgentName } from '../lib/utils/agent-names'
import { eventEmitter } from '../lib/infra/event-emitter'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

function scopeFilter(conversationId: string, squadId: string | null) {
  return and(
    eq(assistantConversationAgents.conversationId, conversationId),
    squadId === null ? isNull(assistantConversationAgents.squadId) : eq(assistantConversationAgents.squadId, squadId)
  )
}

/**
 * Find or lazily create the agent a conversation owns for one scope: the general helper
 * (squadId null, a system-manager with the owner's permissions) or one consultant per squad.
 * Call inside the caller's transaction after locking the conversation row; that lock is what
 * serializes concurrent first delegations. Dormant helpers resume through normal inbox delivery; only terminated helpers are replaced.
 * All reads/writes must use tx: a global-pool Agent helper can deadlock the pool while
 * transcript saves and inbox polling wait for this conversation lock. Emit only after commit.
 */
export async function resolveOwnedAgent(
  tx: Tx,
  conversation: { id: string; ownerUserId: string; agentId?: string | null },
  target: { squadId: string | null },
  afterCommit: Array<() => void>
): Promise<Agent> {
  const [row] = await tx
    .select({ agentId: assistantConversationAgents.agentId })
    .from(assistantConversationAgents)
    .where(scopeFilter(conversation.id, target.squadId))
  if (row) {
    const [existing] = await tx.select().from(agents).where(eq(agents.id, row.agentId))
    if (existing && existing.status !== 'terminated') return new Agent(existing)
    await tx.delete(assistantConversationAgents).where(scopeFilter(conversation.id, target.squadId))
  }
  const [created] = await tx
    .insert(agents)
    .values({
      agentTypeId:
        target.squadId === null ? (conversation.agentId ? 'assistant-worker' : 'system-manager') : 'consultant',
      ownerUserId: target.squadId === null ? conversation.ownerUserId : null,
      squadId: target.squadId,
      persist: false,
      context: {
        scope: target.squadId === null ? { type: 'system-manager' } : { type: 'consultant', id: target.squadId },
      },
      metadata: {
        name: target.squadId === null ? generateAgentName() : 'Assistant task',
        purpose: target.squadId === null ? 'Assistant background tasks' : 'Assistant squad tasks',
        resourceGeneration: crypto.randomUUID(),
      },
    })
    .returning()
  const agent = new Agent(created!)
  await tx
    .insert(assistantConversationAgents)
    .values({ conversationId: conversation.id, squadId: target.squadId, agentId: agent.id })
  afterCommit.push(() => eventEmitter.emit('agent.created', { agentId: agent.id, squadId: agent.squadId }))
  return agent
}

/** The conversation whose general helper this agent is. Consultants never own a page editor. */
export async function findOwningConversation(
  agentId: string
): Promise<{ id: string; kind: AssistantConversationKind; editor: AssistantEditorState | null } | undefined> {
  const [brain] = await db
    .select({ id: assistantConversations.id, kind: assistantConversations.kind, editor: assistantConversations.editor })
    .from(assistantConversations)
    .where(eq(assistantConversations.agentId, agentId))
    .limit(1)
  if (brain) return brain
  const [row] = await db
    .select({
      id: assistantConversations.id,
      kind: assistantConversations.kind,
      editor: assistantConversations.editor,
    })
    .from(assistantConversationAgents)
    .innerJoin(assistantConversations, eq(assistantConversations.id, assistantConversationAgents.conversationId))
    .where(and(eq(assistantConversationAgents.agentId, agentId), isNull(assistantConversationAgents.squadId)))
    .limit(1)
  return row
}

/** Delegate communication policy applies to both general and squad helpers, independently of editor access. */
export async function isAssistantDelegate(agentId: string): Promise<boolean> {
  const [row] = await db
    .select({ agentId: assistantConversationAgents.agentId })
    .from(assistantConversationAgents)
    .where(eq(assistantConversationAgents.agentId, agentId))
    .limit(1)
  return Boolean(row)
}
