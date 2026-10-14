import { eq } from 'drizzle-orm'
import { db, modelTiers } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import { resolveAgentModelSpec } from '../../lib/utils/model-spec'
import { getModelRuntime } from '../agent/auth-backend'
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
  if (message.stopReason === 'error' || message.stopReason === 'aborted')
    throw new Error(message.errorMessage || `Light completion ${message.stopReason}`)
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
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
