import { readSquadFile } from '../services/squad/read-file'
import { createHash } from 'node:crypto'
import { Type, type TSchema, type Static } from '@sinclair/typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { and, desc, eq, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { selectWorkStreamPresentationState, workStreamNeedsHumanAttention, workStreamRef } from '@ficus/shared'
import {
  agents,
  assistantEntries,
  assistantTasks,
  assistantUpdates,
  db,
  images,
  inbox,
  messages,
  workStreams,
} from '../db'
import { Agent } from '../entities/Agent'
import { InboxMessage } from '../entities/InboxMessage'
import { WorkStream } from '../entities/WorkStream'
import { hasAgentResourcePermission, hasPermission } from '../services/rbac'
import {
  requireAssistantConversation,
  sendAssistantTaskRequest,
  changeAssistantTask,
} from '../services/assistant-task-requests'
import { listVisibleSquads, searchEntities } from '../services/entity-search'
import { suggestAssistantSquad, type AssistantRoutingDeps } from '../services/routing/assistant-routing'
import {
  MAX_FORWARDED_IMAGES,
  prepareForwardedImages,
  withForwardedImages,
} from '../services/attachments/forward-images'
import { getAgentQuestion, answerAgentQuestion, dismissAgentQuestion } from '../services/agents/questions'
import { canAnswerAgentQuestion } from '../services/agents/question-authorization'
import { listPendingActionsForIdentity } from '../services/agents/actions'
import { resolveGlobalActivityAccess } from '../services/squad-activity/access'
import { projectGlobalActivity } from '../services/squad-activity/global-activity'
import { computeDerivedStates, type DerivedStreamInfo } from '../services/work-streams/derived-state'

const uuid = Type.String({ format: 'uuid' })
const request = Type.String({ minLength: 1, maxLength: 20000 })
const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }))
const imageIds = Type.Optional(
  Type.Array(uuid, {
    minItems: 1,
    maxItems: MAX_FORWARDED_IMAGES,
    description:
      'IDs of images this conversation received (from list_conversation_images). The recipient gets copies it can see.',
  })
)

type StreamRow = Pick<
  typeof workStreams.$inferSelect,
  'id' | 'number' | 'title' | 'squadId' | 'status' | 'pause' | 'assigneeAgentId' | 'agentIds' | 'updatedAt'
>
const streamColumns = {
  id: workStreams.id,
  number: workStreams.number,
  title: workStreams.title,
  squadId: workStreams.squadId,
  status: workStreams.status,
  pause: workStreams.pause,
  assigneeAgentId: workStreams.assigneeAgentId,
  agentIds: workStreams.agentIds,
  updatedAt: workStreams.updatedAt,
}

/** The feed's presentation and needs-you rule, so the Assistant and the UI agree on what is waiting. */
function presentStream(stream: Pick<StreamRow, 'status' | 'pause'>, facts: DerivedStreamInfo | undefined) {
  const presentation = {
    status: stream.status,
    pause: stream.pause,
    delivery: facts?.delivery,
    derivedState: facts?.derivedState,
    openWaits: facts?.openWaits,
  }
  return {
    state: selectWorkStreamPresentationState(presentation),
    needsHuman: workStreamNeedsHumanAttention(presentation),
  }
}

/** Needs-human streams first, then most recently updated. */
async function summarizeStreams(streams: StreamRow[], squadNames: Map<string, string>) {
  const derived = await computeDerivedStates(streams)
  const summaries = streams.map((stream) => {
    const facts = derived.get(stream.id)
    return {
      id: workStreamRef(stream),
      workStreamId: stream.id,
      title: stream.title,
      squadId: stream.squadId,
      squadName: squadNames.get(stream.squadId),
      ...presentStream(stream, facts),
      openWaits:
        facts?.openWaits.map((wait) => ({
          id: wait.id,
          type: wait.type,
          message: wait.message,
          referenceId: wait.referenceId,
        })) ?? [],
      updatedAt: stream.updatedAt,
    }
  })
  return [...summaries.filter((s) => s.needsHuman), ...summaries.filter((s) => !s.needsHuman)]
}

/** Stable across provider/tool replay, distinct across executions and conversations. */
export function assistantToolClientId(agentId: string, executionId: string, toolCallId: string): string {
  const bytes = createHash('sha256')
    .update(JSON.stringify([agentId, executionId, toolCallId]))
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Conversation and authority are runner-bound. No model-provided owner or fake HTTP context. */
export function createAssistantTools(
  agentId: string,
  executionId: string,
  conversationId: string,
  routingDeps: AssistantRoutingDeps = {}
): ToolDefinition[] {
  const identity = { type: 'agent' as const, agentId, squadId: null }
  const access = () => requireAssistantConversation(identity, conversationId)
  function tool<S extends TSchema>(
    name: string,
    description: string,
    parameters: S,
    run: (input: Static<S>, clientId: string) => Promise<unknown>
  ): ToolDefinition {
    return {
      name,
      label: name.replaceAll('_', ' '),
      description,
      parameters,
      execute: async (callId, input) => {
        try {
          await access()
          const result = await run(input as Static<S>, assistantToolClientId(agentId, executionId, callId))
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
        } catch (error) {
          return {
            content: [{ type: 'text', text: error instanceof Error ? error.message : 'Assistant request failed' }],
            details: { error: true },
            isError: true,
          }
        }
      },
    }
  }
  const taskTools = (['continue', 'retry', 'cancel'] as const).map((operation) =>
    tool(
      `${operation}_task`,
      `${operation} exactly one task's current request. Does not stop unrelated work. Read list_tasks for the current request ID.` +
        (operation === 'cancel'
          ? ''
          : ' The task stays on its existing delegate; to move work to another delegate, cancel_task it and delegate_task again.'),
      Type.Object({
        taskId: uuid,
        expectedRequestId: uuid,
        request: operation === 'cancel' ? Type.Optional(request) : request,
        mode: Type.Optional(Type.Union([Type.Literal('steer'), Type.Literal('follow-up')])),
      }),
      async (input, clientId) =>
        changeAssistantTask(identity, conversationId, input.taskId, {
          ...input,
          operation,
          clientId,
          ...(operation === 'cancel' ? { reason: input.request } : {}),
        })
    )
  )
  return [
    tool(
      'delegate_task',
      'Start an independent task. Omit squadId for your general worker, your main delegate: it uses your current permissions and handles instance-wide work (users, roles, permissions and access, settings, work across squads) even when a squad is named. Pass squadId only when the work needs that squad’s expertise, code, or workspace; squad delegates are squad-scoped and cannot read accounts or roles, and squad consultants require consultant creation access. Steer is default; independent scopes may run concurrently.',
      Type.Object({
        request,
        squadId: Type.Optional(uuid),
        agentId: Type.Optional(uuid),
        label: Type.Optional(Type.String({ maxLength: 80 })),
        mode: Type.Optional(Type.Union([Type.Literal('steer'), Type.Literal('follow-up')])),
        imageIds,
      }),
      (input, clientId) => sendAssistantTaskRequest(identity, conversationId, { ...input, clientId })
    ),
    tool(
      'list_conversation_images',
      'List the images the user sent in this conversation, newest first, with their IDs and the message each came with. Pass IDs as imageIds to delegate_task or message_agent to hand the images on.',
      Type.Object({ limit }),
      async (input) => {
        const { conversation } = await access()
        if (!conversation.agentId) return { images: [] }
        const rows = await db
          .select({ id: images.id, mimeType: images.mimeType, size: images.size, createdAt: images.createdAt })
          .from(images)
          .where(eq(images.agentId, conversation.agentId))
          .orderBy(desc(images.createdAt))
          .limit(input.limit ?? 20)
        if (!rows.length) return { images: [] }
        const carriers = await db
          .select({
            id: messages.id,
            content: messages.content,
            imageIds: sql<unknown>`${messages.metadata}->'imageIds'`,
          })
          .from(messages)
          .where(
            and(
              eq(messages.agentId, conversation.agentId),
              sql`${messages.metadata}->'imageIds' ?| array[${sql.join(
                rows.map((row) => sql`${row.id}`),
                sql`, `
              )}]::text[]`
            )
          )
        const carrierOf = new Map<string, { id: string; content: string }>()
        for (const carrier of carriers)
          if (Array.isArray(carrier.imageIds))
            for (const id of carrier.imageIds) if (typeof id === 'string') carrierOf.set(id, carrier)
        return {
          images: rows.map((row) => {
            const carrier = carrierOf.get(row.id)
            return {
              ...row,
              ...(carrier ? { messageId: carrier.id, messagePreview: carrier.content.slice(0, 200) } : {}),
            }
          }),
        }
      }
    ),
    ...taskTools,
    tool(
      'read_task_update',
      'Read the original task report in bounded sections. Only updates in this conversation are accessible.',
      Type.Object({ messageId: uuid, offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
      async (input) => {
        const [row] = await db
          .select({ content: inbox.content })
          .from(assistantUpdates)
          .innerJoin(inbox, eq(inbox.id, assistantUpdates.messageId))
          .where(
            and(eq(assistantUpdates.conversationId, conversationId), eq(assistantUpdates.messageId, input.messageId))
          )
        if (!row) throw new Error('Update not found')
        const offset = input.offset ?? 0
        return {
          content: row.content.slice(offset, offset + 12000),
          nextOffset: offset + 12000 < row.content.length ? offset + 12000 : null,
        }
      }
    ),
    tool(
      'list_tasks',
      'List the tasks this conversation delegated, with current request IDs, including blocked or completed tasks. Only your own delegations: use get_work for squads’ work streams and read_inbox view=actions for what needs the user.',
      Type.Object({ limit }),
      async (input) =>
        db
          .select()
          .from(assistantTasks)
          .where(eq(assistantTasks.conversationId, conversationId))
          .orderBy(desc(assistantTasks.updatedAt))
          .limit(input.limit ?? 50)
    ),
    tool(
      'get_work',
      'Read live work. No arguments: active work streams in every squad the user can read, needsHuman first, each with its state and open waits. With squadId: that squad’s agents (with status) and its work streams. With workStreamId: one work stream in full.',
      Type.Object({
        squadId: Type.Optional(uuid),
        workStreamId: Type.Optional(
          Type.String({ minLength: 1, maxLength: 64, description: 'Work number (42 or #42) or UUID.' })
        ),
        includeFinished: Type.Optional(Type.Boolean({ description: 'Include done and canceled work. Default false.' })),
        limit,
      }),
      async (input) => {
        const { user } = await access()
        if (input.squadId && input.workStreamId) throw new Error('Pass squadId or workStreamId, not both')
        if (input.workStreamId) {
          const stream = await WorkStream.find(input.workStreamId.replace(/^work:/, ''))
          if (!stream || !(await hasPermission(user, 'workstreams:read', stream.squadId)))
            throw new Error('Work stream not found')
          const facts = (await computeDerivedStates([stream])).get(stream.id)
          return { ...stream.toJson(), ...facts, ...presentStream(stream, facts) }
        }
        const readable = await resolveGlobalActivityAccess(user)
        const scoped = input.squadId ? readable.filter((entry) => entry.squadId === input.squadId) : readable
        if (input.squadId && scoped.length === 0) throw new Error('Squad not found')
        const squadIds = scoped.filter((entry) => entry.access.workstreamsRead).map((entry) => entry.squadId)
        const max = input.limit ?? 50
        // Every live stream is read before truncating, so an old blocked stream is never cut for a
        // recently updated one; finished work is bounded and only fills the remaining space.
        const inSquads = inArray(workStreams.squadId, squadIds)
        const [live, finished] = squadIds.length
          ? await Promise.all([
              db
                .select(streamColumns)
                .from(workStreams)
                .where(and(inSquads, inArray(workStreams.status, ['queued', 'active'])))
                .orderBy(desc(workStreams.updatedAt)),
              input.includeFinished
                ? db
                    .select(streamColumns)
                    .from(workStreams)
                    .where(and(inSquads, inArray(workStreams.status, ['done', 'canceled'])))
                    .orderBy(desc(workStreams.updatedAt))
                    .limit(max)
                : [],
            ])
          : [[], []]
        const all = await summarizeStreams(
          [...live, ...finished],
          new Map(scoped.map((entry) => [entry.squadId, entry.squadName]))
        )
        const streams = all.slice(0, max)
        const truncated = all.length > max ? { omitted: all.length - max } : {}
        if (!input.squadId) return { workStreams: streams, ...truncated }
        const squad = scoped[0]!
        const squadAgents = squad.access.agentsRead
          ? await db
              .select({
                id: agents.id,
                agentTypeId: agents.agentTypeId,
                status: agents.status,
                metadata: agents.metadata,
              })
              .from(agents)
              .where(and(eq(agents.squadId, squad.squadId), notInArray(agents.status, ['terminated'])))
          : []
        return {
          squad: { id: squad.squadId, name: squad.squadName },
          agents: squadAgents.map((agent) => ({
            id: agent.id,
            type: agent.agentTypeId,
            status: agent.status,
            name: (agent.metadata as { name?: string } | null)?.name,
          })),
          workStreams: streams,
          ...truncated,
        }
      }
    ),
    tool(
      'read_activity',
      'Read recent activity, newest first, across squads the user can read or for one squad. Use for what happened; use read_inbox view=actions for what needs the user.',
      Type.Object({ squadId: Type.Optional(uuid), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
      async (input) => {
        const { user } = await access()
        const readable = await resolveGlobalActivityAccess(user)
        const scoped = input.squadId ? readable.filter((entry) => entry.squadId === input.squadId) : readable
        if (input.squadId && scoped.length === 0) throw new Error('Squad not found')
        const page = await projectGlobalActivity({
          limit: input.limit ?? 20,
          verbose: false,
          agentIds: [],
          kinds: [],
          squadAccess: scoped.map(({ squadId, access }) => ({ squadId, access })),
        })
        const names = new Map(scoped.map((entry) => [entry.squadId, entry.squadName]))
        return { items: page.items.map((item) => ({ ...item, squadName: names.get(item.squadId) })) }
      }
    ),
    tool(
      'list_squads',
      'List squads visible to the user, with full IDs and manager IDs.',
      Type.Object({ limit }),
      async (input) => listVisibleSquads((await access()).user, input.limit)
    ),
    tool(
      'suggest_squad',
      'Ask which squad a request is for, with the same decision model as the routing hint on user messages: Ficus itself (instance), general work, or one squad’s project. Use it to ask again with a clearer phrasing or for a request the hint did not cover. Without a decision model it falls back to matching squad names and purposes.',
      Type.Object({ request: Type.String({ minLength: 1, maxLength: 4000 }) }),
      async (input) => suggestAssistantSquad((await access()).user, input.request, routingDeps)
    ),
    tool(
      'search_ficus',
      'Search visible squads, work streams and conversations. Results include full IDs for subsequent tools.',
      Type.Object({ q: Type.String({ minLength: 1, maxLength: 200 }), squadId: Type.Optional(uuid), limit }),
      async (input) => searchEntities((await access()).user, input)
    ),
    tool(
      'read_squad_files',
      'Read a bounded portion of a squad workspace file, or a memory file under /memory/, using the user’s workspace or memory read permission.',
      Type.Object({
        squadId: uuid,
        path: Type.String({ minLength: 1, maxLength: 2048 }),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20000 })),
      }),
      async (input) => readSquadFile((await access()).user, input)
    ),
    tool(
      'read_thread',
      'Read an agent’s status, current execution, and conversation using current resource access. Requires the full agent UUID; beforeId must belong to this thread.',
      Type.Object({ agentId: uuid, beforeId: Type.Optional(uuid), limit }),
      async (input) => {
        const { user } = await access()
        const target = await Agent.find(z.string().uuid().parse(input.agentId))
        if (!target || !(await hasAgentResourcePermission(user, target, 'agents:read')))
          throw new Error('Agent not found')
        const [{ execution }, page] = await Promise.all([
          target.getActiveExecutionState(),
          target.listMessages({ limit: input.limit ?? 50, beforeId: input.beforeId }),
        ])
        return {
          agent: {
            id: target.id,
            type: target.agentTypeId,
            status: target.status,
            execution: execution ? { id: execution.id, status: execution.status } : null,
          },
          ...page,
        }
      }
    ),
    tool(
      'message_agent',
      'Send a message to a known agent the user can chat with. Use delegate_task to track independent work. Requires the full UUID.',
      Type.Object({ agentId: uuid, request, imageIds }),
      async (input, clientId) => {
        const { user, conversation } = await access()
        const target = await Agent.find(z.string().uuid().parse(input.agentId))
        if (!target || !(await hasAgentResourcePermission(user, target, 'chat:send')))
          throw new Error('Agent not found')
        const forwarded = input.imageIds?.length
          ? await prepareForwardedImages({
              sourceAgentId: conversation.agentId,
              imageIds: input.imageIds,
              target,
              userId: user.userId,
            })
          : null
        const result = await withForwardedImages(forwarded, () =>
          InboxMessage.sendOnce(
            {
              recipientType: 'agent',
              recipientId: target.id,
              senderType: 'user',
              senderId: user.userId,
              content: input.request,
              ...(forwarded ? { metadata: { imageIds: forwarded.ids }, persistInTransaction: forwarded.insert } : {}),
            },
            `assistant-message:${clientId}`
          )
        )
        return { messageId: result.message.id, agentId: target.id }
      }
    ),
    tool(
      'read_inbox',
      'Read what is waiting for the user. view=actions: the Needs you list — agent questions awaiting an answer, blocked or in-review work streams, pull requests awaiting a human review or merge, agent errors, and Assistant tasks needing input, each with its IDs; this is the tool for "what needs me". view=notifications: the user’s own inbox messages (task and agent updates, work-stream events); unread is independent of whether a task update has been summarized.',
      Type.Object({
        view: Type.Union([Type.Literal('actions'), Type.Literal('notifications')]),
        limit,
        unreadOnly: Type.Optional(Type.Boolean({ description: 'notifications only' })),
      }),
      async (input) => {
        const { user } = await access()
        if (input.view === 'actions') {
          const actions = await listPendingActionsForIdentity(user, { includeDeliveryGates: true })
          return { actions: actions.slice(0, input.limit ?? 50), total: actions.length }
        }
        return db
          .select()
          .from(inbox)
          .where(
            and(
              eq(inbox.recipientType, 'user'),
              eq(inbox.recipientId, user.userId),
              input.unreadOnly ? isNull(inbox.readAt) : undefined
            )
          )
          .orderBy(desc(inbox.createdAt))
          .limit(input.limit ?? 30)
      }
    ),
    tool(
      'mark_read',
      'Mark exactly one message in the user’s own inbox read.',
      Type.Object({ messageId: uuid }),
      async (input) => {
        const { user } = await access()
        const rows = await db
          .update(inbox)
          .set({ readAt: new Date() })
          .where(
            and(eq(inbox.id, input.messageId), eq(inbox.recipientType, 'user'), eq(inbox.recipientId, user.userId))
          )
          .returning({ id: inbox.id })
        if (!rows.length) throw new Error('Message not found')
        return { marked: true }
      }
    ),
    tool(
      'answer_question',
      'Resolve an existing agent question on the user’s behalf: pass the answer the user supplied, or dismiss=true (with an optional reason) when the user asks to dismiss it. Question IDs come from read_inbox view=actions. Never invent approvals.',
      Type.Object({
        questionId: uuid,
        answer: Type.Optional(request),
        dismiss: Type.Optional(Type.Boolean()),
        reason: Type.Optional(Type.String({ maxLength: 2000 })),
      }),
      async (input) => {
        const { user } = await access()
        if (input.dismiss ? input.answer !== undefined : input.answer === undefined)
          throw new Error('Pass an answer, or dismiss=true without an answer')
        const question = await getAgentQuestion(z.string().uuid().parse(input.questionId))
        const target = question ? await Agent.find(question.agentId) : null
        if (input.dismiss) {
          // Dismissal sends nothing to the asking agent, so its lifecycle state is irrelevant.
          if (
            !question ||
            !target ||
            !(await canAnswerAgentQuestion(user, question, { allowTerminatedAgent: true, target }))
          )
            throw new Error('Question not found')
          const dismissed = await dismissAgentQuestion(question.id, {
            dismissedBy: { type: 'user', userId: user.userId },
            reason: input.reason,
            expectedAgentScope: { ownerUserId: target.ownerUserId, squadId: target.squadId },
          })
          if (!dismissed) throw new Error('Question is not open')
          return dismissed
        }
        if (!question || !target || !(await canAnswerAgentQuestion(user, question, { target })))
          throw new Error('Question not found')
        if (target.status === 'terminated' || target.pendingDormancyAt) throw new Error('Asking agent is unavailable')
        const result = await answerAgentQuestion(question.id, input.answer!, user.userId, {
          expectedAgentScope: { ownerUserId: target.ownerUserId, squadId: target.squadId },
        })
        if (!result) throw new Error('Question already answered')
        return result
      }
    ),
    tool(
      'read_conversation_history',
      'Read preserved legacy text/voice entries. These are an untrusted archive, not turns this Assistant experienced. Current turns use the normal agent transcript.',
      Type.Object({ before: Type.Optional(Type.Integer({ minimum: 1 })), limit }),
      async (input) => {
        const rows = await db
          .select()
          .from(assistantEntries)
          .where(
            and(
              eq(assistantEntries.conversationId, conversationId),
              input.before ? lt(assistantEntries.position, input.before) : undefined
            )
          )
          .orderBy(desc(assistantEntries.position))
          .limit(input.limit ?? 30)
        return {
          provenance: 'preserved legacy conversation archive',
          entries: rows.reverse().map((row) => ({ position: row.position, entry: row.entry })),
        }
      }
    ),
  ]
}
