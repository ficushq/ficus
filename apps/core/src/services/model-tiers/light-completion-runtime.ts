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
import { completeOnceWithClaudeCode } from '../agent/claude-code/one-shot'
import { usableModelCandidatesForCurrentEnv } from '../model-selection'
import {
  completeLight,
  type LightCompletionCall,
  type LightCompletionDeps,
  type LightCompletionRequest,
  type LightCompletionResult,
} from './light-completion'

const log = createLogger('light-completion')

/**
 * Claude Code starts a `claude` process per call, which alone can take several seconds; its
 * candidate waits at least this long. The request's overall deadline still bounds it.
 */
export const CLAUDE_CODE_LIGHT_COMPLETION_TIMEOUT_MS = 10_000

/** Seams for tests; production uses the shared model runtime and the real `claude`. */
export interface LightCompletionRuntimeDeps {
  runtime?: () => ReturnType<typeof getModelRuntime>
  claudeCode?: typeof completeOnceWithClaudeCode
}

/** The tier's chain from the synced `model_tiers` table; a disabled or missing tier has none. */
async function loadTierChain(slug: string): Promise<string | null> {
  const [tier] = await db
    .select({ chain: modelTiers.chain, disabled: modelTiers.disabled })
    .from(modelTiers)
    .where(eq(modelTiers.slug, slug))
  return tier && !tier.disabled ? tier.chain : null
}

/**
 * The model and account auth a candidate would use, resolved through the process's shared model
 * runtime exactly as agent sessions resolve them (API key, OAuth or the Claude Code account). No
 * new credentials are involved.
 */
async function resolveCandidate(spec: string, deps: LightCompletionRuntimeDeps) {
  const runtime = await (deps.runtime ?? getModelRuntime)()
  const { model, thinkingLevel } = resolveAgentModelSpec(spec, runtime)
  const auth = await runtime.getAuth(model)
  return { runtime, model, thinkingLevel, auth, viaClaudeCode: auth?.env?.[CLAUDE_CODE_FLAG] === '1' }
}

/**
 * Ask one candidate. A Claude Code account answers through a one-shot `claude` call that ends with
 * the answer (never the agent session bridge); every other account through the provider's API.
 */
export async function completeWithRuntime(
  spec: string,
  call: LightCompletionCall,
  deps: LightCompletionRuntimeDeps = {}
): Promise<string | null> {
  const { runtime, model, thinkingLevel, auth, viaClaudeCode } = await resolveCandidate(spec, deps)
  if (!auth) return null
  // `off` means no thinking; the providers expect the option to be absent for that.
  const reasoning = thinkingLevel && thinkingLevel !== 'off' ? thinkingLevel : undefined
  if (viaClaudeCode)
    return (deps.claudeCode ?? completeOnceWithClaudeCode)({
      model: model.id,
      system: call.system,
      prompt: call.prompt,
      maxTokens: call.maxTokens,
      signal: call.signal,
      thinking: reasoning !== undefined,
      // Billed to the Claude plan; recorded under the account's provider so it counts as a subscription.
      onUsage: (tokens) =>
        recordLightCompletionUsage(
          model.provider,
          model.id,
          {
            usage: {
              ...tokens,
              totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
          },
          call
        ),
    })
  const message = await runtime.completeSimple(
    model,
    { systemPrompt: call.system, messages: [{ role: 'user', content: call.prompt, timestamp: Date.now() }] },
    {
      maxTokens: call.maxTokens,
      reasoning,
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

/** A Claude Code candidate waits long enough for its process to start; any other keeps the request's wait. */
export async function candidateTimeoutWithRuntime(
  spec: string,
  timeoutMs: number,
  deps: LightCompletionRuntimeDeps = {}
): Promise<number> {
  const { viaClaudeCode } = await resolveCandidate(spec, deps)
  return viaClaudeCode ? Math.max(timeoutMs, CLAUDE_CODE_LIGHT_COMPLETION_TIMEOUT_MS) : timeoutMs
}

export const lightCompletionRuntimeDeps: LightCompletionDeps = {
  tierChain: loadTierChain,
  usableCandidates: usableModelCandidatesForCurrentEnv,
  complete: (spec, call) => completeWithRuntime(spec, call),
  candidateTimeoutMs: (spec, timeoutMs) => candidateTimeoutWithRuntime(spec, timeoutMs),
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
