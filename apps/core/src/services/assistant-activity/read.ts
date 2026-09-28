import { and, asc, desc, eq, lt, sql } from 'drizzle-orm'
import type {
  AssistantActivityCounts,
  AssistantActivityPage,
  AssistantActivityUpdate,
  AssistantConversationActivity,
  AssistantConversationActivityDetail,
  AssistantTaskSummary,
} from '@ficus/shared'
import { agents, assistantConversations, assistantTasks, assistantUpdates, db, inbox } from '../../db'

export const ACTIVITY_PREVIEW_LENGTH = 160
export const ACTIVITY_UPDATE_PAGE_SIZE = 50

/** Plain-text preview: one line, bounded, never rendered as markup. */
export function activityPreview(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length > ACTIVITY_PREVIEW_LENGTH ? `${flat.slice(0, ACTIVITY_PREVIEW_LENGTH - 1)}…` : flat
}

const UNFINISHED = sql`status NOT IN ('completed', 'failed', 'cancelled')`

/**
 * Per-conversation aggregate. Tasks and updates are pre-aggregated separately and joined once per
 * conversation, so their cardinalities never multiply. `unavailable` counts unfinished tasks whose
 * agent is missing or terminated; status itself is never rewritten by a read.
 */
const activityRows = (ownerUserId: string, where?: ReturnType<typeof sql>) => sql<ActivityRow>`
  WITH owned AS (
    -- Page-editor conversations are scoped to their page and never surface in app-wide activity.
    SELECT id, title, updated_at, next_update_sequence FROM assistant_conversations
    WHERE owner_user_id = ${ownerUserId} AND kind = 'assistant' ${where ?? sql``}
  ),
  task_counts AS (
    SELECT t.conversation_id,
      count(*) FILTER (WHERE t.status = 'working') AS working,
      count(*) FILTER (WHERE t.status = 'waiting') AS waiting,
      count(*) FILTER (WHERE t.status = 'needs-input') AS needs_input,
      count(*) FILTER (WHERE a.id IS NULL OR a.status = 'terminated') AS unavailable,
      count(*) AS unfinished
    FROM assistant_tasks t
    LEFT JOIN agents a ON a.id = t.agent_id
    WHERE t.conversation_id IN (SELECT id FROM owned) AND t.${UNFINISHED}
    GROUP BY t.conversation_id
  ),
  unread_counts AS (
    SELECT conversation_id, count(*) AS unread FROM assistant_updates
    WHERE conversation_id IN (SELECT id FROM owned) AND seen_at IS NULL
    GROUP BY conversation_id
  )
  SELECT o.id, o.title, o.updated_at AS "updatedAt", o.next_update_sequence AS "latestUpdateSequence",
    coalesce(u.unread, 0)::int AS "unreadUpdates",
    coalesce(t.working, 0)::int AS "workingTasks",
    coalesce(t.waiting, 0)::int AS "waitingTasks",
    coalesce(t.needs_input, 0)::int AS "needsInputTasks",
    coalesce(t.unavailable, 0)::int AS "unavailableTasks",
    coalesce(t.unfinished, 0)::int AS "unfinishedTasks",
    latest.message_id AS "latestMessageId", latest.content AS "latestContent", latest.created_at AS "latestCreatedAt"
  FROM owned o
  LEFT JOIN task_counts t ON t.conversation_id = o.id
  LEFT JOIN unread_counts u ON u.conversation_id = o.id
  LEFT JOIN LATERAL (
    SELECT au.message_id, i.content, au.created_at FROM assistant_updates au
    JOIN inbox i ON i.id = au.message_id
    WHERE au.conversation_id = o.id ORDER BY au.sequence DESC LIMIT 1
  ) latest ON true
`

type ActivityRow = {
  id: string
  title: string
  updatedAt: Date | string
  latestUpdateSequence: number
  unreadUpdates: number
  workingTasks: number
  waitingTasks: number
  needsInputTasks: number
  unavailableTasks: number
  unfinishedTasks: number
  latestMessageId: string | null
  latestContent: string | null
  latestCreatedAt: Date | string | null
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toConversationActivity(row: ActivityRow): AssistantConversationActivity {
  return {
    id: row.id,
    title: row.title,
    updatedAt: iso(row.updatedAt),
    latestUpdateSequence: row.latestUpdateSequence,
    unreadUpdates: row.unreadUpdates,
    workingTasks: row.workingTasks,
    waitingTasks: row.waitingTasks,
    needsInputTasks: row.needsInputTasks,
    unavailableTasks: row.unavailableTasks,
    latestUpdate:
      row.latestMessageId && row.latestCreatedAt
        ? {
            messageId: row.latestMessageId,
            preview: activityPreview(row.latestContent ?? ''),
            createdAt: iso(row.latestCreatedAt),
          }
        : null,
  }
}

/**
 * Conversations with unread updates or unfinished tasks, ordered by attention. Totals cover every
 * owned conversation, not only the returned page. Reads never lease, seed, or acknowledge anything.
 */
export async function listAssistantActivity(
  ownerUserId: string,
  pagination: { limit: number; offset: number }
): Promise<AssistantActivityPage> {
  const rows = await db.execute<ActivityRow>(sql`
    WITH activity AS (${activityRows(ownerUserId)})
    SELECT * FROM activity
    WHERE "unreadUpdates" > 0 OR "unfinishedTasks" > 0
    ORDER BY ("needsInputTasks" > 0) DESC, ("unreadUpdates" > 0) DESC, "updatedAt" DESC, id ASC
    LIMIT ${pagination.limit + 1} OFFSET ${pagination.offset}
  `)
  const [totalsRow] = await db.execute<{ [K in keyof AssistantActivityCounts]: number }>(sql`
    WITH activity AS (${activityRows(ownerUserId)})
    SELECT count(*) FILTER (WHERE "unreadUpdates" > 0)::int AS "unreadConversations",
      coalesce(sum("unreadUpdates"), 0)::int AS "unreadUpdates",
      coalesce(sum("workingTasks"), 0)::int AS "workingTasks",
      coalesce(sum("waitingTasks"), 0)::int AS "waitingTasks",
      coalesce(sum("needsInputTasks"), 0)::int AS "needsInputTasks",
      coalesce(sum("unavailableTasks"), 0)::int AS "unavailableTasks"
    FROM activity
  `)
  const page = [...rows]
  return {
    totals: totalsRow ?? {
      unreadConversations: 0,
      unreadUpdates: 0,
      workingTasks: 0,
      waitingTasks: 0,
      needsInputTasks: 0,
      unavailableTasks: 0,
    },
    conversations: page.slice(0, pagination.limit).map(toConversationActivity),
    hasMore: page.length > pagination.limit,
  }
}

function senderName(metadata: Record<string, unknown>): string {
  const sender = metadata.sender as { name?: string; agentTypeName?: string } | undefined
  return sender?.name || sender?.agentTypeName || 'Agent'
}

/** One update card: the tracking row plus its inbox message. */
export function toAssistantActivityUpdate({
  update,
  message,
}: {
  update: typeof assistantUpdates.$inferSelect
  message: typeof inbox.$inferSelect
}): AssistantActivityUpdate {
  return {
    messageId: update.messageId,
    taskId: update.taskId,
    requestId: update.requestId,
    sequence: update.sequence,
    reportedStatus: update.reportedStatus,
    content: message.content,
    subject: message.subject,
    senderName: senderName(message.metadata),
    processedAt: update.processedAt?.toISOString() ?? null,
    seenAt: update.seenAt?.toISOString() ?? null,
    createdAt: update.createdAt.toISOString(),
  }
}

/** Tracked tasks plus one page of updates in ascending display order; `null` when not owned. */
export async function readAssistantActivity(
  ownerUserId: string,
  conversationId: string,
  beforeSequence?: number
): Promise<AssistantConversationActivityDetail | null> {
  const [row] = await db.execute<ActivityRow>(activityRows(ownerUserId, sql`AND id = ${conversationId}`))
  if (!row) return null
  const taskRows = await db
    .select({ task: assistantTasks, agentStatus: agents.status })
    .from(assistantTasks)
    .leftJoin(agents, eq(agents.id, assistantTasks.agentId))
    .where(eq(assistantTasks.conversationId, conversationId))
    .orderBy(asc(assistantTasks.createdAt), asc(assistantTasks.id))
  const tasks: AssistantTaskSummary[] = taskRows.map(({ task, agentStatus }) => ({
    id: task.id,
    currentRequestId: task.currentRequestId,
    agentId: task.agentId,
    kind: task.kind,
    squadId: task.squadId,
    label: task.label,
    status: task.status,
    unavailable:
      !['completed', 'failed', 'cancelled'].includes(task.status) && (!agentStatus || agentStatus === 'terminated'),
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  }))
  const updateRows = await db
    .select({ update: assistantUpdates, message: inbox })
    .from(assistantUpdates)
    .innerJoin(inbox, eq(inbox.id, assistantUpdates.messageId))
    .where(
      and(
        eq(assistantUpdates.conversationId, conversationId),
        beforeSequence !== undefined ? lt(assistantUpdates.sequence, beforeSequence) : undefined
      )
    )
    .orderBy(desc(assistantUpdates.sequence))
    .limit(ACTIVITY_UPDATE_PAGE_SIZE + 1)
  const page = updateRows.slice(0, ACTIVITY_UPDATE_PAGE_SIZE).reverse()
  // Pending answers must not disappear behind the update cursor or the read-state filter.
  const pendingInputRows = await db
    .selectDistinctOn([assistantTasks.id], { update: assistantUpdates, message: inbox })
    .from(assistantTasks)
    .innerJoin(
      assistantUpdates,
      and(
        eq(assistantUpdates.taskId, assistantTasks.id),
        eq(assistantUpdates.requestId, assistantTasks.currentRequestId),
        eq(assistantUpdates.conversationId, assistantTasks.conversationId),
        eq(assistantUpdates.reportedStatus, 'needs-input')
      )
    )
    .innerJoin(inbox, eq(inbox.id, assistantUpdates.messageId))
    .where(and(eq(assistantTasks.conversationId, conversationId), eq(assistantTasks.status, 'needs-input')))
    .orderBy(asc(assistantTasks.id), desc(assistantUpdates.sequence))
  return {
    conversation: toConversationActivity(row),
    tasks,
    updates: page.map(toAssistantActivityUpdate),
    pendingInputs: pendingInputRows.map(toAssistantActivityUpdate),
    hasMore: updateRows.length > ACTIVITY_UPDATE_PAGE_SIZE,
    beforeSequence: page[0]?.update.sequence ?? null,
  }
}

/** Owner check shared by mutations; returns the conversation row or null. */
export async function ownedConversation(ownerUserId: string, conversationId: string) {
  const [conversation] = await db
    .select()
    .from(assistantConversations)
    .where(and(eq(assistantConversations.id, conversationId), eq(assistantConversations.ownerUserId, ownerUserId)))
  return conversation ?? null
}
