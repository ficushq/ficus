import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface BatchSnapshot<T> {
  status: 'running' | 'partial' | 'complete'
  plannedRuns: number
  failedJobs: number[]
  /** Completed results in planned order, never padded with invented or unfinished runs. */
  runs: T[]
}

/**
 * Stop scheduling on the first failure, but drain in-flight jobs and checkpoint every known result.
 * A failed or interrupted cohort cannot be mistaken for a complete comparison. No retries occur.
 */
export async function runBatch<T>(
  jobs: (() => Promise<T>)[],
  concurrency: number,
  checkpoint: (snapshot: BatchSnapshot<T>) => unknown
): Promise<{ snapshot: BatchSnapshot<T>; errors: { index: number; error: unknown }[] }> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be a positive integer')
  const completed = new Map<number, T>()
  const errors: { index: number; error: unknown }[] = []
  let next = 0
  let stopped = false
  let checkpointFailed = false
  let checkpointError: unknown
  const snapshot = (final = false): BatchSnapshot<T> => ({
    status: errors.length || checkpointFailed ? 'partial' : final ? 'complete' : 'running',
    plannedRuns: jobs.length,
    failedJobs: errors.map(({ index }) => index).sort((a, b) => a - b),
    runs: [...completed].sort(([a], [b]) => a - b).map(([, result]) => result),
  })
  const publish = (value: BatchSnapshot<T>) => {
    try {
      checkpoint(value)
    } catch (error) {
      checkpointFailed = true
      checkpointError = error
      stopped = true
    }
  }
  publish(snapshot())
  const worker = async () => {
    while (!stopped && next < jobs.length) {
      const index = next++
      try {
        completed.set(index, await jobs[index]!())
      } catch (error) {
        errors.push({ index, error })
        stopped = true
      }
      publish(snapshot())
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs.length, concurrency) }, worker))
  const final = snapshot(true)
  publish(final)
  if (checkpointFailed) throw checkpointError
  return { snapshot: final, errors }
}

/** Replace the snapshot atomically; readers see the previous complete JSON or the new one. */
export function writeRecordingSnapshot(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 1)}\n`)
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}
