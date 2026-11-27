import { describe, expect, it } from 'bun:test'
import { buildHiddenToolsPromptSection } from './prompt'

describe('buildHiddenToolsPromptSection', () => {
  it('names every hidden tool, grouped, and says to load them with tool_search', () => {
    const section = buildHiddenToolsPromptSection([
      'browser_open',
      'ast_symbols',
      'browser_click',
      'dispatch',
      'custom_tool',
    ])
    expect(section).toBe(
      [
        '## Tools loaded on demand',
        '',
        'More tools are available but not loaded. Load them with `tool_search` before use (search by tool name or by what you need, for example "screenshot the page"); a loaded tool can be called from your next call on and stays loaded:',
        '- Browser automation and visual review: open a page, click, type, scroll, read text, take a screenshot, read console logs: browser_click, browser_open',
        '- Code navigation: list the symbols in a file, find references to a symbol, rename a symbol across the codebase: ast_symbols',
        '- Subagents: dispatch scoped tasks to ephemeral subagents, check their status, stop one: dispatch',
        '- Other tools: custom_tool',
        '',
        'When these instructions or a skill tell you to use one of these tools, load it with `tool_search` first.',
      ].join('\n')
    )
  })

  it('depends only on the set of names, so it is identical on every turn', () => {
    const a = buildHiddenToolsPromptSection(['browser_open', 'monitor', 'browser_click', 'todo_add'])
    const b = buildHiddenToolsPromptSection(['todo_add', 'browser_click', 'monitor', 'browser_open', 'monitor'])
    expect(a).toBe(b)
  })

  it('is empty when nothing is hidden', () => {
    expect(buildHiddenToolsPromptSection([])).toBe('')
  })
})
