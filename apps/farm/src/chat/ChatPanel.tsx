import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAgentConversation, useConversationClient } from '@ficus/client-react'
import { ChatShell } from './ChatShell'
import { ConversationView, useCanSendChat } from './ConversationView'
import { chatQueries } from './queries'

export interface AgentConversationProps {
  agentId: string
  hideInboxMessages?: boolean
  placeholder?: string
  draftKey?: string
  afterConversation?: ReactNode
  beforeConversation?: ReactNode
}

/** A live conversation with an existing agent (manager, worker, consultant or the assistant's agent). */
export function AgentConversation({
  agentId,
  hideInboxMessages,
  placeholder,
  draftKey,
  afterConversation,
  beforeConversation,
}: AgentConversationProps) {
  const client = useConversationClient()
  const conv = useAgentConversation({ agentId })
  const agent = useQuery(chatQueries.agent(client, agentId))
  // Permission is per squad once the agent is known (the web's Chat does the same).
  const { canSend } = useCanSendChat(agent.data?.squadId ?? undefined, agent.isSuccess || agent.isError)
  return (
    <ConversationView
      conv={conv}
      canSend={canSend}
      hideInboxMessages={hideInboxMessages}
      placeholder={placeholder}
      draftKey={draftKey ?? `manager:${agentId}`}
      afterConversation={afterConversation}
      beforeConversation={beforeConversation}
    />
  )
}

export interface ChatPanelProps {
  agentId: string
  title: string
  subtitle?: string
  onClose: () => void
  header?: ReactNode
  leading?: ReactNode
}

/** Talk to a robot: the farmer (squad manager), a planter (worker) or a consultant. */
export function ChatPanel({ agentId, title, subtitle, onClose, header, leading }: ChatPanelProps) {
  return (
    <ChatShell title={title} subtitle={subtitle} header={header} leading={leading} onClose={onClose}>
      <AgentConversation key={agentId} agentId={agentId} />
    </ChatShell>
  )
}
