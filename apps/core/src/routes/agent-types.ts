import { publicErrorMessage } from '../db/errors'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { AgentType } from '../entities/AgentType'
import { db, agentTypes, modelTiers } from '../db'
import { agentTypeSync } from '../services/config-sync'
import { validateAgentTypeConfig } from '../services/config/validate-config'
import { Skill } from '../entities/Skill'
import { requirePermission } from '../middleware/require-permission'
import { resolveModelChain } from '../services/model-selection/model-tier-resolution'
import { composeAgentTypePrompt } from '../services/agent-types/compose-prompt'

type ModelTierRow = typeof modelTiers.$inferSelect

function resolvedAgentTypeJson(type: AgentType, candidateTier?: ModelTierRow) {
  const tier = candidateTier && !candidateTier.disabled ? candidateTier : null
  const resolution = resolveModelChain({
    typeOverride: type.model,
    tier,
    tierSlug: type.tier,
    instanceDefault: process.env.DEFAULT_MODEL?.trim() ?? '',
  })
  return { ...type.toJson(), resolvedChain: resolution.chain, provenance: resolution.provenance }
}

const agentTypesRoutes = new Hono()

// GET /api/agent-types - List all agent types
agentTypesRoutes.get('/', requirePermission('agent-types:read'), async (c) => {
  const types = await AgentType.list()
  const tiers = new Map((await db.select().from(modelTiers)).map((tier) => [tier.slug, tier]))
  return c.json(types.map((type) => resolvedAgentTypeJson(type, type.tier ? tiers.get(type.tier) : undefined)))
})

// GET /api/agent-types/:id - Get agent type details
agentTypesRoutes.get('/:id', requirePermission('agent-types:read'), async (c) => {
  const type = await AgentType.find(c.req.param('id'))
  if (!type) return c.json({ error: 'Agent type not found' }, 404)
  const [tier] = type.tier ? await db.select().from(modelTiers).where(eq(modelTiers.slug, type.tier)) : []
  return c.json({ ...resolvedAgentTypeJson(type, tier), resolvedSystemPrompt: await composeAgentTypePrompt(type) })
})

// POST /api/agent-types - Create new agent type
agentTypesRoutes.post('/', requirePermission('agent-types:create'), async (c) => {
  const body = await c.req.json()
  const { id } = body
  if (!id) return c.json({ error: 'id is required' }, 400)
  try {
    await validateAgentTypeConfig({ ...body, id })
  } catch (e: any) {
    return c.json({ error: publicErrorMessage(e) }, 400)
  }
  const existing = await AgentType.find(id)
  if (existing) return c.json({ error: `Agent type "${id}" already exists` }, 409)
  await AgentType.upsert({ ...body, id })
  const created = await AgentType.mustFind(id)
  return c.json(created.toJson(), 201)
})

// PUT /api/agent-types/:id - Update agent type (admin edit)
agentTypesRoutes.put('/:id', requirePermission('agent-types:update'), async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const existing = await AgentType.find(id)
  if (!existing) return c.json({ error: 'Agent type not found' }, 404)
  try {
    await validateAgentTypeConfig({ ...body, id })
  } catch (e: any) {
    return c.json({ error: publicErrorMessage(e) }, 400)
  }
  await AgentType.upsert({ ...body, includes: body.includes ?? existing.includes, id })
  await agentTypeSync.recomputeFieldOverrides(id)
  AgentType.invalidateCache()
  const updated = await AgentType.mustFind(id)
  return c.json(updated.toJson())
})

// POST /api/agent-types/:id/add-skill - Append one skill without replacing the full list
agentTypesRoutes.post('/:id/add-skill', requirePermission('agent-types:update'), async (c) => {
  const id = c.req.param('id')
  const existing = await AgentType.find(id)
  if (!existing) return c.json({ error: 'Agent type not found' }, 404)
  const body = await c.req.json()
  const skillId = body.skillId ?? body.id
  if (typeof skillId !== 'string' || !skillId.trim()) return c.json({ error: 'skillId is required' }, 400)
  const skill = await Skill.find(skillId)
  if (!skill || skill.disabled) return c.json({ error: `Skill "${skillId}" does not exist` }, 400)
  const nextSkills = [...new Set([...(existing.skills ?? []), skillId])]
  await AgentType.upsert({
    id: existing.id,
    name: existing.name,
    model: existing.model,
    tier: existing.tier,
    description: existing.description ?? undefined,
    systemPrompt: existing.systemPrompt,
    includes: existing.includes,
    skills: nextSkills,
    extensions: existing.extensions ?? undefined,
    toolsAllow: existing.toolsAllow ?? undefined,
    toolsDeny: existing.toolsDeny ?? undefined,
    integrationCapabilities: existing.integrationCapabilities ?? undefined,
    earlyMarginTokens: existing.earlyMarginTokens,
    inFlightMarginTokens: existing.inFlightMarginTokens,
  })
  await agentTypeSync.recomputeFieldOverrides(id)
  AgentType.invalidateCache()
  const updated = await AgentType.mustFind(id)
  return c.json(updated.toJson())
})

// POST /api/agent-types/:id/remove-skill - Remove one skill without replacing the full list
agentTypesRoutes.post('/:id/remove-skill', requirePermission('agent-types:update'), async (c) => {
  const id = c.req.param('id')
  const existing = await AgentType.find(id)
  if (!existing) return c.json({ error: 'Agent type not found' }, 404)
  const body = await c.req.json()
  const skillId = body.skillId ?? body.id
  if (typeof skillId !== 'string' || !skillId.trim()) return c.json({ error: 'skillId is required' }, 400)
  const nextSkills = (existing.skills ?? []).filter((s) => s !== skillId)
  await AgentType.upsert({
    id: existing.id,
    name: existing.name,
    model: existing.model,
    tier: existing.tier,
    description: existing.description ?? undefined,
    systemPrompt: existing.systemPrompt,
    includes: existing.includes,
    skills: nextSkills,
    extensions: existing.extensions ?? undefined,
    toolsAllow: existing.toolsAllow ?? undefined,
    toolsDeny: existing.toolsDeny ?? undefined,
    integrationCapabilities: existing.integrationCapabilities ?? undefined,
    earlyMarginTokens: existing.earlyMarginTokens,
    inFlightMarginTokens: existing.inFlightMarginTokens,
  })
  await agentTypeSync.recomputeFieldOverrides(id)
  AgentType.invalidateCache()
  const updated = await AgentType.mustFind(id)
  return c.json(updated.toJson())
})

// DELETE /api/agent-types/:id — only custom entries (no template) can be deleted
agentTypesRoutes.delete('/:id', requirePermission('agent-types:delete'), async (c) => {
  const id = c.req.param('id')
  if (PROTECTED_AGENT_TYPES.includes(id)) {
    return c.json({ error: 'Cannot delete built-in agent type' }, 400)
  }
  const existing = await AgentType.find(id)
  if (!existing) return c.json({ error: 'Agent type not found' }, 404)
  if (existing.yamlTemplate != null) {
    return c.json({ error: 'Cannot delete a template-based config — use disable instead' }, 400)
  }
  await db.delete(agentTypes).where(eq(agentTypes.id, id))
  AgentType.invalidateCache()
  return c.json({ ok: true })
})

// GET /api/agent-types/:id/template-diff
agentTypesRoutes.get('/:id/template-diff', requirePermission('agent-types:read'), async (c) => {
  try {
    const diff = await agentTypeSync.getTemplateDiff(c.req.param('id'))
    return c.json(diff)
  } catch (e: any) {
    return c.json({ error: publicErrorMessage(e) }, 404)
  }
})

// POST /api/agent-types/:id/revert-to-template
agentTypesRoutes.post('/:id/revert-to-template', requirePermission('agent-types:update'), async (c) => {
  try {
    await agentTypeSync.revertToTemplate(c.req.param('id'))
    AgentType.invalidateCache()
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: publicErrorMessage(e) }, 400)
  }
})

// POST /api/agent-types/:id/revert-template-fields
agentTypesRoutes.post('/:id/revert-template-fields', requirePermission('agent-types:update'), async (c) => {
  try {
    const body = await c.req.json()
    await agentTypeSync.revertTemplateFields(c.req.param('id'), body.fields ?? [])
    AgentType.invalidateCache()
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: publicErrorMessage(e) }, 400)
  }
})

const PROTECTED_AGENT_TYPES = ['manager', 'system-manager', 'assistant', 'assistant-worker', 'consultant']

// POST /api/agent-types/:id/disable
agentTypesRoutes.post('/:id/disable', requirePermission('agent-types:update'), async (c) => {
  const id = c.req.param('id')
  if (PROTECTED_AGENT_TYPES.includes(id)) {
    return c.json({ error: 'Cannot disable built-in agent type' }, 400)
  }
  if (!(await AgentType.find(id))) return c.json({ error: 'Agent type not found' }, 404)
  await agentTypeSync.setDisabled(id, true)
  AgentType.invalidateCache()
  return c.json({ ok: true })
})

// POST /api/agent-types/:id/enable
agentTypesRoutes.post('/:id/enable', requirePermission('agent-types:update'), async (c) => {
  const id = c.req.param('id')
  if (!(await AgentType.find(id))) return c.json({ error: 'Agent type not found' }, 404)
  await agentTypeSync.setDisabled(id, false)
  AgentType.invalidateCache()
  return c.json({ ok: true })
})

// GET /api/agent-types/:id/export
agentTypesRoutes.get('/:id/export', requirePermission('agent-types:read'), async (c) => {
  const rows = await db
    .select()
    .from(agentTypes)
    .where(eq(agentTypes.id, c.req.param('id')))
  if (!rows[0]) return c.json({ error: 'Not found' }, 404)
  const yamlStr = agentTypeSync.toYaml(rows[0] as any)
  return c.text(yamlStr, 200, { 'Content-Type': 'text/yaml' })
})

export { agentTypesRoutes }
