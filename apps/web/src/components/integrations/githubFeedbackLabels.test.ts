import { expect, test } from 'bun:test'
import type { GitHubFeedbackScreening } from '@ficus/shared'
import { kindLabel, reasonLabel, screeningLabel } from './githubFeedbackLabels'

test('holds that are not about author trust never claim the author is untrusted', () => {
  for (const reason of ['unknown_editor', 'ambiguous_observation', 'stale_observation', 'source_unverified']) {
    const label = reasonLabel(reason)!
    expect(label).not.toBe(reason)
    expect(label).not.toMatch(/not trusted/i)
  }
  expect(reasonLabel('untrusted_author')).toMatch(/not trusted/)
  expect(kindLabel({ objectKind: 'action' })).toBe('Issue or pull request action')
})

test('decision model verdicts read as one line, leading with the strongest signal', () => {
  const base: GitHubFeedbackScreening = {
    state: 'held',
    outcome: 'unsafe',
    instructsAgent: null,
    intent: null,
    intentConfidence: null,
    providerId: 'p',
    model: 'm',
    screenedAt: null,
  }
  const label = (patch: Partial<GitHubFeedbackScreening>) => screeningLabel({ ...base, ...patch })
  expect(screeningLabel(null)).toBeNull()
  expect(label({ state: 'running', outcome: null })).toBe('Decision model: screening…')
  expect(label({ instructsAgent: 0.94, intent: 'malicious', intentConfidence: 0.8 })).toBe(
    'Decision model: likely prompt injection, 94%'
  )
  expect(label({ instructsAgent: 0.1, intent: 'malicious', intentConfidence: 0.88 })).toBe(
    'Decision model: likely malicious, 88%'
  )
  expect(label({ instructsAgent: 0.1, intent: 'suspicious', intentConfidence: 0.6 })).toBe(
    'Decision model: suspicious, 60%'
  )
  expect(label({ outcome: 'uncertain', instructsAgent: 0.1, intent: 'benign', intentConfidence: 0.55 })).toBe(
    'Decision model: not confident it’s safe (benign, 55%)'
  )
  expect(
    label({ state: 'passed', outcome: 'safe', instructsAgent: 0.01, intent: 'benign', intentConfidence: 0.97 })
  ).toBe('Decision model: likely safe, 97%')
  expect(label({ outcome: 'unavailable' })).toBe('Decision model: didn’t answer')
  expect(label({ outcome: 'unconfigured' })).toBe('Decision model: none set up')
  expect(label({ outcome: 'too_long' })).toBe('Decision model: too long to screen')
  expect(label({ outcome: 'skipped' })).toBe('Decision model: not screened')
  expect(label({ outcome: 'source_unavailable' })).toContain('can’t read this any more')
  expect(reasonLabel('decision_model_allowed')).toMatch(/decision model/i)
})
