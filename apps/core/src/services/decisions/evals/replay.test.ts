import { describe, expect, test } from 'bun:test'
import { discoverEvals, readSnapshot, replaySnapshot } from './run'

/*
 * Offline: every recorded answer (`bun run decisions:eval --record`) goes back through the current
 * production rule. A case that passed when it was recorded must still pass, so a threshold or rule
 * change that breaks a known case fails here without a provider, a key, or a network. Answers
 * recorded for a different request (the prompt changed since) are stale: re-record them.
 */
const evals = await discoverEvals()

describe('decision evals replay their recorded answers', () => {
  for (const { file, evaluation } of evals) {
    test(evaluation.name, () => {
      const snapshot = readSnapshot(file, evaluation.name)
      if (!snapshot) return
      const replayed = replaySnapshot(evaluation, snapshot)
      const regressions = replayed.filter(
        (entry) => !entry.stale && entry.passedWhenRecorded === true && entry.pass === false
      )
      expect(
        regressions.map((entry) => `${entry.case} (${entry.providerKey}): now ${JSON.stringify(entry.outcome)}`)
      ).toEqual([])
      const stale = replayed.filter((entry) => entry.stale)
      if (stale.length)
        console.warn(
          `${evaluation.name}: ${stale.length} recorded answers are for an older prompt; re-record with --record`
        )
    })
  }
})

test('every eval has unique case names, labels, and a request its build can make', () => {
  for (const { evaluation } of evals) {
    const names = evaluation.cases.map(
      (c, index) =>
        c.name ?? (evaluation.caseName && !('request' in c) ? evaluation.caseName(c as never) : `case ${index + 1}`)
    )
    expect(new Set(names).size).toBe(names.length)
    for (const c of evaluation.cases) {
      expect(c.expect !== undefined || (c.accept?.length ?? 0) > 0).toBe(true)
      if (!('request' in c))
        expect(Object.keys(evaluation.build(c as never).request.questions).length).toBeGreaterThan(0)
    }
  }
})
