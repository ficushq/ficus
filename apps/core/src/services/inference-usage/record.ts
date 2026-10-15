/**
 * `recordInferenceUsage`: the one call every feature makes after a model call. It never throws and never
 * blocks the caller: billing, pricing and the insert happen in the background, and a failure is logged.
 */
import type { InferenceBilling } from '@ficus/shared'
import { createLogger } from '../../lib/infra/logger'
import type { AccountStoreV1 } from '../agent/account-store'
import { classifyBilling } from './billing'
import { fullTokens, priceUsage, type ModelLookup } from './pricing'
import { uuidOrNull, type InferenceUsageEvent } from './types'

const log = createLogger('inference-usage')

/** A ledger row as inserted into `inference_usage` (id and createdAt are database defaults). */
export interface InferenceUsageRow {
  occurredAt: Date
  feature: string
  provider: string | null
  model: string | null
  accountId: string | null
  billing: InferenceBilling
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  units: InferenceUsageEvent['units'] | null
  costNanodollars: number
  listCostNanodollars: number | null
  costEstimated: boolean
  squadId: string | null
  workStreamId: string | null
  attemptId: number | null
  stepId: string | null
  agentId: string | null
  executionId: string | null
  parentAgentId: string | null
  parentExecutionId: string | null
  userId: string | null
  source: Record<string, unknown> | null
  dedupeKey: string | null
}

export interface InferenceUsageDeps {
  lookupModel: ModelLookup
  store: AccountStoreV1
}

/** Whether an event has anything to account for. */
export function hasUsage(event: InferenceUsageEvent): boolean {
  const tokens = fullTokens(event.tokens)
  if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite > 0) return true
  const units = event.units
  if (units && ((units.audioSeconds ?? 0) > 0 || (units.characters ?? 0) > 0 || (units.images ?? 0) > 0)) return true
  return (event.listCostUsd ?? 0) > 0
}

function text(value: string | null | undefined, max: number): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null
}

/** Builds the row for an event: billing from the account, prices from the model registry. Pure. */
export function buildInferenceUsageRow(event: InferenceUsageEvent, deps: InferenceUsageDeps): InferenceUsageRow {
  const tokens = fullTokens(event.tokens)
  const listKnown =
    typeof event.listCostUsd === 'number' ||
    (event.provider && event.model ? deps.lookupModel(event.provider, event.model) !== undefined : false)
  const billing =
    event.billing ??
    classifyBilling({ provider: event.provider, accountId: event.accountId, hasListPrice: listKnown }, deps)
  const priced = priceUsage(
    {
      feature: event.feature,
      provider: event.provider,
      model: event.model,
      billing,
      tokens,
      units: event.units,
      listCostUsd: event.listCostUsd,
      tokensEstimated: event.tokensEstimated,
    },
    deps
  )
  const attribution = event.attribution ?? {}
  return {
    occurredAt: event.occurredAt ?? new Date(),
    feature: event.feature.slice(0, 64),
    provider: text(event.provider, 64),
    model: text(event.model, 128),
    accountId: text(event.accountId, 64),
    billing,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.cacheRead,
    cacheWriteTokens: tokens.cacheWrite,
    units: event.units ?? null,
    ...priced,
    squadId: uuidOrNull(attribution.squadId),
    workStreamId: uuidOrNull(attribution.workStreamId),
    attemptId: Number.isInteger(attribution.attemptId) ? attribution.attemptId! : null,
    stepId: text(attribution.stepId, 100),
    agentId: uuidOrNull(attribution.agentId),
    executionId: uuidOrNull(attribution.executionId),
    parentAgentId: uuidOrNull(attribution.parentAgentId),
    parentExecutionId: uuidOrNull(attribution.parentExecutionId),
    userId: uuidOrNull(attribution.userId),
    source: event.source && Object.keys(event.source).length > 0 ? event.source : null,
    dedupeKey: text(event.dedupeKey, 160),
  }
}

async function defaultDeps(): Promise<InferenceUsageDeps> {
  const [{ tryGetModelRuntime }, { readAccountStore }] = await Promise.all([
    import('../agent/auth-backend'),
    import('../agent/account-store'),
  ])
  const runtime = tryGetModelRuntime()
  return { lookupModel: (provider, model) => runtime?.getModel(provider, model), store: readAccountStore() }
}

/** Inserts rows; a duplicate dedupe key is skipped. Returns how many rows were new. */
export async function insertInferenceUsageRows(rows: InferenceUsageRow[]): Promise<number> {
  if (rows.length === 0) return 0
  const { db, inferenceUsage } = await import('../../db')
  const inserted = await db
    .insert(inferenceUsage)
    .values(rows)
    // The only unique index besides the id is the partial dedupe-key one, so a plain DO NOTHING skips
    // exactly the duplicate dedupe keys.
    .onConflictDoNothing()
    .returning({ id: inferenceUsage.id })
  return inserted.length
}

type Sink = (event: InferenceUsageEvent) => void | Promise<void>
let testSink: Sink | undefined
let depsOverride: (() => Promise<InferenceUsageDeps>) | undefined
const pending = new Set<Promise<void>>()

/**
 * Records one provider call in the ledger. Synchronous and never throws: the write happens in the
 * background. Events with no tokens, units or cost are skipped (there is nothing to account for).
 */
export function recordInferenceUsage(event: InferenceUsageEvent): void {
  try {
    if (!event?.feature || !hasUsage(event)) return
    const snapshot: InferenceUsageEvent = {
      ...event,
      occurredAt: event.occurredAt ?? new Date(),
      attribution: event.attribution ? { ...event.attribution } : undefined,
    }
    const work = (async () => {
      if (testSink) return void (await testSink(snapshot))
      const deps = await (depsOverride ?? defaultDeps)()
      await insertInferenceUsageRows([buildInferenceUsageRow(snapshot, deps)])
    })()
      .catch((error) => log.warn('Could not record inference usage', { feature: event.feature, error }))
      .finally(() => pending.delete(work))
    pending.add(work)
  } catch (error) {
    log.warn('Could not record inference usage', { feature: event?.feature, error })
  }
}

/** Waits for every background write started so far (tests, graceful shutdown). */
export async function flushInferenceUsage(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending])
}

/** Test seam: capture events instead of writing them (undefined restores the database write). */
export function setInferenceUsageSinkForTest(sink: Sink | undefined): void {
  testSink = sink
}

/** Test seam: price and classify with fixed deps instead of the live model runtime and account store. */
export function setInferenceUsageDepsForTest(deps: InferenceUsageDeps | undefined): void {
  depsOverride = deps ? async () => deps : undefined
}
