import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { generateSkillReferences, renderSkillReference } from './skill-references'

const repoRoot = resolve(import.meta.dir, '../../..')

describe('skill reference copies', () => {
  test('each committed copy matches its docs page (regenerate with: bun apps/docs/scripts/skill-references.ts)', () => {
    for (const { target, content } of generateSkillReferences())
      expect(readFileSync(resolve(repoRoot, target), 'utf8')).toBe(content)
  })

  test('keeps the page title and description and makes site links absolute', () => {
    const page =
      '---\ntitle: Build a workflow\ndescription: Field reference.\n---\n\nSee [Choose](/use/workflows/) and [below](#limits).\n'
    expect(renderSkillReference('page.mdx', page)).toContain(
      '# Build a workflow\n\nField reference.\n\nSee [Choose](https://docs.ficus.sh/use/workflows/) and [below](#limits).\n'
    )
  })
})
