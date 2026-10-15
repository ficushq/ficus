import type { Usage } from '@earendil-works/pi-ai'
import { eq } from 'drizzle-orm'
import { db, modelTiers } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import { resolveAgentModelSpec } from '../../lib/utils/model-spec'
import { getModelRuntime } from '../agent/auth-backend'
import { readAccountStore } from '../agent/account-store'
import { isAccountUsable } from '../agent/account-usable'
import { recordInferenceUsage } from '../inference-usage'
import { accountForProvider } from '../inference-usage/billing'
import { attributionFromSource } from '../inference-usage/types'
import { CLAUDE_CODE_FLAG } from '../agent/claude-code/account'
import { usableModelCandidatesForCurrentEnv } from '../model-selection'
import {
  completeLight,
  type LightCompletionCall,
  type LightCompletionDeps,
  type LightCompletionRequest,
  type LightCompletionResult,
} from './light-completion'

const log = createLogger('light-completion')

/** The tier's chain from the synced `model_tiers` table; a disabled or missing tier has none. */
async function loadTierChain(slug: string): Promise<string | null> {
  const [tier] = await db
    .select({ chain: modelTiers.chain, disabled: modelTiers.disabled })
    .from(modelTiers)
    .where(eq(modelTiers.slug, slug))
  return tier && !tier.disabled ? tier.chain : null
}

/**
 * Ask one candidate through the process's shared model runtime, which resolves the stored provider
 * account (API key or OAuth) exactly as agent sessions do. No new credentials are involved.
 */
async function completeWithRuntime(spec: string, call: LightCompletionCall): Promise<string | null> {
  const runtime = await getModelRuntime()
  const { model, thinkingLevel } = resolveAgentModelSpec(spec, runtime)
  const auth = await runtime.getAuth(model)
  if (!auth) return null
  // A Claude Code account runs the user's own `claude` process per request: not a one-shot call.
  if (auth.env?.[CLAUDE_CODE_FLAG] === '1') return null
  const message = await runtime.completeSimple(
    model,
    { systemPrompt: call.system, messages: [{ role: 'user', content: call.prompt, timestamp: Date.now() }] },
    {
      maxTokens: call.maxTokens,
      // `off` means no thinking; the providers expect the option to be absent for that.
      reasoning: thinkingLevel && thinkingLevel !== 'off' ? thinkingLevel : undefined,
      signal: call.signal,
      timeoutMs: call.timeoutMs,
      maxRetries: 0,
    }
  )
  recordLightCompletionUsage(model.provider, model.id, message, call)
  if (message.stopReason === 'error' || message.stopReason === 'aborted')
    throw new Error(message.errorMessage || `Light completion ${message.stopReason}`)
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** One ledger row per candidate that reached a provider, answered or not (`lite:<purpose>`). */
export function recordLightCompletionUsage(
  provider: string,
  modelId: string,
  message: { usage?: Usage; stopReason?: string; model?: string },
  call: Pick<LightCompletionCall, 'tier' | 'purpose' | 'source'>
): void {
  if (!message.usage) return
  let accountId: string | undefined
  try {
    accountId = accountForProvider(provider, readAccountStore(), isAccountUsable)?.id
  } catch {
    accountId = undefined
  }
  const total = message.usage.cost?.total
  recordInferenceUsage({
    feature: `lite:${call.purpose ?? 'unknown'}`,
    provider,
    model: message.model ?? modelId,
    accountId,
    tokens: {
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
    },
    listCostUsd: typeof total === 'number' && total > 0 ? total : undefined,
    attribution: attributionFromSource(call.source),
    source: {
      tier: call.tier ?? 'lite',
      ...(call.purpose ? { purpose: call.purpose } : {}),
      stopReason: message.stopReason,
    },
  })
}

export const lightCompletionRuntimeDeps: LightCompletionDeps = {
  tierChain: loadTierChain,
  usableCandidates: usableModelCandidatesForCurrentEnv,
  complete: completeWithRuntime,
  onCandidateError: (spec, error) =>
    log.debug(`Light completion candidate ${spec} failed: ${error instanceof Error ? error.message : String(error)}`),
}

/**
 * One light completion on a model tier, with the instance's real providers. Resolves null when no
 * candidate answers in time; never throws. See `light-completion.ts` for the contract.
 */
export function completeWithTier(
  request: LightCompletionRequest,
  deps: LightCompletionDeps = lightCompletionRuntimeDeps
): Promise<LightCompletionResult | null> {
  return completeLight(request, deps)
}
