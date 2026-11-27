import { afterEach, describe, expect, it } from 'bun:test'
import { claudeCodeToolLabels, clearClaudeCodeToolLabelsForTest, registerClaudeCodeToolLabels } from './claude-code'

const plan = { mode: 'claude-code' as const, hidden: ['browser_open'], reason: 'test' }

describe('Claude Code tool labels', () => {
  afterEach(() => clearClaudeCodeToolLabelsForTest())

  it('keeps a session that is still in use when older sessions are evicted', () => {
    registerClaudeCodeToolLabels('live', plan)
    for (let i = 0; i < 1_999; i++) registerClaudeCodeToolLabels(`old-${i}`, plan)
    // A bridge turn on the live session makes it the most recently used.
    expect(claudeCodeToolLabels('live').enableToolSearch).toBe('true')
    registerClaudeCodeToolLabels('new', plan)
    expect(claudeCodeToolLabels('live').deferred.has('browser_open')).toBe(true)
    expect(claudeCodeToolLabels('old-0').enableToolSearch).toBe('false')
  })

  it('defaults to every tool up front for an unknown session', () => {
    expect(claudeCodeToolLabels('unknown')).toEqual({ deferred: new Set(), enableToolSearch: 'false' })
    expect(claudeCodeToolLabels(undefined).enableToolSearch).toBe('false')
  })
})
