import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AssistantChat, ChatPanel, NewConsultantChat } from '../../chat'
import { farmQueries } from '../../api/queries'
import { agentLabel } from '../agentLabels'
import { roleLabel } from '../selection'
import { roleFor } from '../appearance'
import { RobotAvatar } from '../RobotAvatar'
import { PORCH_ASSISTANT_ID } from '../useFarmData'
import { useFarmCard } from './context'
import { FieldLog } from './FieldLog'

export type ChatTarget =
  | { kind: 'agent'; agentId: string }
  | { kind: 'consultant'; squadId: string }
  /** `fresh` starts a new Assistant conversation (a token so each start gets its own window). */
  | { kind: 'assistant'; conversationId?: string; fresh?: string }
  /** A squad's field log: not a conversation, but it floats and pins the same way. */
  | { kind: 'fieldLog'; squadId: string }

/** The robot's animated portrait in a chat's title bar; clicking it opens the robot's card. */
function Portrait({ agentId }: { agentId: string }) {
  const env = useFarmCard()
  const known = env.agentsById.get(agentId)
  const fetched = useQuery({ ...farmQueries.agent(agentId), enabled: !known && agentId !== PORCH_ASSISTANT_ID })
  const agent = known ?? fetched.data
  if (!agent) return null
  const squad = agent.squadId ? env.squadsById.get(agent.squadId) : undefined
  return (
    <button
      type="button"
      className="g-chat-avatar"
      aria-label={`Open ${agentLabel(agent).primary}'s card`}
      onClick={() => env.select(agentId === PORCH_ASSISTANT_ID ? { kind: 'assistant' } : { kind: 'robot', agentId })}
    >
      <RobotAvatar
        agent={agent}
        squad={squad}
        role={agentId === PORCH_ASSISTANT_ID ? 'assistant' : undefined}
        halted={env.halted.has(agentId)}
        size={44}
      />
    </button>
  )
}

/** One window's contents: a robot, a new consultant from a seed packet, the assistant, or a squad's field log. */
export function ChatSlot({ target, onClose }: { target: ChatTarget; onClose: () => void }) {
  const env = useFarmCard()
  // A new consultant has no agent until its first message is answered.
  const [consultantId, setConsultantId] = useState<string>()
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
          leading={<Portrait agentId={target.agentId} />}
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
          onStarted={setConsultantId}
          leading={consultantId ? <Portrait agentId={consultantId} /> : undefined}
          onClose={onClose}
        />
      )
    }
    case 'assistant':
      return (
        <AssistantChat
          key={target.conversationId ?? target.fresh ?? 'latest'}
          conversationId={target.conversationId}
          fresh={!!target.fresh}
          leading={<Portrait agentId={PORCH_ASSISTANT_ID} />}
          onClose={onClose}
        />
      )
    case 'fieldLog':
      return <FieldLog key={target.squadId} squadId={target.squadId} onClose={onClose} />
  }
}
