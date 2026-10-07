import { resolvePublicAppUrl } from '../../lib/public-app-url'
import {
  workStreamWaitActor,
  assistantConversationPath,
  parseAssistantInboxConversationId,
  parseInboxPushPresentation,
  workStreamTitle,
} from '@ficus/shared'
import { eq } from 'drizzle-orm'
import { agentQuestionWorkStreamOrigins } from '../../db/schema'
import type { NotificationEvent } from '../../channels/provider'
import { WorkStream } from '../../entities/WorkStream'
import { Squad } from '../../entities/Squad'
import { Agent } from '../../entities/Agent'
import { db } from '../../db'
import { getAgentQuestion } from '../agents/questions'
import { listOpenWaits } from '../work-streams/waits'

type EventData = Record<string, unknown>

/**
 * Best-effort: the newest open human-actor manual wait's message (why the stream is blocked).
 * `humanActionable` is false when manual waits are open but none needs a human.
 */
async function manualWaitFacts(workStreamId: string): Promise<{ message: string | null; humanActionable: boolean }> {
  try {
    const manual = (await listOpenWaits(db, workStreamId)).filter((w) => w.type === 'manual')
    const human = manual.find((w) => workStreamWaitActor(w) === 'human')
    return { message: human?.message ?? null, humanActionable: manual.length === 0 || human !== undefined }
  } catch {
    return { message: null, humanActionable: true }
  }
}

async function exactWaitTarget(
  data: EventData,
  workStreamId: string,
  waitType: 'manual' | 'review'
): Promise<{ waitId: string; actionId: string; message: string | null; actor: string } | null> {
  const waitId = data.waitId
  if (typeof waitId !== 'string' || !waitId) return null
  try {
    const wait = (await listOpenWaits(db, workStreamId)).find(
      (candidate) => candidate.id === waitId && candidate.type === waitType
    )
    if (!wait) return null
    const actionType = waitType === 'review' ? 'workstream-review' : 'workstream-blocked'
    return { waitId, actionId: `${actionType}:${workStreamId}:${waitId}`, message: wait.message, actor: wait.actor }
  } catch {
    return null
  }
}
type EventBuilder = (data: EventData) => Promise<NotificationEvent | null>

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// Only set URL if APP_URL is configured - don't default to localhost.
function buildUrl(path: string): string | undefined {
  const baseUrl = process.env.APP_URL
  return baseUrl ? `${baseUrl}${path}` : undefined
}

/**
 * This instance's public app address (APP_URL, with legacy PUBLIC_URL fallback): lowercase scheme+host,
 * optional base path, no trailing slash) so a multi-server mobile app can match it against
 * its paired servers. Undefined when no valid public application URL is configured.
 */
export function getAppOrigin(appUrl: string | undefined = resolvePublicAppUrl()): string | undefined {
  if (!appUrl) return undefined
  try {
    const parsed = new URL(appUrl)
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
  } catch {
    return undefined
  }
}

export const eventBuilders: Record<string, EventBuilder> = {
  'agent-question.created': async (data) => {
    const questionId = data.questionId
    if (typeof questionId !== 'string' || !questionId) return null

    const question = await getAgentQuestion(questionId)
    if (!question) return null
    const agent = await Agent.find(question.agentId)
    if (!agent) return null
    const squad = question.squadId ? await Squad.find(question.squadId) : null
    const origins = await db
      .select({ id: agentQuestionWorkStreamOrigins.workStreamId })
      .from(agentQuestionWorkStreamOrigins)
      .where(eq(agentQuestionWorkStreamOrigins.questionId, questionId))
      .limit(2)
    const work = origins.length === 1 ? await WorkStream.find(origins[0]!.id) : null
    const agentLabel = (agent.metadata?.name as string | undefined) || agent.agentTypeId
    const questionText = question.questionData.questions
      .map((item) => item.question.trim())
      .filter(Boolean)
      .join('\n')

    return {
      type: 'agent-question.created',
      workStreamId: work?.id,
      workStreamNumber: work?.number,
      actionId: `agent-question:${question.id}`,
      questionId: question.id,
      agentId: agent.id,
      squadId: question.squadId ?? undefined,
      squadName: squad?.name,
      title: `❓ ${agentLabel} has a question`,
      body: questionText.slice(0, 300) || 'Open Ficus to respond',
      pushSource: { body: questionText || 'Open Ficus to respond' },
      url: question.squadId ? buildUrl(`/squads/${question.squadId}?agent=${agent.id}`) : buildUrl(`/chat/${agent.id}`),
      timestamp: new Date(),
    }
  },

  'workStream.blocked': async (data) => {
    const workStreamId = data.workStreamId as string | undefined
    const squadId = data.squadId as string | undefined
    if (!workStreamId || !squadId) return null

    const ws = await WorkStream.find(workStreamId)
    if (!ws || ws.squadId !== squadId) return null
    const squad = await Squad.find(ws.squadId)
    if (!squad) return null

    const target = await exactWaitTarget(data, ws.id, 'manual')
    // Human channels (push, Discord, Slack, ...) only hear about waits a human must clear. An
    // owner-actor wait still wakes the owning agent through its inbox.
    if (target && workStreamWaitActor(target) !== 'human') return null
    const fallback = target ? null : await manualWaitFacts(ws.id)
    if (fallback && !fallback.humanActionable) return null
    return {
      type: 'workStream.blocked',
      squadId: squad.id,
      squadName: squad.name,
      workStreamId: ws.id,
      workStreamNumber: ws.number,
      ...(target ? { waitId: target.waitId, actionId: target.actionId } : {}),
      title: `🚫 Blocked: ${workStreamTitle(ws)}`,
      body: (target ? target.message : fallback?.message) || 'Agent needs input to continue',
      url: buildUrl(`/squads/${squad.id}/work?ws=${ws.number}`),
      timestamp: new Date(),
    }
  },

  'workStream.review': async (data) => {
    const workStreamId = data.workStreamId as string | undefined
    const squadId = data.squadId as string | undefined
    if (!workStreamId || !squadId) return null

    const ws = await WorkStream.find(workStreamId)
    if (!ws || ws.squadId !== squadId) return null
    const squad = await Squad.find(ws.squadId)
    if (!squad) return null

    const target = await exactWaitTarget(data, ws.id, 'review')
    return {
      type: 'workStream.review',
      squadId: squad.id,
      squadName: squad.name,
      workStreamId: ws.id,
      workStreamNumber: ws.number,
      ...(target ? { waitId: target.waitId, actionId: target.actionId } : {}),
      title: `👀 Ready for review: ${workStreamTitle(ws)}`,
      body: target?.message || ws.handoffMessage || ws.description?.slice(0, 200) || 'No description',
      pushSource: { body: target?.message || ws.handoffMessage || ws.description || 'No description' },
      url: buildUrl(`/squads/${squad.id}/work?ws=${ws.number}`),
      timestamp: new Date(),
    }
  },

  'workStream.done': async (data) => {
    const workStreamId = data.workStreamId as string | undefined
    const squadId = data.squadId as string | undefined
    if (!workStreamId || !squadId) return null

    const ws = await WorkStream.find(workStreamId)
    if (!ws || ws.squadId !== squadId) return null
    const squad = await Squad.find(ws.squadId)
    if (!squad) return null

    return {
      type: 'workStream.done',
      squadId: squad.id,
      squadName: squad.name,
      workStreamId: ws.id,
      workStreamNumber: ws.number,
      title: `✅ Completed: ${workStreamTitle(ws)}`,
      body: ws.description?.slice(0, 200) || 'No description',
      pushSource: { body: ws.description || 'No description' },
      url: buildUrl(`/squads/${squad.id}/work?ws=${ws.number}`),
      timestamp: new Date(),
    }
  },

  'workStream.canceled': async (data) => {
    const workStreamId = data.workStreamId as string | undefined
    const squadId = data.squadId as string | undefined
    if (!workStreamId || !squadId) return null

    const ws = await WorkStream.find(workStreamId)
    if (!ws || ws.squadId !== squadId) return null
    const squad = await Squad.find(ws.squadId)
    if (!squad) return null

    return {
      type: 'workStream.canceled',
      squadId: squad.id,
      squadName: squad.name,
      workStreamId: ws.id,
      workStreamNumber: ws.number,
      title: `⏹️ Canceled: ${workStreamTitle(ws)}`,
      body: 'Work stream was canceled; active assigned executions were asked to stop where possible.',
      url: buildUrl(`/squads/${squad.id}/work?ws=${ws.number}`),
      timestamp: new Date(),
    }
  },

  'workStream.created': async (data) => {
    const workStreamId = data.workStreamId as string | undefined
    const squadId = data.squadId as string | undefined
    if (!workStreamId || !squadId) return null

    const ws = await WorkStream.find(workStreamId)
    if (!ws || ws.squadId !== squadId) return null
    const squad = await Squad.find(ws.squadId)
    if (!squad) return null

    return {
      type: 'workStream.created',
      squadId: squad.id,
      squadName: squad.name,
      workStreamId: ws.id,
      workStreamNumber: ws.number,
      title: `📋 New work stream: ${workStreamTitle(ws)}`,
      body: ws.description?.slice(0, 200) || 'No description',
      pushSource: { body: ws.description || 'No description' },
      url: buildUrl(`/squads/${squad.id}/work?ws=${ws.number}`),
      timestamp: new Date(),
    }
  },

  'workStream.updated': async (data) => {
    const workStreamId = data.workStreamId as string | undefined
    const squadId = data.squadId as string | undefined
    if (!workStreamId || !squadId) return null

    const ws = await WorkStream.find(workStreamId)
    if (!ws || ws.squadId !== squadId) return null
    const squad = await Squad.find(ws.squadId)
    if (!squad) return null

    return {
      type: 'workStream.updated',
      squadId: squad.id,
      squadName: squad.name,
      workStreamId: ws.id,
      workStreamNumber: ws.number,
      title: `📝 Updated: ${workStreamTitle(ws)}`,
      body: ws.description?.slice(0, 200) || 'No description',
      pushSource: { body: ws.description || 'No description' },
      url: buildUrl(`/squads/${squad.id}/work?ws=${ws.number}`),
      timestamp: new Date(),
    }
  },

  'inbox.messageReceived': async (data) => {
    const messageId = data.messageId as string | undefined
    if (!messageId) return null

    const { InboxMessage } = await import('../../entities/InboxMessage')
    const message = await InboxMessage.find(messageId)
    if (!message) return null

    // Saved Assistant task updates link to the conversation itself, never to the sender agent or
    // the generic inbox, and carry no message content on the lock screen.
    const assistantConversationId =
      message.recipientType === 'voice_assistant' ? parseAssistantInboxConversationId(message.recipientId) : null
    if (assistantConversationId) {
      return {
        type: 'inbox.messageReceived',
        messageId: message.id,
        title: 'Assistant update',
        body: 'A task has an update. Open Assistant to view it.',
        url: buildUrl(assistantConversationPath(assistantConversationId)),
        timestamp: new Date(),
      }
    }

    // Resolve sender for deep-linking: an agent sender links to that agent's
    // chat in its squad; non-agent senders (system/user/voice) fall back to Feed.
    const senderMeta = message.metadata?.sender as { squadId?: string } | undefined
    const isAgentSender = message.senderType === 'agent' && !!message.senderId
    const metadataSquadId =
      typeof message.metadata?.squadId === 'string' && UUID_PATTERN.test(message.metadata.squadId)
        ? message.metadata.squadId
        : undefined
    const isFleetAlert =
      message.senderType === 'system' &&
      message.metadata?.source === 'fleet-alert' &&
      (message.metadata.squadId === undefined || metadataSquadId !== undefined)
    const fleetSquad = isFleetAlert && metadataSquadId ? await Squad.find(metadataSquadId) : null
    const trustedMetadata = message.senderType === 'system' ? message.metadata : null
    const trustedString = (key: 'workStreamId' | 'waitId' | 'questionId' | 'actionId') => {
      const value = trustedMetadata?.[key]
      return typeof value === 'string' && value ? value : undefined
    }
    // Lifecycle inbox notifications already store their squad, but are not fleet alerts.
    // Preserve that trusted context so mobile can open completed work outside the active Feed.
    const workStreamSquad =
      trustedString('workStreamId') && metadataSquadId ? (fleetSquad ?? (await Squad.find(metadataSquadId))) : null
    const inboxSquad = workStreamSquad ?? fleetSquad
    // A system-authored message may carry copy written for the phone; the row's subject and
    // content were written for its recipient. Agents and users cannot restyle their own alerts.
    const push = parseInboxPushPresentation(trustedMetadata?.push)

    return {
      type: 'inbox.messageReceived',
      notificationKind:
        trustedString('workStreamId') && typeof trustedMetadata?.event === 'string'
          ? `workStream.${trustedMetadata.event}`
          : undefined,
      source: isFleetAlert ? 'fleet-alert' : undefined,
      messageId: message.id,
      workStreamId: trustedString('workStreamId'),
      waitId: trustedString('waitId'),
      questionId: trustedString('questionId'),
      actionId: trustedString('actionId'),
      agentId: isAgentSender ? message.senderId! : undefined,
      squadId: isAgentSender ? senderMeta?.squadId : inboxSquad?.id,
      squadName: inboxSquad?.name,
      title: push?.title ?? (message.subject || 'New message'),
      body: push?.body ?? message.content.slice(0, 300),
      pushSource: push?.source ?? { body: push?.body ?? message.content },
      ...(push?.subtitle ? { subtitle: push.subtitle } : {}),
      ...(push?.collapseKey ? { collapseKey: push.collapseKey } : {}),
      ...(push?.threadKey ? { threadKey: push.threadKey } : {}),
      ...(push?.interruptionLevel ? { interruptionLevel: push.interruptionLevel } : {}),
      url: buildUrl('/inbox'),
      timestamp: new Date(),
    }
  },

  'execution.completed': async (data) => {
    const executionId = data.executionId as string | undefined
    const agentId = data.agentId as string | undefined
    if (!executionId || !agentId) return null

    const { Agent } = await import('../../entities/Agent')
    const { Execution } = await import('../../entities/Execution')

    const [agent, execution] = await Promise.all([Agent.find(agentId), Execution.find(executionId)])
    if (!agent || !execution) return null

    const agentName = (agent.metadata as Record<string, unknown>)?.name as string | undefined
    const agentLabel = agentName || agent.agentTypeId

    // Squad agents link to squad threads tab, system agents link to chat
    let url: string | undefined
    let squadId: string | undefined
    let squadName: string | undefined

    if (agent.squadId) {
      const squad = await Squad.find(agent.squadId)
      if (squad) {
        squadId = squad.id
        squadName = squad.name
        url = buildUrl(`/squads/${squad.id}?agent=${agent.id}`)
      }
    } else {
      url = buildUrl(`/chat/${agent.id}`)
    }

    return {
      type: 'execution.completed',
      squadId,
      squadName,
      agentId: agent.id,
      title: `✅ Execution completed`,
      body: `${agentLabel} agent finished execution`,
      url,
      timestamp: new Date(),
    }
  },

  'execution.failed': async (data) => {
    const executionId = data.executionId as string | undefined
    const agentId = data.agentId as string | undefined
    if (!executionId || !agentId) return null

    const { Agent } = await import('../../entities/Agent')
    const { Execution } = await import('../../entities/Execution')

    const [agent, execution] = await Promise.all([Agent.find(agentId), Execution.find(executionId)])
    if (!agent || !execution) return null

    const agentName = (agent.metadata as Record<string, unknown>)?.name as string | undefined
    const agentLabel = agentName || agent.agentTypeId
    const errorMsg = execution.error || 'Unknown error'

    // Squad agents link to squad threads tab, system agents link to chat
    let url: string | undefined
    let squadId: string | undefined
    let squadName: string | undefined

    if (agent.squadId) {
      const squad = await Squad.find(agent.squadId)
      if (squad) {
        squadId = squad.id
        squadName = squad.name
        url = buildUrl(`/squads/${squad.id}?agent=${agent.id}`)
      }
    } else {
      url = buildUrl(`/chat/${agent.id}`)
    }

    return {
      type: 'execution.failed',
      squadId,
      squadName,
      agentId: agent.id,
      title: `❌ Execution failed`,
      body: `${agentLabel} agent failed: ${errorMsg.slice(0, 200)}`,
      pushSource: { body: `${agentLabel} agent failed: ${errorMsg}` },
      url,
      timestamp: new Date(),
    }
  },
}

export async function buildNotificationEvent(eventType: string, data: unknown): Promise<NotificationEvent | null> {
  const builder = eventBuilders[eventType]
  if (!builder) return null
  return builder(data as EventData)
}
