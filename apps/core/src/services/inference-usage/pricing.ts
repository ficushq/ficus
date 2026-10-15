/**
 * What a model call cost: the billed amount (what the instance actually pays per call) and the list-price
 * equivalent (the same call on a pay-as-you-go API key), both in nanodollars.
 */
import { calculateCost, type Usage } from '@earendil-works/pi-ai'
import { SERVICE_PRICES, type InferenceBilling, type InferenceUnits } from '@ficus/shared'
import type { InferenceTokens } from './types'

/** A model with per-million-token prices, as pi's model registry returns it. */
export type PricedModel = Parameters<typeof calculateCost>[0]
export type ModelLookup = (provider: string, model: string) => PricedModel | undefined

export interface PriceInput {
  feature: string
  provider?: string | null
  model?: string | null
  billing: InferenceBilling
  tokens?: Partial<InferenceTokens>
  units?: InferenceUnits | null
  /** Already-known list cost in USD; wins over every lookup. */
  listCostUsd?: number | null
  tokensEstimated?: boolean
}

export interface PricedUsage {
  costNanodollars: number
  listCostNanodollars: number | null
  costEstimated: boolean
}

export function nanodollars(usd: number): number {
  return Math.round(usd * 1e9)
}

export function fullTokens(tokens: Partial<InferenceTokens> | undefined): InferenceTokens {
  const count = (value: number | undefined) => (Number.isFinite(value) && value! > 0 ? Math.round(value!) : 0)
  return {
    input: count(tokens?.input),
    output: count(tokens?.output),
    cacheRead: count(tokens?.cacheRead),
    cacheWrite: count(tokens?.cacheWrite),
  }
}

/** The Claude Code bridge reports Claude models under its own provider id; Anthropic's list price applies. */
function listPriceProvider(provider: string): string {
  return provider === 'claude-code' ? 'anthropic' : provider
}

function modelListCostUsd(input: PriceInput, lookupModel: ModelLookup): number | null {
  if (!input.provider || !input.model) return null
  const model = lookupModel(listPriceProvider(input.provider), input.model)
  if (!model?.cost) return null
  const tokens = fullTokens(input.tokens)
  const usage: Usage = {
    ...tokens,
    totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
  const cost = calculateCost(model, usage)
  // An all-zero price table means "unpriced" (custom/compatible models), not "free".
  const priced = model.cost.input > 0 || model.cost.output > 0
  return priced ? cost.total : null
}

function serviceListCostUsd(input: PriceInput): number | null {
  const key = `${input.provider ?? ''}/${input.model ?? ''}`
  if (input.feature === 'transcription') {
    const price = (SERVICE_PRICES.transcription as Record<string, { perAudioMinuteUsd: number }>)[key]
    const seconds = input.units?.audioSeconds
    return price && seconds !== undefined ? (seconds / 60) * price.perAudioMinuteUsd : null
  }
  if (input.feature.startsWith('embedding:')) {
    const price = SERVICE_PRICES.embedding[key]
    return price ? (fullTokens(input.tokens).input / 1e6) * price.perMillionTokensUsd : null
  }
  if (input.feature === 'tts' && input.provider === 'google') {
    const characters = input.units?.characters
    return characters !== undefined ? (characters / 1e6) * SERVICE_PRICES.tts.google.perMillionCharactersUsd : null
  }
  return null
}

/**
 * Prices one call. List cost: the caller's figure, else pi's model registry, else SERVICE_PRICES, else
 * unknown. Billed cost: `api` bills the list price, `subscription` and `self-hosted` bill 0, `unknown`
 * bills the list price as an estimate.
 */
export function priceUsage(input: PriceInput, deps: { lookupModel: ModelLookup }): PricedUsage {
  let listUsd: number | null = null
  if (typeof input.listCostUsd === 'number' && Number.isFinite(input.listCostUsd) && input.listCostUsd >= 0) {
    listUsd = input.listCostUsd
  } else if (input.listCostUsd !== null) {
    listUsd = modelListCostUsd(input, deps.lookupModel) ?? serviceListCostUsd(input)
  }
  const list = listUsd === null ? null : nanodollars(listUsd)
  const estimated = input.tokensEstimated === true
  switch (input.billing) {
    case 'api':
      return { costNanodollars: list ?? 0, listCostNanodollars: list, costEstimated: estimated || list === null }
    case 'subscription':
      return { costNanodollars: 0, listCostNanodollars: list, costEstimated: estimated }
    case 'self-hosted':
      return { costNanodollars: 0, listCostNanodollars: null, costEstimated: estimated }
    case 'unknown':
      return { costNanodollars: list ?? 0, listCostNanodollars: list, costEstimated: true }
  }
}
