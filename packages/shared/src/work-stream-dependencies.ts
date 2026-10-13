/**
 * Per-edge unlock conditions for work-stream dependencies.
 *
 * `dependsOn` stays the authoritative list of dependency IDs (cycle checks,
 * the graph, effective priority). Each edge additionally carries an unlock
 * condition: `done` (the default, the dependency must be done) or `ready`
 * (the dependency's work is implemented and its delivery pull request is
 * open, or it is done).
 */

export const WORK_STREAM_DEPENDENCY_CONDITIONS = ['done', 'ready'] as const
export type WorkStreamDependencyCondition = (typeof WORK_STREAM_DEPENDENCY_CONDITIONS)[number]

/** A dependency as callers write it: a bare ID means `done`. */
export type WorkStreamDependencyInput = string | { id: string; condition?: WorkStreamDependencyCondition }

/**
 * How a `ready` unlock relates the dependent's branch to the dependency's:
 * - `stacked`: the dependent's branch was moved onto this dependency's branch head.
 * - `included`: another stacked dependency's branch already contains this one.
 * - `manual`: nothing was rewritten; the assignee was told to merge the branch in.
 */
export type WorkStreamDependencyStackMode = 'stacked' | 'included' | 'manual'

/** Server-owned state of one `ready` edge, stored beside `dependsOn`. Never client-supplied. */
export interface WorkStreamDependencyEdgeState {
  condition: 'ready'
  /**
   * When the edge was first observed satisfied while the dependency was not
   * done. Sticky: the dependency returning to rework or being canceled later
   * does not re-block the dependent.
   */
  readyUnlockedAt?: string
  /** Present once the unlock was evaluated for stacking. */
  stack?: WorkStreamDependencyStackState
}

export type WorkStreamDependencyStackState =
  /** Different repositories, or no repository: only the unlock applies. */
  | { mode: 'none'; decidedAt: string; reason: string }
  | {
      mode: WorkStreamDependencyStackMode
      decidedAt: string
      /** The dependency's branch and the head it had when the dependent was admitted. */
      branch: string
      headSha?: string
      reason?: string
      /** Latest head the code host reported for the dependency's delivery pull request. */
      observedHeadSha?: string
      /** Head the dependent's assignee and owner were last told about. */
      notifiedHeadSha?: string
      mergedNotifiedAt?: string
      canceledNotifiedAt?: string
    }

/** One dependency edge as responses describe it. */
export interface WorkStreamDependencyEdge {
  workStreamId: string
  condition: WorkStreamDependencyCondition
  /** The edge no longer holds the dependent back. */
  satisfied: boolean
  /** Set when a `ready` edge unlocked before the dependency was done. */
  unlockedAt?: string
  /** Present when the dependent builds on the dependency's unmerged branch. */
  stack?: { mode: WorkStreamDependencyStackMode; branch: string; headSha?: string }
  /** The dependent cannot be delivered until this dependency has merged. */
  holdsDelivery?: boolean
}

export class InvalidDependencyConditionError extends Error {
  constructor(value: string) {
    super(
      `Unknown dependency condition "${value}". Use <id>, <id>:done (wait until the dependency is done) or <id>:ready (wait until its work is implemented and its pull request is open).`
    )
    this.name = 'InvalidDependencyConditionError'
  }
}

/** Parse the CLI form `<id>`, `<id>:done` or `<id>:ready`. */
export function parseDependencySpec(spec: string): { id: string; condition: WorkStreamDependencyCondition } {
  const value = spec.trim()
  const separator = value.lastIndexOf(':')
  if (separator === -1) return { id: value, condition: 'done' }
  const id = value.slice(0, separator)
  const condition = value.slice(separator + 1)
  if (!id || !(WORK_STREAM_DEPENDENCY_CONDITIONS as readonly string[]).includes(condition))
    throw new InvalidDependencyConditionError(condition)
  return { id, condition: condition as WorkStreamDependencyCondition }
}

/** Split caller input into the authoritative ID list and the non-default conditions. */
export function normalizeDependencyInputs(inputs: readonly WorkStreamDependencyInput[]): {
  ids: string[]
  conditions: Record<string, WorkStreamDependencyCondition>
} {
  const ids: string[] = []
  const conditions: Record<string, WorkStreamDependencyCondition> = {}
  for (const input of inputs) {
    const id = typeof input === 'string' ? input : input.id
    const condition = typeof input === 'string' ? 'done' : (input.condition ?? 'done')
    if (!(WORK_STREAM_DEPENDENCY_CONDITIONS as readonly string[]).includes(condition))
      throw new InvalidDependencyConditionError(String(condition))
    if (!ids.includes(id)) ids.push(id)
    conditions[id] = condition
  }
  return { ids, conditions }
}

export function dependencyEdgeCondition(
  edges: Record<string, WorkStreamDependencyEdgeState> | null | undefined,
  dependencyId: string
): WorkStreamDependencyCondition {
  return edges?.[dependencyId]?.condition === 'ready' ? 'ready' : 'done'
}

/** An edge is satisfied when its dependency is done, or a `ready` edge has unlocked. */
export function isDependencyEdgeSatisfied(
  edges: Record<string, WorkStreamDependencyEdgeState> | null | undefined,
  dependencyId: string,
  dependencyStatus: string | undefined
): boolean {
  if (dependencyStatus === 'done') return true
  const edge = edges?.[dependencyId]
  return edge?.condition === 'ready' && !!edge.readyUnlockedAt
}

/** The dependent builds on this dependency's branch, so its delivery waits for the merge. */
export function isStackedDependencyEdge(edge: WorkStreamDependencyEdgeState | undefined): edge is {
  condition: 'ready'
  readyUnlockedAt?: string
  stack: Exclude<WorkStreamDependencyStackState, { mode: 'none' }>
} {
  return !!edge?.stack && edge.stack.mode !== 'none'
}
