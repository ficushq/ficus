import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { AgentSession } from './AgentSession'
import * as modelSelection from '../services/model-selection'
import { getSessionDir } from '../lib/infra/session-files'
import { createBrowserTools } from '../tools/browser'
import { createTodoTools } from '../tools/todo'
import { AGENT_TYPES_DIR, EXTENSIONS_DIR } from '../lib/paths'
import type { ToolSearchPolicy } from '../services/agent/tool-search'
import { parseToolSearchPolicy } from '../services/agent/tool-search/labels'

const bash: ToolDefinition = {
  name: 'bash',
  label: 'bash',
  description: 'Run a shell command',
  parameters: Type.Object({ command: Type.String() }),
  execute: async () => ({ content: [{ type: 'text', text: '' }], details: {} }),
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

interface CreateOptions {
  toolSearch?: ToolSearchPolicy
  agentId?: string
  core?: ToolDefinition[]
  allow?: string[]
  extensionPaths?: string[]
}

async function create(model: string, options: CreateOptions = {}) {
  const selection = spyOn(modelSelection, 'selectModelSpecForCurrentEnvWithSwitchBack').mockReturnValue({
    selected: model,
    candidates: [{ spec: model, provider: model.split(':')[0]!, modelId: model.split(':')[1]!, usable: true }],
  })
  try {
    const session = await AgentSession.create({
      model,
      systemPrompt: 'You are a test agent.',
      ...(options.agentId ? { storage: { agentId: options.agentId } } : {}),
      ...(options.extensionPaths ? { extensionPaths: options.extensionPaths } : {}),
      tools: {
        core: options.core ?? [bash],
        available: createBrowserTools('agent-tool-search-test', 'sandbox-tool-search-test'),
        ...(options.allow ? { allow: options.allow } : {}),
        toolSearch: options.toolSearch,
      },
    })
    cleanups.push(() => session.pi.dispose())
    return session
  } finally {
    selection.mockRestore()
  }
}

const browserNames = [
  'browser_click',
  'browser_console',
  'browser_open',
  'browser_read',
  'browser_screenshot',
  'browser_scroll',
  'browser_type',
]

// Each case builds real sessions (and one resumes from disk); a cold run on a loaded box is slow.
const TIMEOUT_MS = 60_000

describe('AgentSession tool search', () => {
  it(
    'declares only direct tools plus tool_search and names the hidden tools in the system prompt',
    async () => {
      // The browser tools alone are under the size threshold, so search: on forces the split.
      const session = await create('anthropic:claude-opus-5-5', { toolSearch: { search: 'on' } })
      expect(session.pi.getActiveToolNames().sort()).toEqual(['bash', 'tool_search'])
      const exposures = Object.fromEntries(session.pi.getAllTools().map((tool) => [tool.name, tool.exposure]))
      for (const name of browserNames) expect(exposures[name]).toBe('deferred')
      expect(session.pi.systemPrompt).toContain(`automation and visual review: open a page`)
      expect(session.pi.systemPrompt).toContain(browserNames.join(', '))
    },
    TIMEOUT_MS
  )

  it(
    'declares every tool when the deferrable tools are under the size threshold',
    async () => {
      const session = await create('anthropic:claude-opus-5-5')
      expect(session.pi.getActiveToolNames().sort()).toEqual(['bash', ...browserNames])
      expect(session.pi.systemPrompt).not.toContain('tool_search')
    },
    TIMEOUT_MS
  )

  it(
    'declares every tool with search: off',
    async () => {
      const session = await create('anthropic:claude-opus-5-5', { toolSearch: { search: 'off' } })
      expect(session.pi.getActiveToolNames().sort()).toEqual(['bash', ...browserNames])
      expect(session.pi.systemPrompt).not.toContain('tool_search')
    },
    TIMEOUT_MS
  )

  it(
    'declares every tool on a model that cannot add tools mid-conversation',
    async () => {
      const session = await create('zai:glm-5.3', { toolSearch: { search: 'on' } })
      expect(session.pi.getActiveToolNames().sort()).toEqual(['bash', ...browserNames])
    },
    TIMEOUT_MS
  )

  it.each(['engineer', 'manager'])(
    'a new %s session hides the browser, code navigation and checklist tools',
    async (id) => {
      // The shipped type's tools block, as sync stores it: allow list plus `search: on`.
      const tools = (
        yaml.load(readFileSync(join(AGENT_TYPES_DIR, `${id}.yaml`), 'utf8')) as { tools: Record<string, unknown> }
      ).tools
      const toolSearch = parseToolSearchPolicy(tools)
      expect(toolSearch).toEqual({ search: 'on' })
      const todo = createTodoTools({ read: async () => null, write: async () => {} })
      const session = await create('anthropic:claude-opus-5-5', {
        toolSearch,
        allow: tools.allow as string[],
        core: [bash, ...todo],
        // The real code-ast extension, which both types load for the ast_* tools.
        extensionPaths: [join(EXTENSIONS_DIR, 'code-ast')],
      })
      const astNames = session.pi
        .getAllTools()
        .map((tool) => tool.name)
        .filter((name) => name.startsWith('ast_'))
        .sort()
      const todoNames = todo.map((tool) => tool.name).sort()
      expect(astNames.length).toBeGreaterThan(0)
      expect(session.pi.getActiveToolNames().sort()).toEqual(['bash', 'tool_search'])
      const exposures = Object.fromEntries(session.pi.getAllTools().map((tool) => [tool.name, tool.exposure]))
      for (const name of [...browserNames, ...astNames, ...todoNames]) expect(exposures[name]).toBe('deferred')
      const prompt = session.pi.systemPrompt
      expect(prompt).toContain('## Tools loaded on demand')
      expect(prompt).toContain(browserNames.join(', '))
      expect(prompt).toContain(`- Code navigation: list the symbols in a file`)
      expect(prompt).toContain(astNames.join(', '))
      expect(prompt).toContain(`- Checklist: add, list, toggle, update and remove todo items: ${todoNames.join(', ')}`)
    },
    TIMEOUT_MS
  )

  it(
    'keeps the recorded plan on the next turn even when a new decision would differ',
    async () => {
      const agentId = `tool-search-${randomUUID()}`
      cleanups.push(() => rmSync(getSessionDir(agentId), { recursive: true, force: true }))
      const first = await create('anthropic:claude-opus-5-5', { agentId, toolSearch: { search: 'on' } })
      const prompt = first.pi.systemPrompt
      // pi writes the session file (with the recorded plan) once the conversation starts.
      first.pi.sessionManager.appendMessage({ role: 'user', content: 'hi', timestamp: Date.now() })
      first.pi.dispose()
      // Same session file, but the type now says off: the session keeps its starting tool set and prompt.
      const next = await create('anthropic:claude-opus-5-5', { agentId, toolSearch: { search: 'off' } })
      expect(next.pi.getActiveToolNames().sort()).toEqual(['bash', 'tool_search'])
      expect(next.pi.systemPrompt).toBe(prompt)
    },
    TIMEOUT_MS
  )
})
