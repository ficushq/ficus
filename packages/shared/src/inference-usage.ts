/**
 * The inference cost ledger: what every model call costs, by feature, model, account and billing type.
 * Core writes one row per provider call (`recordInferenceUsage`); Settings → Spend reads them.
 * See docs/wiki/inference-usage.md.
 */
import { DECISION_PURPOSE_INFO, type DecisionPurpose } from './decisions'

/** How a call was paid for. Subscription and self-hosted calls bill $0 per call. */
export const INFERENCE_BILLING = ['api', 'subscription', 'self-hosted', 'unknown'] as const
export type InferenceBilling = (typeof INFERENCE_BILLING)[number]

/** Non-token quantities some services bill by. */
export interface InferenceUnits {
  audioSeconds?: number
  characters?: number
  images?: number
}

export interface InferenceFeatureInfo {
  /** A feature id, or a prefix (`decision`, `lite`) for `<prefix>:<purpose>` ids. */
  id: string
  label: string
  description: string
  /** True for `<id>:<purpose>` families. */
  prefix?: boolean
}

/**
 * Every kind of model call Ficus makes. A new feature adds its id here so the viewer can name it, then
 * records its calls with that id. Ids are kebab-case; `<prefix>:<purpose>` for purpose-qualified families.
 */
export const INFERENCE_FEATURES: readonly InferenceFeatureInfo[] = [
  { id: 'agent-turn', label: 'Agent turns', description: 'Model calls agents make while they work.' },
  { id: 'compaction', label: 'Compaction', description: 'Summarizing a long agent conversation to fit.' },
  {
    id: 'precompaction',
    label: 'Pre-compaction',
    description: 'Summaries prepared ahead of time so compaction is instant.',
  },
  { id: 'decision', label: 'Decision models', description: 'Small yes/no and pick-one questions.', prefix: true },
  { id: 'lite', label: 'Lite tier', description: 'Short completions on the Lite model tier.', prefix: true },
  { id: 'transcription', label: 'Transcription', description: 'Speech to text (voice messages, dictation).' },
  { id: 'tts-reformat', label: 'Speech rewrite', description: 'Rewriting a message so it reads well aloud.' },
  { id: 'tts', label: 'Text to speech', description: 'Reading messages aloud.' },
  { id: 'ai-extract', label: 'AI extract', description: 'Pulling structured fields out of text.' },
  { id: 'embedding:index', label: 'Memory indexing', description: 'Embeddings for indexed memory.' },
  { id: 'embedding:search', label: 'Memory search', description: 'Embeddings for memory search queries.' },
]

function titleCase(id: string): string {
  const words = id.split(/[-_\s]+/).filter(Boolean)
  return words.map((word, index) => (index === 0 ? word[0]!.toUpperCase() + word.slice(1) : word)).join(' ')
}

/** A human label for a feature id; unknown ids fall back to the id itself. */
export function featureLabel(id: string): string {
  const exact = INFERENCE_FEATURES.find((feature) => !feature.prefix && feature.id === id)
  if (exact) return exact.label
  const separator = id.indexOf(':')
  if (separator > 0) {
    const prefix = id.slice(0, separator)
    const purpose = id.slice(separator + 1)
    if (prefix === 'decision') return DECISION_PURPOSE_INFO[purpose as DecisionPurpose]?.label ?? purpose
    if (prefix === 'lite') return `${titleCase(purpose)} · Lite tier`
  }
  return id
}

/**
 * List prices for non-token services, in USD. Reviewed 2026-10-15 against the providers' price pages;
 * check them again when a provider changes prices.
 */
export const SERVICE_PRICES = {
  /** OpenAI Whisper: per minute of audio. */
  transcription: { 'openai/whisper-1': { perAudioMinuteUsd: 0.006 } },
  /** OpenAI embeddings: per million input tokens. */
  embedding: {
    'openai/text-embedding-3-small': { perMillionTokensUsd: 0.02 },
    'openai/text-embedding-3-large': { perMillionTokensUsd: 0.13 },
    'openai/text-embedding-ada-002': { perMillionTokensUsd: 0.1 },
  } as Record<string, { perMillionTokensUsd: number }>,
  /** Google Cloud Text-to-Speech Chirp 3 HD voices: per million characters. */
  tts: { google: { perMillionCharactersUsd: 30 } },
} as const

export interface SubscriptionPlanInfo {
  label: string
  /** List price per month in USD (per seat for team plans); null when it is negotiated. */
  monthlyUsd: number | null
}

/**
 * Well-known subscription plans by provider, with their monthly list prices in USD. Reviewed 2026-10-15;
 * admins can override the price per account in Settings → Spend.
 */
export const SUBSCRIPTION_PLANS: Record<string, Record<string, SubscriptionPlanInfo>> = {
  anthropic: {
    pro: { label: 'Claude Pro', monthlyUsd: 20 },
    'max-5x': { label: 'Claude Max 5x', monthlyUsd: 100 },
    'max-20x': { label: 'Claude Max 20x', monthlyUsd: 200 },
    team: { label: 'Claude Team', monthlyUsd: 30 },
    enterprise: { label: 'Claude Enterprise', monthlyUsd: null },
  },
  'openai-codex': {
    free: { label: 'ChatGPT Free', monthlyUsd: 0 },
    plus: { label: 'ChatGPT Plus', monthlyUsd: 20 },
    pro: { label: 'ChatGPT Pro', monthlyUsd: 200 },
    business: { label: 'ChatGPT Business', monthlyUsd: 30 },
    enterprise: { label: 'ChatGPT Enterprise', monthlyUsd: null },
    edu: { label: 'ChatGPT Edu', monthlyUsd: null },
  },
}

/** The plan table for a provider; the Claude Code bridge uses Claude's plans. */
export function subscriptionPlansFor(provider: string): Record<string, SubscriptionPlanInfo> | undefined {
  return SUBSCRIPTION_PLANS[provider === 'claude-code' ? 'anthropic' : provider]
}

/** A plan's label; unknown plans are labelled by their id. */
export function planLabel(provider: string, plan: string): string {
  return subscriptionPlansFor(provider)?.[plan]?.label ?? plan
}

// ── Spend API ────────────────────────────────────────────────────────────────

export const SPEND_DIMENSIONS = [
  'feature',
  'provider',
  'model',
  'account',
  'billing',
  'squad',
  'workStream',
  'agent',
  'user',
] as const
export type SpendDimension = (typeof SPEND_DIMENSIONS)[number]

/** The longest range one spend request may cover. */
export const SPEND_MAX_RANGE_DAYS = 400

export interface SpendTotals {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** What calls billed (0 for subscription and self-hosted calls). */
  billedUsd: number
  /** Subscription fees for the range (see the fee rule in docs/wiki/inference-usage.md). */
  subscriptionFeesUsd: number
  /** billedUsd + subscriptionFeesUsd. */
  totalUsd: number
  /** Every call at list price, with no subscription fees: the "without subscriptions" preview. */
  listUsd: number
  /** Some calls had estimated costs or no known list price. */
  approximate: boolean
}

export interface SpendSeriesPoint {
  /** YYYY-MM-DD, UTC. */
  day: string
  billedUsd: number
  listUsd: number
  calls: number
  tokens: number
}

export type SubscriptionPlanSource = 'detected' | 'manual'

export interface SpendSubscriptionLine {
  provider: string
  accountId: string
  label: string
  plan: string | null
  planLabel: string | null
  planSource: SubscriptionPlanSource | null
  /** What the provider reported when it does not map to one priced plan (Claude Code `max`). */
  detectedPlan: string | null
  monthlyPriceUsd: number | null
  priceSource: 'default' | 'custom' | null
  /** No plan or price is known: no fee is counted until an admin chooses one. */
  needsChoice: boolean
  feeUsd: number
  calls: number
  listUsd: number
}

export interface SpendSummary {
  from: string
  to: string
  totals: SpendTotals
  series: SpendSeriesPoint[]
  subscriptions: SpendSubscriptionLine[]
  /** Projected total for the current UTC month at this month's rate, with full subscription fees. */
  projection: { monthUsd: number | null }
  meta: {
    retentionDays: number
    /** Per-call rows are read from this day (UTC) on; earlier days come from daily totals. Null before any pruning. */
    detailFrom: string | null
    /** False when filters narrow to a slice of calls (a squad, a model, ...) that fees cannot be split by. */
    feesIncluded: boolean
  }
}

export interface SpendBreakdownRow {
  key: string | null
  label: string
  key2?: string | null
  label2?: string
  calls: number
  tokens: number
  billedUsd: number
  listUsd: number
  approximate: boolean
}

export interface SpendBreakdown {
  by: SpendDimension
  by2?: SpendDimension
  rows: SpendBreakdownRow[]
  truncated: boolean
}

export interface SpendFilters {
  squadId?: string
  workStreamId?: string
  agentId?: string
  userId?: string
  feature?: string
  provider?: string
  model?: string
  accountId?: string
  billing?: InferenceBilling
}

/** Which filter narrows to one value of a dimension. */
export const SPEND_DIMENSION_FILTER: Record<SpendDimension, keyof SpendFilters> = {
  feature: 'feature',
  provider: 'provider',
  model: 'model',
  account: 'accountId',
  billing: 'billing',
  squad: 'squadId',
  workStream: 'workStreamId',
  agent: 'agentId',
  user: 'userId',
}
