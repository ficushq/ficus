import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareRuns, type RecordedRun } from './run'
import { findScenario } from './scenarios'

// Freeze this historical cohort's membership. Future scenarios or default-tier changes must not
// silently replace or supplement the evidence used for the delivery-guidance comparison.
const names = [
  'ask-human-decision',
  'offer-followup',
  'restart-side-effect',
  'restart-idempotent',
  'no-logs-request',
  'no-worktree',
  'cleanup-owned',
  'automerge-clean',
  'automerge-blocked',
  'slot-queued',
  'paused-wait',
  'completion-ready',
  'ci-failure-rework',
  'requester-identity',
  'new-work-request',
  'integration-not-merge-authority',
  'cli-discovery',
  'readable-handoff',
]
const oldRef = '8f3e9d7abab4ed97fcb7a892964b680e1af60a66'
const newRef = '8936a554b947b626e8c619a8861c4d64e4c9517b'
const files = ['2026-11-19-17-06-49.json', '2026-11-19-17-08-20.json', '2026-11-19-17-11-34.json']
const runs = files.flatMap(
  (file) =>
    (JSON.parse(readFileSync(join(import.meta.dir, 'recordings', file), 'utf8')) as { runs: RecordedRun[] }).runs
)

function key(run: Pick<RecordedRun, 'scenario' | 'commit' | 'model' | 'repeat'>): string {
  return JSON.stringify([run.scenario, run.commit, run.model, run.repeat])
}

test('final delivery comparison has both complete sides, with no duplicate or substituted runs', () => {
  const expected: string[] = []
  for (const scenario of names) {
    const defaultModel = ['completion-ready', 'integration-not-merge-authority'].includes(scenario)
      ? 'anthropic:claude-opus-5-5:high'
      : 'anthropic:claude-opus-5-5:medium'
    for (const model of [defaultModel, 'anthropic:claude-sonnet-5-5:medium'])
      for (const commit of [oldRef, newRef])
        for (const repeat of [1, 2, 3]) expected.push(key({ scenario, model, commit, repeat }))
  }
  expect(runs).toHaveLength(216)
  expect(runs.map(key).sort()).toEqual(expected.sort())
})

test('the full cohort passes the unchanged rule while disclosing the non-must handoff drop', () => {
  const scenarios = names.map((name) => findScenario(name)!)
  expect(scenarios.every(Boolean)).toBe(true)
  const oldRuns = runs.filter((run) => run.commit === oldRef)
  const newRuns = runs.filter((run) => run.commit === newRef)
  expect(compareRuns(scenarios, oldRuns, newRuns).failures).toEqual([])
  const handoff = (rows: RecordedRun[]) =>
    rows.filter(
      (run) =>
        run.scenario === 'readable-handoff' && run.model === 'anthropic:claude-opus-5-5:medium' && run.verdict.pass
    ).length
  expect(handoff(oldRuns)).toBe(2)
  expect(handoff(newRuns)).toBe(0)
  expect(findScenario('readable-handoff')!.must).toBe(false)
})
