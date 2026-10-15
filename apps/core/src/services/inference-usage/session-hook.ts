/**
 * Records every model call an agent session makes: one ledger row per assistant message (so failover is
 * attributed to the model that actually answered) and one per compaction summary.
 */
import type { Usage } from '@earendil-works/pi-ai'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { recordInferenceUsage } from './record'
import type { InferenceAttribution } from './types'

export interface SessionUsageContext {
  /** Feature id for the session's own turns (`agent-turn`, `ai-extract`, `compaction`, ...). */
  feature: string
  /** Read at each call, so attribution can change during a session (a new sender, a new execution). */
  attribution?: () => InferenceAttribution
  /** The account currently serving a provider. */
  getAccountId: (provider: string) => string | undefined
  /** The model the session uses now, for compaction summaries (they carry no model of their own). */
  getModel: () => { provider: string; id: string } | undefined
  source?: Record<string, unknown>
}

/**
 * Compaction summaries already recorded when they were made (pre-compaction bakes, fit fallbacks). pi
 * passes the summary's `usage` object through unchanged to `compaction_end`, so the hook skips those.
 */
const recordedSummaryUsage = new WeakSet<object>()

function listCost(usage: Usage): number | undefined {
  // pi prices calls with the model's own table; 0 means "unpriced" (Claude Code bridge, compatible
  // endpoints), so leave the list price to the ledger's lookup.
  const total = usage.cost?.total
  return typeof total === 'number' && total > 0 ? total : undefined
}

function tokensOf(usage: Usage) {
  return { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite }
}

function safeAttribution(context: Pick<SessionUsageContext, 'attribution'>): InferenceAttribution | undefined {
  try {
    return context.attribution?.()
  } catch {
    return undefined
  }
}

/** Records a compaction summary made outside pi's own compaction (a bake or a fit fallback). */
export function recordCompactionSummary(
  context: Pick<SessionUsageContext, 'attribution' | 'getAccountId' | 'source'>,
  info: { kind: 'precompaction' | 'compaction'; model: { provider: string; id: string }; usage: Usage | undefined }
): void {
  if (!info.usage) return
  recordedSummaryUsage.add(info.usage)
  recordInferenceUsage({
    feature: info.kind,
    provider: info.model.provider,
    model: info.model.id,
    accountId: context.getAccountId(info.model.provider),
    tokens: tokensOf(info.usage),
    listCostUsd: listCost(info.usage),
    attribution: safeAttribution(context),
    source: { ...context.source, summary: info.kind === 'precompaction' ? 'bake' : 'fit-fallback' },
  })
}

/** Handles one session event. Exported for tests; `attachInferenceUsageRecorder` subscribes it. */
export function handleSessionUsageEvent(event: AgentSessionEvent, context: SessionUsageContext): void {
  if (event.type === 'message_end') {
    const message = event.message as { role?: string } & Partial<{
      provider: string
      model: string
      usage: Usage
      stopReason: string
      responseId: string
      responseModel: string
    }>
    if (message.role !== 'assistant' || !message.usage) return
    const provider = message.provider ?? null
    recordInferenceUsage({
      feature: context.feature,
      provider,
      model: message.model ?? null,
      accountId: provider ? context.getAccountId(provider) : undefined,
      tokens: tokensOf(message.usage),
      listCostUsd: listCost(message.usage),
      attribution: safeAttribution(context),
      source: {
        ...context.source,
        stopReason: message.stopReason,
        ...(message.responseId ? { responseId: message.responseId } : {}),
        ...(message.responseModel && message.responseModel !== message.model
          ? { responseModel: message.responseModel }
          : {}),
      },
    })
    return
  }
  if (event.type === 'compaction_end') {
    const usage = event.result?.usage
    if (!usage || recordedSummaryUsage.has(usage)) return
    const model = context.getModel()
    recordInferenceUsage({
      feature: 'compaction',
      provider: model?.provider ?? null,
      model: model?.id ?? null,
      accountId: model ? context.getAccountId(model.provider) : undefined,
      tokens: tokensOf(usage),
      listCostUsd: listCost(usage),
      attribution: safeAttribution(context),
      source: { ...context.source, reason: event.reason },
    })
  }
}

/** Subscribes the ledger to a pi session. Returns the unsubscribe function. */
export function attachInferenceUsageRecorder(
  session: { subscribe: (listener: (event: AgentSessionEvent) => void) => () => void },
  context: SessionUsageContext
): () => void {
  return session.subscribe((event) => {
    try {
      handleSessionUsageEvent(event, context)
    } catch {
      // Accounting must never disturb a session.
    }
  })
}
