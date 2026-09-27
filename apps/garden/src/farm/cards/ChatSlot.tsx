import { AssistantChat, ChatPanel, NewConsultantChat } from '../../chat'
import { agentLabel } from '../agentLabels'
import { roleLabel } from '../selection'
import { roleFor } from '../appearance'
import { useFarmCard } from './context'

export type ChatTarget =
  | { kind: 'agent'; agentId: string }
  | { kind: 'consultant'; squadId: string }
  | { kind: 'assistant'; conversationId?: string }

/** The one open conversation: a robot, a new consultant from a seed packet, or the assistant. */
export function ChatSlot({ target, onClose }: { target: ChatTarget; onClose: () => void }) {
  const env = useFarmCard()
  switch (target.kind) {
    case 'agent': {
      const agent = env.agentsById.get(target.agentId)
      const squad = agent?.squadId ? env.squadsById.get(agent.squadId) : undefined
      const label = agent ? agentLabel(agent) : null
      return (
        <ChatPanel
          key={target.agentId}
          agentId={target.agentId}
          title={label?.primary ?? 'Robot'}
          subtitle={agent ? `${roleLabel(roleFor(agent, squad))}${squad ? ` · ${squad.name}` : ''}` : undefined}
          onClose={onClose}
        />
      )
    }
    case 'consultant': {
      const squad = env.squadsById.get(target.squadId)
      return (
        <NewConsultantChat
          key={target.squadId}
          squadId={target.squadId}
          squadName={squad?.name ?? 'this plot'}
          onClose={onClose}
        />
      )
    }
    case 'assistant':
      return (
        <AssistantChat
          key={target.conversationId ?? 'latest'}
          conversationId={target.conversationId}
          onClose={onClose}
        />
      )
  }
}
