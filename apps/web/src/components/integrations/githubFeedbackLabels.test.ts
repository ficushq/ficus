import { expect, test } from 'bun:test'
import { kindLabel, reasonLabel } from './githubFeedbackLabels'

test('holds that are not about author trust never claim the author is untrusted', () => {
  for (const reason of ['unknown_editor', 'ambiguous_observation', 'stale_observation', 'source_unverified']) {
    const label = reasonLabel(reason)!
    expect(label).not.toBe(reason)
    expect(label).not.toMatch(/not trusted/i)
  }
  expect(reasonLabel('untrusted_author')).toMatch(/not trusted/)
  expect(kindLabel({ objectKind: 'action' })).toBe('Issue or pull request action')
})
