import { eq } from 'drizzle-orm'
import { db, modelTiers } from '../../db'
import { AgentType } from '../../entities/AgentType'
import { SharedPrompt } from '../../entities/SharedPrompt'
import { Skill } from '../../entities/Skill'
import { validateModelSpecList } from '../../lib/utils/model-spec'
import { assertConfigId, assertNonEmptyString } from '../../lib/validation/config-ids'
import { INTEGRATION_CAPABILITIES, squadPresetWorkflowsSchema } from '@ficus/shared'

const MAX_EARLY_MARGIN_TOKENS = 1_000_000

function validateEarlyMarginTokens(value: unknown): void {
  if (value == null) return
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_EARLY_MARGIN_TOKENS
  ) {
    throw new Error(`earlyMarginTokens must be an integer between 0 and ${MAX_EARLY_MARGIN_TOKENS}`)
  }
}

function validateInFlightMarginTokens(value: unknown): void {
  if (value == null) return
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_EARLY_MARGIN_TOKENS
  ) {
    throw new Error(`inFlightMarginTokens must be an integer between 0 and ${MAX_EARLY_MARGIN_TOKENS}`)
  }
}

export async function validateAgentTypeConfig(input: any): Promise<void> {
  assertConfigId(input.id, 'agent type id')
  if (input.systemOnly !== undefined && typeof input.systemOnly !== 'boolean')
    throw new Error('systemOnly must be a boolean')
  assertNonEmptyString(input.name, 'name')
  if (!input.model && !input.tier) throw new Error('model or tier is required')
  assertNonEmptyString(input.systemPrompt, 'systemPrompt')
  if (Object.hasOwn(input, 'flowPrompt'))
    throw new Error('flowPrompt was removed; put expertise in systemPrompt and step instructions in the workflow')
  if (input.model) validateModelSpecList(input.model)
  if (input.tier) {
    assertConfigId(input.tier, 'model tier')
    const [tier] = await db
      .select({ disabled: modelTiers.disabled })
      .from(modelTiers)
      .where(eq(modelTiers.slug, input.tier))
    if (!tier || tier.disabled) throw new Error(`Model tier "${input.tier}" does not exist or is disabled`)
  }
  validateEarlyMarginTokens(input.earlyMarginTokens)
  validateInFlightMarginTokens(input.inFlightMarginTokens)
  if (input.integrationCapabilities != null) {
    const policy = input.integrationCapabilities
    if (typeof policy !== 'object' || policy.version !== 1 || !policy.allow || typeof policy.allow !== 'object') {
      throw new Error('integrationCapabilities must use policy version 1')
    }
    for (const [provider, capabilities] of Object.entries(policy.allow)) {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider)) throw new Error(`Invalid integration provider "${provider}"`)
      if (!Array.isArray(capabilities)) throw new Error(`Integration capabilities for "${provider}" must be an array`)
      for (const capability of capabilities) {
        if (typeof capability !== 'string' || !(INTEGRATION_CAPABILITIES as readonly string[]).includes(capability)) {
          throw new Error(`Unknown integration capability "${String(capability)}"`)
        }
      }
    }
  }
  if (input.skills != null) {
    if (!Array.isArray(input.skills)) throw new Error('skills must be an array')
    for (const ref of input.skills) {
      assertNonEmptyString(ref, 'skill reference')
      const skill = await Skill.find(ref)
      if (skill) {
        if (skill.disabled) throw new Error(`Skill "${ref}" is disabled`)
        continue
      }
      throw new Error(`Skill "${ref}" does not exist`)
    }
  }
  if (input.includes != null) {
    if (!Array.isArray(input.includes)) throw new Error('includes must be an array')
    const seen = new Set<string>()
    for (const id of input.includes) {
      if (typeof id !== 'string' || !id) throw new Error('includes must contain non-empty ids')
      if (seen.has(id)) throw new Error(`includes lists '${id}' twice`)
      seen.add(id)
      const sharedPrompt = await SharedPrompt.find(id)
      if (!sharedPrompt) throw new Error(`Unknown shared prompt '${id}'`)
      // Composition skips disabled prompts, so accepting one here would store a
      // reference that silently does nothing.
      if (sharedPrompt.disabled) throw new Error(`Shared prompt '${id}' is disabled`)
    }
  }
}

export async function validateSquadPresetConfig(input: any): Promise<void> {
  assertConfigId(input.id, 'squad preset id')
  assertNonEmptyString(input.name, 'name')
  if (input.workflows != null) {
    const styles = squadPresetWorkflowsSchema.parse(input.workflows)
    const { validateSquadWorkflows } = await import('../workflows/access')
    await validateSquadWorkflows(
      { workflow: styles.default, workflowSetup: { guidance: styles.guidance, choices: styles.choices } },
      ''
    )
  }
  const refs = new Set<string>()
  for (const ref of input.defaultAgents ?? []) refs.add(ref)
  if (input.workerInstructions !== undefined) {
    throw new Error('workerInstructions was removed; put worker behavior in agent expertise and workflows')
  }
  for (const template of input.scheduleTemplates ?? []) {
    const agentType = template?.action?.agentType
    if (agentType) refs.add(agentType)
  }
  for (const ref of refs) {
    assertConfigId(ref, 'agent type reference')
    const agentType = await AgentType.find(ref)
    if (!agentType || agentType.disabled) throw new Error(`Agent type "${ref}" does not exist`)
  }
}
