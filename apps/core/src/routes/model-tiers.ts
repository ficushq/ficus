import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, agentTypes, modelTiers } from '../db'
import { validateModelSpecList } from '../lib/utils/model-spec'
import { requirePermission } from '../middleware/require-permission'
import { readAccountStore } from '../services/agent/account-store'
import { modelTierSync } from '../services/config-sync'
import { inspectTierCapabilities } from '../services/model-selection/tier-capability-policy'
import {
  getOpenRouterExpansionStateForCurrentEnv,
  inspectOpenRouterFallbacks,
  invalidOpenRouterFallbackWarning,
  usableModelCandidatesForCurrentEnv,
} from '../services/model-selection'

import { getModelCatalog } from '../services/model-selection/model-catalog'

export const modelTiersRoutes = new Hono()
modelTiersRoutes.get('/catalog', requirePermission('agent-types:read'), async (c) => c.json(await getModelCatalog()))
modelTiersRoutes.get('/', requirePermission('agent-types:read'), async (c) => {
  const tiers = await db.select().from(modelTiers).orderBy(asc(modelTiers.sortOrder))
  const types = await db.select({ tier: agentTypes.tier }).from(agentTypes)
  const openRouterActive = getOpenRouterExpansionStateForCurrentEnv().active
  return c.json(
    tiers.map((tier) => ({
      ...tier,
      usedByCount: types.filter((type) => type.tier === tier.slug).length,
      derivedOpenRouterFallbacks: openRouterActive ? inspectOpenRouterFallbacks(tier.chain).fallbacks : [],
      // What a one-shot tier call (e.g. reply suggestions) can use right now: enabled, signed in,
      // healthy, with no OpenRouter fallbacks. Empty means such a feature silently does nothing.
      usableCandidates: tier.disabled ? [] : usableModelCandidatesForCurrentEnv(tier.chain),
    }))
  )
})
modelTiersRoutes.put('/:slug', requirePermission('agent-types:update'), async (c) => {
  const slug = c.req.param('slug')
  const body = await c.req.json()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return c.json({ error: 'slug must be kebab-case' }, 400)
  try {
    validateModelSpecList(body.chain)
  } catch (error) {
    return c.json({ error: String(error) }, 400)
  }
  const accounts = Object.values(readAccountStore().accounts)
    .flat()
    .filter((account) => account.kind === 'openai-compatible')
  const policy = inspectTierCapabilities(body.chain, accounts, Number(process.env.MODEL_CONTEXT_WINDOW_FLOOR ?? 16384))
  const openRouterWarnings = inspectOpenRouterFallbacks(body.chain).invalid.map(
    (entry) => `OpenRouter fallback skipped: ${invalidOpenRouterFallbackWarning(entry)}`
  )
  const warnings = [...policy.warnings, ...openRouterWarnings]
  if (policy.errors.length) return c.json({ error: policy.errors.join('; '), warnings }, 400)
  const values = {
    slug,
    label: body.label,
    description: body.description ?? null,
    chain: body.chain,
    sortOrder: body.sortOrder ?? 0,
    updatedAt: new Date(),
  }
  await db.insert(modelTiers).values(values).onConflictDoUpdate({ target: modelTiers.slug, set: values })
  await modelTierSync.recomputeFieldOverrides(slug)
  return c.json({
    ...(await db.select().from(modelTiers).where(eq(modelTiers.slug, slug)))[0],
    warnings,
  })
})
modelTiersRoutes.delete('/:slug', requirePermission('agent-types:update'), async (c) => {
  const slug = c.req.param('slug')
  const [used] = await db.select({ id: agentTypes.id }).from(agentTypes).where(eq(agentTypes.tier, slug)).limit(1)
  if (used) return c.json({ error: `Tier is used by agent type ${used.id}` }, 409)
  await db.delete(modelTiers).where(eq(modelTiers.slug, slug))
  return c.json({ ok: true })
})
