/**
 * One-shot "light" completions: a single prompt to the cheapest usable model of a model tier, for
 * small utility calls outside any agent session (reply suggestions, labels, short summaries).
 *
 * The contract is deliberately narrow so callers can fire it from hot paths without care:
 * - bounded: a per-candidate timeout, an overall deadline, and a small output cap;
 * - falls back through the tier's chain, skipping candidates agent model selection would skip
 *   (disabled, unauthenticated or unhealthy providers);
 * - never throws: every failure, timeout or empty answer resolves to `null`.
 *
 * This file is pure (no database or provider imports); `light-completion-runtime.ts` wires the
 * real tier table, provider auth and model runtime.
 */

/** Per-candidate wait before moving on to the next model. */
export const LIGHT_COMPLETION_TIMEOUT_MS = 8_000
/** Overall budget across every candidate. */
export const LIGHT_COMPLETION_TOTAL_TIMEOUT_MS = 15_000
export const LIGHT_COMPLETION_MAX_TOKENS = 256
/** Hard ceiling on what a caller may ask for: these calls are meant to be tiny. */
export const LIGHT_COMPLETION_MAX_TOKENS_CEILING = 1_024

export interface LightCompletionRequest {
  /** Model tier slug whose chain is tried in order, e.g. `lite`. */
  tier: string
  /** Instructions for the model. */
  system: string
  /** The single user turn. */
  prompt: string
  /** Output cap; defaults to {@link LIGHT_COMPLETION_MAX_TOKENS}, never above the ceiling. */
  maxTokens?: number
  timeoutMs?: number
  totalTimeoutMs?: number
  /** Caller cancellation; an aborted signal stops before or between candidates. */
  signal?: AbortSignal
  /** What the completion is for, in the inference cost ledger (`lite:<purpose>`), e.g. `reply-suggestions`. */
  purpose?: string
  /** Who it is for, in the ledger: `{ agentId, squadId, userId, ... }`. */
  source?: Record<string, unknown>
}

export interface LightCompletionResult {
  text: string
  /** The model spec that answered. */
  model: string
}

export interface LightCompletionCall {
  system: string
  prompt: string
  maxTokens: number
  timeoutMs: number
  signal: AbortSignal
  /** The tier and the request's purpose and source, for cost accounting. */
  tier?: string
  purpose?: string
  source?: Record<string, unknown>
}

export interface LightCompletionDeps {
  /** The tier's chain, or null when the tier is missing or disabled. */
  tierChain: (slug: string) => Promise<string | null>
  /** The chain's usable candidates, in priority order. */
  usableCandidates: (chain: string) => string[]
  /**
   * Ask one candidate. Resolves the answer text, or null when the candidate cannot serve the
   * call (e.g. no usable credential); may throw on a provider failure.
   */
  complete: (spec: string, call: LightCompletionCall) => Promise<string | null>
  /** Start a timer; returns a cancel function. Injected so tests can fire deadlines. */
  setTimer?: (fire: () => void, ms: number) => () => void
  /** Milliseconds clock for the overall deadline. */
  now?: () => number
  /** Failure reporting; defaults to silence. */
  onCandidateError?: (spec: string, error: unknown) => void
}

const defaultSetTimer = (fire: () => void, ms: number) => {
  const handle = setTimeout(fire, ms)
  return () => clearTimeout(handle)
}

class LightCompletionTimeout extends Error {
  constructor(ms: number) {
    super(`Light completion timed out after ${ms}ms`)
    this.name = 'LightCompletionTimeout'
  }
}

/** Run one light completion through a tier's chain. Never throws; resolves null on any failure. */
export async function completeLight(
  request: LightCompletionRequest,
  deps: LightCompletionDeps
): Promise<LightCompletionResult | null> {
  try {
    if (request.signal?.aborted) return null
    const chain = await deps.tierChain(request.tier)
    if (!chain?.trim()) return null
    const candidates = deps.usableCandidates(chain)
    if (candidates.length === 0) return null

    const now = deps.now ?? Date.now
    const setTimer = deps.setTimer ?? defaultSetTimer
    const timeoutMs = positive(request.timeoutMs, LIGHT_COMPLETION_TIMEOUT_MS)
    const totalTimeoutMs = positive(request.totalTimeoutMs, LIGHT_COMPLETION_TOTAL_TIMEOUT_MS)
    const maxTokens = Math.min(
      positive(request.maxTokens, LIGHT_COMPLETION_MAX_TOKENS),
      LIGHT_COMPLETION_MAX_TOKENS_CEILING
    )
    const deadline = now() + totalTimeoutMs

    for (const spec of candidates) {
      if (request.signal?.aborted) return null
      const remaining = deadline - now()
      if (remaining <= 0) return null
      const budget = Math.min(timeoutMs, remaining)
      try {
        const text = await attempt(spec, request, maxTokens, budget, deps, setTimer)
        if (text) return { text, model: spec }
      } catch (error) {
        deps.onCandidateError?.(spec, error)
      }
    }
    return null
  } catch (error) {
    deps.onCandidateError?.('(setup)', error)
    return null
  }
}

/** One candidate, raced against its timeout and the caller's signal; the provider call is aborted on either. */
async function attempt(
  spec: string,
  request: LightCompletionRequest,
  maxTokens: number,
  budget: number,
  deps: LightCompletionDeps,
  setTimer: NonNullable<LightCompletionDeps['setTimer']>
): Promise<string | null> {
  const controller = new AbortController()
  let cancelTimer = () => {}
  let detachCaller = () => {}
  const stopped = new Promise<never>((_, reject) => {
    cancelTimer = setTimer(() => {
      controller.abort()
      reject(new LightCompletionTimeout(budget))
    }, budget)
    const caller = request.signal
    if (caller) {
      const onAbort = () => {
        controller.abort()
        reject(new Error('Light completion aborted'))
      }
      caller.addEventListener('abort', onAbort, { once: true })
      detachCaller = () => caller.removeEventListener('abort', onAbort)
    }
  })
  // A provider that ignores the abort may still settle later; nothing awaits it then.
  stopped.catch(() => {})
  try {
    const call = deps.complete(spec, {
      system: request.system,
      prompt: request.prompt,
      maxTokens,
      timeoutMs: budget,
      signal: controller.signal,
      tier: request.tier,
      ...(request.purpose ? { purpose: request.purpose } : {}),
      ...(request.source ? { source: request.source } : {}),
    })
    call.catch(() => {})
    const text = await Promise.race([call, stopped])
    return typeof text === 'string' && text.trim() ? text.trim() : null
  } finally {
    cancelTimer()
    detachCaller()
  }
}

function positive(value: number | undefined, fallback: number): number {
  return value != null && Number.isFinite(value) && value > 0 ? value : fallback
}
