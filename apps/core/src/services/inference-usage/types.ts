import type { InferenceBilling, InferenceUnits } from '@ficus/shared'

/** Who and what a model call is attributed to. Every field is optional; record what the caller knows. */
export interface InferenceAttribution {
  squadId?: string | null
  workStreamId?: string | null
  attemptId?: number | null
  stepId?: string | null
  agentId?: string | null
  executionId?: string | null
  /** The agent/execution that caused this one (a subagent's dispatcher), so spend rolls up to its cause. */
  parentAgentId?: string | null
  parentExecutionId?: string | null
  /** The human whose action caused the call, when known. */
  userId?: string | null
}

export interface InferenceTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** One provider call, as a feature reports it to `recordInferenceUsage`. */
export interface InferenceUsageEvent {
  /** Feature id from INFERENCE_FEATURES (`agent-turn`, `transcription`, ...) or `<prefix>:<purpose>`. */
  feature: string
  provider?: string | null
  model?: string | null
  accountId?: string | null
  /** Omitted: classified from the provider account (see billing.ts). */
  billing?: InferenceBilling
  tokens?: Partial<InferenceTokens>
  units?: InferenceUnits | null
  /** The list cost in USD when the caller already knows it (pi's `usage.cost.total`); omitted: looked up. */
  listCostUsd?: number | null
  /** Token counts are estimates (the provider did not report usage). */
  tokensEstimated?: boolean
  occurredAt?: Date
  attribution?: InferenceAttribution
  source?: Record<string, unknown>
  /** Natural key for at-most-once writes (backfill). */
  dedupeKey?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Keeps only well-formed uuids, so a stray id never fails the insert. */
export function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null
}

/** Attribution from a free-form source record (`{ squadId, agentId, workStreamId, executionId, userId }`). */
export function attributionFromSource(source: Record<string, unknown> | null | undefined): InferenceAttribution {
  if (!source) return {}
  return {
    squadId: uuidOrNull(source.squadId),
    workStreamId: uuidOrNull(source.workStreamId),
    agentId: uuidOrNull(source.agentId),
    executionId: uuidOrNull(source.executionId),
    userId: uuidOrNull(source.userId),
  }
}
