import type {
  DecisionFeatureSwitch,
  DecisionFeatureView,
  DecisionProviderKind,
  DecisionProviderView,
  DecisionPurpose,
  DecisionQuestions,
  DecisionResult,
  DecisionRouting,
} from '@ficus/shared'
import { apiFetch } from './client'

/** Decision model providers (Jev, Clef, OpenAI Decisions) and which of them each purpose asks. */
export interface DecisionSettings {
  providers: DecisionProviderView[]
  routing: DecisionRouting
  kinds: Record<DecisionProviderKind, { label: string; description: string; defaultModel: string; models: string[] }>
  purposes: Array<{ id: DecisionPurpose; label: string; description: string }>
  /** Everything decision models power, with each instance feature's switch. */
  features: DecisionFeatureView[]
  /** Whether the OpenAI API services key is set; OpenAI Decisions has no key of its own. */
  openAIServicesKey: boolean
}

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
): Promise<DecisionFeatureView[]> {
  return apiFetch<DecisionFeatureView[]>(`/decisions/features/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  })
}

export function tryDecision(input: DecisionTryInput): Promise<DecisionTryOutcome> {
  return apiFetch<DecisionTryOutcome>('/decisions/try', { method: 'POST', body: JSON.stringify(input) })
}
