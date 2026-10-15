import { describe, expect, test } from 'bun:test'
import type { AgentStatus } from '@ficus/shared'
import { closeAgentTerminalsWhenAgentStops } from './terminal-cleanup'

const AGENT = '11111111-1111-4111-8111-111111111111'

function harness(statuses: Record<string, AgentStatus | null>, sandboxesWithSessions: string[]) {
  const handlers = new Map<string, (payload: { agentId: string }) => unknown>()
  const killed: string[] = []
  const lookups: string[] = []
  const stop = closeAgentTerminalsWhenAgentStops({
    on: (event, handler) => {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    terminals: {
      hasSessions: (sandboxId) => sandboxesWithSessions.includes(sandboxId),
      killSandboxSessions: (sandboxId) => killed.push(sandboxId),
    },
    findAgentStatus: async (agentId) => {
      lookups.push(agentId)
      return statuses[agentId] ?? null
    },
  })
  return { emit: (event: string) => handlers.get(event)!({ agentId: AGENT }), killed, lookups, handlers, stop }
}

describe('closeAgentTerminalsWhenAgentStops', () => {
  test('kills the agent box shells on termination and deletion', async () => {
    const h = harness({}, [`agent_${AGENT}`])
    await h.emit('agent.terminated')
    await h.emit('agent.deleted')
    expect(h.killed).toEqual([`agent_${AGENT}`, `agent_${AGENT}`])
  })

  test('kills shells when an update leaves the agent dormant, keeps them while live', async () => {
    const live = harness({ [AGENT]: 'idle' }, [`agent_${AGENT}`])
    await live.emit('agent.updated')
    expect(live.killed).toEqual([])

    const dormant = harness({ [AGENT]: 'dormant' }, [`agent_${AGENT}`])
    await dormant.emit('agent.updated')
    expect(dormant.killed).toEqual([`agent_${AGENT}`])
  })

  test('does not look the agent up when nobody has a shell in its box', async () => {
    const h = harness({ [AGENT]: 'dormant' }, [])
    await h.emit('agent.updated')
    expect(h.lookups).toEqual([])
    expect(h.killed).toEqual([])
  })

  test('unsubscribes every handler', () => {
    const h = harness({}, [])
    expect(h.handlers.size).toBe(3)
    h.stop()
    expect(h.handlers.size).toBe(0)
  })
})
