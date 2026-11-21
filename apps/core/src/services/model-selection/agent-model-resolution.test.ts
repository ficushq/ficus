import { describe, expect, test } from 'bun:test'
import {
  AgentModelResolutionError,
  describeAgentModel,
  requireAgentModelChain,
  type AgentModelInputs,
  type ModelTierRow,
} from './agent-model-resolution'

const tierRows: ModelTierRow[] = [
  { slug: 'deep', label: 'Deep', chain: 'tier:deep:high', disabled: false },
  { slug: 'standard', label: 'Standard', chain: 'tier:standard:medium', disabled: false },
  { slug: 'retired', label: 'Retired', chain: 'tier:retired:low', disabled: true },
  { slug: 'empty', label: 'Empty', chain: ' ', disabled: false },
]
const tiers = new Map(tierRows.map((tier) => [tier.slug, tier]))

function inputs(overrides: Partial<AgentModelInputs> = {}): AgentModelInputs {
  return {
    modelOverride: 'agent:model:xhigh',
    tierOverride: 'deep',
    workflow: { tier: 'standard', model: '' },
    agentType: { id: 'engineer', model: 'type:model:high', tier: 'standard' },
    tiers,
    instanceDefault: 'default:model:medium',
    ...overrides,
  }
}

describe('describeAgentModel resolution order', () => {
  test('an agent model override wins over every other source', () => {
    expect(describeAgentModel(inputs())).toEqual({
      chain: 'agent:model:xhigh',
      source: { kind: 'agent-model-override' },
    })
  })

  test('a subagent that inherited its parent chain says so', () => {
    expect(describeAgentModel(inputs({ inheritedParentChain: true })).source).toEqual({
      kind: 'inherited-parent-chain',
    })
  })

  test('an agent tier override comes next and follows the tier chain', () => {
    expect(describeAgentModel(inputs({ modelOverride: null }))).toEqual({
      chain: 'tier:deep:high',
      source: { kind: 'agent-tier-override', tier: 'deep', tierLabel: 'Deep' },
    })
  })

  test('then the workflow participant tier, before the agent type', () => {
    expect(describeAgentModel(inputs({ modelOverride: null, tierOverride: null }))).toEqual({
      chain: 'tier:standard:medium',
      source: { kind: 'workflow-tier', tier: 'standard', tierLabel: 'Standard' },
    })
  })

  test('a workflow participant without a tier runs its snapshot model', () => {
    expect(
      describeAgentModel(
        inputs({ modelOverride: null, tierOverride: null, workflow: { tier: null, model: 'flow:model:low' } })
      )
    ).toEqual({ chain: 'flow:model:low', source: { kind: 'workflow-model' } })
  })

  test('then the agent type model, before the agent type tier', () => {
    expect(describeAgentModel(inputs({ modelOverride: null, tierOverride: null, workflow: null }))).toEqual({
      chain: 'type:model:high',
      source: { kind: 'agent-type-model' },
    })
  })

  test('then the agent type tier', () => {
    expect(
      describeAgentModel(
        inputs({
          modelOverride: null,
          tierOverride: null,
          workflow: null,
          agentType: { id: 'engineer', model: '', tier: 'standard' },
        })
      )
    ).toEqual({
      chain: 'tier:standard:medium',
      source: { kind: 'agent-type-tier', tier: 'standard', tierLabel: 'Standard' },
    })
  })

  test('then the instance default', () => {
    expect(
      describeAgentModel(
        inputs({ modelOverride: null, tierOverride: null, workflow: null, agentType: { id: 'engineer' } })
      )
    ).toEqual({ chain: 'default:model:medium', source: { kind: 'instance-default' } })
  })

  test('blank overrides do not count as set', () => {
    expect(describeAgentModel(inputs({ modelOverride: '  ', tierOverride: '' })).source.kind).toBe('workflow-tier')
  })
})

describe('describeAgentModel failures', () => {
  test('a disabled tier override fails clearly instead of falling back', () => {
    const resolution = describeAgentModel(inputs({ modelOverride: null, tierOverride: 'retired' }))
    expect(resolution).toEqual({
      chain: '',
      source: { kind: 'agent-tier-override', tier: 'retired', tierLabel: 'Retired' },
      error: "Model tier 'retired' does not exist or is disabled",
    })
    expect(() => requireAgentModelChain(resolution)).toThrow(AgentModelResolutionError)
  })

  test('a missing tier override fails clearly', () => {
    const resolution = describeAgentModel(inputs({ modelOverride: null, tierOverride: 'removed' }))
    expect(resolution.source).toEqual({ kind: 'agent-tier-override', tier: 'removed' })
    expect(resolution.error).toBe("Model tier 'removed' does not exist or is disabled")
  })

  test('a tier override with an empty chain fails clearly', () => {
    expect(describeAgentModel(inputs({ modelOverride: null, tierOverride: 'empty' })).error).toContain(
      'needs a valid chain'
    )
  })

  test('a disabled workflow tier fails like flow dispatch does', () => {
    const resolution = describeAgentModel(
      inputs({ modelOverride: null, tierOverride: null, workflow: { tier: 'retired', model: '' } })
    )
    expect(resolution.source.kind).toBe('workflow-tier')
    expect(resolution.error).toBe("Model tier 'retired' does not exist or is disabled")
  })

  test("an agent type's own disabled tier keeps falling to the instance default", () => {
    expect(
      describeAgentModel(
        inputs({
          modelOverride: null,
          tierOverride: null,
          workflow: null,
          agentType: { id: 'engineer', model: '', tier: 'retired' },
        })
      )
    ).toEqual({ chain: 'default:model:medium', source: { kind: 'instance-default' } })
  })

  test('no source at all reports what to configure', () => {
    const resolution = describeAgentModel(
      inputs({
        modelOverride: null,
        tierOverride: null,
        workflow: null,
        agentType: { id: 'engineer' },
        instanceDefault: '',
      })
    )
    expect(resolution.error).toContain('No model chain resolves for agent type engineer')
    expect(() => requireAgentModelChain(resolution)).toThrow('No model chain resolves')
  })
})
