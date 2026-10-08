import type { ComponentType } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import type { DecisionProviderKind, DecisionProviderView } from '@ficus/shared'
import { ApiError } from '../../api/client'
import { decisionQueryKeys } from '../../queryKeys'
import { CloudflareIcon, CpuIcon, LightningIcon, OpenAIIcon } from '../icons'

/** The mark shown for each decision provider kind. */
export const DECISION_KIND_LOGOS: Record<DecisionProviderKind, ComponentType<{ className?: string }>> = {
  jev: LightningIcon,
  systemone: CpuIcon,
  cloudflare: CloudflareIcon,
  openai: OpenAIIcon,
}

/** Which connection fields a kind needs; OpenAI Decisions borrows the OpenAI API services key. */
export const DECISION_KIND_FIELDS: Record<
  DecisionProviderKind,
  { apiKey: 'required' | 'optional' | 'none'; baseUrl: boolean; accountId: boolean; freeModel: boolean }
> = {
  jev: { apiKey: 'required', baseUrl: false, accountId: false, freeModel: false },
  systemone: { apiKey: 'optional', baseUrl: true, accountId: false, freeModel: true },
  cloudflare: { apiKey: 'required', baseUrl: false, accountId: true, freeModel: false },
  openai: { apiKey: 'none', baseUrl: false, accountId: false, freeModel: false },
}

/** Where the OpenAI API services key is added. */
export const OPENAI_SERVICES_LINK = '/settings?section=integrations&setting=integration-openai-services'

/** Core's own `{ error }` sentence when it sent one, without the "API error: 400:" prefix. */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const payload = error.payload as { error?: unknown } | undefined
    if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error.trim()
  }
  return error instanceof Error ? error.message : String(error)
}

export function providerName(providers: readonly DecisionProviderView[], id: string): string {
  return providers.find((provider) => provider.id === id)?.label ?? id
}

export function invalidateDecisions(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: decisionQueryKeys.all })
}

/** A probability as a percentage that never rounds a real chance to 0% or 100%. */
export function formatPercent(probability: number): string {
  const percent = probability * 100
  return `${percent > 0 && percent < 1 ? '<1' : percent > 99 && percent < 100 ? '>99' : Math.round(percent)}%`
}
