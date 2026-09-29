import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtemp, readFile, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { db, skills } from '../../db'
import { Skill } from '../../entities/Skill'
import { getSandboxSkillsDir, materializeSandboxSkills, materializeSkills } from './skill-materializer'

describe('materializeSkills', () => {
  beforeEach(async () => {
    await db.delete(skills)
    Skill.invalidateCache()
  })

  test('writes enabled DB skill content to SKILL.md directories', async () => {
    await Skill.upsert({ id: 'custom-skill', name: 'Custom Skill', content: '# Custom Skill\n\nUse this.' })
    const paths = await materializeSkills(['custom-skill'])
    expect(paths).toHaveLength(1)
    await expect(readFile(join(paths![0], 'SKILL.md'), 'utf-8')).resolves.toContain('# Custom Skill')
  })

  test('writes DB skill support files beside SKILL.md', async () => {
    await Skill.upsert({
      id: 'custom-skill',
      name: 'Custom Skill',
      content: '# Custom Skill\n\nRead ./helper.md',
      supportFiles: { 'helper.md': '# Helper\n', 'nested/deep.md': '# Deep\n' },
    })
    const paths = await materializeSkills(['custom-skill'])
    expect(paths).toHaveLength(1)
    await expect(readFile(join(paths![0], 'helper.md'), 'utf-8')).resolves.toBe('# Helper\n')
    await expect(readFile(join(paths![0], 'nested', 'deep.md'), 'utf-8')).resolves.toBe('# Deep\n')
  })

  test('uses deterministic persistent paths and avoids rewriting unchanged files', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'ficus-skills-test-'))
    await Skill.upsert({ id: 'custom-skill', name: 'Custom Skill', content: '# Custom Skill\n' })

    const first = await materializeSkills(['custom-skill'], baseDir)
    const before = (await stat(join(first![0], 'SKILL.md'))).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await materializeSkills(['custom-skill'], baseDir)
    const after = (await stat(join(second![0], 'SKILL.md'))).mtimeMs

    expect(first![0]).toBe(join(baseDir, 'custom-skill'))
    expect(second![0]).toBe(first![0])
    expect(after).toBe(before)
  })

  test('materializes selected skills into a sandbox-scoped directory', async () => {
    await Skill.upsert({ id: 'custom-skill', name: 'Custom Skill', content: '# Custom Skill\n' })

    const paths = await materializeSandboxSkills('squad_abc123', ['custom-skill'])

    expect(paths).toEqual([join(getSandboxSkillsDir('squad_abc123'), 'custom-skill')])
    await expect(readFile(join(paths![0], 'SKILL.md'), 'utf-8')).resolves.toContain('# Custom Skill')
  })

  test('authoritatively prunes stale skill directories including an empty expected set', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'ficus-skills-test-'))
    await Skill.upsert({ id: 'first-skill', name: 'First', content: '# First\n' })
    await Skill.upsert({ id: 'second-skill', name: 'Second', content: '# Second\n' })
    await materializeSkills(['first-skill', 'second-skill'], baseDir, true)

    await materializeSkills(['first-skill'], baseDir, true)
    await expect(stat(join(baseDir, 'second-skill'))).rejects.toThrow()
    await materializeSkills([], baseDir, true)
    await expect(stat(join(baseDir, 'first-skill'))).rejects.toThrow()
  })

  test('removes stale support files from persistent directories', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'ficus-skills-test-'))
    await Skill.upsert({
      id: 'custom-skill',
      name: 'Custom Skill',
      content: '# Custom Skill\n',
      supportFiles: { 'old.md': 'old', 'keep.md': 'keep' },
    })
    const paths = await materializeSkills(['custom-skill'], baseDir)

    await Skill.upsert({
      id: 'custom-skill',
      name: 'Custom Skill',
      content: '# Custom Skill\n',
      supportFiles: { 'keep.md': 'keep' },
    })
    await materializeSkills(['custom-skill'], baseDir)

    await expect(readFile(join(paths![0], 'keep.md'), 'utf-8')).resolves.toBe('keep')
    await expect(readFile(join(paths![0], 'old.md'), 'utf-8')).rejects.toThrow()
  })
})
