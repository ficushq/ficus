/**
 * Agents read skills inside their sandboxes, where neither the repository nor the docs site is
 * guaranteed to be available. Skills that rely on a public docs page therefore ship a copy of it
 * as a support file. This keeps each copy identical to its source page, minus the sections written
 * only for people (screen layouts, editor tools, upgrade notes): each reference lists the headings
 * agents receive, and a heading missing from the list is left out together with its subsections.
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
    // Left out for agents: "How delivery state is recorded" (storage and API internals),
    // "Review screen and visual editor", and "Upgrading older definitions" with its
    // "Targeted editor edits", which describe the web app and its editor assistant.
    sections: [
      'Start with a complete example',
      'Definition fields',
      'Participants: who performs the work',
      'Steps: instructions, results, and decisions',
      'Handoffs and rework',
      'Parallel branches and joins',
      'Routing policy',
      'Limits',
      'Completion policy',
      'Delivery pull requests',
      'Integration subscriptions',
      'Questions, waits, and pauses',
      'Presets, sources, and customizations',
      'Structured CLI input',
      'Agent authoring workflow',
      'Validate before using a flow',
    ],
  },
] as const

/**
 * Keep the text before the first `##` heading and every `##`/`###` section whose heading is
 * allowed. A subsection is kept only when its parent section is kept. Headings inside fenced code
 * blocks are not headings. Every allowed heading must exist, so a renamed heading fails loudly.
 */
export function selectSections(source: string, body: string, allowed: readonly string[]): string {
  const remaining = new Set(allowed)
  const kept: string[] = []
  let fenced = false
  let keepSection = true
  let keepSubsection = true
  for (const line of body.split('\n')) {
    if (/^(```|~~~)/.test(line)) fenced = !fenced
    const heading = fenced ? null : /^(##|###) (.+)$/.exec(line)
    if (heading) {
      const title = heading[2]!.trim()
      const allowedHere = allowed.includes(title)
      remaining.delete(title)
      if (heading[1] === '##') {
        keepSection = allowedHere
        keepSubsection = true
      } else {
        keepSubsection = keepSection && allowedHere
      }
    }
    if (keepSection && keepSubsection) kept.push(line)
  }
  if (remaining.size) throw new Error(`${source} has no section ${[...remaining].map((t) => `"${t}"`).join(', ')}`)
  return kept.join('\n').trim()
}

/** Markdown for an agent: title and description from the frontmatter, site links made absolute. */
export function renderSkillReference(source: string, page: string, sections?: readonly string[]): string {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(page)
  if (!match) throw new Error(`${source} has no frontmatter`)
  const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(match[1]!)?.[1]?.trim()
  const title = field('title')
  if (!title) throw new Error(`${source} has no title`)
  const description = field('description')
  const pageBody = page.slice(match[0].length).trim()
  const body = (sections ? selectSections(source, pageBody, sections) : pageBody).replace(
    /\]\((\/[^)]*)\)/g,
    (_link, path: string) => `](${DOCS_SITE}${path})`
  )
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
  return SKILL_REFERENCES.map(({ source, target, sections }) => ({
    target,
    content: renderSkillReference(source, readFileSync(resolve(repoRoot, source), 'utf8'), sections),
  }))
}

if (import.meta.main) {
  for (const { target, content } of generateSkillReferences()) {
    writeFileSync(resolve(repoRoot, target), content)
    console.log(`Wrote ${target}`)
  }
}
