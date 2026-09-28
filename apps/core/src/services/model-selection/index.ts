import { tryGetModelRuntime } from '../agent'
import { isAccountUsable } from '../agent/account-usable'
import { splitModelPriorityList } from '../../lib/utils/model-spec'
import { listAccounts, readAccountStore, type AccountStoreV1 } from '../agent/account-store'
import { getDisabledProviders } from './disabled-providers'
import {
  selectModelSpec,
  selectModelSpecWithSwitchBack,
  PROVIDERS_WITHOUT_AUTH,
  type ModelSelection,
  type SwitchBackModelSelection,
} from './select-model'
import { providerHealth } from '../provider-health/registry'
import { providerRouteDecision, providerSwitchBackEligible } from '../provider-health/routing'
import { expandOpenRouterFallbacks } from './openrouter-expansion'
import { isOpenRouterTierExpansionEnabled } from './openrouter-settings'

export * from './select-model'
export * from './disabled-providers'
export * from './openrouter-settings'
export * from './openrouter-expansion'

/**
 * Extra settling time that must elapse after a provider's cooldown (`retryAt`)
 * before an agent proactively switches BACK to it. Prevents flap right after
 * cooldown expiry. Overridable for testing/tuning.
 */
export const SWITCH_BACK_STABILITY_MS = Number(process.env.MODEL_SWITCH_BACK_STABILITY_MS) || 30_000

/**
 * Resolve a (possibly comma-separated) model spec to a single usable spec
 * using the real auth status (ModelRuntime-backed CredentialStore), the
 * disabled-providers setting, and the in-memory provider health registry. The
 * first candidate whose provider is enabled, configured, and currently healthy
 * is selected.
 *
 * @throws {ModelSelectionError} if no candidate is usable.
 */
export function selectModelSpecForCurrentEnv(spec: string, opts?: { preferContextTokens?: number }): ModelSelection {
  const accountStore = readAccountStore()
  const disabled = getDisabledProviders()
  const resolvedSpec = expandOpenRouterForCurrentEnv(spec, accountStore, disabled)
  return selectResolvedModelSpec(resolvedSpec, accountStore, disabled, opts)
}

/** Select from a caller-supplied resolved list without deriving shadows again. */
export function selectResolvedModelCandidatesForCurrentEnv(
  candidates: string[],
  opts?: { preferContextTokens?: number }
): ModelSelection {
  return selectResolvedModelSpec(candidates.join(','), readAccountStore(), getDisabledProviders(), opts)
}

function selectResolvedModelSpec(
  resolvedSpec: string,
  accountStore: AccountStoreV1,
  disabled: Set<string>,
  opts?: { preferContextTokens?: number }
): ModelSelection {
  return selectModelSpec(resolvedSpec, {
    // Stored accounts count as configured even when all are temporarily exhausted;
    // health is evaluated separately so the candidate is reported as exhausted
    // rather than unauthenticated. hasRuntimeRoute() covers env/runtime auth and
    // explicitly auth-exempt extension providers.
    isProviderConfigured: (p) => hasConfiguredAccount(p, accountStore) || hasRuntimeRoute(p),
    isProviderDisabled: (p) => disabled.has(p),
    isProviderHealthy: (p) =>
      providerRouteDecision(p, accountStore, providerHealth.snapshotRecords(), hasRuntimeRoute(p))?.state === 'ready',
    preferContextTokens: opts?.preferContextTokens,
    modelCatalog: tryGetModelRuntime(),
  })
}

/**
 * Switch-back-aware variant of {@link selectModelSpecForCurrentEnv}. Treats
 * `currentSpec` (the agent's persisted `selectedModel`) as a sticky preference:
 * stay on it unless a strictly-higher candidate is usable and switch-back-stable.
 * Use this at session creation. Failover/concurrency must keep using the eager
 * {@link selectModelSpecForCurrentEnv}.
 */
export function selectModelSpecForCurrentEnvWithSwitchBack(
  spec: string,
  currentSpec?: string
): SwitchBackModelSelection {
  const accountStore = readAccountStore()
  const disabled = getDisabledProviders()
  const resolvedSpec = expandOpenRouterForCurrentEnv(spec, accountStore, disabled)
  return selectModelSpecWithSwitchBack(resolvedSpec, currentSpec, {
    // Stored accounts count as configured even when all are temporarily exhausted;
    // health is evaluated separately so the candidate is reported as exhausted
    // rather than unauthenticated. hasRuntimeRoute() covers env/runtime auth and
    // explicitly auth-exempt extension providers.
    isProviderConfigured: (p) => hasConfiguredAccount(p, accountStore) || hasRuntimeRoute(p),
    isProviderDisabled: (p) => disabled.has(p),
    isProviderHealthy: (p) =>
      providerRouteDecision(p, accountStore, providerHealth.snapshotRecords(), hasRuntimeRoute(p))?.state === 'ready',
    isSwitchBackStable: (p) =>
      providerSwitchBackEligible(
        p,
        accountStore,
        providerHealth.snapshotRecords(),
        hasRuntimeRoute(p),
        SWITCH_BACK_STABILITY_MS
      ),
    modelCatalog: tryGetModelRuntime(),
  })
}

export interface OpenRouterExpansionState {
  enabled: boolean
  routeReady: boolean
  active: boolean
}

/** The single activation decision shared by model selection and presentation. */
export function getOpenRouterExpansionStateForCurrentEnv(): OpenRouterExpansionState {
  return openRouterExpansionState(readAccountStore(), getDisabledProviders())
}

function openRouterExpansionState(store: AccountStoreV1, disabled: Set<string>): OpenRouterExpansionState {
  const routeReady =
    !disabled.has('openrouter') && (hasConfiguredAccount('openrouter', store) || hasRuntimeRoute('openrouter'))
  const enabled = isOpenRouterTierExpansionEnabled()
  return { enabled, routeReady, active: enabled && routeReady }
}

/** Resolve the stable authored + derived candidate space without applying transient health filtering. */
export function resolveModelCandidatesForCurrentEnv(spec: string): string[] {
  return splitModelPriorityList(expandOpenRouterForCurrentEnv(spec, readAccountStore(), getDisabledProviders()))
}

function expandOpenRouterForCurrentEnv(spec: string, store: AccountStoreV1, disabled: Set<string>): string {
  const state = openRouterExpansionState(store, disabled)
  return expandOpenRouterFallbacks(spec, { enabled: state.enabled, routeReady: state.routeReady })
}

function hasRuntimeRoute(provider: string): boolean {
  return PROVIDERS_WITHOUT_AUTH.has(provider) || (tryGetModelRuntime()?.hasConfiguredAuth(provider) ?? false)
}

function hasConfiguredAccount(provider: string, store: AccountStoreV1): boolean {
  return listAccounts(store, provider).some(isAccountUsable)
}
