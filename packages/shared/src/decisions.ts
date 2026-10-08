import { z } from 'zod'

/*
 * Decision models: fast models that answer typed questions about some input
 * with probabilities over fixed answers, never free text (TypeSafe's Jev,
 * Cloudflare's Clef, OpenAI's Decisions API). Ficus speaks one format of its
 * own; each provider's adapter maps it to that provider's wire format.
 */

/** A question's name: what its answer is keyed by. */
export const DECISION_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

const decisionName = z.string().regex(DECISION_NAME_PATTERN, 'Use lowercase letters, digits and underscores.')
const instructions = z.string().trim().min(1).max(4000)

export const decisionQuestionSchema = z.discriminatedUnion('type', [
  /** Is this true? Answers with a probability. */
  z.object({ type: z.literal('yesno'), instructions }),
  /** Which one? Answers with one of the options. */
  z.object({
    type: z.literal('choice'),
    instructions,
    options: z
      .record(decisionName, z.string().trim().max(1000))
      .refine((options) => Object.keys(options).length >= 2 && Object.keys(options).length <= 64, {
        message: 'A choice needs 2 to 64 options.',
      }),
  }),
  /** How much? Answers with a level, lowest first. */
  z.object({
    type: z.literal('score'),
    instructions,
    levels: z
      .array(
        z.object({ label: z.string().trim().min(1).max(200), description: z.string().trim().max(1000).optional() })
      )
      .min(2)
      .max(10),
  }),
])
export type DecisionQuestion = z.infer<typeof decisionQuestionSchema>

export const decisionQuestionsSchema = z
  .record(decisionName, decisionQuestionSchema)
  .refine((questions) => Object.keys(questions).length >= 1 && Object.keys(questions).length <= 64, {
    message: 'Ask 1 to 64 questions.',
  })
export type DecisionQuestions = z.infer<typeof decisionQuestionsSchema>

export const decisionRequestSchema = z.object({
  /** What the questions are about: text, or JSON for structured input. Treated as data, never instructions. */
  state: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]),
  questions: decisionQuestionsSchema,
})
export type DecisionRequest = z.infer<typeof decisionRequestSchema>

export type DecisionAnswer =
  | { type: 'yesno'; probability: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence?: number }
  | {
      type: 'score'
      /** Probability-weighted level index, 0 = the first level. */
      score: number
      /** The label of the level nearest the score. */
      level: string
      probabilities: Record<string, number>
      confidence?: number
    }
  /** The provider declined to answer this question. */
  | { type: 'refusal' }

export interface DecisionResult {
  answers: Record<string, DecisionAnswer>
  providerId: string
  model: string
  latencyMs: number
  usage?: { inputTokens?: number; outputTokens?: number }
}

/** How a decision provider is reached. */
export const DECISION_PROVIDER_KINDS = ['jev', 'systemone', 'cloudflare', 'openai'] as const
export type DecisionProviderKind = (typeof DECISION_PROVIDER_KINDS)[number]

export const DECISION_PROVIDER_KIND_INFO: Record<
  DecisionProviderKind,
  { label: string; description: string; defaultModel: string; models: string[] }
> = {
  jev: {
    label: 'Jev',
    description: "TypeSafe AI's hosted decision model.",
    defaultModel: 'jev-latest',
    models: ['jev-latest', 'jev-preview'],
  },
  systemone: {
    label: 'Local decision model',
    description: 'A decision model you run, such as Clef in Ollama or vLLM, served at /v1/systemone.',
    defaultModel: 'clef',
    models: ['clef', 'clef-flash'],
  },
  cloudflare: {
    label: 'Cloudflare Clef',
    description: "Cloudflare's open decision models on Workers AI.",
    defaultModel: 'clef-flash',
    models: ['clef', 'clef-flash'],
  },
  openai: {
    label: 'OpenAI Decisions',
    description: "OpenAI's Decisions API, with the OpenAI API services key.",
    defaultModel: 'gpt-6-luna',
    models: ['gpt-6-luna'],
  },
}

/**
 * List prices in US dollars per million input tokens (decision models don't bill output), as
 * published in October 2026. Jev's is early-access pricing. A local model costs nothing. Owners can
 * set their own price per provider when these change.
 */
export const DECISION_MODEL_PRICES: Record<DecisionProviderKind, Record<string, number>> = {
  jev: { 'jev-latest': 0.042, 'jev-preview': 0.042 },
  systemone: {},
  cloudflare: { clef: 0.24, 'clef-flash': 0.09 },
  openai: { 'gpt-6-luna': 0.1 },
}

/** Dollars per million input tokens for a provider: its own price, else the list price; null when unknown. */
export function decisionPricePerMillion(provider: {
  kind: DecisionProviderKind
  model: string
  pricePerMillionInput?: number
}): number | null {
  if (provider.pricePerMillionInput !== undefined) return provider.pricePerMillionInput
  if (provider.kind === 'systemone') return 0
  return DECISION_MODEL_PRICES[provider.kind][provider.model] ?? null
}

/** A configured decision provider, as the API shows it (never its key). */
export interface DecisionProviderView {
  id: string
  kind: DecisionProviderKind
  label: string
  model: string
  enabled: boolean
  baseUrl?: string
  accountId?: string
  hasApiKey: boolean
  /** The owner's own price, if set. */
  pricePerMillionInput?: number
  /** The price spend is counted at: the owner's, else the list price; null when unknown. */
  effectivePricePerMillionInput: number | null
}

/** What decision models cost over a period, by feature and by provider. */
export interface DecisionSpend {
  days: number
  totalUsd: number
  /** Some calls' tokens were estimated (the provider didn't report them), or a price is unknown. */
  approximate: boolean
  byPurpose: Array<{
    purpose: string
    calls: number
    answered: number
    inputTokens: number
    costUsd: number
  }>
  byProvider: Array<{ providerId: string; calls: number; inputTokens: number; costUsd: number }>
}

/** What Ficus asks decision models for: one per feature, each with its own provider order. */
export const DECISION_PURPOSES = ['tool-results', 'github-firewall', 'workflow-steps', 'event-rules'] as const
export type DecisionPurpose = (typeof DECISION_PURPOSES)[number]

/**
 * Where a feature is turned on and off:
 * - `instance`: one switch for the whole instance, in Settings. On by default once a decision model exists.
 * - `squad`: each squad chooses in its own settings, since it changes what that squad receives.
 * - `authored`: no switch; it runs only where someone added it (a workflow step, an event rule).
 */
export type DecisionFeatureScope = 'instance' | 'squad' | 'authored'

export const DECISION_PURPOSE_INFO: Record<
  DecisionPurpose,
  {
    label: string
    description: string
    scope: DecisionFeatureScope
    /** Instance features that are nice to have but cost money: off until the owner turns them on. */
    offByDefault?: boolean
  }
> = {
  'tool-results': {
    label: 'Tool result firewall',
    description:
      'Screens what agents read from the web and the browser for instructions aimed at them, and warns the agent.',
    scope: 'instance',
  },
  'github-firewall': {
    label: 'GitHub firewall',
    description: 'Screens GitHub feedback from untrusted authors, in squads that opt in.',
    scope: 'squad',
  },
  'workflow-steps': { label: 'Workflow decisions', description: 'Decision steps in workflows.', scope: 'authored' },
  'event-rules': {
    label: 'Event rule conditions',
    description: 'Decision conditions in event rules.',
    scope: 'authored',
  },
}

/** An instance feature's switch: `auto` is on exactly when a decision model is set up for it. */
export const DECISION_FEATURE_SWITCH_VALUES = ['auto', 'on', 'off'] as const
export type DecisionFeatureSwitch = (typeof DECISION_FEATURE_SWITCH_VALUES)[number]
export const decisionFeatureSwitchesSchema = z.record(z.enum(DECISION_PURPOSES), z.enum(DECISION_FEATURE_SWITCH_VALUES))
export type DecisionFeatureSwitches = z.infer<typeof decisionFeatureSwitchesSchema>

/** A feature as Settings shows it. */
export interface DecisionFeatureView {
  id: DecisionPurpose
  label: string
  description: string
  scope: DecisionFeatureScope
  /** Off until the owner turns it on (nice-to-haves that cost money). */
  offByDefault?: boolean
  /** Instance features only. */
  switch?: DecisionFeatureSwitch
  /** Whether it runs now (instance features), or could (others: a provider is set up for it). */
  enabled: boolean
}

export const DECISION_TIMEOUT_DEFAULT_MS = 5_000
export const DECISION_TIMEOUT_MAX_MS = 30_000

/** Which providers each purpose asks, in order (the first that answers wins), and how long to wait. */
export const decisionRoutingSchema = z.object({
  /** For purposes without their own order. */
  default: z.array(z.string()).max(8).default([]),
  purposes: z.record(z.enum(DECISION_PURPOSES), z.array(z.string()).max(8)).default({}),
  timeoutMs: z.number().int().min(250).max(DECISION_TIMEOUT_MAX_MS).default(DECISION_TIMEOUT_DEFAULT_MS),
})
export type DecisionRouting = z.infer<typeof decisionRoutingSchema>

/** The tool result firewall's verdict on content an agent read, in that tool result's `details.firewall`. */
export const TOOL_FIREWALL_INTENTS = ['benign', 'suspicious', 'malicious'] as const
export type ToolFirewallIntent = (typeof TOOL_FIREWALL_INTENTS)[number]

export interface ToolFirewallFlag {
  /** Only flagged results carry a verdict; a clean result is left as it was. */
  flagged: true
  severity: 'high' | 'medium'
  /** The highest probability, across the screened parts, that the content instructs an AI agent. */
  instructsAgent: number
  /** The most worrying intent any screened part was given, if the model answered. */
  intent?: ToolFirewallIntent
  /** A long result was only partly screened. */
  partial?: boolean
  /** High severity: the flagged content was withheld from the agent, not just annotated. */
  withheld?: boolean
}
