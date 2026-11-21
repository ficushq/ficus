import { eq, inArray } from 'drizzle-orm'
import type { AgentModelResolution } from '@ficus/shared'
import { db, modelTiers, workflowBindings } from '../../db'
import {
  describeAgentModel,
  selectedTierChain,
  type ModelTierRow,
  type WorkflowModelBinding,
} from './agent-model-resolution'

/** The workflow binding's frozen model choice for an agent, or null for an agent outside a workflow. */
export async function loadWorkflowModelBinding(agentId: string): Promise<WorkflowModelBinding | null> {
  const [binding] = await db
    .select({ agentSnapshot: workflowBindings.agentSnapshot })
    .from(workflowBindings)
    .where(eq(workflowBindings.agentId, agentId))
  if (!binding) return null
  return { tier: binding.agentSnapshot.tier || null, model: binding.agentSnapshot.model ?? '' }
}

export async function loadModelTiers(slugs: Array<string | null | undefined>): Promise<Map<string, ModelTierRow>> {
  const wanted = [...new Set(slugs.map((slug) => slug?.trim()).filter((slug): slug is string => !!slug))]
  if (wanted.length === 0) return new Map()
  const rows = await db
    .select({ slug: modelTiers.slug, label: modelTiers.label, chain: modelTiers.chain, disabled: modelTiers.disabled })
    .from(modelTiers)
    .where(inArray(modelTiers.slug, wanted))
  return new Map(rows.map((row) => [row.slug, row]))
}

/** The model a subject agent row needs to resolve, loading only the sources its overrides do not decide. */
export interface AgentModelSubject {
  id: string
  modelOverride: string | null
  tierOverride: string | null
  metadata: Record<string, unknown> | null
}

/** Load the sources an agent's model depends on and resolve it (see {@link describeAgentModel}). */
export async function resolveAgentModel(
  agent: AgentModelSubject,
  loadAgentType: () => Promise<{ id: string; model?: string | null; tier?: string | null }>
): Promise<AgentModelResolution> {
  const base = {
    modelOverride: agent.modelOverride,
    tierOverride: agent.tierOverride,
    inheritedParentChain: agent.metadata?.inheritModel === true,
    instanceDefault: process.env.DEFAULT_MODEL?.trim() ?? '',
  }
  // An agent-level override decides on its own; skip the workflow and agent type lookups.
  if (agent.modelOverride?.trim()) return describeAgentModel({ ...base, agentType: { id: '' }, tiers: new Map() })
  if (agent.tierOverride?.trim())
    return describeAgentModel({ ...base, agentType: { id: '' }, tiers: await loadModelTiers([agent.tierOverride]) })
  const workflow = await loadWorkflowModelBinding(agent.id)
  if (workflow && (workflow.tier || workflow.model.trim()))
    return describeAgentModel({
      ...base,
      workflow,
      agentType: { id: '' },
      tiers: await loadModelTiers([workflow.tier]),
    })
  const agentType = await loadAgentType()
  const tiers = agentType.model?.trim() ? new Map() : await loadModelTiers([agentType.tier])
  return describeAgentModel({ ...base, workflow, agentType, tiers })
}

/** Validate a tier slug before an agent stores it: it must exist, be enabled and have a usable chain. */
export async function validateTierOverride(slug: string): Promise<void> {
  const trimmed = slug.trim()
  if (!trimmed) throw new Error('Tier override must be a model tier slug')
  const resolution = selectedTierChain(trimmed, await loadModelTiers([trimmed]), 'agent-tier-override')
  if (resolution.error) throw new Error(resolution.error)
}
