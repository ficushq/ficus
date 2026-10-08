import { useQuery } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import { agentConversationLink, type AssistantConversationLink } from '../lib/assistantConversationLinks'
import { AgentActivityDot } from './AgentActivityDot'
import { ChevronRightIcon, ChatBubbleIcon } from './icons'

export function AssistantConversationLinkRow({
  conversation,
  onOpen,
}: {
  conversation: AssistantConversationLink
  onOpen: (conversation: AssistantConversationLink) => void
}) {
  const agent = useQuery(queries.agents.detail(conversation.agentId))
  const resolved = agent.data ? agentConversationLink(agent.data) : conversation
  return (
    <button
      type="button"
      onClick={() => onOpen(resolved)}
      className="ficus-button ficus-button-secondary my-1 flex w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-selection"
      aria-label={`${conversation.kind === 'background' || conversation.kind === 'squad' ? 'View task' : 'Open conversation'}: ${resolved.label}`}
    >
      {agent.data ? (
        <AgentActivityDot status={agent.data.status} className="shrink-0" />
      ) : (
        <ChatBubbleIcon className="h-4 w-4 shrink-0 text-muted" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{resolved.label}</span>
        <span className="block text-xs text-muted">
          {conversation.kind === 'background' || conversation.kind === 'squad' ? 'View task' : 'Open conversation'}
        </span>
      </span>
      <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted" />
    </button>
  )
}
