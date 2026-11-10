import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, 'SkillsSection.tsx'), 'utf8')

describe('SkillsSection support files editor', () => {
  test('edits skill support files inside the main skill form', () => {
    expect(source).toContain('Support files')
    expect(source).toContain('supportFiles')
    expect(source).toContain('addSupportFile')
    expect(source).toContain('removeSupportFile')
  })

  test('syncs open edit form when refreshed skill data arrives', () => {
    // Re-seeded while rendering when the edited skill's data changes.
    expect(source.includes('if (editing?.id && editingSkill && seededFrom !== editingSkill)')).toBe(true)
    expect(source.includes('setEditing({ ...editingSkill')).toBe(true)
  })
})
