import { describe, expect, it } from 'bun:test'
import { isToolSearchPolicy, parseToolSearchPolicy, resolveToolLabel, resolveToolSearchMode, toolGroup } from './labels'

describe('resolveToolLabel', () => {
  it('keeps core tools direct and rarely used heavy tools deferrable by default', () => {
    for (const name of [
      'bash',
      'squad_bash',
      'read',
      'write',
      'edit',
      'ask_human',
      'notify_contact',
      'memory_search',
      'memory_get',
      'memory_write',
      'short_term_memory_write',
      'sandbox_status',
      'set_agent_purpose',
      'websearch',
      'webfetch',
    ]) {
      expect(resolveToolLabel(name)).toBe('direct')
    }
    for (const name of [
      'browser_open',
      'browser_screenshot',
      'ast_symbols',
      'ast_rename',
      'dispatch',
      'check_subagents',
      'stop_subagent',
      'monitor',
      'todo_add',
    ]) {
      expect(resolveToolLabel(name)).toBe('deferrable')
    }
  })

  it('treats a tool it does not know as direct', () => {
    expect(resolveToolLabel('linear_issue_create')).toBe('direct')
  })

  it("applies the agent type's override, with direct winning over deferred", () => {
    const policy = { direct: ['browser_*'], deferred: ['webfetch', 'browser_open'] }
    expect(resolveToolLabel('browser_open', policy)).toBe('direct')
    expect(resolveToolLabel('browser_click', policy)).toBe('direct')
    expect(resolveToolLabel('webfetch', policy)).toBe('deferrable')
    expect(resolveToolLabel('ast_symbols', policy)).toBe('deferrable')
    expect(resolveToolLabel('read', policy)).toBe('direct')
  })
})

describe('tool groups', () => {
  it('puts deferrable tools in a described namespace', () => {
    expect(toolGroup('browser_screenshot')?.name).toBe('browser')
    expect(toolGroup('browser_screenshot')?.description).toContain('screenshot')
    expect(toolGroup('ast_references')?.name).toBe('code_navigation')
    expect(toolGroup('bash')).toBeUndefined()
  })
})

describe('parseToolSearchPolicy', () => {
  it('reads search, direct and deferred and ignores allow and deny', () => {
    expect(
      parseToolSearchPolicy({ allow: ['read'], search: 'off', direct: ['browser_*'], deferred: ['webfetch'] })
    ).toEqual({ search: 'off', direct: ['browser_*'], deferred: ['webfetch'] })
    expect(parseToolSearchPolicy({ allow: ['read'] })).toBeUndefined()
  })

  it('rejects an unknown mode and non-array name lists', () => {
    expect(() => parseToolSearchPolicy({ search: 'sometimes' })).toThrow("'tools.search' must be one of auto, on, off")
    expect(() => parseToolSearchPolicy({ search: false })).toThrow("'tools.search'")
    expect(() => parseToolSearchPolicy({ direct: 'browser_*' })).toThrow("'tools.direct' must be an array")
    expect(() => parseToolSearchPolicy({ deferred: [1] })).toThrow("'tools.deferred' must be an array")
  })

  it('defaults the mode to auto', () => {
    expect(resolveToolSearchMode(undefined)).toBe('auto')
    expect(resolveToolSearchMode({ direct: ['x'] })).toBe('auto')
    expect(resolveToolSearchMode({ search: 'on' })).toBe('on')
  })

  it('recognizes stored policies', () => {
    expect(isToolSearchPolicy({ search: 'off' })).toBe(true)
    expect(isToolSearchPolicy({ search: 'off', allow: [] })).toBe(false)
    expect(isToolSearchPolicy({ search: 'maybe' })).toBe(false)
    expect(isToolSearchPolicy(['off'])).toBe(false)
    expect(isToolSearchPolicy(null)).toBe(false)
  })
})
