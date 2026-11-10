import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, 'SquadPresetsSection.tsx'), 'utf8')

describe('SquadPresetsSection template revert refresh', () => {
  test('syncs expanded row form state when refreshed squad preset data arrives', () => {
    // Re-seeded while rendering when the squad preset object changes.
    expect(source.includes('if (formSource !== squadPreset)')).toBe(true)
    expect(source.includes('setForm(squadPresetToForm(squadPreset))')).toBe(true)
  })
})
