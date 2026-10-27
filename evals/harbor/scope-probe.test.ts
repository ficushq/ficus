import { expect, test } from 'bun:test'
import { caseMessage, grade, snapshotPrompt } from './scope-probe'
import { resolve } from 'node:path'

test('evaluation labels are not present in the message sent to the model', () => {
  const message = caseMessage({ role: 'manager', scenario: 'A specific fictional report.' })
  expect(message).toContain('A specific fictional report.')
  expect(message).not.toContain('expected')
  expect(message).not.toContain('caseId')
})
test('scoring rejects incomplete, incorrectly typed, wrong-action and unsupported answers', () => {
  const expected = { ready: false, disposition: 'repair' as const }
  for (const answer of [
    'null',
    'garbage',
    '{"ready":"false","disposition":"repair","reason":"x"}',
    '{"ready":false,"disposition":"follow-up","reason":"x"}',
    '{"ready":false,"disposition":"repair"}',
  ]) {
    expect(grade(answer, expected).pass).toBe(false)
  }
  expect(
    grade('{"ready":false,"disposition":"repair","reason":"A required dependency prevents the outcome."}', expected)
      .pass
  ).toBe(true)
})
test('baseline is read from immutable Git objects and differs from candidate', async () => {
  const root = resolve(import.meta.dir, '../..')
  for (const role of ['manager', 'reviewer']) {
    const old = await snapshotPrompt(root, role, '38efa36c')
    const current = await snapshotPrompt(root, role)
    expect(old).not.toContain('### Required Dependencies and Completion')
    expect(current).toContain('### Required Dependencies and Completion')
    expect(old).not.toEqual(current)
  }
})
