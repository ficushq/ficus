import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { generateSkillReferences, renderSkillReference, selectSections } from './skill-references'

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
  test('keeps only allowed sections, with subsections only under a kept parent', () => {
    const body = [
      'Intro.',
      '## Kept',
      'A.',
      '```yaml',
      '## not a heading inside code',
      '```',
      '### Kept child',
      'B.',
      '### Dropped child',
      'C.',
      '## Dropped',
      'D.',
      '### Kept child',
      'E.',
    ].join('\n')
    expect(selectSections('page.mdx', body, ['Kept', 'Kept child'])).toBe(
      ['Intro.', '## Kept', 'A.', '```yaml', '## not a heading inside code', '```', '### Kept child', 'B.'].join('\n')
    )
  })

  test('fails when an allowed heading no longer exists', () => {
    expect(() => selectSections('page.mdx', '## Present\n', ['Present', 'Renamed'])).toThrow(
      'page.mdx has no section "Renamed"'
    )
  })

  test('the workflow reference leaves out the sections written for people', () => {
    const [reference] = generateSkillReferences().filter(({ target }) => target.includes('setup-workflows'))
    expect(reference!.content).toContain('## Presets, sources, and customizations')
    expect(reference!.content).toContain('`set-outcome`')
    for (const heading of [
      'How delivery state is recorded',
      'Review screen and visual editor',
      'Upgrading older definitions',
      'Targeted editor edits',
    ])
      expect(reference!.content).not.toContain(`## ${heading}`)
  })
})
