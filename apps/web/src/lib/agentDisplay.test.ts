import { describe, expect, it } from 'bun:test'
import type { Agent } from '@ficus/shared'
import {
  agentListLabels,
  agentThreadLinkTitle,
  agentTypeDisplayName,
  getAgentLabel,
  getAgentTitle,
  getConversationTitle,
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

  it('uses the squad’s name for the type, and reads the general type as "General Purpose agent"', () => {
    expect(getAgentLabel(agent({ purpose: 'Payments' }), undefined, () => 'Builder')).toBe('Builder (Payments)')
    expect(getAgentLabel(agent({ purpose: 'Docs' }, 'general'))).toBe('General Purpose agent (Docs)')
  })
})

describe('agentListLabels', () => {
  const engineer = (id: string, metadata: Agent['metadata']) => ({ ...agent(metadata), id })
  it('tells untitled agents of one type apart by their work stream, then name, then a short ID', () => {
    const labels = agentListLabels(
      [
        engineer('working-1', { name: 'Edda' }),
        engineer('named-2', { name: 'Quinn' }),
        engineer('3f9a2b7c-unnamed', {}),
        engineer('titled-4', { name: 'Pearl', purpose: 'Onboarding' }),
      ],
      (candidate) => (candidate.id === 'working-1' ? '#12' : undefined)
    )
    expect([...labels.values()]).toEqual([
      'Engineer (#12)',
      'Engineer (Quinn)',
      'Engineer (3f9a2b7c)',
      'Engineer (Onboarding)',
    ])
  })

  it('names a lone agent of its type by type and purpose only', () => {
    expect(agentListLabels([engineer('solo', { name: 'Edda' })]).get('solo')).toBe('Engineer')
  })
})

describe('configured agent type names', () => {
  // The squad renamed two built-in types and added a custom one.
  const names: Record<string, string> = { engineer: 'Builder', 'system-manager': 'Assistant', 'qa-bot': 'Release QA' }
  const typeNames = (id: string) => names[id]

  it('names every type by its configured name, custom types included, and title-cases the rest', () => {
    expect(agentTypeDisplayName('engineer', typeNames)).toBe('Builder')
    expect(agentTypeDisplayName('system-manager', typeNames)).toBe('Assistant')
    expect(agentTypeDisplayName('qa-bot', typeNames)).toBe('Release QA')
    expect(agentTypeDisplayName('qa-bot')).toBe('Qa Bot')
    expect(agentTypeDisplayName('reviewer', typeNames)).toBe('Reviewer')
    // The general type is never a bare "General".
    expect(agentTypeDisplayName('general', typeNames)).toBe('General Purpose agent')
    expect(agentTypeDisplayName('general', () => 'Helper')).toBe('Helper agent')
  })

  it('reaches every label helper', () => {
    const builder = mk({ id: 'b', agentTypeId: 'engineer', metadata: { name: 'Fern' } })
    const qa = mk({ id: 'q', agentTypeId: 'qa-bot', metadata: { name: 'Moss', purpose: 'Smoke tests' } })
    const assistant = mk({ id: 's', agentTypeId: 'system-manager', metadata: { name: 'Sol' } })
    expect(getAgentLabel(builder, undefined, typeNames)).toBe('Builder')
    expect(getAgentLabel(builder, '#12', typeNames)).toBe('Builder (#12)')
    expect(getAgentTitle(assistant, typeNames)).toBe('Assistant')
    expect(getConversationTitle(builder, typeNames)).toBe('Builder')
    expect(getConversationTitle(qa, typeNames)).toBe('Smoke tests')
    expect(agentListLabels([builder, qa], undefined, typeNames)).toEqual(
      new Map([
        ['b', 'Builder'],
        ['q', 'Release QA (Smoke tests)'],
      ])
    )
    const twin = mk({ id: 'b2', agentTypeId: 'engineer', metadata: { name: 'Ash' } })
    expect(typeFirstAgentLabels([builder, twin, qa], undefined, typeNames)).toEqual(
      new Map([
        ['b', 'Builder (Fern)'],
        ['b2', 'Builder (Ash)'],
        ['q', 'Release QA'],
      ])
    )
  })

  it('finds an agent by the type name people read', () => {
    const qa = mk({ id: 'q', agentTypeId: 'qa-bot', metadata: { name: 'Moss' } })
    expect(agentMatchesQuery(qa, 'release', typeNames)).toBe(true)
    expect(agentMatchesQuery(qa, 'release')).toBe(false)
  })

  it('titles an agent thread link without saying "agent" twice', () => {
    expect(agentThreadLinkTitle('Builder')).toBe('Open Builder agent thread')
    expect(agentThreadLinkTitle('General Purpose agent')).toBe('Open General Purpose agent thread')
  })
})
