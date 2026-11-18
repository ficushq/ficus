import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { sharedPrompts } from '../../db'
import { SharedPrompt } from '../../entities/SharedPrompt'
import { AGENT_TYPE_SHARED_PROMPTS_DIR } from '../../lib/paths'
import { assertConfigId, assertNonEmptyString } from '../../lib/validation/config-ids'
import { ConfigSync, type SyncResult } from './ConfigSync'
import { adoptSplitIncludes, readableTextIncludeStored } from './split-includes'
import { adoptPublicTextInclude, publicTextIncludeStored } from './public-text-include'

export interface SharedPromptMarkdown {
  id: string
  name: string
  description?: string
  content: string
}

/** Name = first markdown heading (any level) or the id; description = first non-heading paragraph line. */
export function parseSharedPromptMarkdown(content: string, id: string): SharedPromptMarkdown {
  assertConfigId(id, 'shared prompt id')
  assertNonEmptyString(content, 'content')
  const lines = content.split(/\r?\n/)
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s+\S/.test(line))
  const name = headingIndex >= 0 ? lines[headingIndex].replace(/^#{1,6}\s+/, '').trim() : id
  const description = lines
    .slice(headingIndex >= 0 ? headingIndex + 1 : 0)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'))
  return { id, name, ...(description ? { description } : {}), content }
}

/** Reads every include block on disk, keyed by file stem. Shared with AgentTypeSync validation. */
export async function loadSharedPromptFiles(dir: string = AGENT_TYPE_SHARED_PROMPTS_DIR): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return out
  }
  for (const file of entries) {
    if (!file.endsWith('.md') || file.startsWith('.')) continue
    out.set(file.replace(/\.md$/, ''), await readFile(join(dir, file), 'utf-8'))
  }
  return out
}

export class SharedPromptSync extends ConfigSync<SharedPromptMarkdown> {
  readonly name = 'shared-prompts'
  readonly directory = AGENT_TYPE_SHARED_PROMPTS_DIR
  readonly table = sharedPrompts
  readonly idColumn = sharedPrompts.id
  readonly yamlTemplateColumn = sharedPrompts.yamlTemplate
  readonly yamlFieldOverridesColumn = sharedPrompts.yamlFieldOverrides
  readonly updatedAtColumn = sharedPrompts.updatedAt
  readonly disabledColumn = sharedPrompts.disabled

  async sync(): Promise<SyncResult> {
    // The sync that first stores `readable-text` is the upgrade past the split of
    // `rules`; only then are pre-split include lists migrated (see split-includes).
    const migrateIncludes = !(await readableTextIncludeStored())
    // Likewise the sync that first stores `public-text` (the fixed public-text
    // rules moved out of `squad-rules`) adopts it into custom include lists.
    const adoptPublicText = !(await publicTextIncludeStored())
    const result = await super.sync()
    if (migrateIncludes && (await readableTextIncludeStored())) await adoptSplitIncludes()
    if (adoptPublicText && (await publicTextIncludeStored())) await adoptPublicTextInclude()
    return result
  }

  async loadFromDir(): Promise<SharedPromptMarkdown[]> {
    const files = await loadSharedPromptFiles(this.directory)
    if (files.size === 0) this.log.warn(`Directory empty or missing: ${this.directory}`)
    return [...files.entries()].map(([id, content]) => parseSharedPromptMarkdown(content, id))
  }

  parse(content: string, filename: string): SharedPromptMarkdown {
    return parseSharedPromptMarkdown(content, filename.replace(/\.md$/i, ''))
  }

  toRecord(parsed: SharedPromptMarkdown): Record<string, unknown> {
    return { id: parsed.id, name: parsed.name, description: parsed.description ?? null, content: parsed.content }
  }

  getId(parsed: SharedPromptMarkdown): string {
    return parsed.id
  }

  toComparable(row: Record<string, unknown>): Record<string, unknown> {
    return { id: row.id, name: row.name, description: row.description ?? null, content: row.content }
  }

  toYaml(row: Record<string, unknown>): string {
    return String(row.content ?? '')
  }

  async afterSync(): Promise<void> {
    SharedPrompt.invalidateCache()
  }
}
