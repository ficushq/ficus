import { Hono } from 'hono'
import { z } from 'zod'
import {
  DECISION_PROVIDER_KIND_INFO,
  DECISION_PROVIDER_KINDS,
  DECISION_FEATURE_SWITCH_VALUES,
  DECISION_PURPOSE_INFO,
  DECISION_PURPOSES,
  decisionRequestSchema,
  decisionRoutingSchema,
} from '@ficus/shared'
import { requirePermission } from '../middleware/require-permission'
import { auditActor, type Identity } from '../services/rbac'
import { getOpenAIServiceKey } from '../services/integrations/openai-services/settings'
import { systemOneBase } from '../services/decisions/adapters'
import { askProvider, decide, decisionFeatures, DECISION_PROBE } from '../services/decisions/service'
import {
  addDecisionProvider,
  decisionProviderView,
  getDecisionProvider,
  getDecisionRouting,
  listDecisionProviders,
  removeDecisionProvider,
  setDecisionFeatureSwitch,
  setDecisionRouting,
  updateDecisionProvider,
} from '../services/decisions/store'

/*
 * Decision model providers and which of them each purpose asks. Managed alongside AI Providers,
 * with the same permissions; their keys are never returned.
 */

const app = new Hono()

const providerInput = z.object({
  kind: z.enum(DECISION_PROVIDER_KINDS),
  label: z.string().max(80).optional(),
  model: z.string().max(128).optional(),
  baseUrl: z.string().max(2048).optional(),
  accountId: z.string().max(128).optional(),
  apiKey: z.string().max(4096).optional(),
})

const providerPatch = providerInput.omit({ kind: true }).extend({ enabled: z.boolean().optional() })

app.get('/', requirePermission('provider-auth:read'), (c) =>
  c.json({
    providers: listDecisionProviders().map(decisionProviderView),
    routing: getDecisionRouting(),
    kinds: DECISION_PROVIDER_KIND_INFO,
    purposes: DECISION_PURPOSES.map((id) => ({ id, ...DECISION_PURPOSE_INFO[id] })),
    features: decisionFeatures(),
    openAIServicesKey: Boolean(getOpenAIServiceKey()),
  })
)

/** Check a provider answers a test question, then save it. */
app.post('/providers', requirePermission('provider-auth:write'), async (c) => {
  const parsed = providerInput.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid provider' }, 400)
  const input = parsed.data
  if (input.kind === 'systemone') {
    try {
      input.baseUrl = systemOneBase(input.baseUrl ?? '')
    } catch {
      return c.json({ error: 'Enter the server URL, such as http://localhost:11434' }, 400)
    }
  }
  const model = input.model?.trim() || DECISION_PROVIDER_KIND_INFO[input.kind].defaultModel
  try {
    await askProvider({ id: 'probe', ...input, model }, DECISION_PROBE, { signal: AbortSignal.timeout(15_000) })
  } catch (error) {
    return c.json({ error: `It didn't answer a test question: ${error instanceof Error ? error.message : error}` }, 400)
  }
  const provider = await addDecisionProvider({ ...input, model })
  return c.json(decisionProviderView(provider), 201)
})

app.patch('/providers/:id', requirePermission('provider-auth:write'), async (c) => {
  const parsed = providerPatch.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid change' }, 400)
  const provider = await updateDecisionProvider(c.req.param('id'), parsed.data)
  if (!provider) return c.json({ error: 'No such decision provider' }, 404)
  return c.json(decisionProviderView(provider))
})

app.delete('/providers/:id', requirePermission('provider-auth:write'), async (c) => {
  if (!(await removeDecisionProvider(c.req.param('id')))) return c.json({ error: 'No such decision provider' }, 404)
  return c.json({ ok: true })
})

/** Look for decision models served on this machine's usual ports (Ollama, vLLM, SGLang). */
app.post('/providers/detect', requirePermission('provider-auth:read'), async (c) => {
  const found = await Promise.all(
    [11434, 8000, 30000, 8080].map(async (port) => {
      const baseUrl = `http://localhost:${port}`
      try {
        const response = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(750) })
        if (!response.ok) return null
        const body = (await response.json()) as { data?: Array<{ id?: string }> }
        const models = (body.data ?? []).flatMap((entry) =>
          entry.id && /clef|jev|systemone/i.test(entry.id) ? [entry.id] : []
        )
        return models.length ? { baseUrl, models } : null
      } catch {
        return null
      }
    })
  )
  return c.json(found.filter(Boolean))
})

app.put('/routing', requirePermission('provider-auth:write'), async (c) => {
  const parsed = decisionRoutingSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid routing' }, 400)
  const known = new Set(listDecisionProviders().map((provider) => provider.id))
  const ids = [...parsed.data.default, ...Object.values(parsed.data.purposes).flat()]
  const unknown = ids.find((id) => !known.has(id))
  if (unknown) return c.json({ error: `No such decision provider: ${unknown}` }, 400)
  return c.json(await setDecisionRouting(parsed.data, auditActor(c.get('identity') as Identity)))
})

const featureSwitchInput = z.object({ value: z.enum(DECISION_FEATURE_SWITCH_VALUES) })

/** Turn an instance feature (such as the tool result firewall) on or off, or back to automatic. */
app.put('/features/:id', requirePermission('provider-auth:write'), async (c) => {
  const id = c.req.param('id') as (typeof DECISION_PURPOSES)[number]
  if (!DECISION_PURPOSES.includes(id) || DECISION_PURPOSE_INFO[id].scope !== 'instance')
    return c.json({ error: 'Only instance features have a switch here' }, 400)
  const parsed = featureSwitchInput.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Use auto, on or off' }, 400)
  await setDecisionFeatureSwitch(id, parsed.data.value, auditActor(c.get('identity') as Identity))
  return c.json(decisionFeatures())
})

const tryInput = decisionRequestSchema.extend({
  /** Ask this provider directly, or else the purpose's providers in order (the default order without one). */
  providerId: z.string().optional(),
  purpose: z.enum(DECISION_PURPOSES).optional(),
})

/** Settings' "Try a decision": ask with real providers and show what came back. */
app.post('/try', requirePermission('provider-auth:write'), async (c) => {
  const parsed = tryInput.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid question' }, 400)
  const { providerId, purpose, ...request } = parsed.data
  if (providerId) {
    const provider = getDecisionProvider(providerId)
    if (!provider) return c.json({ error: 'No such decision provider' }, 404)
    try {
      return c.json({
        ok: true,
        result: await askProvider(provider, request, { signal: AbortSignal.timeout(getDecisionRouting().timeoutMs) }),
      })
    } catch (error) {
      return c.json({
        ok: false,
        reason: 'unavailable',
        errors: [{ providerId, error: String(error instanceof Error ? error.message : error) }],
      })
    }
  }
  return c.json(await decide(purpose ?? 'default', request, { source: { kind: 'settings-try' } }))
})

export default app
