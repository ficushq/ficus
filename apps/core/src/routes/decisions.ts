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
import { EvalCaptureUnavailableError, evalCaptureState, setEvalCapture } from '../services/decisions/evals/capture'
import {
  askProvider,
  decide,
  decisionFeatures,
  decisionSpend,
  recordProviderAnswer,
  DECISION_PROBE,
  type DecisionOutcome,
} from '../services/decisions/service'
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

const providerPatch = providerInput.omit({ kind: true }).extend({
  enabled: z.boolean().optional(),
  /** Dollars per million input tokens; null goes back to the list price. */
  pricePerMillionInput: z.number().min(0).max(1000).nullable().optional(),
})

app.get('/', requirePermission('provider-auth:read'), async (c) =>
  c.json({
    providers: listDecisionProviders().map(decisionProviderView),
    routing: getDecisionRouting(),
    kinds: DECISION_PROVIDER_KIND_INFO,
    purposes: DECISION_PURPOSES.map((id) => ({ id, ...DECISION_PURPOSE_INFO[id] })),
    features: decisionFeatures(),
    openAIServicesKey: Boolean(getOpenAIServiceKey()),
    evalCapture: await evalCaptureState(),
  })
)

/**
 * Save users' corrections of decisions as candidate eval cases (`bun run decisions:eval --inbox`).
 * Off by default; refused on hosted instances, whose users' text is never kept for evals.
 */
app.put('/eval-capture', requirePermission('provider-auth:write'), async (c) => {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Send {enabled: true|false}' }, 400)
  try {
    await setEvalCapture(parsed.data.enabled, auditActor(c.get('identity') as Identity))
  } catch (error) {
    if (error instanceof EvalCaptureUnavailableError) return c.json({ error: error.message }, 403)
    throw error
  }
  return c.json(await evalCaptureState())
})

/** Check a provider answers a test question, then save it. */
app.post('/providers', requirePermission('provider-auth:write'), async (c) => {
  const parsed = providerInput.safeParse(await c.req.json())
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
  const parsed = providerPatch.safeParse(await c.req.json())
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
  const parsed = decisionRoutingSchema.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid routing' }, 400)
  const known = new Set(listDecisionProviders().map((provider) => provider.id))
  const ids = [...parsed.data.default, ...Object.values(parsed.data.purposes).flat()]
  const unknown = ids.find((id) => !known.has(id))
  if (unknown) return c.json({ error: `No such decision provider: ${unknown}` }, 400)
  return c.json(await setDecisionRouting(parsed.data, auditActor(c.get('identity') as Identity)))
})

/** What decision models cost, by feature and provider, over the last 1, 7 or 30 days. */
app.get('/spend', requirePermission('provider-auth:read'), async (c) => {
  const days = Number(c.req.query('days') ?? 30)
  if (![1, 7, 30].includes(days)) return c.json({ error: 'days must be 1, 7 or 30' }, 400)
  return c.json(await decisionSpend(days))
})

const featureSwitchInput = z.object({ value: z.enum(DECISION_FEATURE_SWITCH_VALUES) })

/** Turn an instance feature (such as the tool result firewall) on or off, or back to automatic. */
app.put('/features/:id', requirePermission('provider-auth:write'), async (c) => {
  const id = c.req.param('id') as (typeof DECISION_PURPOSES)[number]
  if (!DECISION_PURPOSES.includes(id) || DECISION_PURPOSE_INFO[id].scope !== 'instance')
    return c.json({ error: 'Only instance features have a switch here' }, 400)
  const parsed = featureSwitchInput.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: 'Use auto, on or off' }, 400)
  await setDecisionFeatureSwitch(id, parsed.data.value, auditActor(c.get('identity') as Identity))
  return c.json(decisionFeatures())
})

const tryInput = decisionRequestSchema.extend({
  /** Ask this provider directly, or else the purpose's providers in order (the default order without one). */
  providerId: z.string().optional(),
  purpose: z.enum(DECISION_PURPOSES).optional(),
  /** Who is asking, for the decision log: Settings' try (default) or a decision eval run. */
  source: z.enum(['settings-try', 'eval']).optional(),
})

/** Settings' "Try a decision": ask with real providers and show what came back. */
app.post('/try', requirePermission('provider-auth:write'), async (c) => {
  const parsed = tryInput.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid question' }, 400)
  const { providerId, purpose, source = 'settings-try', ...request } = parsed.data
  if (providerId) {
    const provider = getDecisionProvider(providerId)
    if (!provider) return c.json({ error: 'No such decision provider' }, 404)
    const started = Date.now()
    let outcome: DecisionOutcome
    try {
      const result = await askProvider(provider, request, {
        signal: AbortSignal.timeout(source === 'eval' ? 30_000 : getDecisionRouting().timeoutMs),
      })
      outcome = { ok: true, result }
    } catch (error) {
      outcome = {
        ok: false,
        reason: 'unavailable',
        errors: [{ providerId, error: String(error instanceof Error ? error.message : error) }],
      }
    }
    recordProviderAnswer(purpose ?? 'default', provider, request, outcome, Date.now() - started, { kind: source })
    return c.json(outcome)
  }
  return c.json(await decide(purpose ?? 'default', request, { source: { kind: source } }))
})

export default app
