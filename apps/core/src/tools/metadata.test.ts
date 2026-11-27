import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Type } from '@sinclair/typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { classifiedTools, replayIsHarmless, toolMetadata, toolReplay, withToolMetadata } from './metadata'

const repoRoot = join(import.meta.dir, '../../../..')

interface DeclaredTools {
  names: string[]
  /** Tool names built from a template the scan cannot expand, so a new factory cannot slip past. */
  unresolved: string[]
}

/** The values a factory maps over: `(['a', 'b'] as const).map((op) =>` gives `a` and `b` for `op`. */
function mappedValues(source: string, variable: string): string[] | undefined {
  const list = source.match(
    new RegExp(`\\[([^\\[\\]]*)\\](?:\\s+as\\s+const)?\\)?\\.(?:map|flatMap)\\(\\(?${variable}\\b[^)]*\\)?\\s*=>`)
  )?.[1]
  if (!list) return undefined
  const values = [...list.matchAll(/['"]([a-z0-9_]+)['"]/g)].map((match) => match[1]!)
  return values.length > 0 ? values : undefined
}

/**
 * Tool names declared in source: `name: 'x'` on a definition, the Assistant `tool('x', ...)`
 * helper, a `X_TOOL_NAME = 'x'` constant, and a name built from a template in either position. A
 * template with one `${variable}` is expanded over the list the factory maps it over; any other
 * template is reported as unresolved.
 */
function declaredToolNames(source: string): DeclaredTools {
  const names = [...source.matchAll(/^\s+name: ['"]([a-z][a-z0-9_]*)['"],?$/gm)].map((match) => match[1]!)
  for (const match of source.matchAll(/\btool\(\s*['"]([a-z][a-z0-9_]*)['"]/g)) names.push(match[1]!)
  for (const match of source.matchAll(/_TOOL_NAME = ['"]([a-z][a-z0-9_]*)['"]/g)) names.push(match[1]!)
  const unresolved: string[] = []
  for (const match of source.matchAll(/(?:^\s+name: |\btool\(\s*)`([^`]*)`/gm)) {
    const template = match[1]!
    const parts = template.match(/^([a-z0-9_]*)\$\{(\w+)\}([a-z0-9_]*)$/)
    const values = parts && mappedValues(source, parts[2]!)
    if (!parts || !values) unresolved.push(template)
    else names.push(...values.map((value) => `${parts[1]}${value}${parts[3]}`))
  }
  return { names, unresolved }
}

/** The names in a `const NAME = ['a', 'b'] as const` list, read from source so no database module loads. */
function listedNames(path: string, constant: string): string[] {
  const source = readFileSync(join(repoRoot, path), 'utf8')
  const list = source.match(new RegExp(`${constant} = \\[([^\\]]*)\\]`))?.[1]
  if (!list) throw new Error(`${constant} not found in ${path}`)
  return [...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!)
}

function builtInTools(): DeclaredTools {
  const toolsDir = join(repoRoot, 'apps/core/src/tools')
  const files = readdirSync(toolsDir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'metadata.ts')
    .map((file) => join(toolsDir, file))
  files.push(join(repoRoot, 'config/agent/extensions/code-ast/index.ts'))
  files.push(join(repoRoot, 'apps/core/src/services/agent/tool-search/prompt.ts'))
  const declared = files.map((file) => ({ file, ...declaredToolNames(readFileSync(file, 'utf8')) }))
  const names = [
    ...new Set([
      ...declared.flatMap((tools) => tools.names),
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
  const unresolved = declared.flatMap(({ file, unresolved }) =>
    unresolved.map((template) => `${file.slice(repoRoot.length + 1)}: \`${template}\``)
  )
  return { names, unresolved }
}

describe('tool classification', () => {
  const { names, unresolved } = builtInTools()

  test('every built-in tool is classified explicitly', () => {
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
        // Built from the `${operation}_task` template in the Assistant's tool factory.
        'continue_task',
        'retry_task',
        'cancel_task',
      ])
    )
    expect(names.filter((name) => !classifiedTools().has(name))).toEqual([])
  })

  test('every tool name built from a template is expanded by the scan', () => {
    // A factory that builds names from a template the scan cannot expand would hide its tools from the
    // check above. Map the template over a literal list, or teach declaredToolNames the new shape.
    expect(unresolved).toEqual([])
  })

  test('every name in the table is a real built-in tool', () => {
    // A stale entry would keep a removed tool's class for any later tool that reuses the name.
    expect([...classifiedTools().keys()].filter((name) => !names.includes(name))).toEqual([])
  })

  test('the scan expands factory templates and reports the ones it cannot', () => {
    const factory = [
      "const tools = (['pause', 'resume'] as const).map((operation) =>",
      '  tool(`${operation}_job`, `${operation} a job`, schema, run)',
      ')',
      "const more = ['a', 'b'].map((kind) => ({",
      '  name: `widget_${kind}`,',
      '}))',
      'const other = {',
      '  name: `${prefix}_${suffix}`,',
      '}',
      'const loose = {',
      '  name: `orphan_${missing}`,',
      '}',
    ].join('\n')
    expect(declaredToolNames(factory)).toEqual({
      names: ['pause_job', 'resume_job', 'widget_a', 'widget_b'],
      unresolved: ['${prefix}_${suffix}', 'orphan_${missing}'],
    })
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

  test('a tool no one classified is unsafe and direct, including extension and integration tools', () => {
    for (const name of ['some_extension_tool', 'mcp__github__create_issue', '', 'READ'])
      expect(toolMetadata(name)).toEqual({ replay: 'unsafe', label: 'direct' })
  })

  test('tool_search is idempotent: a repeat finds the tools already loaded', () => {
    expect(toolMetadata('tool_search')).toEqual({ replay: 'idempotent', label: 'direct' })
    expect(replayIsHarmless(toolReplay('tool_search'))).toBe(true)
  })

  test('only the browser, code navigation and checklist tools default to deferrable', () => {
    const deferrable = [...classifiedTools()]
      .filter(([, metadata]) => metadata.label === 'deferrable')
      .map(([name]) => name)
      .sort()
    expect(deferrable).toEqual([
      'ast_references',
      'ast_rename',
      'ast_symbols',
      'browser_click',
      'browser_console',
      'browser_open',
      'browser_read',
      'browser_screenshot',
      'browser_scroll',
      'browser_type',
      'todo_add',
      'todo_list',
      'todo_remove',
      'todo_toggle',
      'todo_update',
    ])
    for (const name of ['bash', 'read', 'ask_human', 'dispatch', 'monitor', 'memory_search', 'webfetch'])
      expect(toolMetadata(name).label).toBe('direct')
  })

  test('the label does not follow the replay class', () => {
    // Deferrable tools span every class, and direct ones too.
    expect(toolMetadata('browser_read')).toEqual({ replay: 'safe', label: 'deferrable' })
    expect(toolMetadata('ast_rename')).toEqual({ replay: 'idempotent', label: 'deferrable' })
    expect(toolMetadata('todo_add')).toEqual({ replay: 'unsafe', label: 'deferrable' })
    expect(toolMetadata('read')).toEqual({ replay: 'safe', label: 'direct' })
    expect(toolMetadata('bash')).toEqual({ replay: 'unsafe', label: 'direct' })
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
    // The label is not stamped: an agent type's override would make a stamped default wrong.
    expect(withToolMetadata(definition('browser_open')).ficus).toEqual({ replay: 'unsafe' })
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
