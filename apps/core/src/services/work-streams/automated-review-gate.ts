import { inArray } from 'drizzle-orm'
import type { WorkStreamDeliveryPresentation, WorkStreamWait } from '@ficus/shared'
import { db, squads } from '../../db'
import { codeHostingRegistry } from '../integrations/code-hosting'

export interface AutomatedReviewGateStream {
  id: string
  squadId: string
  metadata: unknown
}

/** The derived facts the gate predicate needs; satisfied by DerivedStreamInfo. */
export interface AutomatedReviewGateFacts {
  delivery?: Pick<WorkStreamDeliveryPresentation, 'kind'>
  openWaits?: ReadonlyArray<Pick<WorkStreamWait, 'type' | 'closedAt'>>
}

function hasOpenReviewWait(derived: AutomatedReviewGateFacts | undefined): boolean {
  return !!derived?.openWaits?.some((wait) => wait.type === 'review' && wait.closedAt === null)
}

/**
 * True when an open review wait is a delivery gate the code host settles
 * without a human verdict, verified against the delivery flow:
 *
 * - `delivery.kind === 'external'` — an activated completion-ready run whose
 *   tracked change request is waiting on the code host (CI pending, merge not
 *   yet required of a human). The presentation comes from live integration
 *   evidence, never from the `metadata.github.ci` notification watermark
 *   ledger. It also implies the tracked change request binding below.
 * - `completion.mode === 'pr-auto-merge'` — the flow completes by auto-merge.
 *   `pr-merge`/`direct-merge` always end in a human or agent merge action.
 * - the squad `policies.allowAutoMerge === true` — without the policy the
 *   delivery instructions forbid enabling native auto-merge and leave the PR
 *   open for a human merge, so the review wait stays human-actionable.
 *
 * An approved or sent-back review wait is closed, so approval and rework
 * naturally drop the annotation. Absent facts (older callers) stay
 * human-actionable, matching the shared sort's back-compat default.
 */
export function isAutomatedReviewGate(
  stream: Pick<AutomatedReviewGateStream, 'metadata'>,
  derived: AutomatedReviewGateFacts | undefined,
  allowAutoMerge: unknown
): boolean {
  if (derived?.delivery?.kind !== 'external') return false
  if (!hasOpenReviewWait(derived)) return false
  if (allowAutoMerge !== true) return false
  const metadata = (stream.metadata ?? {}) as Record<string, unknown>
  const completion = (metadata.completion ?? {}) as Record<string, unknown>
  if (completion.mode !== 'pr-auto-merge') return false
  return !!codeHostingRegistry.resolve(stream.metadata)?.reference.changeRequest
}

/**
 * Annotate which streams' open review waits are automated delivery gates.
 * Batches one squads-metadata read; only squads of review-waiting external
 * deliveries are probed.
 */
export async function computeAutomatedReviewGates(
  streams: readonly AutomatedReviewGateStream[],
  derivedByStream: ReadonlyMap<string, AutomatedReviewGateFacts | undefined>
): Promise<Set<string>> {
  const candidates = streams.filter((stream) => {
    const derived = derivedByStream.get(stream.id)
    return derived?.delivery?.kind === 'external' && hasOpenReviewWait(derived)
  })
  if (candidates.length === 0) return new Set<string>()
  const squadIds = [...new Set(candidates.map((stream) => stream.squadId))]
  const rows = await db
    .select({ id: squads.id, metadata: squads.metadata })
    .from(squads)
    .where(inArray(squads.id, squadIds))
  const allowAutoMerge = new Map(
    rows.map((row) => [
      row.id,
      (row.metadata as { policies?: { allowAutoMerge?: unknown } } | null)?.policies?.allowAutoMerge === true,
    ])
  )
  return new Set(
    candidates
      .filter((stream) =>
        isAutomatedReviewGate(stream, derivedByStream.get(stream.id), allowAutoMerge.get(stream.squadId))
      )
      .map((stream) => stream.id)
  )
}
