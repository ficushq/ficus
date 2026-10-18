/** Shared with fleet demand so its freshness budget follows the actual probe cadence. */
export const MONITOR_POLL_MAX_INTERVAL_MS = 15_000
export const MONITOR_POLL_FAILURE_TOLERANCE = 5

/** Allow the retry budget, one more poll, and a minute for exec/DB latency. */
export const MONITOR_LIVENESS_WINDOW_MS = MONITOR_POLL_MAX_INTERVAL_MS * (MONITOR_POLL_FAILURE_TOLERANCE + 1) + 60_000
