import { getModel, getModels, getProviders } from '@earendil-works/pi-ai/compat'
import { parseModelSpec, splitModelPriorityList } from '../../lib/utils/model-spec'

/**
 * Why a candidate was rejected during model selection.
 */
export type CandidateReason =
  'parse-error' | 'unknown-provider' | 'unknown-model' | 'provider-disabled' | 'auth-missing' | 'provider-exhausted'

export interface CandidateDiagnostic {
  spec: string
  provider?: string
  modelId?: string
  usable: boolean
  reason?: CandidateReason
}

export interface ModelSelection {
  /** The chosen single model spec (the first usable candidate). */
  selected: string
  /**
   * Diagnostics for every candidate considered, in priority order, up to and
   * including `selected` (i.e. `candidates.at(-1)?.spec === selected`). When
   * `preferContextTokens` causes a later candidate to be selected because it
   * fits the window, earlier entries in this slice may also be `usable: true`
   * — they were skipped for fit, not usability, so `usable` alone does not
   * identify the selected candidate.
   */
  candidates: CandidateDiagnostic[]
}

export interface SelectModelDeps {
  /** Dynamic runtime models registered from verified compatible providers. */
  modelCatalog?: { getProviders(): readonly { id: string }[]; getModel(provider: string, modelId: string): any }
  /** Whether the provider has any usable auth (stored key, OAuth, env, …). */
  isProviderConfigured: (provider: string) => boolean
  /** Whether the provider is globally disabled (skipped by fallback). */
  isProviderDisabled: (provider: string) => boolean
  /**
   * Whether the provider is currently healthy (not in cooldown from a recent
   * exhaustion). Optional — when omitted, providers are assumed healthy.
   * Used by runtime failover / the health registry to skip exhausted
   * providers when starting new sessions.
   */
  isProviderHealthy?: (provider: string) => boolean
  /**
   * Current live context size in tokens. When set, selection PREFERS the first
   * usable candidate whose context window fits it (window − 16_384 reserve).
   * Preference only: when no usable candidate fits, plain first-usable wins —
   * the fit-compaction fallback (#625) shrinks the context after selection.
   */
  preferContextTokens?: number
}

export interface SwitchBackDeps extends SelectModelDeps {
  /**
   * Whether a provider is healthy enough to proactively switch BACK to.
   * Stricter than `isProviderHealthy`. Optional — falls back to
   * `isProviderHealthy`, then to "always stable".
   */
  isSwitchBackStable?: (provider: string) => boolean
}

export interface SwitchBackInfo {
  from: string
  to: string
  reason: string
}

export interface SwitchBackModelSelection extends ModelSelection {
  switchedBack?: SwitchBackInfo
}

/**
 * Providers that need no API key/OAuth to be usable. Empty by default — this
 * is an extension point. Members are treated as auth-configured regardless of
 * `isProviderConfigured`.
 */
export const PROVIDERS_WITHOUT_AUTH = new Set<string>()

/**
 * Error thrown when no candidate in a model priority list is usable. The
 * message lists every attempted candidate with its specific reason so the
 * caller can diagnose missing auth, disabled providers, etc.
 */
export class ModelSelectionError extends Error {
  constructor(public readonly candidates: CandidateDiagnostic[]) {
    super(formatNoUsableMessage(candidates))
    this.name = 'ModelSelectionError'
  }
}

/** Evaluate every candidate in a priority list with full diagnostics (no early stop). */
export function evaluateAllCandidates(spec: string, deps: SelectModelDeps): CandidateDiagnostic[] {
  const specs = splitModelPriorityList(spec)
  const providers = new Set([
    ...(getProviders() as string[]),
    ...(deps.modelCatalog?.getProviders().map((provider) => provider.id) ?? []),
  ])
  const candidates: CandidateDiagnostic[] = []

  for (const candidateSpec of specs) {
    let provider: string
    let modelId: string
    try {
      const parsed = parseModelSpec(candidateSpec)
      provider = parsed.provider
      modelId = parsed.modelId
    } catch {
      candidates.push({ spec: candidateSpec, usable: false, reason: 'parse-error' })
      continue
    }

    if (!providers.has(provider)) {
      candidates.push({ spec: candidateSpec, provider, modelId, usable: false, reason: 'unknown-provider' })
      continue
    }
    if (!deps.modelCatalog?.getModel(provider, modelId) && !getModels(provider as any).some((m) => m.id === modelId)) {
      candidates.push({ spec: candidateSpec, provider, modelId, usable: false, reason: 'unknown-model' })
      continue
    }
    if (deps.isProviderDisabled(provider)) {
      candidates.push({ spec: candidateSpec, provider, modelId, usable: false, reason: 'provider-disabled' })
      continue
    }
    if (!PROVIDERS_WITHOUT_AUTH.has(provider) && !deps.isProviderConfigured(provider)) {
      candidates.push({ spec: candidateSpec, provider, modelId, usable: false, reason: 'auth-missing' })
      continue
    }

    // Dynamic usability: skip providers currently marked exhausted (in
    // cooldown) by the provider health registry. Lets new agents start on an
    // available provider instead of discovering a dead one via first-message
    // failure.
    const healthy = deps.isProviderHealthy ? deps.isProviderHealthy(provider) : true
    if (!healthy) {
      candidates.push({ spec: candidateSpec, provider, modelId, usable: false, reason: 'provider-exhausted' })
      continue
    }

    candidates.push({ spec: candidateSpec, provider, modelId, usable: true })
  }

  return candidates
}

const WINDOW_FIT_RESERVE_TOKENS = 16_384

/** Whether a candidate's model context window fits `contextTokens` (minus a reserve). Never throws. */
function candidateWindowFits(candidate: CandidateDiagnostic, contextTokens: number, deps: SelectModelDeps): boolean {
  if (!candidate.provider || !candidate.modelId) return false
  try {
    const model =
      deps.modelCatalog?.getModel(candidate.provider, candidate.modelId) ??
      getModel(candidate.provider as any, candidate.modelId as any)
    if (!model?.contextWindow) return false
    return model.contextWindow - WINDOW_FIT_RESERVE_TOKENS >= contextTokens
  } catch {
    return false
  }
}

/**
 * Resolve a (possibly comma-separated) model priority list to a single usable
 * spec. The first candidate whose provider is enabled and authenticated is
 * selected. If none are usable, throws {@link ModelSelectionError}.
 *
 * When `deps.preferContextTokens` is set, prefers the first USABLE candidate
 * whose context window fits it; when none fits, falls back to plain
 * first-usable (preference only — never throws for fit reasons).
 */
export function selectModelSpec(spec: string, deps: SelectModelDeps): ModelSelection {
  const candidates = evaluateAllCandidates(spec, deps)
  const firstUsableIdx = candidates.findIndex((c) => c.usable)
  if (firstUsableIdx === -1) throw new ModelSelectionError(candidates)

  const preferTokens = deps.preferContextTokens
  if (preferTokens && preferTokens > 0) {
    const fitIdx = candidates.findIndex((c) => c.usable && candidateWindowFits(c, preferTokens, deps))
    if (fitIdx !== -1) {
      return { selected: candidates[fitIdx].spec, candidates: candidates.slice(0, fitIdx + 1) }
    }
  }

  const firstUsable = candidates[firstUsableIdx]
  return { selected: firstUsable.spec, candidates: candidates.slice(0, firstUsableIdx + 1) }
}

/** Index of `spec` in `candidates`, matching by exact spec then by provider:modelId. */
function findCandidateIndex(candidates: CandidateDiagnostic[], spec: string): number {
  const exact = candidates.findIndex((c) => c.spec === spec)
  if (exact !== -1) return exact

  let target: { provider: string; modelId: string }
  try {
    const parsed = parseModelSpec(spec)
    target = { provider: parsed.provider, modelId: parsed.modelId }
  } catch {
    return -1
  }

  return candidates.findIndex((c) => c.provider === target.provider && c.modelId === target.modelId)
}

/**
 * Like {@link selectModelSpec}, but treats `currentSpec` (the agent's persisted
 * `selectedModel`) as a STICKY preference: stay on it unless a strictly-higher-
 * priority candidate is both usable and switch-back-stable. Never switches
 * sideways/downward. When `currentSpec` is absent/unusable, behaves exactly like
 * `selectModelSpec` (eager).
 */
export function selectModelSpecWithSwitchBack(
  spec: string,
  currentSpec: string | undefined,
  deps: SwitchBackDeps
): SwitchBackModelSelection {
  const candidates = evaluateAllCandidates(spec, deps)
  const firstUsableIdx = candidates.findIndex((c) => c.usable)
  if (firstUsableIdx === -1) throw new ModelSelectionError(candidates)

  const eager = (): SwitchBackModelSelection => {
    const firstUsable = candidates[firstUsableIdx]
    return { selected: firstUsable.spec, candidates: candidates.slice(0, firstUsableIdx + 1) }
  }

  if (!currentSpec) return eager()

  const currentIndex = findCandidateIndex(candidates, currentSpec)
  if (currentIndex === -1) return eager()

  const current = candidates[currentIndex]
  if (!current.usable) return eager()

  const isStable = deps.isSwitchBackStable ?? deps.isProviderHealthy ?? (() => true)
  for (let i = 0; i < currentIndex; i++) {
    const candidate = candidates[i]
    if (candidate.usable && candidate.provider && isStable(candidate.provider)) {
      return {
        selected: candidate.spec,
        candidates: candidates.slice(0, i + 1),
        switchedBack: { from: currentSpec, to: candidate.spec, reason: 'higher-priority-recovered' },
      }
    }
  }

  return { selected: current.spec, candidates: candidates.slice(0, currentIndex + 1) }
}

function formatNoUsableMessage(candidates: CandidateDiagnostic[]): string {
  const lines = candidates.map((d) => `  - ${d.spec}: ${reasonText(d.reason)}`)
  return `No usable model in priority list. Attempted:\n${lines.join('\n')}`
}

function reasonText(reason?: CandidateReason): string {
  switch (reason) {
    case 'parse-error':
      return 'invalid spec format'
    case 'unknown-provider':
      return 'unknown provider'
    case 'unknown-model':
      return 'unknown model for provider'
    case 'provider-disabled':
      return 'provider is disabled'
    case 'auth-missing':
      return 'provider not authenticated/configured'
    case 'provider-exhausted':
      return 'provider exhausted (in cooldown)'
    default:
      return 'unusable'
  }
}
