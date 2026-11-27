import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { AgentSession } from './AgentSession'
import * as modelSelection from '../services/model-selection'
import { getSessionDir } from '../lib/infra/session-files'
import { createBrowserTools } from '../tools/browser'
import type { ToolSearchPolicy } from '../services/agent/tool-search'

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

async function create(model: string, options: { toolSearch?: ToolSearchPolicy; agentId?: string } = {}) {
  const selection = spyOn(modelSelection, 'selectModelSpecForCurrentEnvWithSwitchBack').mockReturnValue({
    selected: model,
    candidates: [{ spec: model, provider: model.split(':')[0]!, modelId: model.split(':')[1]!, usable: true }],
  })
  try {
    const session = await AgentSession.create({
      model,
      systemPrompt: 'You are a test agent.',
      ...(options.agentId ? { storage: { agentId: options.agentId } } : {}),
      tools: {
        core: [bash],
        available: createBrowserTools('agent-tool-search-test', 'sandbox-tool-search-test'),
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

describe('AgentSession tool search', () => {
  it('declares only direct tools plus tool_search and names the hidden tools in the system prompt', async () => {
    // The browser tools alone are under the size threshold, so search: on forces the split.
    const session = await create('anthropic:claude-opus-5-5', { toolSearch: { search: 'on' } })
    expect(session.pi.getActiveToolNames().sort()).toEqual(['bash', 'tool_search'])
    const exposures = Object.fromEntries(session.pi.getAllTools().map((tool) => [tool.name, tool.exposure]))
    for (const name of browserNames) expect(exposures[name]).toBe('deferred')
    expect(session.pi.systemPrompt).toContain(`automation and visual review: open a page`)
    expect(session.pi.systemPrompt).toContain(browserNames.join(', '))
  })

  it('declares every tool when the deferrable tools are under the size threshold', async () => {
    const session = await create('anthropic:claude-opus-5-5')
    expect(session.pi.getActiveToolNames().sort()).toEqual(['bash', ...browserNames])
    expect(session.pi.systemPrompt).not.toContain('tool_search')
  })

  it('declares every tool with search: off', async () => {
    const session = await create('anthropic:claude-opus-5-5', { toolSearch: { search: 'off' } })
    expect(session.pi.getActiveToolNames().sort()).toEqual(['bash', ...browserNames])
    expect(session.pi.systemPrompt).not.toContain('tool_search')
  })

  it('declares every tool on a model that cannot add tools mid-conversation', async () => {
    const session = await create('zai:glm-5.3', { toolSearch: { search: 'on' } })
    expect(session.pi.getActiveToolNames().sort()).toEqual(['bash', ...browserNames])
  })

  it('keeps the recorded plan on the next turn even when a new decision would differ', async () => {
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
  })
})
