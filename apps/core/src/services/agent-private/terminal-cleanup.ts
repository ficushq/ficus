/**
 * Terminals opened in an agent's own box end with the agent: when the agent is
 * terminated, deleted or goes dormant, every shell in `agent_<id>` is killed
 * (its clients are told and disconnected), the same way squad terminals end
 * when the squad is archived. Idle shells also time out after an hour like
 * every other terminal.
 */

import { isLiveAgentStatus, type AgentStatus } from '@ficus/shared'
import { agentWorkspaceSandboxId } from '../../entities/Agent'

type AgentEvent = { agentId: string }

export interface AgentTerminalCleanupDeps {
  on: (
    event: 'agent.updated' | 'agent.terminated' | 'agent.deleted',
    handler: (payload: AgentEvent) => unknown
  ) => () => void
  terminals: { hasSessions(sandboxId: string): boolean; killSandboxSessions(sandboxId: string): void }
  findAgentStatus: (agentId: string) => Promise<AgentStatus | null>
}

export function closeAgentTerminalsWhenAgentStops(deps: AgentTerminalCleanupDeps): () => void {
  const close = (agentId: string) => {
    const sandboxId = agentWorkspaceSandboxId(agentId)
    if (deps.terminals.hasSessions(sandboxId)) deps.terminals.killSandboxSessions(sandboxId)
  }
  const unsubscribers = [
    deps.on('agent.terminated', ({ agentId }) => close(agentId)),
    deps.on('agent.deleted', ({ agentId }) => close(agentId)),
    deps.on('agent.updated', async ({ agentId }) => {
      // Cheap in-memory check first: most agent updates concern agents nobody has a shell in.
      if (!deps.terminals.hasSessions(agentWorkspaceSandboxId(agentId))) return
      const status = await deps.findAgentStatus(agentId).catch(() => undefined)
      if (status === undefined) return
      if (status === null || !isLiveAgentStatus(status)) close(agentId)
    }),
  ]
  return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
}
