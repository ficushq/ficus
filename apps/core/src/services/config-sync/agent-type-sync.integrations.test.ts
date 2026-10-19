import { describe, expect, test } from 'bun:test'
import yaml from 'js-yaml'
import { AgentTypeSync } from './agent-type-sync'

const base = `id: test\nname: Test\nmodel: openai:gpt-5\nsystemPrompt: test\n`

describe('agent type integration policy', () => {
  test('parses, normalizes, persists, and exports version 1 policy', () => {
    const sync = new AgentTypeSync()
    const parsed = sync.parse(
      `${base}integrations:\n  version: 1\n  allow:\n    bigbrain: [agent_tools, agent_tools]\n`,
      'test.yaml'
    )
    expect(parsed.integrations).toEqual({
      version: 1,
      allow: { bigbrain: ['agent_tools'] },
    })
    const record = sync.toRecord(parsed)
    expect(record.integrationCapabilities).toEqual(parsed.integrations)
    expect((yaml.load(sync.toYaml(record)) as any).integrations).toEqual(parsed.integrations)
  })

  test('absence means no integration policy', () => {
    const sync = new AgentTypeSync()
    expect(sync.toRecord(sync.parse(base, 'test.yaml')).integrationCapabilities).toBeNull()
  })

  test.each([
    ['unknown version', 'integrations:\n  version: 2\n  allow: {}'],
    ['unknown capability', 'integrations:\n  version: 1\n  allow:\n    bigbrain: [root_access]'],
    ['malformed provider', 'integrations:\n  version: 1\n  allow:\n    Big Brain: [agent_tools]'],
  ])('rejects %s', (_name, policy) => {
    expect(() => new AgentTypeSync().parse(`${base}${policy}\n`, 'test.yaml')).toThrow()
  })
})
