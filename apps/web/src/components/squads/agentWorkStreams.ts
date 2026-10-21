import type { Agent, WorkStream } from '@ficus/shared'

/**
 * Open (queued or active) work streams per agent, keyed by full agent ID. An agent belongs
 * to a stream when it is the assignee or a bound participant (agentIds may hold ID prefixes).
 * Each list starts with the stream the agent is currently working on (assignee of an active
 * stream), then other active streams, then queued ones; ties go to the most recently updated.
 */
export function groupActiveWorkStreamsByAgent(workStreams: WorkStream[], agents: Agent[]): Map<string, WorkStream[]> {
  const resolve = (id: string | null | undefined) =>
    id ? agents.find((agent) => agent.id === id || agent.id.startsWith(id))?.id : undefined
  const byAgent = new Map<string, WorkStream[]>()
  for (const ws of workStreams) {
    if (ws.status === 'done' || ws.status === 'canceled') continue
    const agentIds = new Set([ws.assigneeAgentId, ...(ws.agentIds ?? [])].map(resolve).filter(Boolean) as string[])
    for (const agentId of agentIds) byAgent.set(agentId, [...(byAgent.get(agentId) ?? []), ws])
  }
  for (const [agentId, list] of byAgent) {
    const rank = (ws: WorkStream) => (ws.status === 'active' ? (resolve(ws.assigneeAgentId) === agentId ? 0 : 1) : 2)
    list.sort((a, b) => rank(a) - rank(b) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  }
  return byAgent
}
