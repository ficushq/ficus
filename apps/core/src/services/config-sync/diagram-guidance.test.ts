import { describe, expect, test } from 'bun:test'
import { readFile } from 'fs/promises'
import { join } from 'path'

const root = join(import.meta.dir, '../../../../../')
const read = (path: string) => readFile(join(root, path), 'utf8')

/** The `## Diagrams` section of the shared squad rules, whitespace-normalized. */
async function diagramSection(): Promise<string> {
  const rules = await read('config/agent-types/shared/squad-rules.md')
  return (rules.split('\n## Diagrams\n')[1]?.split(/\n## /)[0] ?? '').replace(/\s+/g, ' ').trim()
}

describe('diagram guidance', () => {
  test('offers Mermaid diagrams for flows and architecture in the documents people review', async () => {
    const guidance = await diagramSection()
    expect(guidance).toContain('flow, state machine, architecture or sequence')
    expect(guidance).toContain('fenced `mermaid` code block')
    expect(guidance).toContain('pull request bodies, review handoffs, briefs and plans')
  })

  test('keeps diagrams for cases where they clarify, not a default, and stays short', async () => {
    const guidance = await diagramSection()
    expect(guidance).toContain('only when it really clarifies')
    expect(guidance).toContain('It is not a default for every message')
    expect(guidance.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(4)
  })

  test('reaches every squad agent through the shared squad rules', async () => {
    for (const id of ['engineer', 'reviewer', 'architect', 'manager']) {
      const type = Bun.YAML.parse(await read(`config/agent-types/${id}.yaml`)) as { includes?: string[] }
      expect({ id, includes: type.includes?.includes('squad-rules') }).toEqual({ id, includes: true })
    }
  })
})
