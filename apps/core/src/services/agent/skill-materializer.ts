import { consultantSandboxSquadId } from '../sandbox/consultant-sandbox'
import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { dirname, join, relative } from 'path'
import { Skill } from '../../entities/Skill'
import { getHomeDir } from '../../lib/utils/home'
import { assertConfigId } from '../../lib/validation/config-ids'
import { validateSkillSupportFiles } from '../config-sync/skill-sync'

export const MATERIALIZED_SKILLS_DIR = join(getHomeDir(), 'skills', 'materialized')
export const SANDBOX_SKILLS_DIR = join(getHomeDir(), 'skills', 'sandboxes')

export function getSandboxSkillsStorageKey(sandboxId: string): string {
  if (typeof sandboxId !== 'string' || !sandboxId.trim()) throw new Error('sandbox id is required')
  const sanitized = sandboxId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return sanitized || `sandbox-${Bun.hash(sandboxId).toString(36)}`
}

export function getSandboxSkillsDir(sandboxId: string): string {
  return join(SANDBOX_SKILLS_DIR, getSandboxSkillsStorageKey(sandboxId))
}

async function writeIfChanged(path: string, content: string) {
  try {
    if ((await readFile(path, 'utf-8')) === content) return
  } catch {
    // Missing files are written below.
  }
  await writeFile(path, content, 'utf-8')
}

async function listFiles(dir: string, root = dir): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const files = await Promise.all(
      entries.map(async (entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return listFiles(path, root)
        if (entry.isFile()) return [relative(root, path)]
        return []
      })
    )
    return files.flat()
  } catch {
    return []
  }
}

async function removeStaleFiles(dir: string, expectedFiles: Set<string>) {
  for (const file of await listFiles(dir)) {
    if (!expectedFiles.has(file)) await rm(join(dir, file), { force: true })
  }
}

/**
 * Materializes enabled DB skills into deterministic directories under <HOME_DIR>/skills/materialized
 * (or the provided baseDir in tests). Files persist across runs, are only rewritten when content
 * changes, and stale support files are removed so Pi can load stable SKILL.md folders by path.
 */
export async function materializeSkills(
  skillRefs: string[] | null | undefined,
  baseDir = MATERIALIZED_SKILLS_DIR,
  authoritative = false
): Promise<string[] | undefined> {
  if (!skillRefs?.length && !authoritative) return undefined
  const paths: string[] = []
  const expectedDirectories = new Set<string>()
  await mkdir(baseDir, { recursive: true })
  for (const ref of skillRefs ?? []) {
    const skill = await Skill.find(ref)
    if (skill && !skill.disabled) {
      assertConfigId(skill.id, 'skill id')
      const dir = join(baseDir, skill.id)
      expectedDirectories.add(skill.id)
      await mkdir(dir, { recursive: true })
      const supportFiles = validateSkillSupportFiles(skill.supportFiles)
      const expectedFiles = new Set(['SKILL.md', ...Object.keys(supportFiles)])
      await writeIfChanged(join(dir, 'SKILL.md'), skill.content)
      for (const [relativePath, content] of Object.entries(supportFiles)) {
        const filePath = join(dir, relativePath)
        await mkdir(dirname(filePath), { recursive: true })
        await writeIfChanged(filePath, content)
      }
      await removeStaleFiles(dir, expectedFiles)
      paths.push(dir)
    }
  }
  if (authoritative) {
    for (const entry of await readdir(baseDir, { withFileTypes: true })) {
      if (!expectedDirectories.has(entry.name)) await rm(join(baseDir, entry.name), { recursive: true, force: true })
    }
  }
  return paths.length ? paths : undefined
}

export function materializeSandboxSkills(
  sandboxId: string,
  skillRefs: string[] | null | undefined
): Promise<string[] | undefined> {
  return materializeSkills(skillRefs, getSandboxSkillsDir(sandboxId), !consultantSandboxSquadId(sandboxId))
}
