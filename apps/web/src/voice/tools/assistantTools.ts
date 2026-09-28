import { z } from 'zod'
import { agentConversationLink } from '../../lib/assistantConversationLinks'
import * as squads from '../../api/squads'
import { getAgent, listAgents } from '../../api/agents'
import { resolveAgentByReference } from './agentResolution'
import { listGlobalActivity } from '../../api/activity'
import { listPendingActions } from '../../api/actions'
import { answerAgentQuestion, dismissAgentQuestion } from '../../api/agentQuestions'
import { getMyInbox, markAsRead } from '../../api/inbox'
import * as workspace from '../../api/workspace'
import { searchMemory } from '../../api/memory'
import { searchEntities } from '../../api/search'
import { hybridFicusSearch } from '../../lib/hybridFicusSearch'
import { ALL_SECTIONS, isSectionAllowed } from '../../components/settings/settingsSections'
import { resolveVoiceSquadId } from '../squadReferences'
import { getChatDrawerPath, type ChatDrawerToolState } from '../chatDrawerTool'
import type { VoiceAssistantTool, VoiceToolExecutor } from './types'

export interface AssistantToolEnvironment extends VoiceToolExecutor {
  can?: (permission: string) => boolean
}
const text = z.string().trim().min(1)
const limit = z.number().int().min(1).max(50).default(20)
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  execute: VoiceAssistantTool<AssistantToolEnvironment>['execute']
): VoiceAssistantTool<AssistantToolEnvironment> {
  return {
    definition: {
      type: 'function',
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
    },
    execute,
  }
}
const string = { type: 'string' }
const number = { type: 'integer', minimum: 1, maximum: 50 }
const depsDefault = {
  squads,
  getAgent,
  listAgents,
  listGlobalActivity,
  listPendingActions,
  answerAgentQuestion,
  dismissAgentQuestion,
  markAsRead,
  getMyInbox,
  workspace,
  searchMemory,
  searchEntities,
}
export function createAssistantTools(
  overrides: Partial<typeof depsDefault> = {}
): VoiceAssistantTool<AssistantToolEnvironment>[] {
  const deps = { ...depsDefault, ...overrides }
  async function squadId(reference: string, activeOnly = false) {
    const id = resolveVoiceSquadId(reference, await deps.squads.listSquads(activeOnly ? 'active' : undefined))
    if (!id) throw new Error('Unknown or ambiguous squad. Search for its full ID first.')
    return id
  }
  return [
    {
      ...tool(
        'navigate',
        'Operate the UI. Pass exactly one of: path (an app-relative route from the Navigation section of your instructions; only when it differs from the current screen), agentId (offer a conversation link row for an existing agent without sending anything; open=true opens it, only for an explicit request), or drawer (open, closed, expanded, or toggle the Assistant popup; closing during live voice keeps a compact voice strip). Sending a message never navigates; message receipts already show their link.',
        {
          path: { type: 'string', description: 'Route path with optional query, e.g. "/squads/abc123/work"' },
          agentId: string,
          open: { type: 'boolean', description: 'With agentId: open the conversation now (explicit request only).' },
          drawer: { type: 'string', enum: ['open', 'closed', 'expanded', 'toggle'] },
        },
        [],
        async (args, env) => {
          const input = z
            .object({
              path: z.string().trim().min(1).max(2000).optional(),
              agentId: text.optional(),
              open: z.boolean().default(false),
              drawer: z.enum(['open', 'closed', 'expanded', 'toggle']).optional(),
            })
            .refine((value) => [value.path, value.agentId, value.drawer].filter(Boolean).length === 1, {
              message: 'Pass exactly one of path, agentId, or drawer',
            })
            .parse(args)
          if (input.path) {
            env.navigate(input.path)
            return { ok: true, navigatedTo: input.path }
          }
          if (input.drawer) {
            const currentPath = env.getCurrentPath?.() ?? `${window.location.pathname}${window.location.search}`
            const path = getChatDrawerPath(currentPath, input.drawer as ChatDrawerToolState)
            env.navigate(path)
            return { ok: true, drawerState: input.drawer, navigatedTo: path }
          }
          const agent = await resolveAgentByReference(input.agentId!, deps)
          const conversation = agentConversationLink(agent)
          if (input.open && env.openConversation) env.openConversation(conversation)
          return { ok: true, conversation, opened: input.open && Boolean(env.openConversation) }
        }
      ),
      followUp: 'never' as const,
    },
    tool(
      'search_ficus',
      'Look up Ficus entities by name or keyword: squads, work streams, consultant conversations, saved Assistant conversations, and navigation targets (pages and settings sections). Returns canonical IDs and links. It does not read data or configuration: no schedules, environment variables, secrets, integrations, users, permissions, agent status, activity, or the value of any setting. For live state use get_work, read_thread, read_inbox, or read_activity; for anything else use delegate_task.',
      { query: string, limit: number },
      ['query'],
      async (args, env) => {
        const input = z.object({ query: text.max(120), limit }).parse(args)
        const allowed = new Set(
          ALL_SECTIONS.filter((section) => isSectionAllowed(section.id, env.can ?? (() => false), false)).map(
            (section) => section.id
          )
        )
        return hybridFicusSearch(input.query, input.limit, allowed, deps.searchEntities)
      }
    ),
    tool(
      'delegate_task',
      'Run a task in the background: with the user’s own permissions for instance-wide tasks, or as a squad consultant for squad tasks. Results are reported back here. Omit squadId for anything about the whole Ficus instance or the user’s account: schedules, integrations, environment variables, secrets, users, permissions, billing, notifications, instance settings, and any investigation or sustained work that is not owned by one squad. Pass squadId (full ID or URL slug) only for work that belongs to that squad: its project, repositories, work streams, incidents, and squad settings. Give every task a short label. Results, progress, and clarification questions arrive in this conversation as task updates; a receipt is not a result and must never be described as one. To continue or answer a task, call this again with inReplyTo set to the update’s id and the same squadId. Delivery is steer (the new request takes priority); pass follow-up only when the user explicitly wants it queued behind the running task. Never send secret values.',
      {
        label: {
          type: 'string',
          description: '3–6 words naming the task, e.g. "Check enabled schedules". No status words or secrets.',
        },
        request: {
          type: 'string',
          description:
            'Self-contained request from the user’s perspective with every relevant detail, exact URLs, and constraints.',
        },
        squadId: {
          type: 'string',
          description:
            'Full squad ID or URL slug when the task belongs to one squad. Omit for instance-wide or personal tasks.',
        },
        mode: { type: 'string', enum: ['steer', 'follow-up'] },
        inReplyTo: {
          type: 'string',
          description: 'Full inbox update UUID when answering or continuing a task update.',
        },
      },
      ['label', 'request'],
      async (args, env) => {
        if (!env.delegateTask) throw new Error('Background tasks are unavailable in this surface')
        const input = z
          .object({
            label: text.max(80),
            request: text.max(20000),
            squadId: text.optional(),
            mode: z.enum(['steer', 'follow-up']).default('steer'),
            inReplyTo: z.string().uuid().optional(),
          })
          .parse(args)
        const squad = input.squadId ? await squadId(input.squadId, true) : undefined
        return env.delegateTask(input.request, {
          label: input.label,
          squadId: squad,
          mode: input.mode,
          inReplyTo: input.inReplyTo,
        })
      }
    ),
    tool(
      'read_activity',
      'Read recent activity across accessible squads, optionally limited to one squad.',
      { squadId: string, limit: number },
      [],
      async (args) => {
        const input = z.object({ squadId: text.optional(), limit }).parse(args)
        return input.squadId
          ? deps.squads.listSquadActivity(await squadId(input.squadId), { limit: input.limit })
          : deps.listGlobalActivity({ limit: input.limit })
      }
    ),
    tool(
      'read_squad_files',
      'Read a squad’s shared workspace or its memory. Pass path for a file (paginated with offset) or a directory tree (directory=true or no path). Pass query with source=memory to search indexed memory for relevant context and sources instead of reading a path.',
      {
        squadId: string,
        source: { type: 'string', enum: ['workspace', 'memory'] },
        path: string,
        query: { type: 'string', description: 'Memory search query. Only with source=memory.' },
        directory: { type: 'boolean' },
        offset: { type: 'integer', minimum: 0 },
      },
      ['squadId', 'source'],
      async (args) => {
        const input = z
          .object({
            squadId: text,
            source: z.enum(['workspace', 'memory']),
            path: z.string().max(2000).optional(),
            query: z.string().trim().max(1000).optional(),
            directory: z.boolean().default(false),
            offset: z.number().int().min(0).default(0),
          })
          .refine((value) => !(value.query && value.source !== 'memory'), { message: 'query requires source=memory' })
          .parse(args)
        const id = await squadId(input.squadId)
        if (input.query) return deps.searchMemory(id, { query: input.query, limit: 10 })
        const memory = input.source === 'memory'
        if (!input.path || input.directory)
          return memory
            ? deps.workspace.getSquadMemoryTree(id, input.path)
            : deps.workspace.getSquadWorkspaceTree(id, input.path)
        const file = memory
          ? await deps.workspace.getSquadMemoryFile(id, input.path)
          : await deps.workspace.getSquadWorkspaceFile(id, input.path)
        if (file.binary) return { path: file.path, binary: true, size: file.size }
        const content = file.content.slice(input.offset, input.offset + 12000)
        return {
          path: file.path,
          content,
          totalLength: file.content.length,
          nextOffset: input.offset + content.length < file.content.length ? input.offset + content.length : null,
        }
      }
    ),
    tool(
      'read_inbox',
      'Read what is waiting for the user. view=actions: the action center — agent questions awaiting an answer, blocked work, and decisions, each with its action ID; this is the tool for "what needs me". view=notifications: recent inbox notifications (task and agent updates, work-stream events); unread by default, status=all or read for earlier ones. Summarize unless asked for verbatim content.',
      {
        view: { type: 'string', enum: ['actions', 'notifications'] },
        status: { type: 'string', enum: ['unread', 'read', 'all'], description: 'notifications only; default unread' },
        limit: number,
      },
      ['view'],
      async (args) => {
        const input = z
          .object({
            view: z.enum(['actions', 'notifications']),
            status: z.enum(['unread', 'read', 'all']).default('unread'),
            limit: z.number().int().min(1).max(20).default(5),
          })
          .parse(args)
        if (input.view === 'actions') return deps.listPendingActions()
        const messages = await deps.getMyInbox(input.status !== 'unread')
        const filtered = messages.filter((message) =>
          input.status === 'all' ? true : input.status === 'read' ? Boolean(message.readAt) : !message.readAt
        )
        return {
          messages: filtered.slice(0, input.limit).map((message) => ({
            id: message.id,
            subject: message.subject,
            content: message.content,
            senderType: message.senderType,
            senderId: message.senderId,
            senderAgent: message.senderAgent
              ? { id: message.senderAgent.id, agentTypeId: message.senderAgent.agentTypeId }
              : null,
            readAt: message.readAt,
            createdAt: message.createdAt,
          })),
        }
      }
    ),
    tool(
      'answer_question',
      'Resolve an agent question from the action center. Pass the user’s own answer, or dismiss=true (with an optional reason) when the user asks to dismiss it. Read the item first; never invent a decision.',
      { questionId: string, answer: string, dismiss: { type: 'boolean' }, reason: string },
      ['questionId'],
      async (args) => {
        const input = z
          .object({
            questionId: text,
            answer: z.string().trim().max(20000).optional(),
            dismiss: z.boolean().default(false),
            reason: z.string().max(2000).optional(),
          })
          .refine((value) => (value.dismiss ? !value.answer : Boolean(value.answer)), {
            message: 'Pass an answer, or dismiss=true without an answer',
          })
          .parse(args)
        return input.dismiss
          ? deps.dismissAgentQuestion(input.questionId, input.reason)
          : deps.answerAgentQuestion(input.questionId, input.answer!)
      }
    ),
    tool(
      'mark_read',
      'Mark a notification read when the user asks to dismiss it. Does not resolve an agent question; use answer_question for that.',
      { messageId: string },
      ['messageId'],
      async (args) => deps.markAsRead(z.object({ messageId: text }).parse(args).messageId)
    ),
    tool(
      'set_subscription',
      'Watch or unwatch a squad or work stream for this user.',
      { scope: { type: 'string', enum: ['squad', 'work_stream'] }, id: string, watching: { type: 'boolean' } },
      ['scope', 'id', 'watching'],
      async (args) => {
        const input = z.object({ scope: z.enum(['squad', 'work_stream']), id: text, watching: z.boolean() }).parse(args)
        if (input.scope === 'squad')
          return (input.watching ? deps.squads.subscribeSquad : deps.squads.unsubscribeSquad)(await squadId(input.id))
        return (input.watching ? deps.squads.subscribeWorkStream : deps.squads.unsubscribeWorkStream)(input.id)
      }
    ),
  ]
}
export const assistantTools = createAssistantTools()
