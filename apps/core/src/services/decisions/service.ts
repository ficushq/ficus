import { createHash } from 'node:crypto'
import { lt } from 'drizzle-orm'
import { decisionRequestSchema, type DecisionPurpose, type DecisionRequest, type DecisionResult } from '@ficus/shared'
import { db, decisionLog } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import { getOpenAIServiceKey } from '../integrations/openai-services/settings'
import { callDecisionProvider, DecisionProviderError, type DecisionFetch } from './adapters'
import { getDecisionRouting, listDecisionProviders, type StoredDecisionProvider } from './store'

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
}

const cooldownUntil = new Map<string, number>()

/** The enabled providers a purpose asks, in order; `'default'` is the default order itself. */
export function decisionChain(purpose: DecisionPurpose | 'default'): StoredDecisionProvider[] {
  const routing = getDecisionRouting()
  const providers = listDecisionProviders().filter((provider) => provider.enabled)
  const own = purpose === 'default' ? undefined : routing.purposes[purpose]
  const order = own?.length ? own : routing.default
  const chain = order.flatMap((id) => providers.filter((provider) => provider.id === id))
  // Nothing ordered yet: every enabled provider, as added.
  return chain.length || order.length ? chain : providers
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
      const outcome: DecisionOutcome = {
        ok: true,
        result: { ...result, latencyMs: Date.now() - attemptStarted },
      }
      record(purpose, request, outcome, Date.now() - started, options)
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
  options: DecideOptions
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

export function resetDecisionCooldownsForTests() {
  cooldownUntil.clear()
}
