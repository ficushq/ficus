import type {
  DecisionFeatureSwitch,
  DecisionFeatureView,
  DecisionProviderKind,
  DecisionProviderView,
  DecisionPurpose,
  DecisionQuestions,
  DecisionResult,
  DecisionRouting,
  DecisionSpend,
} from '@ficus/shared'
import { apiFetch } from './client'

/** Decision model providers (Jev, Clef, OpenAI Decisions) and which of them each purpose asks. */
export interface DecisionSettings {
  providers: DecisionProviderView[]
  routing: DecisionRouting
  kinds: Record<DecisionProviderKind, { label: string; description: string; defaultModel: string; models: string[] }>
  purposes: Array<{ id: DecisionPurpose; label: string; description: string }>
  /** Everything decision models power, with each instance feature's switch. */
  features: DecisionFeature[]
  /** Whether the OpenAI API services key is set; OpenAI Decisions has no key of its own. */
  openAIServicesKey: boolean
}

/** A feature as Core sends it: its purpose info is spread in, including `offByDefault`. */
export type DecisionFeature = DecisionFeatureView & {
  /** Nice to have but costs money: off under `auto` until the owner turns it on. */
  offByDefault?: boolean
}

/** The periods spend can be added up over. */
export type DecisionSpendDays = 1 | 7 | 30

export interface DecisionProviderInput {
  kind: DecisionProviderKind
  label?: string
  model?: string
  baseUrl?: string
  accountId?: string
  apiKey?: string
}

export interface DecisionProviderPatch {
  label?: string
  model?: string
  enabled?: boolean
  baseUrl?: string
  accountId?: string
  /** A blank key keeps the stored one. */
  apiKey?: string
  /** Dollars per million input tokens; null goes back to the list price. */
  pricePerMillionInput?: number | null
}

export interface DetectedDecisionServer {
  baseUrl: string
  models: string[]
}

export interface DecisionTryInput {
  state: string
  questions: DecisionQuestions
  providerId?: string
  purpose?: DecisionPurpose
}

export type DecisionTryOutcome =
  | { ok: true; result: DecisionResult }
  | { ok: false; reason: 'unconfigured' | 'unavailable'; errors: Array<{ providerId: string; error: string }> }

export function getDecisionSettings(): Promise<DecisionSettings> {
  return apiFetch<DecisionSettings>('/decisions')
}

/** Core asks the provider a test question first and refuses to save one that fails it. */
export function addDecisionProvider(input: DecisionProviderInput): Promise<DecisionProviderView> {
  return apiFetch<DecisionProviderView>('/decisions/providers', { method: 'POST', body: JSON.stringify(input) })
}

export function updateDecisionProvider(id: string, patch: DecisionProviderPatch): Promise<DecisionProviderView> {
  return apiFetch<DecisionProviderView>(`/decisions/providers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export async function deleteDecisionProvider(id: string): Promise<void> {
  await apiFetch(`/decisions/providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** Decision models served on this machine's usual Ollama, vLLM and SGLang ports. */
export function detectDecisionServers(): Promise<DetectedDecisionServer[]> {
  return apiFetch<DetectedDecisionServer[]>('/decisions/providers/detect', { method: 'POST' })
}

export function setDecisionRouting(routing: DecisionRouting): Promise<DecisionRouting> {
  return apiFetch<DecisionRouting>('/decisions/routing', { method: 'PUT', body: JSON.stringify(routing) })
}

/** `auto` is on whenever a decision model is set up for the feature. Returns every feature. */
export function setDecisionFeatureSwitch(
  id: DecisionPurpose,
  value: DecisionFeatureSwitch
): Promise<DecisionFeature[]> {
  return apiFetch<DecisionFeature[]>(`/decisions/features/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  })
}

/** What decision models cost over the last 1, 7 or 30 days, by feature and by provider. */
export function getDecisionSpend(days: DecisionSpendDays): Promise<DecisionSpend> {
  return apiFetch<DecisionSpend>(`/decisions/spend?days=${days}`)
}

export function tryDecision(input: DecisionTryInput): Promise<DecisionTryOutcome> {
  return apiFetch<DecisionTryOutcome>('/decisions/try', { method: 'POST', body: JSON.stringify(input) })
}
