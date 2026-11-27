import { describe, expect, it } from 'bun:test'
import type { Agent } from '@ficus/shared'
import {
  getAgentLabel,
  getAgentName,
  getAgentPrimaryLabel,
  getAgentPurpose,
  agentMatchesQuery,
  typeFirstAgentLabels,
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

describe('typeFirstAgentLabels', () => {
  it('names a lone agent by its type, never by its name', () => {
    const labels = typeFirstAgentLabels([mk({ id: 'e', agentTypeId: 'engineer', metadata: { name: 'Fern' } })])
    expect(labels.get('e')).toBe('Engineer')
  })

  it('tells two agents of one type apart by what they work on, else their purpose', () => {
    const one = mk({ id: 'e1', agentTypeId: 'engineer', metadata: { name: 'Fern', purpose: 'Onboarding' } })
    const two = mk({ id: 'e2', agentTypeId: 'engineer', metadata: { name: 'Moss', purpose: 'Billing' } })
    const manager = mk({ id: 'm', agentTypeId: 'manager', metadata: { name: 'Cascade' } })
    const labels = typeFirstAgentLabels([one, two, manager, one], (agent) =>
      agent.id === 'e1' ? '#12 · Implement' : undefined
    )
    expect(labels.get('e1')).toBe('Engineer (#12 · Implement)')
    expect(labels.get('e2')).toBe('Engineer (Billing)')
    expect(labels.get('m')).toBe('Manager')
  })
})

describe('getAgentLabel', () => {
  it('leads with the type, then what the agent works on or its purpose, and never the name alone', () => {
    expect(getAgentLabel(agent({ name: 'Quartz', purpose: 'Onboarding' }))).toBe('Engineer (Onboarding)')
    expect(getAgentLabel(agent({ name: 'Quartz', purpose: 'Onboarding' }), '#12 · Implement')).toBe(
      'Engineer (#12 · Implement)'
    )
    expect(getAgentLabel(agent({ name: 'Quartz' }))).toBe('Engineer')
    expect(getAgentLabel(agent({ name: 'Quartz' }, 'general-purpose'))).toBe('General Purpose')
  })
})
