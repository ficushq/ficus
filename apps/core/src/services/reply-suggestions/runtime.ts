import { and, desc, eq, sql } from 'drizzle-orm'
import type { MessageMetadata } from '@ficus/shared'
import { agentQuestions, agents, db, messages } from '../../db'
import { jsonbObjectRecovered } from '../../db/jsonb'
import { messageEventData } from '../../entities/message-event'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { completeWithTier } from '../model-tiers/light-completion-runtime'
import {
  ReplySuggestionLimiter,
  suggestRepliesAfterTurn,
  type ReplySuggestionDeps,
  type SuggestionRow,
} from './service'
import { replySuggestionsEnabled } from './visibility'

const log = createLogger('reply-suggestions')

/** Assistant rows read to find the turn's last text: system notices may sit on top of it. */
const RECENT_ASSISTANT_ROWS = 5

function rowMetadata(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function toRow(row: {
  id: string
  content: string
  metadata: unknown
  createdAt: Date
  pending: boolean
}): SuggestionRow {
  return { ...row, metadata: rowMetadata(row.metadata) }
}

const rowColumns = {
  id: messages.id,
  content: messages.content,
  metadata: messages.metadata,
  createdAt: messages.createdAt,
  pending: messages.pending,
}

export const replySuggestionRuntimeDeps: ReplySuggestionDeps = {
  isEnabled: replySuggestionsEnabled,
  loadAgent: async (agentId) => {
    const [agent] = await db
      .select({
        status: agents.status,
        questionData: agents.questionData,
        squadId: agents.squadId,
        agentTypeId: agents.agentTypeId,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
    if (!agent) return null
    const [open] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentQuestions)
      .where(and(eq(agentQuestions.agentId, agentId), eq(agentQuestions.status, 'open')))
    return {
      status: agent.status,
      hasQuestionData: agent.questionData != null,
      openQuestions: open?.count ?? 0,
      squadId: agent.squadId,
      agentTypeId: agent.agentTypeId,
    }
  },
  loadLatestHuman: async (agentId) => {
    const [row] = await db
      .select(rowColumns)
      .from(messages)
      .where(and(eq(messages.agentId, agentId), eq(messages.role, 'human')))
      .orderBy(desc(messages.createdAt))
      .limit(1)
    return row ? toRow(row) : null
  },
  loadLatestUserChat: async (agentId) => {
    const [row] = await db
      .select(rowColumns)
      .from(messages)
      .where(
        and(
          eq(messages.agentId, agentId),
          eq(messages.role, 'human'),
          sql`${messages.metadata}->>'source' = 'user_chat'`
        )
      )
      .orderBy(desc(messages.createdAt))
      .limit(1)
    return row ? toRow(row) : null
  },
  loadRecentAssistant: async (agentId) => {
    const rows = await db
      .select(rowColumns)
      .from(messages)
      .where(and(eq(messages.agentId, agentId), eq(messages.role, 'assistant')))
      .orderBy(desc(messages.createdAt))
      .limit(RECENT_ASSISTANT_ROWS)
    return rows.map(toRow)
  },
  complete: (request) => completeWithTier(request),
  save: async (agentId, messageId, replies) => {
    // One statement: the replies are saved only while no human message has arrived after the target.
    const [saved] = await db
      .update(messages)
      .set({
        metadata: sql<MessageMetadata>`${jsonbObjectRecovered(messages.metadata)} || jsonb_build_object('replySuggestions', ${JSON.stringify(replies)}::jsonb)`,
      })
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.agentId, agentId),
          sql`NOT EXISTS (SELECT 1 FROM ${messages} newer WHERE newer.agent_id = ${messages.agentId} AND newer.role = 'human' AND newer.created_at > ${messages.createdAt})`
        )
      )
      .returning({ id: messages.id, agentId: messages.agentId, metadata: messages.metadata })
    if (!saved) return false
    eventEmitter.emit('message.updated', messageEventData(saved))
    return true
  },
  onError: (error) => log.warn('Could not suggest replies', error),
}

const limiter = new ReplySuggestionLimiter()
let registered = false

/**
 * Suggest replies after each completed turn. Register once, in the API process: it receives
 * every process's `execution.completed` and pushes `message.updated` to clients directly.
 */
export function registerReplySuggestions(deps: ReplySuggestionDeps = replySuggestionRuntimeDeps): () => void {
  if (registered) return () => {}
  registered = true
  const unsubscribe = eventEmitter.on('execution.completed', ({ agentId, status }) => {
    if (status !== 'completed' || !agentId) return
    // Every outcome is logged (ids only, never message text) so a missing chip can be explained.
    void suggestRepliesAfterTurn(agentId, deps, limiter).then((outcome) => {
      log.debug(`Reply suggestions for agent ${agentId}: ${outcome}`)
    })
  })
  return () => {
    unsubscribe()
    registered = false
  }
}
