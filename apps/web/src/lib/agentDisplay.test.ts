import { describe, expect, it } from 'bun:test'
import type { Agent } from '@ficus/shared'
import {
  getAgentName,
  getAgentPrimaryLabel,
  getAgentPurpose,
  agentMatchesQuery,
  countableSquadAgents,
} from './agentDisplay'

function agent(metadata: Agent['metadata'], agentTypeId = 'engineer'): Agent {
  return {
    id: 'agent-1',
    agentTypeId,
    squadId: null,
    status: 'idle',
    persist: false,
    metadata,
    context: {},
    questionData: null,
    sessionUsage: null,
    terminatedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

const mk = (o: Partial<Agent>): Agent =>
  ({ id: 'a', agentTypeId: 'consultant', status: 'idle', metadata: {}, createdAt: new Date(), ...o }) as Agent

describe('agentMatchesQuery', () => {
  it('matches on purpose, name, and type; empty query matches all', () => {
    const a = mk({ metadata: { name: 'Pearl', purpose: 'Review PRs' }, agentTypeId: 'consultant' })
    expect(agentMatchesQuery(a, '')).toBe(true)
    expect(agentMatchesQuery(a, 'review')).toBe(true)
    expect(agentMatchesQuery(a, 'pearl')).toBe(true)
    expect(agentMatchesQuery(a, 'consultant')).toBe(true)
    expect(agentMatchesQuery(a, 'zzz')).toBe(false)
  })
})

describe('countableSquadAgents', () => {
  it('excludes consultant agents', () => {
    const agents = [mk({ id: 'm', agentTypeId: 'manager' }), mk({ id: 'c', agentTypeId: 'consultant' })]
    expect(countableSquadAgents(agents).map((a) => a.id)).toEqual(['m'])
  })
})

describe('agent display helpers', () => {
  it('uses purpose, then generated name, then agent type id', () => {
    expect(getAgentPrimaryLabel(agent({ purpose: '  API reviewer  ', name: 'Cove' }))).toBe('API reviewer')
    expect(getAgentPrimaryLabel(agent({ purpose: ' ', name: 'Cove' }))).toBe('Cove')
    expect(getAgentPrimaryLabel(agent(null, 'manager'))).toBe('manager')
  })

  it('trims purpose and name', () => {
    expect(getAgentPurpose(agent({ purpose: '  Deploy verifier  ' }))).toBe('Deploy verifier')
    expect(getAgentName(agent({ name: '  Nova  ' }))).toBe('Nova')
  })
})
