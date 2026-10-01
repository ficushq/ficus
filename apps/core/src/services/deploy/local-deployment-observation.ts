/** Only read-only observations belong here. Never put ensure/start/stop in a deadline race. */
export const LOCAL_DEPLOYMENT_OBSERVATION_TIMEOUT_MS = 5_000
export type ScheduleObservationTimeout = (callback: () => void, ms: number) => () => void
const scheduleTimeout: ScheduleObservationTimeout = (callback, ms) => {
  const timer = setTimeout(callback, ms)
  return () => clearTimeout(timer)
}

const observations = new Map<string, { snapshotKey: string; result: Promise<unknown>; settled: Promise<void> }>()
const MAX_PENDING_OBSERVATIONS = 2

/**
 * Cancel a read at its total deadline, retaining ownership until its transport
 * cleanup settles. Only identical lifecycle snapshots may join its evidence.
 * A different snapshot is unverified until the owned read/cleanup settles,
 * rather than starting a parallel read or reinterpreting old evidence as new.
 * A stale caller cannot cancel a newer read; the original deadline still owns
 * cancellation. Late results cannot escape the expired public promise.
 */
export function observeLocalDeployment<T>(
  id: string,
  snapshotKey: string,
  read: (signal: AbortSignal) => Promise<T>,
  schedule: ScheduleObservationTimeout = scheduleTimeout
): Promise<T> {
  const existing = observations.get(id)
  if (existing) {
    if (existing.snapshotKey === snapshotKey) return existing.result as Promise<T>
    return Promise.reject(new Error('Observation belongs to a different lifecycle snapshot'))
  }
  if (observations.size >= MAX_PENDING_OBSERVATIONS)
    return Promise.reject(new Error('Observation capacity unavailable'))
  const controller = new AbortController()
  const result = Promise.withResolvers<T>()
  const cancelTimer = schedule(() => {
    controller.abort()
    result.reject(new Error('App observation deadline expired'))
  }, LOCAL_DEPLOYMENT_OBSERVATION_TIMEOUT_MS)
  const settled = Promise.resolve()
    .then(() => {
      controller.signal.throwIfAborted()
      return read(controller.signal)
    })
    .then(
      (value) => {
        if (!controller.signal.aborted) result.resolve(value)
      },
      (error) => result.reject(error)
    )
    .finally(() => {
      cancelTimer()
      observations.delete(id)
    })
  observations.set(id, { snapshotKey, result: result.promise, settled })
  return result.promise
}

/** Lifecycle/tests drain owned read cancellation before disposing their resources. */
export async function drainLocalDeploymentHealthObservations(): Promise<void> {
  await Promise.all([...observations.values()].map((observation) => observation.settled))
}
