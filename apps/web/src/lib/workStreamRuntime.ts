import type { WorkStream } from '@ficus/shared'

/**
 * Total agent execution runtime for a work stream, in ms.
 *
 * When active executions are present, extrapolates from the backend-computed
 * total using the supplied `now` timestamp.
 */
export function computeWorkStreamElapsedMs(ws: WorkStream, now: number): number {
  const rt = ws.runtime
  if (!rt) return 0
  if (rt.activeCount <= 0) return rt.totalMs
  const computedAt = new Date(rt.computedAt).getTime()
  const delta = Math.max(0, now - computedAt)
  return rt.totalMs + rt.activeCount * delta
}
