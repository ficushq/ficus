import { and, inArray, isNull } from 'drizzle-orm'
import {
  compareByEffectivePriorityThenCreatedAt,
  computeEffectivePriorities,
  type WorkStreamPriority,
} from '@ficus/shared'
import { db } from '../../db'
import { workStreams, workStreamWaits } from '../../db/schema'

export interface PriorityAnnotations {
  effectivePriority: WorkStreamPriority
  /** Title of the dependent that produced the boost — only when effective differs from stored. */
  effectivePriorityVia?: string
  /** 1-based admission-queue position — only for ELIGIBLE (deps-done) `queued` streams. */
  queuePosition?: number
  /** Queued but dep-blocked: not in the admission order until every dependency is done. */
  waitingOnDependencies?: boolean
}

/**
 * Compute the surfaced priority annotations for a set of streams: effective
 * priority (blocker boosting over each stream's squad graph), the boosting
 * dependent's title when it differs from the stored priority, and the
 * admission-queue position for queued streams (ordered exactly like the
 * admission controller: effective priority desc, created_at asc, id asc).
 */
export async function computePriorityAnnotations(
  streams: { id: string; squadId: string }[]
): Promise<Map<string, PriorityAnnotations>> {
  const result = new Map<string, PriorityAnnotations>()
  const squadIds = [...new Set(streams.map((s) => s.squadId))]
  if (squadIds.length === 0) return result

  const rows = await db
    .select({
      id: workStreams.id,
      squadId: workStreams.squadId,
      title: workStreams.title,
      status: workStreams.status,
      priority: workStreams.priority,
      dependsOn: workStreams.dependsOn,
      createdAt: workStreams.createdAt,
    })
    .from(workStreams)
    .where(inArray(workStreams.squadId, squadIds))

  // Dependencies may live outside the loaded squads — resolve unknown ids
  // globally so eligibility matches the admission controller exactly.
  const knownIds = new Set(rows.map((r) => r.id))
  const externalDepIds = [
    ...new Set(rows.filter((r) => r.status === 'queued').flatMap((r) => r.dependsOn ?? [])),
  ].filter((id) => !knownIds.has(id))
  const externalDeps =
    externalDepIds.length > 0
      ? await db
          .select({ id: workStreams.id, status: workStreams.status })
          .from(workStreams)
          .where(inArray(workStreams.id, externalDepIds))
      : []
  const statusOf = new Map<string, string>([
    ...rows.map((r): [string, string] => [r.id, r.status]),
    ...externalDeps.map((r): [string, string] => [r.id, r.status]),
  ])
  const isDepsSatisfied = (dependsOn: string[] | null): boolean =>
    (dependsOn ?? []).every((d) => statusOf.get(d) === 'done')

  // Open waits gate admissibility exactly like the admission controller: a
  // queued stream with ANY open wait holds no queue position.
  const queuedIds = rows.filter((r) => r.status === 'queued').map((r) => r.id)
  const openWaitRows =
    queuedIds.length > 0
      ? await db
          .select({ workStreamId: workStreamWaits.workStreamId })
          .from(workStreamWaits)
          .where(and(inArray(workStreamWaits.workStreamId, queuedIds), isNull(workStreamWaits.closedAt)))
      : []
  const hasOpenWait = new Set(openWaitRows.map((r) => r.workStreamId))
  const isEligible = (id: string, dependsOn: string[] | null): boolean =>
    !hasOpenWait.has(id) && isDepsSatisfied(dependsOn)

  const wanted = new Set(streams.map((s) => s.id))
  for (const squadId of squadIds) {
    const squadRows = rows.filter((r) => r.squadId === squadId)
    const graph = squadRows.map((r) => ({
      id: r.id,
      title: r.title,
      priority: r.priority,
      status: r.status,
      dependsOn: r.dependsOn ?? [],
    }))
    const effective = computeEffectivePriorities(graph)
    const titleOf = new Map(squadRows.map((r) => [r.id, r.title]))

    // Position counts ELIGIBLE queued streams only — a dep-blocked stream is
    // not "next in line" no matter how old or high-priority it is.
    const queueOrder = squadRows
      .filter((r) => r.status === 'queued' && isEligible(r.id, r.dependsOn))
      .map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        effective: effective.get(r.id)?.effective ?? r.priority,
      }))
      .sort(compareByEffectivePriorityThenCreatedAt)
    const positions = new Map(queueOrder.map((entry, index) => [entry.id, index + 1]))

    for (const row of squadRows) {
      if (!wanted.has(row.id)) continue
      const entry = effective.get(row.id)
      const effectivePriority = entry?.effective ?? row.priority
      const annotations: PriorityAnnotations = { effectivePriority }
      if (effectivePriority !== row.priority && entry?.viaId) {
        annotations.effectivePriorityVia = titleOf.get(entry.viaId) ?? entry.viaId
      }
      const position = positions.get(row.id)
      if (position !== undefined) annotations.queuePosition = position
      if (row.status === 'queued' && !isDepsSatisfied(row.dependsOn)) annotations.waitingOnDependencies = true
      result.set(row.id, annotations)
    }
  }
  return result
}
