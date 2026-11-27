import { describe, expect, test } from 'bun:test'
import { agentLabelParts, agentSenderLabel, agentTypeLabel, formatAgentLabel, typeFirstAgentLabel } from './agentLabel'

describe('agentLabelParts', () => {
  test('purpose leads, name is secondary', () => {
    expect(agentLabelParts({ name: 'Quartz', purpose: 'Billing migration' })).toEqual({
      primary: 'Billing migration',
      secondary: 'Quartz',
    })
  })

  test('falls back to name when no purpose', () => {
    expect(agentLabelParts({ name: 'Quartz', purpose: '' })).toEqual({ primary: 'Quartz' })
    expect(agentLabelParts({ name: 'Quartz' })).toEqual({ primary: 'Quartz' })
  })

  test('falls back to agentTypeId then "Agent"', () => {
    expect(agentLabelParts({ agentTypeId: 'consultant' })).toEqual({ primary: 'consultant' })
    expect(agentLabelParts({})).toEqual({ primary: 'Agent' })
  })

  test('drops a redundant name equal to the purpose', () => {
    expect(agentLabelParts({ name: 'Quartz', purpose: 'Quartz' })).toEqual({ primary: 'Quartz' })
  })

  test('formatAgentLabel joins with a separator', () => {
    expect(formatAgentLabel({ name: 'Quartz', purpose: 'Billing migration' })).toBe('Billing migration · Quartz')
    expect(formatAgentLabel({ name: 'Quartz' })).toBe('Quartz')
  })
})

describe('typeFirstAgentLabel', () => {
  test('leads with the type and adds what the agent works on, else its purpose', () => {
    expect(typeFirstAgentLabel({ agentTypeId: 'engineer', purpose: 'Onboarding', workingOn: '#12 · Implement' })).toBe(
      'Engineer (#12 · Implement)'
    )
    expect(typeFirstAgentLabel({ agentTypeId: 'engineer', purpose: ' Onboarding ' })).toBe('Engineer (Onboarding)')
    expect(typeFirstAgentLabel({ agentTypeId: 'general-purpose', purpose: '' })).toBe('General Purpose')
  })

  test('never names the agent; an unknown type reads "Agent"', () => {
    expect(typeFirstAgentLabel({ agentTypeId: null })).toBe('Agent')
    expect(agentTypeLabel('product_lead')).toBe('Product Lead')
  })
})

describe('agentSenderLabel', () => {
  test('names an agent sender type first from its recorded metadata, and nothing else', () => {
    expect(agentSenderLabel({ name: 'Riley', agentTypeId: 'engineer', purpose: 'Fix inline PR rows' })).toBe(
      'Engineer (Fix inline PR rows)'
    )
    expect(agentSenderLabel({ name: 'Riley' }, 'engineer')).toBe('Engineer')
    // The configured type name wins over the title-cased id.
    expect(agentSenderLabel({ name: 'Ava', agentTypeId: 'system-manager', agentTypeName: 'User Assistant' })).toBe(
      'User Assistant'
    )
    expect(agentSenderLabel({ name: 'Noah' })).toBeNull()
    expect(agentSenderLabel(undefined)).toBeNull()
  })
})
