import { expect, test } from 'bun:test'
import { classifyCaughtProviderError } from '../../../lib/error'
import { describeClaudeCodeFailure } from './failures'

test('an expired Claude Code sign-in fails the account over as an expired login', () => {
  const text = describeClaudeCodeFailure('Failed to authenticate: OAuth session expired and could not be refreshed')
  expect(text).toContain('Claude Code sign-in failed')
  expect(text).toContain('claude auth login')
  expect(classifyCaughtProviderError(text)).toEqual({ kind: 'expired-oauth' })
  expect(classifyCaughtProviderError(describeClaudeCodeFailure('Not logged in · Please run /login'))).toEqual({
    kind: 'expired-oauth',
  })
})

test('a too-old Claude Code fails the account over until it is updated', () => {
  const text = describeClaudeCodeFailure(
    "API Error: 400 Claude Code 2.1.221 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again."
  )
  expect(text).toContain('Claude Code is too old')
  expect(classifyCaughtProviderError(text)).toEqual({ kind: 'invalid-credential' })
  // Names the install it ran, so a stray old copy can be found.
  expect(describeClaudeCodeFailure('version 2.1.280 or newer is required', undefined, '/opt/old/claude')).toContain(
    '(ran /opt/old/claude)'
  )
})

test("Anthropic's out-of-extra-usage refusal is exhausted plan credit, not a stop", () => {
  const text = describeClaudeCodeFailure(
    "API Error: 400 You're out of extra usage. Add more at claude.ai/settings/usage and keep going."
  )
  expect(classifyCaughtProviderError(text)).toMatchObject({ kind: 'plan-credit' })
})

test('other Claude Code errors pass through unchanged', () => {
  expect(describeClaudeCodeFailure('API Error: 529 Overloaded')).toBe('API Error: 529 Overloaded')
})
