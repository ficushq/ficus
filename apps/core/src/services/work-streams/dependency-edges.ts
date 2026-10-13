import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  isStackedDependencyEdge,
  resolveCodeHostReference,
  workStreamTitle,
  type WorkStreamDependencyCondition,
  type WorkStreamDependencyEdgeState,
  type WorkflowRun,
} from '@ficus/shared'
import { workStreamFlowRuns, workStreams, workStreamWaits } from '../../db/schema'
import type { DbHandle } from './waits'

/**
 * `ready` dependency edges.
 *
 * `workStreams.dependsOn` is the authoritative list of dependency IDs.
 * `workStreams.dependencyEdges` holds, per dependency ID, the server-owned
 * state of an edge whose unlock condition is `ready`; an ID without an entry
 * waits for `done`, exactly as before this column existed.
 *
 * A `ready` edge is satisfied when the dependency is done, or when its flow is
 * `completion-ready` under a pull-request completion mode and its delivery
 * change request is bound. The first time that is observed while the
 * dependency is not done, `readyUnlockedAt` is stamped and the edge stays
 * satisfied from then on.
 */

export type DependencyEdges = Record<string, WorkStreamDependencyEdgeState>

/** The stored edge object for one dependency ID. */
const edgeOf = (dependencyId: string) => sql`(${workStreams.dependencyEdges}->(${dependencyId}::text))`

const PULL_REQUEST_MODES = ['pr-merge', 'pr-auto-merge']

/** The dependency's work is implemented and its delivery pull request is open. */
export function isDependencyReady(
  status: string | undefined,
  metadata: unknown,
  run: { activated: boolean; state: WorkflowRun } | undefined
): boolean {
  if (status !== 'active' && status !== 'queued') return false
  if (!run?.activated || run.state.status !== 'completion-ready') return false
  if (!PULL_REQUEST_MODES.includes(run.state.definition.completion.mode)) return false
  return !!resolveCodeHostReference(metadata)?.changeRequest
}

/** IDs among `dependencyIds` that are ready right now. Two set-based reads, no per-stream loop. */
export async function loadReadyDependencyIds(tx: DbHandle, dependencyIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(dependencyIds)]
  if (ids.length === 0) return new Set()
  const runs = await tx
    .select({
      id: workStreams.id,
      status: workStreams.status,
      metadata: workStreams.metadata,
      activated: workStreamFlowRuns.activated,
      state: workStreamFlowRuns.state,
    })
    .from(workStreamFlowRuns)
    .innerJoin(workStreams, eq(workStreams.id, workStreamFlowRuns.workStreamId))
    .where(inArray(workStreamFlowRuns.workStreamId, ids))
  return new Set(runs.filter((run) => isDependencyReady(run.status, run.metadata, run)).map((run) => run.id))
}

/** Dependencies of this stream whose `ready` edge has not unlocked yet. */
export function pendingReadyDependencyIds(stream: {
  dependsOn: string[] | null
  dependencyEdges: DependencyEdges | null
}): string[] {
  const edges = stream.dependencyEdges ?? {}
  return (stream.dependsOn ?? []).filter((id) => edges[id]?.condition === 'ready' && !edges[id]?.readyUnlockedAt)
}

/**
 * Stamp `readyUnlockedAt` on one edge and close its open dependency wait.
 * The write is a guarded `jsonb_set`, so it composes with a concurrent edge
 * rewrite: it only lands while the edge is still declared `ready` and still
 * unstamped. Returns whether this call unlocked the edge.
 */
export async function unlockReadyEdge(
  tx: DbHandle,
  streamId: string,
  dependencyId: string,
  at = new Date()
): Promise<boolean> {
  const unlocked = await tx
    .update(workStreams)
    .set({
      dependencyEdges: sql`jsonb_set(${workStreams.dependencyEdges}, ${`{${dependencyId},readyUnlockedAt}`}::text[], to_jsonb(${at.toISOString()}::text))`,
      updatedAt: at,
    })
    .where(
      and(
        eq(workStreams.id, streamId),
        sql`${workStreams.dependsOn} @> ARRAY[${dependencyId}]::uuid[]`,
        sql`${edgeOf(dependencyId)}->>'condition' = 'ready'`,
        sql`${edgeOf(dependencyId)}->>'readyUnlockedAt' IS NULL`
      )
    )
    .returning({ id: workStreams.id })
  if (unlocked.length === 0) return false
  await tx
    .update(workStreamWaits)
    .set({ closedAt: at, resolution: 'satisfied', resolutionNote: 'dependency ready: its pull request is open' })
    .where(
      and(
        eq(workStreamWaits.workStreamId, streamId),
        eq(workStreamWaits.type, 'dependency'),
        eq(workStreamWaits.referenceId, dependencyId),
        isNull(workStreamWaits.closedAt)
      )
    )
  return true
}

/**
 * Write an edge's `stack` state: `replace` records the one-time decision, otherwise the patch is
 * merged into the existing decision. No-op when the edge is gone. Returns whether a row changed.
 */
export async function patchEdgeStack(
  tx: DbHandle,
  streamId: string,
  dependencyId: string,
  patch: Record<string, unknown>,
  options: { replace?: boolean } = {}
): Promise<boolean> {
  const value = JSON.stringify(patch)
  const next = options.replace
    ? sql`${value}::jsonb`
    : sql`coalesce(${edgeOf(dependencyId)}->'stack', '{}'::jsonb) || ${value}::jsonb`
  const rows = await tx
    .update(workStreams)
    .set({
      dependencyEdges: sql`jsonb_set(${workStreams.dependencyEdges}, ${`{${dependencyId},stack}`}::text[], ${next})`,
    })
    .where(
      and(
        eq(workStreams.id, streamId),
        sql`${edgeOf(dependencyId)}->>'condition' = 'ready'`,
        // A decision is written once; a merge patch only refines an existing one.
        options.replace
          ? sql`${edgeOf(dependencyId)}->'stack' IS NULL`
          : sql`${edgeOf(dependencyId)}->'stack' IS NOT NULL`
      )
    )
    .returning({ id: workStreams.id })
  return rows.length > 0
}

/**
 * The stored edges for a dependency write. A plain ID means `done` and stores
 * nothing. A `ready` edge that already existed keeps its server-owned state,
 * so re-sending the same dependency list never re-blocks an unlocked stream
 * or releases a delivery hold.
 */
export function nextDependencyEdges(
  dependencyIds: string[],
  conditions: Record<string, WorkStreamDependencyCondition>,
  previous: DependencyEdges | null | undefined
): DependencyEdges {
  const next: DependencyEdges = {}
  for (const id of dependencyIds) {
    if (conditions[id] !== 'ready') continue
    next[id] = previous?.[id]?.condition === 'ready' ? previous[id] : { condition: 'ready' }
  }
  return next
}

/** A dependency the stream builds on, with what the stream needs to know about it now. */
export interface StackedDependency {
  id: string
  label: string
  status: string | undefined
  mode: 'stacked' | 'included' | 'manual'
  branch: string
  headSha?: string
  reason?: string
}

/** The stream's stacked dependencies with their current status. One read. */
export async function loadStackedDependencies(
  tx: DbHandle,
  stream: { dependsOn: string[] | null; dependencyEdges: DependencyEdges | null }
): Promise<StackedDependency[]> {
  const edges = stream.dependencyEdges ?? {}
  const ids = (stream.dependsOn ?? []).filter((id) => isStackedDependencyEdge(edges[id]))
  if (ids.length === 0) return []
  const rows = await tx
    .select({ id: workStreams.id, number: workStreams.number, title: workStreams.title, status: workStreams.status })
    .from(workStreams)
    .where(inArray(workStreams.id, ids))
  const byId = new Map(rows.map((row) => [row.id, row]))
  return ids.map((id) => {
    const edge = edges[id]
    if (!isStackedDependencyEdge(edge)) throw new Error('unreachable')
    const row = byId.get(id)
    return {
      id,
      label: row ? workStreamTitle(row) : id.slice(0, 8),
      status: row?.status,
      mode: edge.stack.mode,
      branch: edge.stack.branch,
      ...(edge.stack.headSha ? { headSha: edge.stack.headSha } : {}),
      ...(edge.stack.reason ? { reason: edge.stack.reason } : {}),
    }
  })
}

/** Stacked dependencies that have not merged: the stream's delivery waits for each of them. */
export function unmergedStackedDependencies(dependencies: StackedDependency[]): StackedDependency[] {
  return dependencies.filter((dependency) => dependency.status !== 'done')
}

function describeHold(dependency: StackedDependency): string {
  return dependency.status === 'canceled'
    ? `"${dependency.label}" (branch ${dependency.branch}) was canceled and will never merge. Remove its commits from this branch, then have the owner drop the dependency (ficus workstream update --depends-on or --clear-dependencies) to release the hold`
    : `"${dependency.label}" (branch ${dependency.branch}) has not merged yet`
}

/** Raised when a stream is completed while a dependency it builds on has not merged. */
export class WorkStreamStackedDeliveryHoldError extends Error {
  constructor(readonly dependencies: StackedDependency[]) {
    super(
      `Delivery is held: this work stream builds on ${dependencies.length === 1 ? 'a dependency' : 'dependencies'} whose work has not merged. ${dependencies
        .map(describeHold)
        .join(
          '; '
        )}. Finish after every such dependency has merged and the base branch has been merged into this branch.`
    )
    this.name = 'WorkStreamStackedDeliveryHoldError'
  }
}

/** Refuse completion while any dependency the stream builds on is unmerged. */
export async function assertNoStackedDeliveryHold(
  tx: DbHandle,
  stream: { dependsOn: string[] | null; dependencyEdges: DependencyEdges | null }
): Promise<void> {
  const held = unmergedStackedDependencies(await loadStackedDependencies(tx, stream))
  if (held.length > 0) throw new WorkStreamStackedDeliveryHoldError(held)
}

/**
 * What every participant of a stacked stream must know: which branch it was
 * built on (or must merge in), and that delivery is held until the merge.
 * Derived from current statuses, so it never contradicts what finish enforces.
 */
export function stackedDependencyNotice(
  dependencies: StackedDependency[],
  git: { remote?: unknown; baseBranch?: unknown } | undefined
): string | undefined {
  if (dependencies.length === 0) return undefined
  const remote = typeof git?.remote === 'string' && git.remote ? git.remote : 'origin'
  const base = typeof git?.baseBranch === 'string' && git.baseBranch ? git.baseBranch : 'the base branch'
  const head = (dependency: StackedDependency) => (dependency.headSha ? ` at ${dependency.headSha}` : '')
  const lines = dependencies.map((dependency) => {
    const how =
      dependency.mode === 'stacked'
        ? `this stream's branch was built on its branch ${dependency.branch}${head(dependency)}`
        : dependency.mode === 'included'
          ? `its branch ${dependency.branch}${head(dependency)} is already contained in the branch this stream was built on`
          : `its branch ${dependency.branch} was NOT merged into this stream's branch automatically${dependency.reason ? ` (${dependency.reason})` : ''}. Merge it in yourself: git fetch ${remote} ${dependency.branch} && git merge FETCH_HEAD`
    const state =
      dependency.status === 'done'
        ? `It has merged: merge ${base} into this branch before delivery.`
        : dependency.status === 'canceled'
          ? 'It was canceled and will never merge: its commits must not be delivered. Tell the owner, who decides whether to remove them and drop the dependency.'
          : 'It has not merged yet.'
    return `- "${dependency.label}": ${how}. ${state}`
  })
  const held = unmergedStackedDependencies(dependencies)
  return [
    'Stacked dependencies (this stream started before they merged):',
    ...lines,
    held.length > 0
      ? `Delivery hold: this work stream cannot finish, and its pull request must not merge, until ${held.length === 1 ? 'that dependency has' : 'every dependency above has'} merged. Opening the pull request as a draft is fine. Do not enable auto-merge until then; once merged, merge ${base} into this branch first. This takes precedence over any instruction to enable auto-merge. ficus workstream finish refuses while the hold applies.`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}
