import { describe, expect, test } from 'bun:test'
import * as yaml from 'js-yaml'
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

  test('every built-in agent type interpolates the squad context at most once', async () => {
    // The manager used to carry {{squad.context}} in manager.yaml, in the
    // squad-rules include, and in prose in squad-dynamic-context (the
    // interpolator expands it there too), so a squad's whole context repeated.
    const [parsed, files] = await Promise.all([new AgentTypeSync().loadFromDir(), loadSharedPromptFiles()])
    expect(parsed.length).toBeGreaterThan(0)
    for (const agentType of parsed) {
      const composed = composeFromYaml(agentType, files)
      expect(composed.split('{{squad.context}}').length - 1, agentType.id).toBeLessThanOrEqual(1)
    }
    const manager = composeFromYaml(
      parsed.find((item) => item.id === 'manager')!,
      files
    )
    expect(manager.split('{{squad.context}}').length - 1).toBe(1)
  })
})
