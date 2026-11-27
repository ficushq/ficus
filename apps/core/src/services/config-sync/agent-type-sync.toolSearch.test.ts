import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import { AGENT_TYPES_DIR } from '../../lib/paths'
import { AgentTypeSync } from './agent-type-sync'

function minimalYaml(extraLines: string[] = []): string {
  return [
    'id: tool-search-test',
    'name: Tool Search Test',
    'model: anthropic:claude-sonnet-4-6',
    'systemPrompt: You are a test agent.',
    ...extraLines,
  ].join('\n')
}

describe('AgentTypeSync tool-search override', () => {
  const sync = new AgentTypeSync()

  test('reads tools.search, tools.direct and tools.deferred next to allow and deny', () => {
    const parsed = sync.parse(
      minimalYaml([
        'tools:',
        '  allow: [read, browser_*]',
        '  search: auto',
        '  direct: [browser_*]',
        '  deferred: [webfetch]',
      ]),
      'tool-search-test.yaml'
    )
    const record = sync.toRecord(parsed)
    expect(record).toMatchObject({
      toolsAllow: ['read', 'browser_*'],
      toolSearch: { search: 'auto', direct: ['browser_*'], deferred: ['webfetch'] },
    })
    expect(sync.toComparable(record).toolSearch).toEqual({
      search: 'auto',
      direct: ['browser_*'],
      deferred: ['webfetch'],
    })
    // Export writes the keys back under tools, so a round trip keeps them.
    const exported = yaml.load(sync.toYaml({ ...record, yamlTemplate: null })) as { tools: Record<string, unknown> }
    expect(exported.tools).toEqual({
      allow: ['read', 'browser_*'],
      search: 'auto',
      direct: ['browser_*'],
      deferred: ['webfetch'],
    })
    expect(sync.toRecord(sync.parse(sync.toYaml(record), 'tool-search-test.yaml')).toolSearch).toEqual(
      record.toolSearch
    )
  })

  test('stores null when the type sets no override', () => {
    expect(sync.toRecord(sync.parse(minimalYaml(['tools:', '  allow: [read]']), 'x.yaml')).toolSearch).toBeNull()
    expect(sync.toRecord(sync.parse(minimalYaml(), 'x.yaml')).toolSearch).toBeNull()
  })

  test('rejects an unknown search mode', () => {
    expect(() => sync.parse(minimalYaml(['tools:', '  search: sometimes']), 'x.yaml')).toThrow(
      "AgentType: 'tools.search' must be one of auto, on, off"
    )
  })

  test('the fast assistant turns tool search off', () => {
    const parsed = sync.parse(readFileSync(join(AGENT_TYPES_DIR, 'assistant.yaml'), 'utf8'), 'assistant.yaml')
    expect(sync.toRecord(parsed).toolSearch).toEqual({ search: 'off' })
  })

  test.each(['engineer', 'manager'])('the shipped %s turns tool search on, with no warnings', (id) => {
    const warn = mock()
    const quiet = new AgentTypeSync()
    // `log` is a lazy getter on ConfigSync; seed its cache so sync warnings land in the mock.
    ;(quiet as unknown as { _log: unknown })._log = { warn, info: mock(), debug: mock(), error: mock() }
    const parsed = quiet.parse(readFileSync(join(AGENT_TYPES_DIR, `${id}.yaml`), 'utf8'), `${id}.yaml`)
    // A YAML 1.1 parser would read `on` as true; the policy must store the string.
    expect(quiet.toRecord(parsed).toolSearch).toEqual({ search: 'on' })
    expect(warn).not.toHaveBeenCalled()
  })
})
