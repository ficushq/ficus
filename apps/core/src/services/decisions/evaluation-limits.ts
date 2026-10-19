/** Evaluation-only safety limits, per authenticated principal per API process. Not a dollar quota. */
export const EVALUATION_CALLS_PER_MINUTE = 60
export const EVALUATION_CONCURRENCY = 4
export const EVALUATION_MAX_TEXT_BYTES = 64 * 1024
export const EVALUATION_MAX_BODY_BYTES = 12 * 1024 * 1024
export const EVALUATION_TIMEOUT_MS = 30_000
const WINDOW_MS = 60_000
const MAX_TRACKED_CALLERS = 10_000

/** A successful acquisition returns an idempotent release; failures never create a slot. */
export function createEvaluationLimiter(now: () => number = Date.now): (actor: string) => (() => void) | null {
  const callers = new Map<string, { started: number; calls: number; active: number }>()
  return (actor) => {
    const at = now()
    for (const [key, entry] of callers) {
      if (!entry.active && at - entry.started >= WINDOW_MS) callers.delete(key)
    }
    let entry = callers.get(actor)
    if (!entry) {
      if (callers.size >= MAX_TRACKED_CALLERS) return null
      entry = { started: at, calls: 0, active: 0 }
      callers.set(actor, entry)
    }
    if (at - entry.started >= WINDOW_MS) {
      entry.started = at
      entry.calls = 0
    }
    if (entry.calls >= EVALUATION_CALLS_PER_MINUTE || entry.active >= EVALUATION_CONCURRENCY) return null
    entry.calls++
    entry.active++
    let released = false
    return () => {
      if (released) return
      released = true
      entry.active--
    }
  }
}
