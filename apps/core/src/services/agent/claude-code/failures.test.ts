import { expect, test } from 'bun:test'
import { classifyCaughtProviderError } from '../../../lib/error'
import { describeClaudeCodeFailure } from './failures'
import { routeFailure } from '../../execution/failure-routing'
import { isRetryableAssistantError } from '@earendil-works/pi-ai'

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

test('a structured rate limit still fails over when its prose is unfamiliar', () => {
  expect(classifyCaughtProviderError(describeClaudeCodeFailure('Try later', 'rate_limit'))).toMatchObject({
    kind: 'rate-limit',
  })
})

test('a hard Claude Code window keeps the no-fallback waiting-input route', () => {
  for (const window of ['session', 'weekly']) {
    const error = describeClaudeCodeFailure(`You've hit your ${window} limit · resets Oct 6, 6am (UTC)`, 'rate_limit')
    expect(routeFailure(error)).toMatchObject({
      systemMessage: '[System] Rate limit or plan credit exhaustion. Execution stopped.',
      disposition: { status: 'waiting-input', questionData: { questions: [{ id: 'rate_limit' }] } },
    })
  }
})

test('a busy sign-in refresh is retried as a transient failure, not a sign-in to fix', () => {
  const raw =
    'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again'
  const text = describeClaudeCodeFailure(raw, undefined, '/root/.local/bin/claude')
  expect(text).toStartWith('Claude Code sign-in refresh was busy (connection lost) (ran /root/.local/bin/claude): ')
  expect(text).not.toContain('Claude Code sign-in failed')
  // pi retries it with backoff instead of failing the turn.
  expect(isRetryableAssistantError({ stopReason: 'error', errorMessage: text } as never)).toBe(true)
  expect(isRetryableAssistantError({ stopReason: 'error', errorMessage: raw } as never)).toBe(false)
  // Not an expired login: the account is not marked as needing a new sign-in.
  expect(classifyCaughtProviderError(text)).not.toEqual({ kind: 'expired-oauth' })
})
