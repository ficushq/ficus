/**
 * One-shot "light" completions: a single prompt to the cheapest usable model of a model tier, for
 * small utility calls outside any agent session (reply suggestions, labels, short summaries).
 *
 * The contract is deliberately narrow so callers can fire it from hot paths without care:
 * - bounded: a per-candidate timeout, an overall deadline, and a small output cap;
 * - falls back through the tier's chain, skipping candidates agent model selection would skip
 *   (disabled, unauthenticated or unhealthy providers);
 * - never throws: every failure, timeout or empty answer resolves to `null`;
 * - accounted: each call that reached a provider is reported once to `deps.record` with the
 *   tokens and cost the providers reported (never the prompt or the answer). Reporting is
 *   synchronous and fire-and-forget; a failing reporter is ignored.
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
  /** What the call is for, e.g. `reply-suggestions`: its spend is shown under this name. */
  purpose: string
  /** Who the call was made for, e.g. `{ agentId, squadId }`, kept with its spend record. */
  source?: Record<string, string>
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
}

export interface LightCompletionResult {
  text: string
  /** The model spec that answered. */
  model: string
}

/** What one provider call consumed, as the provider reported it. */
export interface LightCompletionUsage {
  /** Input tokens, cache reads and writes included. */
  inputTokens: number
  outputTokens: number
  /** Dollars at the model's list price; null when the model's price is unknown. */
  costUsd: number | null
}

/** One candidate's answer and, when the provider reported it, what it used. */
export interface LightCandidateReply {
  text: string | null
  usage?: LightCompletionUsage | null
}

/** A provider failure that still reported usage (e.g. an error after tokens were billed). */
export class LightCompletionProviderError extends Error {
  constructor(
    message: string,
    readonly usage: LightCompletionUsage | null
  ) {
    super(message)
    this.name = 'LightCompletionProviderError'
  }
}

/** Why a candidate that was asked gave no answer. Fixed words only: provider text is never kept. */
export type LightAttemptFailure = 'empty' | 'error' | 'timeout' | 'aborted'

export interface LightCompletionAttempt {
  /** The model spec asked. */
  model: string
  /** Null when it answered. */
  failure: LightAttemptFailure | null
  /** Null when the provider reported none (or the call was cut off). */
  usage: LightCompletionUsage | null
}

/** One light completion's accounting: every candidate that reached a provider, in order. */
export interface LightCompletionReport {
  tier: string
  purpose: string
  source?: Record<string, string>
  /** The model that answered, or null when none did. */
  model: string | null
  attempts: LightCompletionAttempt[]
  latencyMs: number
}

export interface LightCompletionCall {
  system: string
  prompt: string
  maxTokens: number
  timeoutMs: number
  signal: AbortSignal
}

export interface LightCompletionDeps {
  /** The tier's chain, or null when the tier is missing or disabled. */
  tierChain: (slug: string) => Promise<string | null>
  /** The chain's usable candidates, in priority order. */
  usableCandidates: (chain: string) => string[]
  /**
   * Ask one candidate. Resolves the answer (a bare string is an answer without usage), or null
   * when the candidate cannot serve the call without asking a provider (e.g. no usable
   * credential); may throw on a provider failure, with a {@link LightCompletionProviderError} to
   * pass on usage the provider still reported.
   */
  complete: (spec: string, call: LightCompletionCall) => Promise<LightCandidateReply | string | null>
  /**
   * Account for a call that reached at least one provider. Called once, before the result is
   * returned; it must not block (write in the background). Its errors are ignored.
   */
  record?: (report: LightCompletionReport, request: LightCompletionRequest) => void
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

class LightCompletionAborted extends Error {
  constructor() {
    super('Light completion aborted')
    this.name = 'LightCompletionAborted'
  }
}

/** Run one light completion through a tier's chain. Never throws; resolves null on any failure. */
export async function completeLight(
  request: LightCompletionRequest,
  deps: LightCompletionDeps
): Promise<LightCompletionResult | null> {
  const attempts: LightCompletionAttempt[] = []
  let answer: LightCompletionResult | null = null
  let started: number | null = null
  try {
    const now = deps.now ?? Date.now
    started = now()
    answer = await runCandidates(request, deps, now, attempts)
  } catch (error) {
    deps.onCandidateError?.('(setup)', error)
  }
  if (attempts.length > 0) report(request, deps, answer, attempts, started)
  return answer
}

/** Ask the tier's usable candidates in order; every candidate that reached a provider is pushed to `attempts`. */
async function runCandidates(
  request: LightCompletionRequest,
  deps: LightCompletionDeps,
  now: () => number,
  attempts: LightCompletionAttempt[]
): Promise<LightCompletionResult | null> {
  if (request.signal?.aborted) return null
  const chain = await deps.tierChain(request.tier)
  if (!chain?.trim()) return null
  const candidates = deps.usableCandidates(chain)
  if (candidates.length === 0) return null

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
    const outcome = await attempt(spec, request, maxTokens, budget, deps, setTimer)
    if (outcome.attempt) attempts.push(outcome.attempt)
    if (outcome.error !== undefined) deps.onCandidateError?.(spec, outcome.error)
    if (outcome.text) return { text: outcome.text, model: spec }
  }
  return null
}

/** Hand the call's accounting to `deps.record`; a reporter that throws changes nothing. */
function report(
  request: LightCompletionRequest,
  deps: LightCompletionDeps,
  answer: LightCompletionResult | null,
  attempts: LightCompletionAttempt[],
  started: number | null
) {
  if (!deps.record) return
  try {
    const latencyMs = started === null ? 0 : Math.max(0, (deps.now ?? Date.now)() - started)
    deps.record(
      {
        tier: request.tier,
        purpose: request.purpose,
        ...(request.source ? { source: request.source } : {}),
        model: answer?.model ?? null,
        attempts,
        latencyMs,
      },
      request
    )
  } catch (error) {
    deps.onCandidateError?.('(record)', error)
  }
}

interface AttemptOutcome {
  text: string | null
  /** Null when the candidate could not serve the call without asking a provider. */
  attempt: LightCompletionAttempt | null
  error?: unknown
}

/** One candidate, raced against its timeout and the caller's signal; the provider call is aborted on either. Never throws. */
async function attempt(
  spec: string,
  request: LightCompletionRequest,
  maxTokens: number,
  budget: number,
  deps: LightCompletionDeps,
  setTimer: NonNullable<LightCompletionDeps['setTimer']>
): Promise<AttemptOutcome> {
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
        reject(new LightCompletionAborted())
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
    })
    call.catch(() => {})
    const reply = await Promise.race([call, stopped])
    if (reply == null) return { text: null, attempt: null }
    const { text, usage } = typeof reply === 'string' ? { text: reply, usage: null } : reply
    const answer = typeof text === 'string' && text.trim() ? text.trim() : null
    return { text: answer, attempt: { model: spec, failure: answer ? null : 'empty', usage: usage ?? null } }
  } catch (error) {
    const failure: LightAttemptFailure =
      error instanceof LightCompletionTimeout
        ? 'timeout'
        : error instanceof LightCompletionAborted
          ? 'aborted'
          : 'error'
    const usage = error instanceof LightCompletionProviderError ? error.usage : null
    return { text: null, attempt: { model: spec, failure, usage }, error }
  } finally {
    cancelTimer()
    detachCaller()
  }
}

/** The parts of a model runtime reply that accounting reads (pi-ai's `AssistantMessage.usage`). */
export interface ProviderUsageReport {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  cost?: { total?: number }
}

/**
 * A provider reply's usage, or null when the provider reported no tokens. The cost is the model's
 * list price for those tokens, and null when the model has no price (it would read as free).
 */
export function lightCompletionUsage(
  usage: ProviderUsageReport | null | undefined,
  price: { input?: number; output?: number } | null | undefined
): LightCompletionUsage | null {
  if (!usage) return null
  const count = (value: number | undefined) => (Number.isFinite(value) && value! > 0 ? Math.round(value!) : 0)
  const inputTokens = count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite)
  const outputTokens = count(usage.output)
  if (inputTokens + outputTokens === 0) return null
  const priced = !!price && ((price.input ?? 0) > 0 || (price.output ?? 0) > 0)
  const total = usage.cost?.total
  return {
    inputTokens,
    outputTokens,
    costUsd: priced && typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null,
  }
}

/** A light completion's totals across its attempts, as its spend record keeps them. */
export interface LightCompletionTotals {
  /** Null when no attempt reported usage. */
  inputTokens: number | null
  outputTokens: number | null
  /** Billionths of a dollar; null when no attempt's cost is known. */
  costNanodollars: number | null
  /** Some attempt's usage or price is unknown, so the cost is a lower bound. */
  costEstimated: boolean
}

export function lightCompletionTotals(attempts: readonly LightCompletionAttempt[]): LightCompletionTotals {
  const reported = attempts.flatMap((entry) => (entry.usage ? [entry.usage] : []))
  const priced = reported.flatMap((usage) => (usage.costUsd === null ? [] : [usage.costUsd]))
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
  return {
    inputTokens: reported.length ? sum(reported.map((usage) => usage.inputTokens)) : null,
    outputTokens: reported.length ? sum(reported.map((usage) => usage.outputTokens)) : null,
    costNanodollars: priced.length ? Math.round(sum(priced) * 1e9) : null,
    costEstimated: priced.length < attempts.length,
  }
}

function positive(value: number | undefined, fallback: number): number {
  return value != null && Number.isFinite(value) && value > 0 ? value : fallback
}
