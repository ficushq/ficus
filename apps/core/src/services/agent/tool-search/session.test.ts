/**
 * Tool search on a real pi session (pi's faux provider stands in for the model): what each request
 * declares, loading a tool with `tool_search`, calling it on the next turn, and resuming.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession as PiAgentSession,
  type ResourceLoader,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { activateToolSearch, createToolSearchTool, labelToolForPlan } from './session'
import { buildHiddenToolsPromptSection } from './prompt'
import type { ToolSearchPlan } from './plan'

function tool(name: string, description: string, calls: string[]): ToolDefinition {
  return {
    name,
    label: name,
    description,
    parameters: Type.Object({}),
    async execute() {
      calls.push(name)
      return { content: [{ type: 'text', text: `${name} ran` }], details: {} }
    },
  }
}

/** Stands in for Ficus's wrappers (firewall, recovery, redaction): records that it ran. */
function wrapped(definition: ToolDefinition, wrapperCalls: string[]): ToolDefinition {
  return {
    ...definition,
    async execute(...args) {
      wrapperCalls.push(definition.name)
      return definition.execute(...args)
    },
  }
}

const sessions: PiAgentSession[] = []
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose()
})

async function startSession(input: {
  sessionManager: SessionManager
  plan: ToolSearchPlan
  faux: ReturnType<typeof fauxProvider>
  calls: string[]
  wrapperCalls: string[]
}) {
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false })
  modelRuntime.registerNativeProvider(input.faux.provider)
  const base = [
    tool('bash', 'Run a shell command', input.calls),
    tool('browser_screenshot', 'Take a screenshot of the current page', input.calls),
    tool('browser_open', 'Open a URL in the browser', input.calls),
    tool('ast_symbols', 'List the symbols in a source file', input.calls),
  ].map((definition) => wrapped(definition, input.wrapperCalls))
  const piSession: { current?: PiAgentSession } = {}
  const customTools = base.map((definition) => labelToolForPlan(definition, input.plan))
  if (input.plan.mode === 'search') customTools.push(createToolSearchTool(() => piSession.current))
  const systemPrompt = ['You are a test agent.', buildHiddenToolsPromptSection(input.plan.hidden)].join('\n\n')
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    getPathMetadata: () => new Map(),
    extendResources: () => {},
    reload: async () => {},
  } as ResourceLoader
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir: '/tmp/ficus-tool-search-test',
    modelRuntime,
    model: input.faux.getModel(),
    thinkingLevel: 'off',
    noTools: 'builtin',
    customTools,
    resourceLoader,
    sessionManager: input.sessionManager,
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false, keepRecentTokens: 1 },
    }),
  })
  piSession.current = session
  activateToolSearch(session, input.plan)
  sessions.push(session)
  return session
}

const declared = (context: TranscriptContext) =>
  getCurrentTools(context.messages)
    .map((t) => t.name)
    .sort()

// Real pi sessions, a resume and a compaction: allow for a loaded shared box.
const TIMEOUT_MS = 30_000

describe('tool search on a pi session', () => {
  it(
    'declares direct tools plus tool_search, loads a match, and runs it through the wrappers next turn',
    async () => {
      const faux = fauxProvider({ provider: 'faux-tool-search', models: [{ id: 'faux-model' }] })
      const calls: string[] = []
      const wrapperCalls: string[] = []
      const plan: ToolSearchPlan = {
        mode: 'search',
        hidden: ['ast_symbols', 'browser_open', 'browser_screenshot'],
        reason: 'test',
      }
      const requests: string[][] = []
      const systemPrompts: string[] = []
      const record = (context: TranscriptContext) => {
        requests.push(declared(context))
        systemPrompts.push(getCurrentSystemPrompt(context.messages))
      }
      faux.setResponses([
        (context) => {
          record(context)
          return fauxAssistantMessage(fauxToolCall('tool_search', { query: 'screenshot the page', limit: 1 }), {
            stopReason: 'toolUse',
          })
        },
        (context) => {
          record(context)
          return fauxAssistantMessage(fauxToolCall('browser_screenshot', {}), { stopReason: 'toolUse' })
        },
        (context) => {
          record(context)
          return fauxAssistantMessage('done')
        },
      ])
      const sessionManager = SessionManager.inMemory(process.cwd())
      const session = await startSession({ sessionManager, plan, faux, calls, wrapperCalls })
      await session.prompt('take a screenshot')

      expect(requests[0]).toEqual(['bash', 'tool_search'])
      expect(requests[1]).toEqual(['bash', 'browser_screenshot', 'tool_search'])
      expect(calls).toEqual(['browser_screenshot'])
      expect(wrapperCalls).toEqual(['browser_screenshot'])
      expect(systemPrompts[0]).toContain('browser_open, browser_screenshot')

      // Resume: a new pi session over the same session file keeps the loaded tool, and records no
      // tool change, so the request head (and the prompt cache) stays the same.
      const systemMessagesBefore = sessionManager
        .getBranch()
        .filter((entry) => entry.type === 'message' && entry.message.role === 'system').length
      faux.setResponses([
        (context) => {
          record(context)
          return fauxAssistantMessage('resumed')
        },
      ])
      const resumed = await startSession({ sessionManager, plan, faux, calls, wrapperCalls })
      await resumed.prompt('again')
      expect(requests.at(-1)).toEqual(['bash', 'browser_screenshot', 'tool_search'])
      const systemMessagesAfter = sessionManager
        .getBranch()
        .filter((entry) => entry.type === 'message' && entry.message.role === 'system').length
      expect(systemMessagesAfter).toBe(systemMessagesBefore)
      expect(systemPrompts.at(-1)).toBe(systemPrompts[0])

      // Compaction, then another resume: the loaded tool is still declared.
      // History summary and turn-prefix summary.
      faux.setResponses([() => fauxAssistantMessage('summary'), () => fauxAssistantMessage('turn prefix summary')])
      await resumed.compact()
      faux.setResponses([
        (context) => {
          record(context)
          return fauxAssistantMessage('after compaction')
        },
      ])
      const afterCompaction = await startSession({ sessionManager, plan, faux, calls, wrapperCalls })
      await afterCompaction.prompt('once more')
      expect(sessionManager.getBranch().some((entry) => entry.type === 'compaction')).toBe(true)
      expect(requests.at(-1)).toEqual(['bash', 'browser_screenshot', 'tool_search'])
      expect(systemPrompts.at(-1)).toBe(systemPrompts[0])
    },
    TIMEOUT_MS
  )

  it(
    'declares every tool and no tool_search in a direct session',
    async () => {
      const faux = fauxProvider({ provider: 'faux-direct', models: [{ id: 'faux-model' }] })
      const requests: string[][] = []
      faux.setResponses([
        (context) => {
          requests.push(declared(context))
          return fauxAssistantMessage('ok')
        },
      ])
      const session = await startSession({
        sessionManager: SessionManager.inMemory(process.cwd()),
        plan: { mode: 'direct', hidden: [], reason: 'test' },
        faux,
        calls: [],
        wrapperCalls: [],
      })
      await session.prompt('hi')
      expect(requests[0]).toEqual(['ast_symbols', 'bash', 'browser_open', 'browser_screenshot'])
    },
    TIMEOUT_MS
  )

  it(
    'lets pi tool search find a tool by its namespace description',
    async () => {
      const faux = fauxProvider({ provider: 'faux-namespace', models: [{ id: 'faux-model' }] })
      const requests: string[][] = []
      faux.setResponses([
        // Neither browser tool's own description says "visual review"; their namespace does.
        () => fauxAssistantMessage(fauxToolCall('tool_search', { query: 'visual review' }), { stopReason: 'toolUse' }),
        (context) => {
          requests.push(declared(context))
          return fauxAssistantMessage('ok')
        },
      ])
      const session = await startSession({
        sessionManager: SessionManager.inMemory(process.cwd()),
        plan: { mode: 'search', hidden: ['ast_symbols', 'browser_open', 'browser_screenshot'], reason: 'test' },
        faux,
        calls: [],
        wrapperCalls: [],
      })
      await session.prompt('look at the page')
      expect(requests[0]).toEqual(['bash', 'browser_open', 'browser_screenshot', 'tool_search'])
    },
    TIMEOUT_MS
  )
})
