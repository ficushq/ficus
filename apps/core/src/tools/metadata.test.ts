import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Type } from '@sinclair/typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { classifiedTools, replayIsHarmless, toolMetadata, toolReplay, withToolMetadata } from './metadata'

const repoRoot = join(import.meta.dir, '../../../..')

/** Tool names declared in a source file: `name: 'x'` on a definition, or the Assistant `tool('x', ...)` helper. */
function declaredToolNames(path: string): string[] {
  const source = readFileSync(path, 'utf8')
  const names = [...source.matchAll(/^\s+name: ['"]([a-z][a-z0-9_]*)['"],?$/gm)].map((match) => match[1]!)
  for (const match of source.matchAll(/\btool\(\s*['"]([a-z][a-z0-9_]*)['"]/g)) names.push(match[1]!)
  for (const match of source.matchAll(/_TOOL_NAME = ['"]([a-z][a-z0-9_]*)['"]/g)) names.push(match[1]!)
  // The Assistant's continue/retry/cancel tools are built from one template.
  if (source.includes('`${operation}_task`')) names.push('continue_task', 'retry_task', 'cancel_task')
  return names
}

/** The names in a `const NAME = ['a', 'b'] as const` list, read from source so no database module loads. */
function listedNames(path: string, constant: string): string[] {
  const source = readFileSync(join(repoRoot, path), 'utf8')
  const list = source.match(new RegExp(`${constant} = \\[([^\\]]*)\\]`))?.[1]
  if (!list) throw new Error(`${constant} not found in ${path}`)
  return [...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!)
}

function builtInToolNames(): string[] {
  const toolsDir = join(repoRoot, 'apps/core/src/tools')
  const files = readdirSync(toolsDir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'metadata.ts')
    .map((file) => join(toolsDir, file))
  files.push(join(repoRoot, 'config/agent/extensions/code-ast/index.ts'))
  files.push(join(repoRoot, 'apps/core/src/services/agent/tool-search/prompt.ts'))
  return [
    ...new Set([
      ...files.flatMap(declaredToolNames),
      // Created by pi's coding-agent factories, wrapped for the sandbox.
      'bash',
      'read',
      'write',
      'edit',
      'squad_bash',
      ...listedNames('apps/core/src/services/integrations/bigbrain/tools.ts', 'BIGBRAIN_TOOL_NAMES'),
      ...listedNames('apps/core/src/services/integrations/bigbrain/shared-tools.ts', 'BIGBRAIN_SHARED_TOOL_NAMES'),
    ]),
  ].sort()
}

describe('tool classification', () => {
  test('every built-in tool is classified explicitly', () => {
    const names = builtInToolNames()
    // Guard the scan itself, so a broken pattern cannot make this pass vacuously.
    expect(names).toEqual(
      expect.arrayContaining([
        'ask_human',
        'dispatch',
        'memory_get',
        'todo_add',
        'ast_rename',
        'bigbrain_drop',
        'tool_search',
      ])
    )
    expect(names.filter((name) => !classifiedTools().has(name))).toEqual([])
  })

  test('the classes follow the research brief, checked per tool', () => {
    for (const name of ['read', 'memory_search', 'sandbox_status', 'webfetch', 'browser_screenshot', 'todo_list'])
      expect(toolReplay(name)).toBe('safe')
    for (const name of [
      'write',
      'memory_write',
      'short_term_memory_write',
      'set_agent_purpose',
      'stop_subagent',
      'tool_search',
    ])
      expect(toolReplay(name)).toBe('idempotent')
    for (const name of [
      'bash',
      'squad_bash',
      'edit',
      'memory_patch',
      'memory_append',
      'todo_add',
      'ask_human',
      'notify_contact',
      'dispatch',
      'browser_click',
      'browser_type',
      'monitor',
      // A repeat publishes again, reloads the page, or shows the person another link.
      'artifact_publish',
      'browser_open',
      'navigate',
    ])
      expect(toolReplay(name)).toBe('unsafe')
  })

  test('a tool no one classified is unsafe, including extension and integration tools', () => {
    for (const name of ['some_extension_tool', 'mcp__github__create_issue', '', 'READ'])
      expect(toolMetadata(name)).toEqual({ replay: 'unsafe' })
  })

  test('only safe and idempotent replays are harmless', () => {
    expect(replayIsHarmless('safe')).toBe(true)
    expect(replayIsHarmless('idempotent')).toBe(true)
    expect(replayIsHarmless('unsafe')).toBe(false)
  })
})

describe('metadata on tool definitions', () => {
  const definition = (name: string, extra: Partial<ToolDefinition> & { ficus?: unknown } = {}) =>
    ({
      name,
      label: name,
      description: 'fixture',
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
      ...extra,
    }) as ToolDefinition

  test('a classified tool carries its class and the matching standard hints', () => {
    expect(withToolMetadata(definition('read'))).toMatchObject({
      ficus: { replay: 'safe' },
      annotations: { readOnlyHint: true },
    })
    expect(withToolMetadata(definition('write'))).toMatchObject({
      ficus: { replay: 'idempotent' },
      annotations: { readOnlyHint: false, idempotentHint: true },
    })
    expect(withToolMetadata(definition('bash'))).toMatchObject({
      ficus: { replay: 'unsafe' },
      annotations: { readOnlyHint: false, idempotentHint: false },
    })
  })

  test('an unclassified tool is unsafe for Ficus and keeps its own hints; it cannot declare itself safe', () => {
    const tool = withToolMetadata(
      definition('ext_tool', { annotations: { readOnlyHint: true }, ficus: { replay: 'safe' } })
    )
    expect(tool.ficus).toEqual({ replay: 'unsafe' })
    expect(tool.annotations).toEqual({ readOnlyHint: true })
  })
})
