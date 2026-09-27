import type { WorkStream } from '@ficus/shared'
import { actionsForAgent, ActionView, AgentPendingQuestions, MailboxList, StreamActions } from '../../actions'
import { agentLabel } from '../agentLabels'
import { useFarmCard } from './context'

/** The action forms each card hosts, bound to the farm's navigation. */
export function PlotActions({ stream }: { stream: WorkStream }) {
  const env = useFarmCard()
  return (
    <StreamActions stream={stream} showPauseControls onOpenAgent={(id) => env.select({ kind: 'robot', agentId: id })} />
  )
}

export function RobotActions({ agentId }: { agentId: string }) {
  const env = useFarmCard()
  const agent = env.agentsById.get(agentId)
  // Only what's addressed to this robot itself; plot-level decisions live on the plot card.
  const direct = actionsForAgent(env.input.pendingActions, agentId, { direct: true }).filter(
    (a) => a.type !== 'agent-question'
  )
  return (
    <>
      <AgentPendingQuestions agentId={agentId} agentName={agent ? agentLabel(agent).primary : 'This robot'} />
      {direct.map((action) => (
        <ActionView
          key={action.id}
          action={action}
          onFocusStream={(id) => env.select({ kind: 'plot', streamId: id })}
          onOpenAssistant={(conversationId) => env.openAssistant(conversationId)}
        />
      ))}
    </>
  )
}

export function MailboxContents() {
  const env = useFarmCard()
  return (
    <MailboxList
      actions={env.input.pendingActions}
      onFocusStream={(id) => env.select({ kind: 'plot', streamId: id })}
      onOpenAssistant={(conversationId) => env.openAssistant(conversationId)}
      onOpenAgent={(id) => env.select({ kind: 'robot', agentId: id })}
    />
  )
}
