import { and, eq, isNull, sql } from 'drizzle-orm'
import {
  ASSISTANT_TASK_CONSULTANT_NAME,
  consultantOrigin,
  type AssistantConversationKind,
  type AssistantEditorState,
} from '@ficus/shared'
import { assistantConversationAgents, assistantConversations, agents, db } from '../db'
import { Agent } from '../entities/Agent'
import { generateAgentName } from '../lib/utils/agent-names'
import { eventEmitter } from '../lib/infra/event-emitter'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Agent metadata key holding the task label last applied as an owned helper's purpose. Comparing
 * against it (not the purpose) lets a helper refine its purpose with set_agent_purpose without the
 * next request for the same task overwriting it.
 */
const ASSISTANT_TASK_LABEL_METADATA_KEY = 'assistantTaskLabel'

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
 *
 * The helper's purpose follows the delegated task: `taskLabel` (already bounded to the 80-char
 * purpose limit) seeds a new helper and replaces a reused helper's purpose only when it differs
 * from the label last applied, so repeated requests for the same task keep any refinement.
 */
export async function resolveOwnedAgent(
  tx: Tx,
  conversation: { id: string; ownerUserId: string; agentId?: string | null },
  target: { squadId: string | null; taskLabel: string },
  afterCommit: Array<() => void>
): Promise<Agent> {
  const [row] = await tx
    .select({ agentId: assistantConversationAgents.agentId })
    .from(assistantConversationAgents)
    .where(scopeFilter(conversation.id, target.squadId))
  if (row) {
    const [existing] = await tx.select().from(agents).where(eq(agents.id, row.agentId))
    if (existing && existing.status !== 'terminated') return retitleOwnedAgent(tx, existing, target, afterCommit)
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
        ...(target.squadId === null ? {} : { origin: 'assistant' }),
      },
      metadata: {
        name: generateAgentName(),
        purpose: target.taskLabel,
        [ASSISTANT_TASK_LABEL_METADATA_KEY]: target.taskLabel,
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

/**
 * Point a reused helper's purpose at a newly delegated task. Consultants still carrying the old
 * shared placeholder name also get a generated name, with the Assistant origin stamped so it stays
 * discoverable once the name no longer says so. Writes through tx; the update event waits for commit.
 */
async function retitleOwnedAgent(
  tx: Tx,
  existing: typeof agents.$inferSelect,
  target: { squadId: string | null; taskLabel: string },
  afterCommit: Array<() => void>
): Promise<Agent> {
  const metadata = (existing.metadata ?? {}) as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  if (metadata[ASSISTANT_TASK_LABEL_METADATA_KEY] !== target.taskLabel) {
    patch.purpose = target.taskLabel
    patch[ASSISTANT_TASK_LABEL_METADATA_KEY] = target.taskLabel
  }
  const legacyName = target.squadId !== null && metadata.name === ASSISTANT_TASK_CONSULTANT_NAME
  if (legacyName) patch.name = generateAgentName()
  if (Object.keys(patch).length === 0) return new Agent(existing)
  const stampOrigin = legacyName && consultantOrigin(existing.context) === null
  const [updated] = await tx
    .update(agents)
    .set({
      metadata: sql`COALESCE(${agents.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      ...(stampOrigin ? { context: sql`${agents.context} || '{"origin":"assistant"}'::jsonb` } : {}),
      updatedAt: new Date(),
    })
    .where(eq(agents.id, existing.id))
    .returning()
  afterCommit.push(() => eventEmitter.emit('agent.updated', { agentId: existing.id, squadId: existing.squadId }))
  return new Agent(updated!)
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
