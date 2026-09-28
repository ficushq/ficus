import { describe, expect, test } from 'bun:test'
import yaml from 'js-yaml'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { AgentTypeSync, composeFromYaml } from './agent-type-sync'
import { loadSharedPromptFiles } from './shared-prompt-sync'

const repoRoot = join(import.meta.dir, '../../../../../')

function readRepoFile(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8')
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ')
}

function readIncludes(config: string): string[] {
  const parsed = yaml.load(config) as { includes?: string[] }
  return parsed.includes ?? []
}

describe('squad context configuration guidance', () => {
  test('manager and consultant include shared top-level context/typeContext guidance', async () => {
    const [manager, consultant, guidance] = await Promise.all([
      readRepoFile('config/agent-types/manager.yaml'),
      readRepoFile('config/agent-types/consultant.yaml'),
      readRepoFile('config/agent-types/shared/squad-dynamic-context.md'),
    ])

    expect(readIncludes(manager)).toContain('squad-dynamic-context')
    expect(readIncludes(consultant)).toContain('squad-dynamic-context')

    const normalizedGuidance = normalize(guidance)
    expect(normalizedGuidance).toContain('Squad Context (all-agent and type-specific)')
    expect(normalizedGuidance, 'guidance should describe top-level fields').toContain('top-level')
    expect(normalizedGuidance.toLowerCase(), 'guidance should name context').toContain('context')
    expect(normalizedGuidance.toLowerCase(), 'guidance should name typeContext').toContain('typecontext')
    expect(normalizedGuidance, 'guidance should explain shared context purpose').toContain('project-wide information')
    expect(normalizedGuidance, 'guidance should explain type context purpose').toContain('role-specific instructions')
    expect(normalizedGuidance, 'guidance should show --context').toContain('--context')
    expect(normalizedGuidance, 'guidance should show --type-context').toContain('--type-context')
    expect(normalizedGuidance, 'guidance should show null delete').toContain('"engineer":null')
    expect(normalizedGuidance).toContain('ficus squad update')
    expect(normalizedGuidance).toContain('ficus squad get')
    expect(normalizedGuidance).toContain('Handle simple context configuration directly when requested')
    expect(normalizedGuidance).not.toContain('ficus squad create')
  })

  test('shared squad context guidance lands in the composed manager and consultant prompts', async () => {
    const [parsed, files] = await Promise.all([new AgentTypeSync().loadFromDir(), loadSharedPromptFiles()])

    for (const id of ['manager', 'consultant']) {
      const agentType = parsed.find((item) => item.id === id)
      expect(agentType, `${id} agent type should load`).toBeTruthy()
      const composed = composeFromYaml(agentType!, files)
      expect(composed).toContain('Squad Context (all-agent and type-specific)')
      expect(composed).toContain('project-wide information')
      expect(composed).toContain('role-specific instructions')
    }
  })
})
