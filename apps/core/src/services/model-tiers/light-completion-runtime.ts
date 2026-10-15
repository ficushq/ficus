import { eq } from 'drizzle-orm'
import { db, modelTiers } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import { resolveAgentModelSpec } from '../../lib/utils/model-spec'
import { getModelRuntime } from '../agent/auth-backend'
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
  if (message.stopReason === 'error' || message.stopReason === 'aborted')
    throw new Error(message.errorMessage || `Light completion ${message.stopReason}`)
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
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
