import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { eq } from 'drizzle-orm'
import { db, skills } from '../../db'
import { SkillSync, parseSkillMarkdown } from './skill-sync'

describe('parseSkillMarkdown', () => {
  test('extracts required-permission from frontmatter', () => {
    const md = [
      '---',
      'name: gated',
      'description: "gated skill"',
      'required-permission: system:logs',
      '---',
      '',
      '# Gated',
      '',
      'Body',
    ].join('\n')

    const parsed = parseSkillMarkdown(md, 'gated')

    expect(parsed.requiredPermission).toBe('system:logs')
  })

  test('returns null requiredPermission when key absent', () => {
    const md = ['---', 'name: open', '---', '', '# Open', '', 'Body'].join('\n')

    const parsed = parseSkillMarkdown(md, 'open')

    expect(parsed.requiredPermission).toBeNull()
  })

  test('returns null requiredPermission when no frontmatter exists', () => {
    const parsed = parseSkillMarkdown('# Plain\n\nBody', 'plain')

    expect(parsed.requiredPermission).toBeNull()
  })

  test('rejects empty required-permission value', () => {
    const md = ['---', 'required-permission: ""', '---', '', '# X'].join('\n')

    expect(() => parseSkillMarkdown(md, 'x')).toThrow(/non-empty string/)
  })

  test('rejects null required-permission value', () => {
    const md = ['---', 'required-permission:', '---', '', '# X'].join('\n')

    expect(() => parseSkillMarkdown(md, 'x')).toThrow(/non-empty string/)
  })
})

describe('SkillSync', () => {
  beforeEach(async () => {
    await db.delete(skills)
  })

  test('syncs SKILL.md files without overwriting overridden fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ficus-skill-sync-'))
    await mkdir(join(dir, 'custom-skill'))
    await writeFile(join(dir, 'custom-skill', 'SKILL.md'), '# Custom Skill\n\nOriginal description\n')
    const sync = new SkillSync()
    ;(sync as any).directory = dir

    await sync.sync()
    await db
      .update(skills)
      .set({ content: '# Admin Skill\n\nAdmin content\n', yamlFieldOverrides: ['content'] })
      .where(eq(skills.id, 'custom-skill'))
    await writeFile(join(dir, 'custom-skill', 'SKILL.md'), '# Custom Skill\n\nChanged template\n')

    const result = await sync.sync()
    const [row] = await db.select().from(skills).where(eq(skills.id, 'custom-skill'))
    expect(result.synced).toBe(1)
    expect(row.content).toContain('Admin content')
    expect(row.yamlFieldOverrides).toEqual(['content'])
    expect(row.yamlTemplate).toMatchObject({ content: '# Custom Skill\n\nChanged template\n' })
  })

  test('persists requiredPermission from frontmatter to the DB', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ficus-skill-sync-'))
    await mkdir(join(dir, 'gated-skill'))
    await writeFile(
      join(dir, 'gated-skill', 'SKILL.md'),
      '---\nname: gated\nrequired-permission: system:logs\n---\n\n# Gated\n\nBody\n'
    )
    const sync = new SkillSync()
    ;(sync as any).directory = dir

    await sync.sync()

    const [row] = await db.select().from(skills).where(eq(skills.id, 'gated-skill'))
    expect(row.requiredPermission).toBe('system:logs')
  })

  test('syncs referenced markdown support files from skill directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ficus-skill-sync-'))
    await mkdir(join(dir, 'custom-skill', 'nested'), { recursive: true })
    await writeFile(join(dir, 'custom-skill', 'SKILL.md'), '# Custom Skill\n\nRead ./helper.md\n')
    await writeFile(join(dir, 'custom-skill', 'helper.md'), '# Helper\n')
    await writeFile(join(dir, 'custom-skill', 'nested', 'deep.md'), '# Deep\n')
    const sync = new SkillSync()
    ;(sync as any).directory = dir

    await sync.sync()

    const [row] = await db.select().from(skills).where(eq(skills.id, 'custom-skill'))
    expect(row.supportFiles).toEqual({ 'helper.md': '# Helper\n', 'nested/deep.md': '# Deep\n' })
  })

  test('repo ships the frontend-visual-review skill', async () => {
    const { SKILLS_DIR } = await import('../../lib/paths')
    const { readFile, stat } = await import('fs/promises')
    const { join } = await import('path')
    const filePath = join(SKILLS_DIR, 'frontend-visual-review', 'SKILL.md')
    await expect(stat(filePath)).resolves.toBeDefined()
    const md = await readFile(filePath, 'utf8')
    expect(md).toMatch(/^---/)
    expect(md).toMatch(/name:\s*frontend-visual-review/)
  })

  test('repo ships a workspace-agnostic and secret-safe Notion skill', async () => {
    const { SKILLS_DIR } = await import('../../lib/paths')
    const { readFile } = await import('fs/promises')
    const { join } = await import('path')
    const md = await readFile(join(SKILLS_DIR, 'notion', 'SKILL.md'), 'utf8')
    for (const term of [
      'ntn api ls --json',
      'v1/search',
      'ntn pages get',
      'ntn datasources query',
      'NOTION_API_TOKEN',
    ]) {
      expect(md).toContain(term)
    }
    for (const prohibited of ['ntn login', 'ntn logout', 'ntn workers oauth token', '--unsafe-verbose']) {
      expect(md).toContain(prohibited)
    }
    expect(md).not.toMatch(/workspace-[0-9a-f]|secret_[0-9a-z]|ntn_[0-9a-z]{20}/i)
    expect(parseSkillMarkdown(md, 'notion').name).toBe('Notion CLI')
  })

  test('repo ships the system:logs-gated view-system-logs skill', async () => {
    const { SKILLS_DIR } = await import('../../lib/paths')
    const { readFile, stat } = await import('fs/promises')
    const { join } = await import('path')
    const filePath = join(SKILLS_DIR, 'view-system-logs', 'SKILL.md')
    await expect(stat(filePath)).resolves.toBeDefined()
    const md = await readFile(filePath, 'utf8')
    expect(md).toContain('ficus system logs')
    expect(parseSkillMarkdown(md, 'view-system-logs').requiredPermission).toBe('system:logs')
  })
})
