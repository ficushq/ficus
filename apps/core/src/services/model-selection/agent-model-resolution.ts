import type { AgentModelResolution, AgentModelSource } from '@ficus/shared'

/** The longest chain an agent row, workflow snapshot or tier may carry into a session. */
const MAX_CHAIN_LENGTH = 500

export interface ModelTierRow {
  slug: string
  label: string
  chain: string
  disabled: boolean
}

/** The model a workflow binding froze for its worker: a tier slug, or a resolved model chain. */
export interface WorkflowModelBinding {
  tier: string | null
  model: string
}

/** Everything that decides an agent's model chain, already loaded. */
export interface AgentModelInputs {
  modelOverride?: string | null
  tierOverride?: string | null
  /** The model override was copied from the parent when the subagent was dispatched. */
  inheritedParentChain?: boolean
  workflow?: WorkflowModelBinding | null
  agentType: { id: string; model?: string | null; tier?: string | null }
  tiers: ReadonlyMap<string, ModelTierRow>
  instanceDefault: string
}

/** The model tier is missing or disabled, or its chain is unusable. */
export class AgentModelResolutionError extends Error {
  constructor(
    message: string,
    readonly source: AgentModelSource
  ) {
    super(message)
    this.name = 'AgentModelResolutionError'
  }
}

function unavailableTierMessage(slug: string): string {
  return `Model tier '${slug}' does not exist or is disabled`
}

/** A selected tier must exist, be enabled and carry a usable chain; it never silently falls back. */
export function selectedTierChain(
  slug: string,
  tiers: ReadonlyMap<string, ModelTierRow>,
  kind: 'agent-tier-override' | 'workflow-tier'
): AgentModelResolution {
  const tier = tiers.get(slug)
  const source: AgentModelSource = { kind, tier: slug, ...(tier ? { tierLabel: tier.label } : {}) }
  if (!tier || tier.disabled) return { chain: '', source, error: unavailableTierMessage(slug) }
  const chain = tier.chain.trim()
  if (!chain || chain.length > MAX_CHAIN_LENGTH)
    return {
      chain: '',
      source,
      error: `Model tier '${slug}' needs a valid chain of at most ${MAX_CHAIN_LENGTH} characters`,
    }
  return { chain, source }
}

/**
 * Resolve an agent's model chain and its source. Order: agent model override, agent tier override,
 * workflow participant tier or model, agent type model, agent type tier, instance default.
 *
 * Never throws: a source that cannot resolve (a missing or disabled selected tier, no instance
 * default) returns an empty chain with `error` set, so serializing an agent stays safe. Callers that
 * start a session use {@link requireAgentModelChain}.
 */
export function describeAgentModel(inputs: AgentModelInputs): AgentModelResolution {
  const modelOverride = inputs.modelOverride?.trim()
  if (modelOverride)
    return {
      chain: modelOverride,
      source: { kind: inputs.inheritedParentChain ? 'inherited-parent-chain' : 'agent-model-override' },
    }
  const tierOverride = inputs.tierOverride?.trim()
  if (tierOverride) return selectedTierChain(tierOverride, inputs.tiers, 'agent-tier-override')
  if (inputs.workflow) {
    if (inputs.workflow.tier) return selectedTierChain(inputs.workflow.tier, inputs.tiers, 'workflow-tier')
    const workflowModel = inputs.workflow.model.trim()
    if (workflowModel) return { chain: workflowModel, source: { kind: 'workflow-model' } }
  }
  const typeModel = inputs.agentType.model?.trim()
  if (typeModel) return { chain: typeModel, source: { kind: 'agent-type-model' } }
  // An agent type's own tier keeps its existing behavior: disabled or missing falls to the instance default.
  const typeTierSlug = inputs.agentType.tier?.trim()
  const typeTier = typeTierSlug ? inputs.tiers.get(typeTierSlug) : undefined
  const typeTierChain = typeTier && !typeTier.disabled ? typeTier.chain.trim() : ''
  if (typeTier && typeTierChain)
    return {
      chain: typeTierChain,
      source: { kind: 'agent-type-tier', tier: typeTier.slug, tierLabel: typeTier.label },
    }
  const instanceDefault = inputs.instanceDefault.trim()
  if (instanceDefault) return { chain: instanceDefault, source: { kind: 'instance-default' } }
  return {
    chain: '',
    source: { kind: 'instance-default' },
    error: `No model chain resolves for agent type ${inputs.agentType.id}; configure its model/tier or DEFAULT_MODEL`,
  }
}

/** The chain of a resolution, or the resolution's error. */
export function requireAgentModelChain(resolution: AgentModelResolution): string {
  if (resolution.error || !resolution.chain) {
    throw new AgentModelResolutionError(resolution.error ?? 'No model chain resolves', resolution.source)
  }
  return resolution.chain
}
