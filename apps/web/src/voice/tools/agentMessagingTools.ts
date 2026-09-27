import type { Agent, DeliveryMode } from '@ficus/shared'
import { getAgent, listAgents, sendAgentMessage, stopAgent } from '../../api/agents'
import { sendInboxMessage } from '../../api/inbox'
import { resolveAgentByReference } from './agentResolution'
import type { VoiceAssistantTool, VoiceToolExecutor } from './types'

function createMessageAgentDefinition(options: { allowStop: boolean }) {
  // The site-operator variant (allowStop) ships alongside delegate_task, so instance-wide and
  // squad work routes there. The workspace variant has no delegate_task and keeps its own routing.
  const opening = options.allowStop
    ? 'Send a message to a specific agent: a system manager, squad manager, or squad worker.'
    : 'Send a message to a user assistant, squad manager, or squad worker.'
  const artifacts =
    'Also use this to answer an artifact builder only when that artifact builder is already in waiting-input state after asking for human input. Do not use for normal artifact creation or iteration; use request_artifact instead.'
  const routing = options.allowStop
    ? 'Instance-wide or squad work goes through delegate_task; use message_agent only for an explicitly requested or visible agent.'
    : 'Global or personal Tau settings, environment variables, secrets, and integration accounts go through message_agent to the user assistant using the user’s permissions. Unscoped settings requests go to the user assistant via message_agent for scope resolution.'
  const ownership =
    'Use a squad manager only for clearly squad-owned project work; viewing a squad page does not establish that ownership.'
  const delivery =
    'If the agent is idle, this wakes it up. If running, the message steers or follows up based on the mode.'
  const stop =
    'Mode stop halts the agent immediately: only for urgent stops such as a runaway or harmful action; to change what an agent or task is doing, steer it instead.'
  return {
    type: 'function' as const,
    name: 'message_agent',
    description: [opening, artifacts, routing, ownership, delivery, ...(options.allowStop ? [stop] : [])].join(' '),
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID to message' },
        content: {
          type: 'string',
          description:
            "The message content. Be specific — include all relevant details from the user's request. Send message from the user's perspective as if you were the user.",
        },
        inReplyTo: { type: 'string', description: 'Full inbox message UUID when replying to an update' },
        mode: {
          type: 'string',
          enum: options.allowStop ? ['steer', 'follow-up', 'stop'] : ['steer', 'follow-up'],
          description:
            '"steer" (default) delivers now and interrupts the current turn. "follow-up" queues after the current turn. "stop" halts the agent.',
        },
      },
      required: options.allowStop ? ['agentId'] : ['agentId', 'content'],
    },
  }
}

export type AgentMessagingDependencies = {
  getAgent: typeof getAgent
  listAgents: typeof listAgents
  sendAgentMessage: typeof sendAgentMessage
  stopAgent: typeof stopAgent
  sendInboxMessage: typeof sendInboxMessage
}

export function createAgentMessagingTools(deps: AgentMessagingDependencies) {
  const directMessageAgentTool: VoiceAssistantTool<VoiceToolExecutor> = {
    definition: createMessageAgentDefinition({ allowStop: true }),
    async execute(args, env) {
      const {
        agentId,
        content,
        mode = 'steer',
        inReplyTo,
      } = args as {
        agentId: string
        content?: string
        mode?: DeliveryMode | 'stop'
        inReplyTo?: string
      }
      // The model may pass a handle or a mis-copied id; resolve before any target check.
      const agent = await resolveAgentByReference(agentId, deps)
      if (!isAllowedMessageAgentTarget(agent)) return disallowedMessageAgentTargetResult()
      if (mode === 'stop') {
        await deps.stopAgent(agent.id)
        return { ok: true, stopped: true }
      }
      if (!content?.trim()) return { error: 'content is required unless mode is stop' }
      if (env.messageAgent) return env.messageAgent(agent.id, content, mode, inReplyTo)
      const result = await deps.sendAgentMessage(agent.id, content, undefined, mode)
      return { ok: result.success, agentStatus: result.status }
    },
  }

  const workspaceInboxMessageAgentTool: VoiceAssistantTool<VoiceToolExecutor> = {
    definition: createMessageAgentDefinition({ allowStop: false }),
    async execute(args) {
      const {
        agentId,
        content,
        mode = 'steer',
      } = args as {
        agentId: string
        content?: string
        mode?: DeliveryMode | 'stop'
      }
      if (mode === 'stop') return { error: 'stop is not available in this surface' }
      const agent = await deps.getAgent(agentId)
      if (!isAllowedMessageAgentTarget(agent)) return disallowedMessageAgentTargetResult()
      if (!content?.trim()) return { error: 'content is required' }

      const message = await deps.sendInboxMessage({
        recipientType: 'agent',
        recipientId: agent.id,
        // Author as the user's own voice assistant; the server binds it to workspace:<userId>.
        asVoiceAssistant: true,
        content: withWorkspaceVoiceReplyGuidance(content),
        deliveryMode: mode,
        metadata: {
          sourceTool: 'message_agent',
        },
      })

      return {
        ok: true,
        persisted: true,
        delivered: Boolean(message.deliveredAt),
        deliveryMode: message.deliveryMode,
      }
    },
  }

  return { directMessageAgentTool, workspaceInboxMessageAgentTool }
}

export const { directMessageAgentTool, workspaceInboxMessageAgentTool } = createAgentMessagingTools({
  getAgent,
  listAgents,
  sendAgentMessage,
  stopAgent,
  sendInboxMessage,
})
export const messageAgentTool = directMessageAgentTool

export const WORKSPACE_VOICE_REPLY_GUIDANCE =
  'Reply to the workspace voice assistant through inbox: ficus inbox send <this message\'s sender id> "<message>" --recipient-type voice_assistant.'

function withWorkspaceVoiceReplyGuidance(content: string): string {
  return `${content}\n\n${WORKSPACE_VOICE_REPLY_GUIDANCE}`
}

export function isAllowedMessageAgentTarget(agent: Agent): boolean {
  if (agent.agentTypeId === 'artifact-builder-default') return agent.status === 'waiting-input'
  if (agent.agentTypeId === 'system-manager') return true
  if (agent.squadId) return true
  return false
}

function disallowedMessageAgentTargetResult() {
  return {
    ok: false,
    error:
      'message_agent can only target user assistants, squad managers, squad workers, or waiting-input artifact builders. Use request_artifact for normal artifact builders and artifact iteration.',
  }
}

export const agentMessagingTools = [directMessageAgentTool]
