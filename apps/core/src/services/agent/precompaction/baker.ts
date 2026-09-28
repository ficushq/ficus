import {
  compact,
  prepareCompaction,
  type AgentSession as PiAgentSession,
  type CompactionResult,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent'
import {
  classifyCaughtProviderError,
  isInternalExecutionError,
  providerErrorText,
  type CaughtProviderErrorClassification,
} from '../../../lib/error'
import { createLogger } from '../../../lib/infra/logger'
import { parseModelSpec, resolveAgentModelSpec, splitModelPriorityList } from '../../../lib/utils/model-spec'
import type { PrecompactionBakeOutput } from './controller'
import { getDisabledProviders } from '../../model-selection/disabled-providers'
import { providerHealth } from '../../provider-health/registry'
import { providerRouteDecision } from '../../provider-health/routing'
import { readAccountStore } from '../account-store'
import { clampPreparationForBudget, estimateSummarizeTokens, summarizeInputBudget } from './context-fit'

const log = createLogger('precompaction-baker')

/**
 * Resolve request auth for a compaction summarize call via the session's
 * ModelRuntime, flattening `ProviderHeaders` (whose values may be `null`)
 * into the `Record<string, string>` shape `compact()` accepts. Resolves
 * `null` when the provider has no usable auth.
 */
async function resolveCompactAuth(
  session: PiAgentSession,
  model: NonNullable<PiAgentSession['model']>
): Promise<{
  apiKey: string | undefined
  headers: Record<string, string> | undefined
  env?: Record<string, string>
} | null> {
  const auth = await session.modelRuntime.getAuth(model)
  if (!auth) return null
  const headers = auth.auth.headers
    ? (Object.fromEntries(Object.entries(auth.auth.headers).filter(([, v]) => v != null)) as Record<string, string>)
    : undefined
  return { apiKey: auth.auth.apiKey, headers, env: auth.env }
}

export interface PiCompactionProviderSwitch {
  /** Concrete account projected for this request, when stored auth is active. */
  accountId?: string
  /** Commit wrapper/account state after the live pi model switch succeeds. */
  commit?: () => void | Promise<void>
  /** Restore any auth projection made before auth/model switch if the candidate is abandoned. */
  rollback?: () => void | Promise<void>
}

export interface PiCompactionModelFailoverOptions {
  /** Original priority list (e.g. `openai-codex:gpt-5.6-luna,zai:glm-5-turbo`). */
  priorityList: string
  /** Test hook / advanced override. Defaults to non-disabled, non-exhausted candidates in priority order. */
  selectNextSpec?: (exhaustedProvider: string) => string | undefined
  /** Prepare credentials/account projection before auth is resolved for the next provider. */
  prepareProviderSwitch?: (
    nextProvider: string,
    nextSpec: string
  ) => false | void | PiCompactionProviderSwitch | Promise<false | void | PiCompactionProviderSwitch>
  /** Concrete account used by the current compaction request, when stored auth is active. */
  getActiveAccountId?: () => string | undefined
  /** Test seam; the site-local Ficus guard always runs before classification. */
  classifyError?: (error: unknown) => CaughtProviderErrorClassification | null
  /** Called after the live pi session has switched models and provider/account state is committed. */
  onModelSwitched?: (nextProvider: string, nextSpec: string) => void | Promise<void>
}

export interface PiCompactionBakerOptions {
  modelFailover?: PiCompactionModelFailoverOptions
}

/**
 * Build the `bake` dependency for {@link PrecompactionController}: run pi's pure
 * compaction functions (`prepareCompaction` + `compact`) against a branch
 * snapshot, using the session's own model, thinking level, auth, and stream
 * function.
 *
 * This mirrors pi's own compaction-auth path
 * (`AgentSession._getCompactionRequestAuth`) for the standard provider case:
 * auth is resolved via `modelRuntime.getAuth`. The function never throws — it
 * resolves to `null` on any failure (missing model, nothing to compact, auth
 * failure, abort, or compact error) so the controller silently degrades to
 * pi's synchronous fallback.
 *
 * Failover side effect: when `compact` throws an error that classifies as
 * provider exhaustion (e.g. a codex `usage_limit_reached` hard plan limit),
 * the active provider is marked exhausted in the {@link providerHealth} registry
 * — with the classifier's reason and parsed reset time — then (when the baker is
 * configured with a priority list) compaction is retried once on the next
 * healthy provider. A successful retry returns that compaction result directly,
 * so pi does not perform its synchronous fallback with the old exhausted model.
 * If no retry is possible, the bake still resolves to `null`; compaction failure
 * stays non-fatal, but the exhaustion no longer disappears silently.
 */
export function createPiCompactionBaker(
  session: PiAgentSession,
  options: PiCompactionBakerOptions = {}
): (entries: SessionEntry[], signal: AbortSignal) => Promise<PrecompactionBakeOutput | null> {
  return async (entries, signal) => {
    const model = session.model
    if (!model) return null

    const settings = session.settingsManager.getCompactionSettings()
    const preparation = prepareCompaction(entries, settings)
    if (!preparation) return null

    // Fit the summarize request to the session model's window (#625): after a
    // large→small model switch the raw preparation can exceed the summarizer's
    // own context window, which used to fail the bake (and pi's sync fallback)
    // with the very overflow compaction was meant to fix.
    const budget = summarizeInputBudget(model, settings)
    const fitPreparation = clampPreparationForBudget(preparation, budget)
    const residual = estimateSummarizeTokens(fitPreparation)
    if (residual > budget) {
      log.warn(
        `Clamped summarize request still ~${residual} tokens, over ${model.provider}:${model.id} budget (${budget}); proceeding anyway.`
      )
    }

    const auth = await resolveCompactAuth(session, model)
    if (!auth) return null
    if (signal.aborted) return null

    try {
      return await compact(
        fitPreparation,
        model,
        auth.apiKey,
        auth.headers,
        undefined, // customInstructions — use pi defaults
        signal,
        session.thinkingLevel,
        session.agent.streamFunction,
        auth.env
      )
    } catch (err) {
      // Compaction failure must stay non-fatal, but if the failure is provider
      // exhaustion (e.g. a codex usage_limit_reached hard plan limit), mark the
      // provider exhausted and retry compaction once on the next healthy
      // priority-list provider. A successful retry returns a baked result, so
      // pi does not fall back to synchronous compaction with the stale/exhausted
      // model captured before the hook. Mirrors the main-run failover path
      // (model-failover.ts). Best-effort: never re-throw out of here.
      try {
        const errorText = providerErrorText(err)
        if (errorText && isInternalExecutionError(errorText)) return null
        const classification = (options.modelFailover?.classifyError ?? classifyCaughtProviderError)(err)
        if (classification) {
          markProviderExhausted(model.provider, options.modelFailover?.getActiveAccountId?.(), classification)
          const failoverResult = await attemptCompactionModelFailover(
            session,
            options.modelFailover,
            model.provider,
            preparation,
            signal
          )
          if (failoverResult) return failoverResult
        }
      } catch {
        // Exhaustion marking/failover must never escape the baker.
      }
      return null
    }
  }
}

function markProviderExhausted(
  provider: string,
  accountId: string | undefined,
  classification: CaughtProviderErrorClassification
): void {
  providerHealth.recordFailure(providerHealth.captureAttempt(provider, accountId), classification)
  log.warn(
    `Compaction failed with provider exhaustion (${classification.kind}); ` +
      `marked ${provider}${accountId ? ` account ${accountId}` : ''} exhausted.`
  )
}

async function attemptCompactionModelFailover(
  session: PiAgentSession,
  options: PiCompactionModelFailoverOptions | undefined,
  exhaustedProvider: string,
  preparation: Parameters<typeof compact>[0],
  signal: AbortSignal
): Promise<PrecompactionBakeOutput | null> {
  if (!options) return null

  const candidateSpecs = options.selectNextSpec
    ? [options.selectNextSpec(exhaustedProvider)].filter((spec): spec is string => spec != null)
    : selectNextCompactionSpecs(options.priorityList, exhaustedProvider)

  for (const nextSpec of candidateSpecs) {
    const attempt = await attemptCompactionFailoverCandidate(
      session,
      options,
      nextSpec,
      exhaustedProvider,
      preparation,
      signal
    )
    if (attempt.kind === 'success') return attempt.result
    if (attempt.kind === 'stop') return null
    // `skip` means the candidate was unusable before the model switch (disabled,
    // no healthy account, auth failure, invalid spec); try the later candidate.
  }

  return null
}

type CandidateAttempt = { kind: 'success'; result: PrecompactionBakeOutput } | { kind: 'skip' } | { kind: 'stop' }

async function attemptCompactionFailoverCandidate(
  session: PiAgentSession,
  options: PiCompactionModelFailoverOptions,
  nextSpec: string,
  exhaustedProvider: string,
  preparation: Parameters<typeof compact>[0],
  signal: AbortSignal
): Promise<CandidateAttempt> {
  let prepared: PiCompactionProviderSwitch | undefined
  try {
    const { provider: nextProvider } = parseModelSpec(nextSpec)
    if (nextProvider === exhaustedProvider) return { kind: 'skip' }

    const { model: nextModel, thinkingLevel } = resolveAgentModelSpec(nextSpec)
    const preparationResult = await options.prepareProviderSwitch?.(nextProvider, nextSpec)
    if (preparationResult === false) return { kind: 'skip' }
    prepared = preparationResult ?? undefined

    const auth = await resolveCompactAuth(session, nextModel)
    if (!auth) {
      await prepared?.rollback?.()
      return { kind: 'skip' }
    }
    if (signal.aborted) {
      await prepared?.rollback?.()
      return { kind: 'stop' }
    }

    const originalModel = session.model
    const originalThinkingLevel = session.thinkingLevel
    let switched = false

    try {
      await session.setModel(nextModel)
      switched = true
      if (thinkingLevel) session.setThinkingLevel(thinkingLevel)
    } catch {
      await prepared?.rollback?.()
      return { kind: 'stop' }
    }

    if (signal.aborted) {
      await restoreCompactionFailoverState(session, originalModel, originalThinkingLevel, prepared, switched)
      return { kind: 'stop' }
    }

    try {
      const fitPreparation = clampPreparationForBudget(
        preparation,
        summarizeInputBudget(nextModel, preparation.settings)
      )
      const compaction = await compact(
        fitPreparation,
        nextModel,
        auth.apiKey,
        auth.headers,
        undefined, // customInstructions — use pi defaults
        signal,
        session.thinkingLevel,
        session.agent.streamFunction,
        auth.env
      )
      try {
        await prepared?.commit?.()
        await options.onModelSwitched?.(nextProvider, nextSpec)
      } catch {
        await restoreCompactionFailoverState(session, originalModel, originalThinkingLevel, prepared, switched)
        return { kind: 'stop' }
      }
      return { kind: 'success', result: { compaction, modelKey: modelKeyFor(nextModel) } }
    } catch (err) {
      // Best effort: if the fallback provider is also exhausted, mark it so a
      // later attempt can skip it too. Do not recurse/loop here; compaction must
      // stay bounded and non-fatal. Because pi's synchronous fallback already
      // resolved auth for the pre-hook model, restore the original live model
      // before returning null so fallback auth/model cannot mismatch.
      const errorText = providerErrorText(err)
      const classification = errorText && isInternalExecutionError(errorText) ? null : classifyCaughtProviderError(err)
      if (classification) markProviderExhausted(nextProvider, prepared?.accountId, classification)
      await restoreCompactionFailoverState(session, originalModel, originalThinkingLevel, prepared, switched)
      return { kind: 'stop' }
    }
  } catch {
    try {
      await prepared?.rollback?.()
    } catch {
      // best-effort rollback
    }
    return { kind: 'skip' }
  }
}

async function restoreCompactionFailoverState(
  session: PiAgentSession,
  originalModel: PiAgentSession['model'],
  originalThinkingLevel: PiAgentSession['thinkingLevel'],
  prepared: PiCompactionProviderSwitch | undefined,
  switched: boolean
): Promise<void> {
  try {
    if (switched && originalModel) await session.setModel(originalModel)
    if (originalThinkingLevel) session.setThinkingLevel(originalThinkingLevel)
  } catch {
    // Best effort: the important thing is not to throw out of compaction.
  }
  try {
    await prepared?.rollback?.()
  } catch {
    // Best effort rollback.
  }
}

function selectNextCompactionSpecs(priorityList: string, exhaustedProvider: string): string[] {
  const disabled = getDisabledProviders()
  const specs: string[] = []
  for (const spec of splitModelPriorityList(priorityList)) {
    const provider = parseModelSpec(spec).provider
    if (provider === exhaustedProvider) continue
    if (disabled.has(provider)) continue
    if (providerRouteDecision(provider, readAccountStore(), providerHealth.snapshotRecords(), true)?.state !== 'ready')
      continue
    specs.push(spec)
  }
  return specs
}

function modelKeyFor(model: { provider: string; id: string; contextWindow: number }): string {
  return `${model.provider}/${model.id}/${model.contextWindow}`
}

/**
 * On-demand "fit" compaction served through the `session_before_compact` hook
 * (#625). When pi triggers compaction and the summarize request does NOT fit
 * the current model's window (large→small model switch: live failover or a
 * cold restart onto a smaller-window provider), pi's own synchronous
 * compaction would fail with the very overflow it is trying to fix — and pi
 * then sends the oversized prompt anyway. This fallback summarizes with a
 * summarizer that fits instead:
 *
 *   1. a healthy, non-disabled priority-list provider whose budget fits the
 *      UNCLAMPED preparation (full-fidelity summary), or
 *   2. the current model with the preparation clamped to its budget.
 *
 * The live session model is NEVER switched — post-compaction context (summary
 * + keepRecentTokens) fits the current model; only the one summarize call may
 * use another provider. Account projections made via `prepareProviderSwitch`
 * are always rolled back afterward. Resolves `undefined` when the request
 * already fits (pi's normal path proceeds) or on any failure (non-fatal).
 */
export function createFitCompactionFallback(
  session: PiAgentSession,
  options: PiCompactionBakerOptions = {}
): (event: SessionBeforeCompactEvent) => Promise<CompactionResult | undefined> {
  return async (event) => {
    try {
      const model = session.model
      if (!model) return undefined
      const preparation = event.preparation as Parameters<typeof compact>[0]
      const settings = preparation.settings
      const estimate = estimateSummarizeTokens(preparation)
      const budget = summarizeInputBudget(model, settings)
      if (estimate <= budget) return undefined

      log.warn(
        `Summarize request (~${estimate} tokens) exceeds ${model.provider}:${model.id} budget (${budget}); ` +
          'running fit compaction.'
      )

      for (const spec of selectFitSummarizerSpecs(options.modelFailover?.priorityList, model.provider)) {
        if (event.signal.aborted) return undefined
        const attempt = await attemptFitSummarizerCandidate(session, options, spec, preparation, estimate, event.signal)
        if (attempt) return attempt
      }

      if (event.signal.aborted) return undefined
      const clamped = clampPreparationForBudget(preparation, budget)
      const clampedResidual = estimateSummarizeTokens(clamped)
      if (clampedResidual > budget) {
        log.warn(
          `Clamped fit-fallback summarize request still ~${clampedResidual} tokens, over ${model.provider}:${model.id} budget (${budget}); proceeding anyway.`
        )
      }
      const auth = await resolveCompactAuth(session, model)
      if (!auth) return undefined
      const compaction = await compact(
        clamped,
        model,
        auth.apiKey,
        auth.headers,
        undefined, // customInstructions — use pi defaults
        event.signal,
        session.thinkingLevel,
        session.agent.streamFunction,
        auth.env
      )
      log.info(`Fit compaction summarized with clamped input on ${model.provider}:${model.id}.`)
      return compaction
    } catch (err) {
      log.warn(`Fit compaction failed: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }
}

async function attemptFitSummarizerCandidate(
  session: PiAgentSession,
  options: PiCompactionBakerOptions,
  spec: string,
  preparation: Parameters<typeof compact>[0],
  estimate: number,
  signal: AbortSignal
): Promise<CompactionResult | undefined> {
  let prepared: PiCompactionProviderSwitch | undefined
  try {
    const { provider } = parseModelSpec(spec)
    const { model: candidate } = resolveAgentModelSpec(spec)
    if (summarizeInputBudget(candidate, preparation.settings) < estimate) return undefined

    const preparationResult = await options.modelFailover?.prepareProviderSwitch?.(provider, spec)
    if (preparationResult === false) return undefined
    prepared = preparationResult ?? undefined

    const auth = await resolveCompactAuth(session, candidate)
    if (!auth) return undefined
    if (signal.aborted) return undefined

    const compaction = await compact(
      preparation,
      candidate,
      auth.apiKey,
      auth.headers,
      undefined, // customInstructions — use pi defaults
      signal,
      session.thinkingLevel,
      session.agent.streamFunction,
      auth.env
    )
    log.info(`Fit compaction summarized with ${candidate.provider}:${candidate.id}.`)
    return compaction
  } catch (err) {
    const errorText = providerErrorText(err)
    const classification = errorText && isInternalExecutionError(errorText) ? null : classifyCaughtProviderError(err)
    if (classification) {
      try {
        markProviderExhausted(parseModelSpec(spec).provider, prepared?.accountId, classification)
      } catch {
        // best-effort marking
      }
    }
    return undefined
  } finally {
    // The candidate was summarizer-only: whatever account projection was made
    // for it must not leak into the live session.
    try {
      await prepared?.rollback?.()
    } catch {
      // best-effort rollback
    }
  }
}

function selectFitSummarizerSpecs(priorityList: string | undefined, currentProvider: string): string[] {
  if (!priorityList) return []
  const disabled = getDisabledProviders()
  return splitModelPriorityList(priorityList).filter((spec) => {
    try {
      const { provider } = parseModelSpec(spec)
      return (
        provider !== currentProvider &&
        !disabled.has(provider) &&
        providerRouteDecision(provider, readAccountStore(), providerHealth.snapshotRecords(), true)?.state === 'ready'
      )
    } catch {
      return false
    }
  })
}
