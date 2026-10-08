import { createHash } from 'node:crypto'
import { and, gte, isNotNull, lt, sql } from 'drizzle-orm'
import {
  decisionPricePerMillion,
  DECISION_PURPOSE_INFO,
  DECISION_PURPOSES,
  decisionRequestSchema,
  type DecisionFeatureView,
  type DecisionSpend,
  type DecisionPurpose,
  type DecisionRequest,
  type DecisionResult,
} from '@ficus/shared'
import { db, decisionLog } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import { getOpenAIServiceKey } from '../integrations/openai-services/settings'
import { callDecisionProvider, DecisionProviderError, type DecisionFetch } from './adapters'
import {
  getDecisionFeatureSwitches,
  getDecisionRouting,
  listDecisionProviders,
  type StoredDecisionProvider,
} from './store'

const log = createLogger('decisions')

/** How long a provider that just failed is skipped while others can answer. */
const COOLDOWN_MS = 30_000
const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export type DecisionOutcome =
  | { ok: true; result: DecisionResult }
  /** `unconfigured`: no enabled provider for this purpose. `unavailable`: none answered in time. */
  | { ok: false; reason: 'unconfigured' | 'unavailable'; errors: Array<{ providerId: string; error: string }> }

export interface DecideOptions {
  /** Where the question came from, for the decision log (e.g. `{ kind: 'github', squadId }`). */
  source?: Record<string, string>
  /** Overrides the routing's timeout (still capped by it). */
  timeoutMs?: number
  signal?: AbortSignal
  fetcher?: DecisionFetch
  /** Tests: skip writing the decision log. */
  skipLog?: boolean
  /** Tests: see what an answer was counted as costing. */
  onCost?: (cost: DecisionCost) => void
}

export interface DecisionCost {
  inputTokens: number
  /** Billionths of a dollar; null when the provider's price is unknown. */
  nanodollars: number | null
  /** The provider didn't report its token count, so it was estimated from the input size. */
  estimated: boolean
}

/** What one answer cost: the provider's reported input tokens (or about 4 characters a token) at its price. */
export function decisionCost(
  provider: Pick<StoredDecisionProvider, 'kind' | 'model' | 'pricePerMillionInput'>,
  request: DecisionRequest,
  result: DecisionResult
): DecisionCost {
  const reported = result.usage?.inputTokens
  const inputTokens =
    typeof reported === 'number' && Number.isFinite(reported) && reported >= 0
      ? Math.round(reported)
      : Math.ceil(JSON.stringify(request).length / 4)
  const price = decisionPricePerMillion(provider)
  // $/million tokens × tokens = micro-dollars; × 1000 = nanodollars.
  return {
    inputTokens,
    nanodollars: price === null ? null : Math.round(inputTokens * price * 1000),
    estimated: reported === undefined,
  }
}

const cooldownUntil = new Map<string, number>()

/**
 * The enabled providers a purpose asks, in order; `'default'` is the default order itself. A
 * sub-feature without an order of its own asks its parent's, then the default.
 */
export function decisionChain(purpose: DecisionPurpose | 'default'): StoredDecisionProvider[] {
  const routing = getDecisionRouting()
  const providers = listDecisionProviders().filter((provider) => provider.enabled)
  const parent = purpose === 'default' ? undefined : DECISION_PURPOSE_INFO[purpose].parent
  const own = purpose === 'default' ? undefined : routing.purposes[purpose]
  const inherited = parent ? routing.purposes[parent] : undefined
  const order = own?.length ? own : inherited?.length ? inherited : routing.default
  const chain = order.flatMap((id) => providers.filter((provider) => provider.id === id))
  // Nothing ordered yet: every enabled provider, as added.
  return chain.length || order.length ? chain : providers
}

/**
 * Whether an instance feature (see DECISION_PURPOSE_INFO) should run: `off` never, `on` always (it
 * still needs a provider to answer), and by default exactly when a provider is set up for it. A
 * sub-feature runs only while its parent does, and then by its own switch.
 */
export function isDecisionFeatureEnabled(purpose: DecisionPurpose): boolean {
  const parent = DECISION_PURPOSE_INFO[purpose].parent
  if (parent && !isDecisionFeatureEnabled(parent)) return false
  const value = getDecisionFeatureSwitches()[purpose] ?? 'auto'
  if (value === 'off') return false
  if (value === 'on') return true
  return !DECISION_PURPOSE_INFO[purpose].offByDefault && decisionChain(purpose).length > 0
}

/** Every decision feature with its scope, switch and whether it runs, for Settings. */
export function decisionFeatures(): DecisionFeatureView[] {
  const switches = getDecisionFeatureSwitches()
  return DECISION_PURPOSES.map((id) => {
    const info = DECISION_PURPOSE_INFO[id]
    return {
      id,
      ...info,
      ...(info.scope === 'instance' ? { switch: switches[id] ?? 'auto' } : {}),
      enabled: info.scope === 'instance' ? isDecisionFeatureEnabled(id) : decisionChain(id).length > 0,
    }
  })
}

/**
 * Ask a purpose's decision providers, first to last, until one answers within the time budget.
 * Never throws for provider failures: callers decide what "no answer" means for them.
 */
export async function decide(
  purpose: DecisionPurpose | 'default',
  input: DecisionRequest,
  options: DecideOptions = {}
): Promise<DecisionOutcome> {
  const request = decisionRequestSchema.parse(input)
  const routing = getDecisionRouting()
  const budget = Math.min(options.timeoutMs ?? routing.timeoutMs, routing.timeoutMs)
  const started = Date.now()
  const chain = decisionChain(purpose)
  if (!chain.length) {
    const outcome: DecisionOutcome = { ok: false, reason: 'unconfigured', errors: [] }
    record(purpose, request, outcome, Date.now() - started, options)
    return outcome
  }

  // Providers cooling down after a failure go last, not away: a lone provider is still asked.
  const now = Date.now()
  const ordered = [
    ...chain.filter((provider) => (cooldownUntil.get(provider.id) ?? 0) <= now),
    ...chain.filter((provider) => (cooldownUntil.get(provider.id) ?? 0) > now),
  ]
  const errors: Array<{ providerId: string; error: string }> = []
  for (const provider of ordered) {
    const remaining = budget - (Date.now() - started)
    if (remaining <= 0 || options.signal?.aborted) break
    const attemptStarted = Date.now()
    try {
      const result = await askProvider(provider, request, {
        signal: AbortSignal.any([AbortSignal.timeout(remaining), ...(options.signal ? [options.signal] : [])]),
        fetcher: options.fetcher,
      })
      cooldownUntil.delete(provider.id)
      options.onCost?.(decisionCost(provider, request, result))
      const outcome: DecisionOutcome = {
        ok: true,
        result: { ...result, latencyMs: Date.now() - attemptStarted },
      }
      record(purpose, request, outcome, Date.now() - started, options, decisionCost(provider, request, result))
      return outcome
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      errors.push({ providerId: provider.id, error: detail })
      cooldownUntil.set(provider.id, Date.now() + COOLDOWN_MS)
      log.warn('Decision provider did not answer', { purpose, providerId: provider.id, error: detail })
    }
  }
  const outcome: DecisionOutcome = { ok: false, reason: 'unavailable', errors }
  record(purpose, request, outcome, Date.now() - started, options)
  return outcome
}

/** Ask one provider directly (Settings' test and the save-time check). Throws its failure. */
export async function askProvider(
  provider: Pick<StoredDecisionProvider, 'id' | 'kind' | 'model' | 'apiKey' | 'baseUrl' | 'accountId'>,
  request: DecisionRequest,
  options: { signal?: AbortSignal; fetcher?: DecisionFetch } = {}
): Promise<DecisionResult> {
  const apiKey = provider.kind === 'openai' ? getOpenAIServiceKey() : provider.apiKey
  if (provider.kind === 'openai' && !apiKey)
    throw new DecisionProviderError('Add an OpenAI API services key in Integrations first', false)
  if ((provider.kind === 'jev' || provider.kind === 'cloudflare') && !apiKey)
    throw new DecisionProviderError('Needs an API key', false)
  if (provider.kind === 'cloudflare' && !provider.accountId)
    throw new DecisionProviderError('Needs a Cloudflare account ID', false)
  if (provider.kind === 'systemone' && !provider.baseUrl) throw new DecisionProviderError('Needs a URL', false)
  const started = Date.now()
  const wire = await callDecisionProvider(
    { kind: provider.kind, model: provider.model, apiKey, baseUrl: provider.baseUrl, accountId: provider.accountId },
    request,
    options
  )
  return {
    answers: wire.answers,
    providerId: provider.id,
    model: wire.model ?? provider.model,
    latencyMs: Date.now() - started,
    ...(wire.usage ? { usage: wire.usage } : {}),
  }
}

/** One cheap question, to check a provider answers before it's saved. */
export const DECISION_PROBE: DecisionRequest = {
  state: 'The sky is blue.',
  questions: { probe: { type: 'yesno', instructions: 'The text describes the color of the sky.' } },
}

let lastPrune = 0

function record(
  purpose: DecisionPurpose | 'default',
  request: DecisionRequest,
  outcome: DecisionOutcome,
  latencyMs: number,
  options: DecideOptions,
  cost?: DecisionCost
) {
  if (options.skipLog) return
  const inputSha256 = createHash('sha256').update(JSON.stringify(request)).digest('hex')
  void (async () => {
    await db.insert(decisionLog).values({
      purpose,
      outcome: outcome.ok ? 'answered' : outcome.reason,
      providerId: outcome.ok ? outcome.result.providerId : null,
      model: outcome.ok ? outcome.result.model : null,
      latencyMs,
      inputTokens: cost?.inputTokens ?? null,
      costNanodollars: cost?.nanodollars ?? null,
      costEstimated: cost ? cost.estimated || cost.nanodollars === null : false,
      inputSha256,
      answers: outcome.ok ? outcome.result.answers : null,
      errors: outcome.ok ? null : outcome.errors,
      source: options.source ?? null,
    })
    if (Date.now() - lastPrune > 60 * 60 * 1000) {
      lastPrune = Date.now()
      await db.delete(decisionLog).where(lt(decisionLog.createdAt, new Date(Date.now() - LOG_RETENTION_MS)))
    }
  })().catch((error) => log.warn('Could not record a decision', error))
}

/** What decision models cost over the last `days` days (the log keeps 30), by feature and by provider. */
export async function decisionSpend(days: number): Promise<DecisionSpend> {
  const since = new Date(Date.now() - Math.min(Math.max(days, 1), 30) * 24 * 60 * 60 * 1000)
  const totals = {
    calls: sql<number>`count(*)::int`,
    inputTokens: sql<string>`coalesce(sum(${decisionLog.inputTokens}), 0)::bigint`,
    nanodollars: sql<string>`coalesce(sum(${decisionLog.costNanodollars}), 0)::bigint`,
    approximate: sql<boolean>`coalesce(bool_or(${decisionLog.costEstimated}), false)`,
  }
  const [purposes, providers] = await Promise.all([
    db
      .select({
        purpose: decisionLog.purpose,
        answered: sql<number>`(count(*) filter (where ${decisionLog.outcome} = 'answered'))::int`,
        ...totals,
      })
      .from(decisionLog)
      .where(gte(decisionLog.createdAt, since))
      .groupBy(decisionLog.purpose),
    db
      .select({ providerId: decisionLog.providerId, ...totals })
      .from(decisionLog)
      .where(and(gte(decisionLog.createdAt, since), isNotNull(decisionLog.providerId)))
      .groupBy(decisionLog.providerId),
  ])
  const usd = (nanodollars: string) => Number(nanodollars) / 1e9
  const byPurpose = purposes
    .map((row) => ({
      purpose: row.purpose,
      calls: row.calls,
      answered: row.answered,
      inputTokens: Number(row.inputTokens),
      costUsd: usd(row.nanodollars),
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls)
  return {
    days,
    totalUsd: byPurpose.reduce((sum, row) => sum + row.costUsd, 0),
    approximate: purposes.some((row) => row.approximate),
    byPurpose,
    byProvider: providers
      .map((row) => ({
        providerId: row.providerId!,
        calls: row.calls,
        inputTokens: Number(row.inputTokens),
        costUsd: usd(row.nanodollars),
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
  }
}

export function resetDecisionCooldownsForTests() {
  cooldownUntil.clear()
}
