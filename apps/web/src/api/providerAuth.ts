import type { ProviderHealthKind } from '@ficus/shared'
import { apiFetch } from './client'

export interface ProviderAccountEntry {
  id: string
  label?: string
  enabled: boolean
  type: 'api_key' | 'oauth'
  hasCredential?: boolean
  health?: 'available' | 'exhausted'
  retryAt?: number
  /** Why the account is exhausted, so the UI can say more than "Exhausted". */
  healthReason?: ProviderHealthKind
  /** Human summary of the health record backing `healthReason`. */
  healthMessage?: string
  lastUsedAt?: number
  kind?: 'openai-compatible'
  providerId?: string
  baseUrl?: string
  model?: string
  capabilities?: CompatibleCapabilities
}

export interface ProviderAuthEntry {
  provider: string
  type: 'api_key' | 'oauth'
  hasCredential: boolean
  configured: boolean
  disabled: boolean
  accounts?: ProviderAccountEntry[]
  /** Whether the provider is currently healthy or exhausted (in cooldown). */
  health?: 'available' | 'exhausted'
  /** Epoch ms when an exhausted provider should be considered available again. */
  retryAt?: number
  /** Reason from the record that makes the provider unusable (account first). */
  healthReason?: ProviderHealthKind
  /** Human summary of the health record backing `healthReason`. */
  healthMessage?: string
}

export interface OpenRouterRoutingSummary {
  enabled: boolean
  active: boolean
  configured: boolean
  health: 'available' | 'exhausted'
  tiers: { slug: string; label: string; fallbacks: string[] }[]
  vendors: string[]
}

export async function getOpenRouterRouting(): Promise<OpenRouterRoutingSummary> {
  return apiFetch<OpenRouterRoutingSummary>('/provider-auth/openrouter/routing')
}

export async function setOpenRouterRoutingEnabled(enabled: boolean): Promise<void> {
  await apiFetch('/provider-auth/openrouter/routing', {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
}

export interface OAuthProvider {
  id: string
  name: string
}

export interface ProviderCatalogEntry {
  id: string
  label: string
  modelCount: number
  oauthAvailable: boolean
  disabled: boolean
}

export type OAuthNeed =
  | { kind: 'starting' }
  | { kind: 'code'; authUrl: string; instructions?: string }
  | { kind: 'device_code'; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { kind: 'select'; message: string; options: { id: string; label: string }[] }
  | { kind: 'done' }
  | { kind: 'error'; message: string }

export interface OAuthStartResult {
  provider: string
  need: OAuthNeed
  status: 'started' | 'already_started'
}

export interface OAuthStatus {
  provider: string
  status: 'none' | 'pending'
  need?: OAuthNeed
  progress?: string[]
}

export async function listProviderAuth(): Promise<ProviderAuthEntry[]> {
  return apiFetch<ProviderAuthEntry[]>('/provider-auth')
}

export async function getProviderAuth(provider: string): Promise<ProviderAuthEntry> {
  return apiFetch<ProviderAuthEntry>(`/provider-auth/${provider}`)
}

export async function setProviderApiKey(provider: string, key: string): Promise<void> {
  await apiFetch(`/provider-auth/${provider}`, {
    method: 'PUT',
    body: JSON.stringify({ key }),
  })
}

export async function deleteProviderAuth(provider: string): Promise<void> {
  await apiFetch(`/provider-auth/${provider}`, { method: 'DELETE' })
}

export async function listProviderAccounts(provider: string): Promise<ProviderAccountEntry[]> {
  return apiFetch<ProviderAccountEntry[]>(`/provider-auth/${provider}/accounts`)
}

export async function addProviderAccount(provider: string, key: string, label?: string): Promise<ProviderAccountEntry> {
  return apiFetch<ProviderAccountEntry>(`/provider-auth/${provider}/accounts`, {
    method: 'POST',
    body: JSON.stringify({ key, label }),
  })
}

export async function updateProviderAccount(
  provider: string,
  accountId: string,
  patch: { label?: string; enabled?: boolean }
): Promise<ProviderAccountEntry> {
  return apiFetch<ProviderAccountEntry>(`/provider-auth/${provider}/accounts/${accountId}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
}

export async function deleteProviderAccount(provider: string, accountId: string): Promise<void> {
  await apiFetch(`/provider-auth/${provider}/accounts/${accountId}`, { method: 'DELETE' })
}

/**
 * Reorder a provider's accounts. Array order is the user's selection
 * preference — the first enabled+healthy account wins; unhealthy/disabled
 * accounts fail over to the next one in order.
 */
export async function reorderProviderAccounts(provider: string, order: string[]): Promise<ProviderAccountEntry[]> {
  return apiFetch<ProviderAccountEntry[]>(`/provider-auth/${provider}/accounts/order`, {
    method: 'PUT',
    body: JSON.stringify({ order }),
  })
}

/**
 * Enable or disable a provider globally for model fallback selection.
 * Disabling preserves credentials; re-enabling reuses them.
 */
export async function setProviderEnabled(provider: string, enabled: boolean): Promise<void> {
  await apiFetch(`/provider-auth/${provider}/enabled`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
}

/**
 * Clear an exhaustion record early, for when the provider's limit window reset
 * ahead of the `retryAt` Ficus recorded. Asserts nothing about upstream state —
 * the next failure re-marks exhaustion.
 */
export async function resetProviderHealth(provider: string, accountId?: string): Promise<ProviderAuthEntry> {
  const path = accountId
    ? `/provider-auth/${provider}/accounts/${accountId}/health/reset`
    : `/provider-auth/${provider}/health/reset`
  return apiFetch<ProviderAuthEntry>(path, { method: 'POST' })
}

export async function listOAuthProviders(): Promise<OAuthProvider[]> {
  return apiFetch<OAuthProvider[]>('/provider-auth/oauth/providers')
}

export async function listProviderCatalog(): Promise<ProviderCatalogEntry[]> {
  return apiFetch<ProviderCatalogEntry[]>('/provider-auth/catalog')
}

/**
 * Start an OAuth login flow.
 *
 * - `accountId` omitted → ADD: completion appends a NEW account (or dedupes
 *   onto a same-upstream account) without touching existing ones.
 * - `accountId` set → REAUTHORIZE: completion refreshes exactly that existing
 *   account's credential in place.
 */
export async function startOAuthFlow(provider: string, accountId?: string): Promise<OAuthStartResult> {
  return apiFetch<OAuthStartResult>(`/provider-auth/${provider}/oauth/start`, {
    method: 'POST',
    ...(accountId ? { body: JSON.stringify({ accountId }) } : {}),
  })
}

export async function cancelOAuthFlow(provider: string): Promise<void> {
  await apiFetch(`/provider-auth/${provider}/oauth/cancel`, { method: 'POST' })
}

export async function completeOAuthFlow(provider: string, code: string): Promise<void> {
  await apiFetch(`/provider-auth/${provider}/oauth/callback`, {
    method: 'POST',
    body: JSON.stringify({ code }),
  })
}

export async function getOAuthStatus(provider: string): Promise<OAuthStatus> {
  return apiFetch<OAuthStatus>(`/provider-auth/${provider}/oauth/status`)
}

export async function selectOAuthOption(provider: string, optionId: string | null): Promise<void> {
  await apiFetch(`/provider-auth/${provider}/oauth/select`, {
    method: 'POST',
    body: JSON.stringify({ optionId }),
  })
}

export interface CompatibleCapabilities {
  tools: boolean
  contextWindow?: number
  probedAt: string
}
export interface DetectedCompatibleServer {
  baseUrl: string
  models: string[]
}
export interface CompatibleProbeResult {
  models: string[]
  capabilities: CompatibleCapabilities
  contextWindowFloor: number
}
export async function detectCompatibleServers(): Promise<DetectedCompatibleServer[]> {
  return apiFetch('/provider-auth/openai-compatible/detect', { method: 'POST' })
}
export async function probeCompatibleProvider(input: {
  baseUrl: string
  model: string
  apiKey?: string
}): Promise<CompatibleProbeResult> {
  return apiFetch('/provider-auth/openai-compatible/probe', { method: 'POST', body: JSON.stringify(input) })
}
export async function addCompatibleProvider(input: {
  baseUrl: string
  model: string
  providerId: string
  apiKey?: string
  label?: string
}): Promise<{ account: ProviderAccountEntry; models: string[] }> {
  return apiFetch('/provider-auth/openai-compatible/accounts', { method: 'POST', body: JSON.stringify(input) })
}
