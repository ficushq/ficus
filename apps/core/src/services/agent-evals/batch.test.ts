import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBatch, writeRecordingSnapshot } from './batch'

test('a later failure preserves completed traces and known usage as an explicitly partial cohort', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eval-partial-'))
  try {
    const path = join(directory, 'cohort.json')
    let thirdStarted = false
    const outcome = await runBatch(
      [
        async () => ({ trace: 'completed trace', usage: { estimatedCostUsd: 0.01 } }),
        async () => {
          throw new Error('provider quota reached')
        },
        async () => {
          thirdStarted = true
          return { trace: 'should not run', usage: { estimatedCostUsd: 9 } }
        },
      ],
      1,
      (snapshot) => writeRecordingSnapshot(path, snapshot)
    )
    const recorded = JSON.parse(readFileSync(path, 'utf8'))
    expect(outcome.errors).toHaveLength(1)
    expect(recorded.status).toBe('partial')
    expect(recorded.plannedRuns).toBe(3)
    expect(recorded.runs).toEqual([{ trace: 'completed trace', usage: { estimatedCostUsd: 0.01 } }])
    expect(recorded.failedJobs).toEqual([1])
    expect(thirdStarted).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an in-flight success is drained and retained after another worker fails, without scheduling more work', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let thirdStarted = false
  const batch = runBatch(
    [
      async () => {
        await gate
        return 'completed in flight'
      },
      async () => {
        throw new Error('failed')
      },
      async () => {
        thirdStarted = true
        return 'unexpected'
      },
    ],
    2,
    (snapshot) => {
      if (snapshot.failedJobs.length) release()
    }
  )
  const outcome = await batch
  expect(outcome.snapshot).toEqual({
    status: 'partial',
    plannedRuns: 3,
    failedJobs: [1],
    runs: ['completed in flight'],
  })
  expect(thirdStarted).toBe(false)
})

test('only a batch with every planned run and no failures is marked complete', async () => {
  const states: string[] = []
  const outcome = await runBatch([async () => 'first', async () => 'second'], 2, (snapshot) =>
    states.push(snapshot.status)
  )
  expect(outcome.snapshot).toEqual({ status: 'complete', plannedRuns: 2, failedJobs: [], runs: ['first', 'second'] })
  expect(states[0]).toBe('running')
  expect(states.at(-1)).toBe('complete')
})

test('checkpoint failure stops new jobs and never publishes complete acceptance', async () => {
  let started = false
  const states: string[] = []
  await expect(
    runBatch(
      [
        async () => {
          started = true
          return 'unexpected'
        },
      ],
      1,
      (snapshot) => {
        states.push(snapshot.status)
        if (states.length === 1) throw new Error('disk unavailable')
      }
    )
  ).rejects.toThrow('disk unavailable')
  expect(started).toBe(false)
  expect(states).toEqual(['running', 'partial'])
})
