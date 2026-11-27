import { TOOL_GROUPS, toolGroup } from './labels'

export const TOOL_SEARCH_TOOL_NAME = 'tool_search'

/**
 * The system prompt section that names every tool a session holds back. It depends only on the
 * set of hidden names (not their order), so it is identical on every turn and after resume.
 */
export function buildHiddenToolsPromptSection(hidden: readonly string[]): string {
  const names = [...new Set(hidden)].sort()
  if (names.length === 0) return ''
  const lines: string[] = []
  for (const group of TOOL_GROUPS) {
    const members = names.filter((name) => toolGroup(name) === group)
    if (members.length > 0) lines.push(`- ${group.description}: ${members.join(', ')}`)
  }
  const other = names.filter((name) => !toolGroup(name))
  if (other.length > 0) lines.push(`- Other tools: ${other.join(', ')}`)
  return [
    '## Tools loaded on demand',
    '',
    `More tools are available but not loaded. Load them with \`${TOOL_SEARCH_TOOL_NAME}\` before use (search by tool name or by what you need, for example "screenshot the page"); a loaded tool can be called from your next call on and stays loaded:`,
    ...lines,
    '',
    `When these instructions or a skill tell you to use one of these tools, load it with \`${TOOL_SEARCH_TOOL_NAME}\` first.`,
  ].join('\n')
}
