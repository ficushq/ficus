import { agentLabelParts, type Agent, type AgentStatus } from '@ficus/shared'

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  active: 'Working',
  idle: 'Idle',
  'waiting-input': 'Waiting for you',
  compacting: 'Tidying up its notes',
  resetting: 'Resetting',
  dormant: 'Asleep',
  terminated: 'Finished',
}

/** The same primary/secondary label the web app shows (purpose leads, else name). */
export function agentLabel(agent: Agent): { primary: string; secondary?: string } {
  return agentLabelParts({
    name: typeof agent.metadata?.name === 'string' ? agent.metadata.name : undefined,
    purpose: typeof agent.metadata?.purpose === 'string' ? agent.metadata.purpose : undefined,
    agentTypeId: agent.agentTypeId,
  })
}
