import type { SessionUsage, UsageTokens } from '@ficus/shared'

/**
 * Per-execution usage accounting.
 *
 * `SessionUsage.stats` is cumulative for the session (see its doc comment), so
 * an execution's own consumption is the difference between a baseline captured
 * right after the session was opened for that execution and the capture taken
 * when it ends. Because the baseline comes from the SAME opened session, the
 * counters can only grow between the two, and a session that was reset or
 * rotated between executions simply produces a lower baseline rather than a
 * negative delta. The clamp below is defence in depth, not an expected path.
 */
const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

export function subtractTokens(current: UsageTokens, baseline: UsageTokens | undefined): UsageTokens {
  const out = {} as UsageTokens
  for (const key of TOKEN_KEYS) {
    out[key] = nonNegative((current?.[key] ?? 0) - (baseline?.[key] ?? 0))
  }
  return out
}

/**
 * Baseline state for one execution's delta accounting.
 *
 * `pending`: the session may be open but this execution's baseline has not
 * been captured yet. A capture taken now MUST NOT carry a `delta` — treating
 * the whole cumulative snapshot as the delta would double-count a resumed
 * session. Rows written from a pending-state capture land in the legacy
 * `MAX()` fallback branch of WorkStream.getMetrics instead.
 *
 * `captured`: the snapshot taken right after the session was opened for this
 * execution (all zeros for a fresh session — which is what distinguishes a
 * legitimate "whole capture is the delta" fresh session from `pending`).
 */
export type UsageBaseline =
  | { readonly kind: 'pending' }
  | { readonly kind: 'captured'; readonly snapshot: SessionUsage }

/**
 * Attach `delta` to a cumulative capture. A `captured` baseline computes the
 * step from it (all zeros for a fresh session, so the whole capture is the
 * delta). A `pending` baseline emits NO `delta` at all: the baseline has not
 * been captured yet, so the only safe attribution is none — the row falls
 * back to legacy semantics instead of double-counting a resumed session.
 */
export function withUsageDelta(current: SessionUsage, baseline: UsageBaseline): SessionUsage {
  if (baseline.kind === 'pending') return { ...current }
  return {
    ...current,
    delta: {
      tokens: subtractTokens(current.stats.tokens, baseline.snapshot.stats.tokens),
      cost: nonNegative((current.stats.cost ?? 0) - (baseline.snapshot.stats.cost ?? 0)),
    },
  }
}

/** The agent/session cumulative view: never carries a per-execution delta. */
export function withoutDelta(usage: SessionUsage): SessionUsage {
  if (!usage.delta) return usage
  const { delta: _stripped, ...rest } = usage
  return rest
}
