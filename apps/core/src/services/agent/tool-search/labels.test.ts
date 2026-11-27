import { describe, expect, it } from 'bun:test'
import { toolNameMatchesAny } from '../../../lib/tools'
import { classifiedTools, toolMetadata } from '../../../tools/metadata'
import {
  isToolSearchPolicy,
  parseToolSearchPolicy,
  resolveToolLabel,
  resolveToolSearchMode,
  TOOL_GROUPS,
  toolGroup,
  unknownToolSearchNames,
} from './labels'

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
      'dispatch',
      'check_subagents',
      'stop_subagent',
      'monitor',
    ]) {
      expect(resolveToolLabel(name)).toBe('direct')
    }
    for (const name of ['browser_open', 'browser_screenshot', 'ast_symbols', 'ast_rename', 'todo_add']) {
      expect(resolveToolLabel(name)).toBe('deferrable')
    }
  })

  it('treats a tool it does not know as direct', () => {
    expect(resolveToolLabel('linear_issue_create')).toBe('direct')
    expect(resolveToolLabel('tool_search')).toBe('direct')
  })

  it('reads the default from the tool metadata table', () => {
    for (const [name, metadata] of classifiedTools()) expect(resolveToolLabel(name)).toBe(metadata.label)
    expect(resolveToolLabel('linear_issue_create')).toBe(toolMetadata('linear_issue_create').label)
  })

  it('keeps the defaults the tool groups used to carry: browser, code navigation and checklist are deferrable', () => {
    const deferrableGroups = ['browser_*', 'ast_*', 'todo_*']
    for (const name of classifiedTools().keys()) {
      expect([name, resolveToolLabel(name)]).toEqual([
        name,
        toolNameMatchesAny(deferrableGroups, name) ? 'deferrable' : 'direct',
      ])
    }
  })

  it('gives every classified tool in a group the same default, so a namespace is loaded whole', () => {
    for (const group of TOOL_GROUPS) {
      const labels = new Set(
        [...classifiedTools()].filter(([name]) => toolGroup(name) === group).map(([, metadata]) => metadata.label)
      )
      expect([group.name, labels.size]).toEqual([group.name, 1])
    }
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

describe('unknownToolSearchNames', () => {
  it('reports typos and accepts known names and patterns', () => {
    expect(
      unknownToolSearchNames({
        direct: ['browser_*', 'browser_open', 'bash', 'memory_search', 'brwoser_open'],
        deferred: ['webfetch', 'todo_*', 'todo_add', 'dispach', '*'],
      })
    ).toEqual(['brwoser_open', 'dispach'])
  })

  it('knows every tool in the metadata table, including ones outside the groups', () => {
    const names = [...classifiedTools().keys()]
    expect(names).toEqual(expect.arrayContaining(['tool_search', 'artifact_publish', 'navigate', 'continue_task']))
    expect(unknownToolSearchNames({ direct: names, deferred: ['bigbrain_*', 'memory_*', 'artifact_*'] })).toEqual([])
  })

  it('reports a pattern that matches no tool in the table', () => {
    // No built-in tool starts with context_; an extension that adds one is still allowed, with a warning.
    expect(unknownToolSearchNames({ direct: ['context_*'], deferred: ['mcp__github__*'] })).toEqual([
      'context_*',
      'mcp__github__*',
    ])
  })
})
