import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DecisionAnswer, DecisionRequest } from '@ficus/shared'
import { defineDecisionEval, margin, matches, passes, requestHash } from './define'
import type { EvalProvider } from './providers'
import { failures, formatMarkdown, formatRun, summarize } from './report'
import { readSnapshot, replaySnapshot, runEval, writeSnapshot } from './run'

const yes = (probability: number): DecisionAnswer => ({ type: 'yesno', probability })

/** A yes/no eval: "steer" at 0.7 or more, "follow-up" at 0.3 or less, otherwise null. */
const sample = defineDecisionEval<{ draft: string }, string | null>({
  name: 'sample',
  purpose: 'composer-delivery',
  build: ({ draft }) => ({
    request: { state: { draft }, questions: { now: { type: 'yesno', instructions: 'Now?' } } },
  }),
  decide: (answers) => {
    const now = answers.now?.type === 'yesno' ? answers.now.probability : 0.5
    return now >= 0.7 ? 'steer' : now <= 0.3 ? 'follow-up' : null
  },
  thresholds: { now: [0.3, 0.7] },
  caseName: ({ draft }) => draft,
  floor: 0.75,
  cases: [
    { draft: "how's it going", expect: 'steer', must: true },
    { draft: 'weather in Lisbon', expect: 'follow-up' },
    { draft: 'thanks', accept: ['steer', null] },
  ],
})

function fakeProvider(scores: Record<string, number>, overrides: Partial<EvalProvider> = {}) {
  const asked: DecisionRequest[] = []
  const provider: EvalProvider = {
    id: 'fake',
    label: 'Fake',
    kind: 'jev',
    model: 'jev-latest',
    readsImages: false,
    ask: async (request) => {
      asked.push(request)
      const draft = (request.state as { draft: string }).draft
      return { answers: { now: yes(scores[draft] ?? 0.5) }, usage: { inputTokens: 100 } }
    },
    ...overrides,
  }
  return { provider, asked }
}

let tmp: string | undefined
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
})

test('expectations match exactly, or on the expected fields of an object; accept lists alternatives', () => {
  expect(matches('steer', 'steer')).toBe(true)
  expect(matches(null, 'steer')).toBe(false)
  expect(matches({ kind: 'bug', squad: 'Shop', action: 'new' }, { kind: 'bug', squad: 'Shop' })).toBe(true)
  expect(matches({ kind: 'bug', squad: 'Docs' }, { squad: 'Shop' })).toBe(false)
  expect(passes({ expect: 'steer' }, 'steer')).toBe(true)
  expect(passes<string | null>({ accept: ['steer', null] }, null)).toBe(true)
  expect(passes({}, 'steer')).toBeNull()
})

test("the margin is the closest a yes/no answer came to a threshold, or a choice's lead over the runner-up", () => {
  expect(margin({ now: yes(0.74) }, { now: [0.3, 0.7] })).toBeCloseTo(0.04)
  expect(margin({ now: yes(0.9) })).toBeCloseTo(0.4) // 0.5 when no thresholds are given
  expect(margin({ pick: { type: 'choice', choice: 'a', probabilities: { a: 0.6, b: 0.35, c: 0.05 } } })).toBeCloseTo(
    0.25
  )
  // With the rule: an answer near a threshold only counts if crossing it would change the outcome.
  const rule = (answers: Record<string, DecisionAnswer>) => {
    const related = answers.related?.type === 'yesno' ? answers.related.probability : 0
    const now = answers.now?.type === 'yesno' ? answers.now.probability : 0
    return Math.max(related, now) >= 0.7 ? 'steer' : related <= 0.3 && now <= 0.5 ? 'follow-up' : null
  }
  const thresholds = { related: [0.3, 0.7], now: [0.5, 0.7] }
  // "how's it going": related sits by 0.3, but now (0.82) decides; the close call is now's 0.12 to 0.7.
  expect(margin({ related: yes(0.29), now: yes(0.82) }, thresholds)).toBeCloseTo(0.01)
  expect(margin({ related: yes(0.29), now: yes(0.82) }, thresholds, rule)).toBeCloseTo(0.12)
  // A choice whose runner-up would give the same outcome is no close call.
  expect(
    margin({ pick: { type: 'choice', choice: 'a', probabilities: { a: 0.6, b: 0.4 } } }, {}, () => 'same')
  ).toBeNull()
})

test('a run asks every provider every case, scores it with the rule, and summarizes per provider', async () => {
  const { provider, asked } = fakeProvider({ "how's it going": 0.83, 'weather in Lisbon': 0.1, thanks: 0.5 })
  const results = await runEval(sample as never, [provider], { repeat: 2 })
  expect(asked).toHaveLength(6)
  expect(results.map((result) => [result.case, result.attempt, result.outcome, result.pass])).toEqual([
    ["how's it going", 1, 'steer', true],
    ["how's it going", 2, 'steer', true],
    ['weather in Lisbon', 1, 'follow-up', true],
    ['weather in Lisbon', 2, 'follow-up', true],
    ['thanks', 1, null, true],
    ['thanks', 2, null, true],
  ])
  expect(results[0]!.margin).toBeCloseTo(0.13)
  expect(results[0]!.hash).toBe(requestHash(sample.build({ draft: "how's it going" }).request))
  // 100 input tokens at Jev's list price.
  expect(results[0]!.costNanodollars).toBeGreaterThan(0)
  const [summary] = summarize(results)
  expect(summary).toMatchObject({ provider: 'fake', labelled: 3, passed: 3, mustFailures: [], flips: 0 })
  expect(failures(sample as never, summarize(results))).toEqual([])
  const table = formatRun(sample as never, results)
  expect(table).toContain("how's it going")
  expect(table).toContain('3/3 right')
  expect(formatMarkdown(sample as never, results)).toContain('| weather in Lisbon | "follow-up" |')
})

test('a failed must-pass case, or accuracy under the floor, fails the run; flips between attempts are counted', async () => {
  let call = 0
  const { provider } = fakeProvider(
    {},
    {
      ask: async (request) => {
        const draft = (request.state as { draft: string }).draft
        // The must-pass case flips between attempts; Lisbon is always wrong.
        const score = draft === "how's it going" ? (call++ % 2 ? 0.2 : 0.9) : draft === 'weather in Lisbon' ? 0.9 : 0.5
        return { answers: { now: yes(score) } }
      },
    }
  )
  const results = await runEval(sample as never, [provider], { repeat: 2, concurrency: 1 })
  const [summary] = summarize(results)
  expect(summary).toMatchObject({ passed: 1, labelled: 3, flips: 1, mustFailures: ["how's it going"] })
  expect(failures(sample as never, [summary!])).toEqual([
    "fake: must-pass case failed: how's it going",
    'fake: 1/3 is below the floor of 75%',
  ])
})

test('image cases skip providers that cannot read images; errors and the cost limit are reported, not thrown', async () => {
  const images = defineDecisionEval<{ x: number }, string>({
    name: 'images',
    purpose: 'screenshot-filing',
    build: () => ({
      request: {
        state: 'x',
        questions: { now: { type: 'yesno', instructions: 'Now?' } },
        images: [{ mediaType: 'image/png', base64: 'AA==' }],
      },
    }),
    decide: () => 'steer',
    cases: [{ x: 1, expect: 'steer' }],
    caseName: () => 'image',
  })
  const [skipped] = await runEval(images as never, [fakeProvider({}).provider])
  expect(skipped).toMatchObject({ skipped: 'does not read images', pass: null })

  const broken = fakeProvider({}, { ask: async () => Promise.reject(new Error('HTTP 401')) }).provider
  const [errored] = await runEval(sample as never, [broken], { concurrency: 1 })
  expect(errored).toMatchObject({ error: 'HTTP 401', pass: false })

  const capped = await runEval(sample as never, [fakeProvider({}).provider], { maxCostDollars: 0, concurrency: 1 })
  expect(capped.every((result) => result.skipped === 'cost limit reached')).toBe(true)
})

test('variants replace the questions (and the rule), so prompts can be compared', async () => {
  const withVariant = {
    ...sample,
    variants: { strict: { questions: { now: { type: 'yesno' as const, instructions: 'Strictly now?' } } } },
  }
  const { provider, asked } = fakeProvider({})
  const [result] = await runEval(withVariant as never, [provider], { variant: 'strict', concurrency: 1 })
  expect((asked[0]!.questions.now as { instructions: string }).instructions).toBe('Strictly now?')
  expect(result!.providerKey).toBe('jev:jev-latest#strict')
  await expect(runEval(sample as never, [provider], { variant: 'nope' })).rejects.toThrow('has no variant "nope"')
})

test('recorded answers replay through the current rule; a changed request is stale, not a failure', async () => {
  tmp = mkdtempSync(join(tmpdir(), 'decision-evals-'))
  const file = join(tmp, 'sample.decision-eval.ts')
  writeFileSync(file, '')
  const { provider } = fakeProvider({ "how's it going": 0.83, 'weather in Lisbon': 0.1, thanks: 0.5 })
  writeSnapshot(file, sample as never, await runEval(sample as never, [provider]))
  const snapshot = readSnapshot(file, 'sample')!
  expect(Object.keys(snapshot.entries)).toEqual(["how's it going", 'weather in Lisbon', 'thanks'])
  expect(snapshot.entries["how's it going"]!['jev:jev-latest']).toMatchObject({
    passed: true,
    answers: { now: yes(0.83) },
  })

  expect(replaySnapshot(sample as never, snapshot).every((entry) => entry.pass === true && !entry.stale)).toBe(true)
  // A stricter rule now fails a case that passed when recorded: the replay test catches it offline.
  const stricter = { ...sample, decide: () => 'follow-up' }
  expect(replaySnapshot(stricter as never, snapshot).find((entry) => entry.case === "how's it going")?.pass).toBe(false)
  // A changed prompt makes the recorded answers stale.
  const reworded = {
    ...sample,
    build: ({ draft }: { draft: string }) => ({
      request: { state: { draft }, questions: { now: { type: 'yesno' as const, instructions: 'Changed?' } } },
    }),
  }
  expect(replaySnapshot(reworded as never, snapshot).every((entry) => entry.stale)).toBe(true)
})
