/**
 * Agents read skills inside their sandboxes, where neither the repository nor the docs site is
 * guaranteed to be available. Skills that rely on a public docs page therefore ship a copy of it
 * as a support file. This keeps each copy identical to its source page.
 *
 *   bun apps/docs/scripts/skill-references.ts   # regenerate after editing a source page
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '../../..')
const DOCS_SITE = 'https://docs.ficus.sh'

export const SKILL_REFERENCES = [
  {
    source: 'apps/docs/src/content/docs/reference/workflow-definition.mdx',
    target: 'config/skills/setup-workflows/reference.md',
  },
] as const

/** Markdown for an agent: title and description from the frontmatter, site links made absolute. */
export function renderSkillReference(source: string, page: string): string {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(page)
  if (!match) throw new Error(`${source} has no frontmatter`)
  const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(match[1]!)?.[1]?.trim()
  const title = field('title')
  if (!title) throw new Error(`${source} has no title`)
  const description = field('description')
  const body = page
    .slice(match[0].length)
    .trim()
    .replace(/\]\((\/[^)]*)\)/g, (_link, path: string) => `](${DOCS_SITE}${path})`)
  return [
    `<!-- Generated from ${source}; edit that page, then run: bun apps/docs/scripts/skill-references.ts -->`,
    '',
    `# ${title}`,
    '',
    ...(description ? [description, ''] : []),
    body,
    '',
  ].join('\n')
}

export function generateSkillReferences(): { target: string; content: string }[] {
  return SKILL_REFERENCES.map(({ source, target }) => ({
    target,
    content: renderSkillReference(source, readFileSync(resolve(repoRoot, source), 'utf8')),
  }))
}

if (import.meta.main) {
  for (const { target, content } of generateSkillReferences()) {
    writeFileSync(resolve(repoRoot, target), content)
    console.log(`Wrote ${target}`)
  }
}
