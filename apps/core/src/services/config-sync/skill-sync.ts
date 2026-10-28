import { assertRecordLimit } from '../../lib/validation/request-collections'
import { readdir, readFile } from 'fs/promises'
import { join, relative, sep } from 'path'
import yaml from 'js-yaml'
import { skills } from '../../db'
import { Skill } from '../../entities/Skill'
import { SKILLS_DIR } from '../../lib/paths'
import { assertConfigId, assertNonEmptyString } from '../../lib/validation/config-ids'
import { ConfigSync } from './ConfigSync'

export type SkillSupportFiles = Record<string, string>

export interface SkillMarkdown {
  id: string
  name: string
  description?: string
  content: string
  supportFiles: SkillSupportFiles
  requiredPermission: string | null
}

export function validateSkillSupportFiles(value: unknown): SkillSupportFiles {
  assertRecordLimit(value, 256, 'support files')
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('supportFiles must be an object')
  const result: SkillSupportFiles = {}
  for (const [path, content] of Object.entries(value as Record<string, unknown>)) {
    if (typeof content !== 'string') throw new Error(`supportFiles.${path} must be a string`)
    validateSupportFilePath(path)
    result[path] = content
  }
  return result
}

export function validateSupportFilePath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
    throw new Error(`Invalid support file path: ${path}`)
  }
  if (path === 'SKILL.md' || !path.endsWith('.md')) throw new Error(`Support file must be a markdown file: ${path}`)
}

/**
 * Extract the leading YAML frontmatter block from a SKILL.md file.
 * Missing frontmatter is not an error; malformed frontmatter is surfaced to
 * config sync so invalid skill definitions fail clearly.
 */
function parseSkillFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return {}
  const parsed = yaml.load(match[1])
  if (parsed == null) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Skill frontmatter must be a YAML mapping')
  }
  return parsed as Record<string, unknown>
}

export function parseSkillMarkdown(content: string, id: string, supportFiles: SkillSupportFiles = {}): SkillMarkdown {
  assertConfigId(id, 'skill id')
  assertNonEmptyString(content, 'content')
  supportFiles = validateSkillSupportFiles(supportFiles)

  const frontmatter = parseSkillFrontmatter(content)
  const hasRequiredPermission = Object.prototype.hasOwnProperty.call(frontmatter, 'required-permission')
  const requiredPermissionRaw = frontmatter['required-permission']
  let requiredPermission: string | null = null
  if (hasRequiredPermission) {
    if (typeof requiredPermissionRaw !== 'string' || !requiredPermissionRaw.trim()) {
      throw new Error(`Skill ${id}: 'required-permission' must be a non-empty string`)
    }
    requiredPermission = requiredPermissionRaw.trim()
  }

  const lines = content.split(/\r?\n/)
  const heading = lines
    .find((line) => line.startsWith('# '))
    ?.replace(/^#\s+/, '')
    .trim()
  const name = heading || id
  const afterHeading = heading ? lines.slice(lines.findIndex((line) => line.startsWith('# ')) + 1) : lines
  const description = afterHeading
    .find((line) => {
      const trimmed = line.trim()
      return trimmed.length > 0 && !trimmed.startsWith('---') && !trimmed.startsWith('#')
    })
    ?.trim()
  return { id, name, description, content, supportFiles, requiredPermission }
}

async function readSupportFiles(root: string): Promise<SkillSupportFiles> {
  const result: SkillSupportFiles = {}
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'SKILL.md') continue
      const rel = relative(root, fullPath).split(sep).join('/')
      validateSupportFilePath(rel)
      result[rel] = await readFile(fullPath, 'utf-8')
    }
  }
  await walk(root)
  return result
}

export class SkillSync extends ConfigSync<SkillMarkdown> {
  readonly name = 'skills'
  readonly directory = SKILLS_DIR
  readonly table = skills
  readonly idColumn = skills.id
  readonly yamlTemplateColumn = skills.yamlTemplate
  readonly yamlFieldOverridesColumn = skills.yamlFieldOverrides
  readonly updatedAtColumn = skills.updatedAt
  readonly disabledColumn = skills.disabled

  async loadFromDir(): Promise<SkillMarkdown[]> {
    let entries: string[]
    try {
      entries = await readdir(this.directory)
    } catch {
      this.log.warn(`Directory not found: ${this.directory}`)
      return []
    }
    const result: SkillMarkdown[] = []
    for (const id of entries) {
      if (id.startsWith('.') || id.startsWith('example-')) continue
      try {
        const skillDir = join(this.directory, id)
        const content = await readFile(join(skillDir, 'SKILL.md'), 'utf-8')
        result.push(parseSkillMarkdown(content, id, await readSupportFiles(skillDir)))
      } catch (error: any) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
        throw error
      }
    }
    return result
  }

  parse(content: string, filename: string): SkillMarkdown {
    return parseSkillMarkdown(content, filename.replace(/\.md$/i, ''))
  }

  toRecord(parsed: SkillMarkdown): Record<string, unknown> {
    return {
      id: parsed.id,
      name: parsed.name,
      description: parsed.description ?? null,
      content: parsed.content,
      supportFiles: parsed.supportFiles,
      requiredPermission: parsed.requiredPermission ?? null,
    }
  }

  getId(parsed: SkillMarkdown): string {
    return parsed.id
  }

  toComparable(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      content: row.content,
      supportFiles: validateSkillSupportFiles(row.supportFiles),
      requiredPermission: row.requiredPermission ?? null,
    }
  }

  toYaml(row: Record<string, unknown>): string {
    return String(row.content ?? '')
  }

  async afterSync(): Promise<void> {
    Skill.invalidateCache()
  }
}
