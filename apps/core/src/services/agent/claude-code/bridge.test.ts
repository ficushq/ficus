import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeContext,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type ToolResultMessage,
} from '@earendil-works/pi-ai'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  CLAUDE_CODE_EXITED,
  CLAUDE_CODE_SESSION_CLOSED,
  CLAUDE_CODE_SIDE_REQUEST,
  createClaudeCodeStream,
} from './bridge'
import { claudeSystemPrompt, emptyUsage, renderHistoryPrompt } from './convert'
import {
  answerInterruptedToolCalls,
  INTERRUPTED_TOOL_CALLS_TYPE,
  interruptedToolCalls,
  interruptedToolResultText,
} from '../interrupted-tool-calls'
import { isRetryableAssistantError } from '@earendil-works/pi-ai'
import { classifyCaughtProviderError } from '../../../lib/error'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { clearClaudeCodeToolLabelsForTest, registerClaudeCodeToolLabels } from '../tool-search/claude-code'

const model = anthropicProvider()
  .getModels()
  .find((candidate) => candidate.id === 'claude-opus-5-5') as Model<Api>
const bash = {
  name: 'bash',
  description: 'Run a command',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
} as any

const TOOL_NAME_NOTE =
  'Tool names: this prompt refers to your tools by short names such as bash. ' +
  'In this session they are named mcp__ficus__<name> (for example mcp__ficus__bash); always call them by that full name.'

/** A scripted stand-in for one Claude Code process (one `query()`). */
class FakeClaude {
  readonly prompts: any[] = []
  interrupted = 0
  closed = false
  private queue: any[] = []
  private wake: (() => void) | undefined
  private promptWaiters: (() => void)[] = []
  client: Client | undefined

  constructor(
    readonly options: Options,
    prompt: AsyncIterable<any>
  ) {
    void (async () => {
      for await (const message of prompt) {
        this.prompts.push(message)
        for (const waiter of this.promptWaiters.splice(0)) waiter()
      }
    })()
  }

  /** The MCP client Claude Code would use for the agent's tools. */
  async tools() {
    if (this.client) return this.client
    const server = (this.options.mcpServers!.ficus as any).instance
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    this.client = new Client({ name: 'claude-code', version: '1' })
    await this.client.connect(clientSide)
    return this.client
  }

  callTool(name: string, args: Record<string, unknown>, toolUseId: string) {
    return this.tools().then((client) =>
      client.request(
        { method: 'tools/call', params: { name, arguments: args, _meta: { 'claudecode/toolUseId': toolUseId } } },
        CallToolResultSchema
      )
    )
  }

  async nextPrompt(count: number) {
    while (this.prompts.length < count) await new Promise<void>((resolve) => this.promptWaiters.push(resolve))
    return this.prompts[count - 1]
  }

  emit(...messages: any[]) {
    this.queue.push(...messages)
    this.wake?.()
  }

  end() {
    this.closed = true
    this.wake?.()
  }

  async interrupt() {
    this.interrupted++
  }

  close() {
    this.end()
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.queue.length) {
        yield this.queue.shift()
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => (this.wake = resolve))
      this.wake = undefined
    }
  }
}

const event = (payload: any) => ({ type: 'stream_event', event: payload, parent_tool_use_id: null, session_id: 'cc-1' })
function textResponse(id: string, text: string) {
  return [
    event({
      type: 'message_start',
      message: {
        id,
        model: 'claude-opus-5-5',
        usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5 },
      },
    }),
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    event({ type: 'content_block_stop', index: 0 }),
    event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
    event({ type: 'message_stop' }),
    { type: 'result', subtype: 'success', result: text, session_id: 'cc-1', is_error: false },
  ]
}
function toolResponse(id: string, toolUseId: string, input: Record<string, unknown>, name = 'mcp__ficus__bash') {
  return [
    event({
      type: 'message_start',
      message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 20, output_tokens: 1 } },
    }),
    event({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolUseId, name, input: {} },
    }),
    event({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    }),
    event({ type: 'content_block_stop', index: 0 }),
    event({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }),
    event({ type: 'message_stop' }),
  ]
}

const user = (text: string): Message => ({ role: 'user', content: text, timestamp: Date.now() })
const toolResult = (toolCallId: string, text: string): ToolResultMessage =>
  ({
    role: 'toolResult',
    toolCallId,
    toolName: 'bash',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: Date.now(),
  }) as ToolResultMessage
const context = (messages: Message[], systemPrompt = 'You are a Ficus worker.') =>
  normalizeContext({ systemPrompt, tools: [bash], messages })

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function harness(stateDir = mkdtempSync(join(tmpdir(), 'claude-code-bridge-'))) {
  dirs.push(stateDir)
  const processes: FakeClaude[] = []
  // The idle-close clock: tests fire pending closes themselves.
  const timers = new Set<() => void>()
  const stream = createClaudeCodeStream({
    executable: () => '/usr/local/bin/claude',
    stateDir: () => stateDir,
    query: ({ prompt, options }) => {
      const fake = new FakeClaude(options, prompt)
      processes.push(fake)
      return fake as any
    },
    schedule: (fn) => {
      timers.add(fn)
      return () => timers.delete(fn)
    },
  })
  const fireIdleTimers = () => {
    const due = [...timers]
    timers.clear()
    for (const fn of due) fn()
  }
  return { stream, processes, stateDir, fireIdleTimers, timers }
}

test('runs Claude Code with no built-in tools, only the agent tools pre-approved, and Ficus’s own prompt', async () => {
  const { stream, processes } = harness()
  const previous = { key: process.env.ANTHROPIC_API_KEY, db: process.env.DATABASE_URL }
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-core'
  process.env.DATABASE_URL = 'postgres://secret'
  try {
    const out = stream(model, context([user('hi')]), { sessionId: 's1', reasoning: 'high' })
    const [claude] = processes
    expect(claude!.options).toMatchObject({
      model: 'claude-opus-5-5',
      pathToClaudeCodeExecutable: '/usr/local/bin/claude',
      systemPrompt: `You are a Ficus worker.\n\n${TOOL_NAME_NOTE}`,
      tools: [],
      allowedTools: ['mcp__ficus__bash'],
      permissionMode: 'dontAsk',
      settingSources: [],
      strictMcpConfig: true,
      effort: 'high',
    })
    expect(claude!.options.env!.ANTHROPIC_API_KEY).toBeUndefined()
    expect(claude!.options.env!.DATABASE_URL).toBeUndefined()
    expect((await claude!.tools()).listTools()).resolves.toMatchObject({ tools: [{ name: 'bash' }] })
    expect((await claude!.nextPrompt(1)).message.content).toEqual([{ type: 'text', text: 'hi' }])
    claude!.emit(...textResponse('msg_1', 'hello'))
    const message = await out.result()
    expect(message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(message.stopReason).toBe('stop')
    expect(message.usage).toMatchObject({ input: 10, output: 7, cacheRead: 5, cost: { total: 0 } })
  } finally {
    if (previous.key === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previous.key
    if (previous.db === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous.db
  }
})

test('the prompt tells the model its tools’ Claude Code names, and keeps the session across turns', async () => {
  const { stream, processes } = harness()
  const first = stream(model, context([user('hi')]), { sessionId: 's-names' })
  const claude = processes[0]!
  expect(claude.options.systemPrompt).toBe(`You are a Ficus worker.\n\n${TOOL_NAME_NOTE}`)
  await claude.nextPrompt(1)
  claude.emit(...textResponse('msg_1', 'hello'))
  const reply = (await first.result()) as AssistantMessage

  // The same base prompt yields the same signature: the next turn reuses the live process.
  const second = stream(model, context([user('hi'), reply, user('again')]), { sessionId: 's-names' })
  expect((await claude.nextPrompt(2)).message.content).toEqual([{ type: 'text', text: 'again' }])
  claude.emit(...textResponse('msg_2', 'hello again'))
  expect((await second.result()).stopReason).toBe('stop')
  expect(processes).toHaveLength(1)
})

test('the tool-name note is left out when the agent has no tools', () => {
  expect(claudeSystemPrompt('Base prompt.', [])).toBe('Base prompt.')
  expect(claudeSystemPrompt(undefined, ['bash'])).toBe(TOOL_NAME_NOTE)
})

test('a tool call ends the turn; Core’s result goes back to the waiting MCP call in the same process', async () => {
  const { stream, processes } = harness()
  const first = stream(model, context([user('list files')]), { sessionId: 's2' })
  const claude = processes[0]!
  await claude.nextPrompt(1)
  claude.emit(...toolResponse('msg_1', 'toolu_1', { command: 'ls' }))
  const call = await first.result()
  expect(call.stopReason).toBe('toolUse')
  expect(call.content).toEqual([{ type: 'toolCall', id: 'toolu_1', name: 'bash', arguments: { command: 'ls' } }])

  // Claude Code calls the tool and waits; Core runs it and starts the next turn with the result.
  const pending = claude.callTool('bash', { command: 'ls' }, 'toolu_1')
  const history = [user('list files'), call as AssistantMessage, toolResult('toolu_1', 'a.txt')]
  const second = stream(model, context(history), { sessionId: 's2' })
  expect(await pending).toEqual({ content: [{ type: 'text', text: 'a.txt' }], isError: false })
  claude.emit(...textResponse('msg_2', 'One file: a.txt'))
  expect((await second.result()).content).toEqual([{ type: 'text', text: 'One file: a.txt' }])

  // The next user message goes to the same Claude Code process.
  const third = stream(model, context([...history, (await second.result()) as AssistantMessage, user('thanks')]), {
    sessionId: 's2',
  })
  expect((await claude.nextPrompt(2)).message.content).toEqual([{ type: 'text', text: 'thanks' }])
  claude.emit(...textResponse('msg_3', 'Any time'))
  expect((await third.result()).stopReason).toBe('stop')
  expect(processes).toHaveLength(1)
})

test('a restarted worker resumes the Claude Code session and sends only what is new', async () => {
  const before = harness()
  const first = before.stream(model, context([user('hi')]), { sessionId: 's3' })
  await before.processes[0]!.nextPrompt(1)
  before.processes[0]!.emit(...textResponse('msg_1', 'hello'))
  const reply = (await first.result()) as AssistantMessage

  const after = harness(before.stateDir)
  const next = after.stream(model, context([user('hi'), reply, user('again')]), { sessionId: 's3' })
  const claude = after.processes[0]!
  expect(claude.options.resume).toBe('cc-1')
  expect((await claude.nextPrompt(1)).message.content).toEqual([{ type: 'text', text: 'again' }])
  claude.emit(...textResponse('msg_2', 'hello again'))
  expect((await next.result()).stopReason).toBe('stop')
})

test('a tool Claude Code calls without its mcp__ficus__ name is never matched to a real tool', async () => {
  // Claude Code rejects an unprefixed name itself ("No such tool available"); Core must not run it.
  const { stream, processes } = harness()
  const first = stream(model, context([user('list files')]), { sessionId: 's-unknown' })
  const claude = processes[0]!
  await claude.nextPrompt(1)
  claude.emit(...toolResponse('msg_1', 'toolu_1', { command: 'ls' }, 'bash'))
  const call = await first.result()
  expect(call.content).toEqual([
    { type: 'toolCall', id: 'toolu_1', name: 'claude-code-unknown:bash', arguments: { command: 'ls' } },
  ])
})

test('a seeded transcript names tool calls the way Claude Code knows them', async () => {
  const history: Message[] = [
    user('list files'),
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'toolu_9', name: 'bash', arguments: { command: 'ls' } }],
      api: 'claude-code',
      provider: 'claude-code',
      model: 'claude-opus-5-5',
      usage: emptyUsage(),
      stopReason: 'toolUse',
      timestamp: Date.now(),
    } as AssistantMessage,
    toolResult('toolu_9', 'a.txt'),
    user('and now?'),
  ]
  const prompt = renderHistoryPrompt(history)
  expect(prompt).toContain('<tool_call name="mcp__ficus__bash" id="toolu_9">')
  expect(prompt).not.toContain('<tool_call name="bash"')
})

test('after a hard restart mid tool call, the re-seeded session shows the restart-aware result pi shows', async () => {
  const before = harness()
  const first = before.stream(model, context([user('list files')]), { sessionId: 's-crash' })
  await before.processes[0]!.nextPrompt(1)
  before.processes[0]!.emit(...toolResponse('msg_1', 'toolu_1', { command: 'ls' }))
  const call = (await first.result()) as AssistantMessage
  // Core dies while the call runs: the session keeps the call, never its result. On resume the
  // context hook answers the recorded call before the conversation reaches the bridge.
  const recorded = interruptedToolCalls([
    {
      type: 'custom',
      id: 'entry-1',
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: INTERRUPTED_TOOL_CALLS_TYPE,
      data: {
        noticeId: 'notice-1',
        executionId: 'execution-1',
        cause: 'core_restart',
        recoveredAt: '2026-11-27T08:05:00.000Z',
        calls: [{ toolCallId: 'toolu_1', toolName: 'bash', replay: 'unsafe' }],
      },
    },
  ])
  const resumed = answerInterruptedToolCalls([user('list files'), call, user('Continue.')], recorded) as Message[]

  const after = harness(before.stateDir)
  const next = after.stream(model, context(resumed), { sessionId: 's-crash' })
  const claude = after.processes[0]!
  // Claude Code's own transcript has no answer for the call, so the session is seeded, not resumed.
  expect(claude.options.resume).toBeUndefined()
  const [transcript, latest] = (await claude.nextPrompt(1)).message.content
  expect(transcript.text).toContain(
    `<tool_result id="toolu_1" error="true">\n${interruptedToolResultText({ toolName: 'bash', replay: 'unsafe' }, { cause: 'core_restart', recoveredAt: '2026-11-27T08:05:00.000Z' })}\n</tool_result>`
  )
  expect(transcript.text).not.toContain('No result provided')
  expect(latest).toEqual({ type: 'text', text: 'Continue.' })
  claude.emit(...textResponse('msg_2', 'checking state first'))
  expect((await next.result()).stopReason).toBe('stop')
})

test('a history Claude Code never saw starts a fresh session seeded with the transcript', async () => {
  const { stream, processes } = harness()
  const compacted: Message[] = [
    user('summary of earlier work'),
    { role: 'assistant', content: [{ type: 'text', text: 'noted' }], responseId: 'elsewhere' } as AssistantMessage,
    user('continue'),
  ]
  const out = stream(model, context(compacted), { sessionId: 's4' })
  const claude = processes[0]!
  expect(claude.options.resume).toBeUndefined()
  const [transcript, latest] = (await claude.nextPrompt(1)).message.content
  expect(transcript.text).toContain('<user>\nsummary of earlier work\n</user>')
  expect(transcript.text).toContain('<assistant>\nnoted\n</assistant>')
  expect(latest).toEqual({ type: 'text', text: 'continue' })
  claude.emit(...textResponse('msg_1', 'continuing'))
  expect((await out.result()).stopReason).toBe('stop')
})

test('abort interrupts Claude Code and ends the turn as aborted', async () => {
  const { stream, processes } = harness()
  const controller = new AbortController()
  const out = stream(model, context([user('long task')]), { sessionId: 's5', signal: controller.signal })
  await processes[0]!.nextPrompt(1)
  controller.abort()
  const message = await out.result()
  expect(message.stopReason).toBe('aborted')
  expect(processes[0]!.interrupted).toBe(1)
})

test('an API error from Claude Code ends the turn with its message', async () => {
  const { stream, processes } = harness()
  const out = stream(model, context([user('hi')]), { sessionId: 's6' })
  await processes[0]!.nextPrompt(1)
  processes[0]!.emit({
    type: 'assistant',
    error: 'rate_limit',
    message: { content: [{ type: 'text', text: 'API Error: usage limit reached' }] },
    parent_tool_use_id: null,
    session_id: 'cc-1',
  })
  const message = await out.result()
  expect(message.stopReason).toBe('error')
  expect(message.errorMessage).toBe('Claude Code rate limit: API Error: usage limit reached')
  expect(isRetryableAssistantError(message)).toBe(true)
})

test('no claude executable fails the turn with a clear error', async () => {
  const stream = createClaudeCodeStream({ executable: () => undefined, stateDir: () => tmpdir() })
  const message = await stream(model, context([user('hi')]), { sessionId: 's7' }).result()
  expect(message.stopReason).toBe('error')
  expect(message.errorMessage).toBe('Claude Code is not installed')
})

for (const shape of ['assistant', 'result']) {
  test(`Claude Code ${shape} session-limit errors remain eligible for tier failover`, async () => {
    const { stream, processes } = harness()
    const out = stream(model, context([user('hi')]), { sessionId: `limit-${shape}` })
    await processes[0]!.nextPrompt(1)
    const text = "You've hit your session limit · resets 2:20am (UTC)"
    processes[0]!.emit(
      shape === 'assistant'
        ? {
            type: 'assistant',
            error: 'rate_limit',
            message: { content: [{ type: 'text', text }] },
            parent_tool_use_id: null,
            session_id: 'cc-1',
          }
        : { type: 'result', subtype: 'error_during_execution', errors: [text], is_error: true, session_id: 'cc-1' }
    )
    const message = await out.result()
    expect(message.stopReason).toBe('error')
    expect(isRetryableAssistantError(message)).toBe(false)
    expect(classifyCaughtProviderError(message.errorMessage, { now: Date.parse('2026-09-29T01:00:00Z') })).toEqual({
      kind: 'plan-credit',
      retryAt: Date.parse('2026-09-29T02:20:00Z'),
    })
  })
}

const weeklyLimit = "You've hit your weekly limit · resets Oct 6, 6am (UTC)"

for (const shape of ['assistant', 'result']) {
  test(`Claude Code ${shape} weekly exhaustion settles without Pi retries and retains its reset`, async () => {
    const { stream, processes } = harness()
    const out = stream(model, context([user('hi')]), { sessionId: `weekly-${shape}` })
    await processes[0]!.nextPrompt(1)
    processes[0]!.emit(
      shape === 'assistant'
        ? {
            type: 'assistant',
            error: 'rate_limit',
            parent_tool_use_id: null,
            message: { content: [{ type: 'text', text: weeklyLimit }] },
            session_id: 'cc-1',
          }
        : {
            type: 'result',
            subtype: 'error_during_execution',
            errors: [weeklyLimit],
            is_error: true,
            session_id: 'cc-1',
          }
    )
    const message = await out.result()
    expect(message.stopReason).toBe('error')
    expect(message.errorMessage).toContain(weeklyLimit)
    expect(isRetryableAssistantError(message)).toBe(false)
    expect(classifyCaughtProviderError(message.errorMessage, { now: Date.parse('2026-10-01T18:00:00Z') })).toEqual({
      kind: 'plan-credit',
      retryAt: Date.parse('2026-10-06T06:00:00Z'),
    })
  })
}

test('quoted quota text in normal output and nested tool errors is not a turn failure', async () => {
  const { stream, processes } = harness()
  const out = stream(model, context([user(weeklyLimit)]), { sessionId: 'quoted-limit' })
  await processes[0]!.nextPrompt(1)
  processes[0]!.emit(
    {
      type: 'assistant',
      error: 'rate_limit',
      parent_tool_use_id: 'nested-tool',
      message: { content: [{ type: 'text', text: weeklyLimit }] },
      session_id: 'cc-1',
    },
    ...textResponse('quoted-response', weeklyLimit)
  )
  const message = await out.result()
  expect(message.stopReason).toBe('stop')
  expect(message.errorMessage).toBeUndefined()
  expect(isRetryableAssistantError(message)).toBe(false)
})

test('cancellation wins over a late weekly quota error', async () => {
  const { stream, processes } = harness()
  const controller = new AbortController()
  const out = stream(model, context([user('hi')]), { sessionId: 'abort-limit', signal: controller.signal })
  await processes[0]!.nextPrompt(1)
  controller.abort()
  processes[0]!.emit({ type: 'result', subtype: 'error_during_execution', errors: [weeklyLimit] })
  const message = await out.result()
  expect(message.stopReason).toBe('aborted')
  expect(isRetryableAssistantError(message)).toBe(false)
})

test('a late result from the previous turn never closes the session under the next one', async () => {
  const { stream, processes, fireIdleTimers } = harness()
  const first = stream(model, context([user('hi')]), { sessionId: 's8' })
  const claude = processes[0]!
  await claude.nextPrompt(1)
  const [result, ...events] = textResponse('msg_1', 'hello').reverse()
  claude.emit(...events.reverse())
  const reply = (await first.result()) as AssistantMessage

  // pi starts the next turn before Claude Code's `result` for the first one arrives.
  const second = stream(model, context([user('hi'), reply, user('long task')]), { sessionId: 's8' })
  await claude.nextPrompt(2)
  claude.emit(result)
  await Bun.sleep(0)
  // Whatever idle close that late result armed must not end the turn in flight.
  fireIdleTimers()
  claude.emit(...textResponse('msg_2', 'done'))
  const message = await second.result()
  expect(message.stopReason).toBe('stop')
  expect(claude.closed).toBe(false)

  // Once the session is idle, it still closes.
  await Bun.sleep(0)
  fireIdleTimers()
  expect(claude.closed).toBe(true)
})

test('a session that ends under a live turn fails it retryably, and the retry gets a new session', async () => {
  for (const text of [CLAUDE_CODE_SESSION_CLOSED, CLAUDE_CODE_EXITED]) {
    expect(isRetryableAssistantError({ stopReason: 'error', errorMessage: text } as AssistantMessage)).toBe(true)
  }

  const { stream, processes } = harness()
  const request = context([user('long task')])
  const live = stream(model, request, { sessionId: 's9' })
  await processes[0]!.nextPrompt(1)
  // The Claude Code process dies mid-response.
  processes[0]!.end()
  const failed = await live.result()
  expect(failed.stopReason).toBe('error')
  expect(isRetryableAssistantError(failed)).toBe(true)

  // pi's retry of the failed turn starts over in a fresh Claude Code process.
  const retry = stream(model, request, { sessionId: 's9' })
  expect(processes).toHaveLength(2)
  const claude = processes[1]!
  await claude.nextPrompt(1)
  claude.emit(...textResponse('msg_2', 'finished'))
  expect((await retry.result()).stopReason).toBe('stop')
})

test('a Claude Code process that exits mid-turn fails it retryably', async () => {
  const { stream, processes } = harness()
  const out = stream(model, context([user('hi')]), { sessionId: 's10' })
  await processes[0]!.nextPrompt(1)
  processes[0]!.end()
  const message = await out.result()
  expect(message.errorMessage).toBe(CLAUDE_CODE_EXITED)
  expect(isRetryableAssistantError(message)).toBe(true)
})

test('pi’s cache warm during a long turn never touches the live session', async () => {
  const { stream, processes } = harness()
  const request = context([user('think hard')])
  const live = stream(model, request, { sessionId: 's11', reasoning: 'xhigh' })
  const claude = processes[0]!
  await claude.nextPrompt(1)

  // ~270s in, pi's cache warmer replays the same request with a one-token cap.
  const warm = await stream(model, request, {
    sessionId: 's11',
    reasoning: 'xhigh',
    maxTokens: 1,
    maxRetries: 0,
  }).result()
  expect(warm.stopReason).toBe('error')
  expect(warm.errorMessage).toBe(CLAUDE_CODE_SIDE_REQUEST)
  // Any other call while the turn is in flight is a side request too.
  const other = await stream(model, request, { sessionId: 's11' }).result()
  expect(other.errorMessage).toBe(CLAUDE_CODE_SIDE_REQUEST)

  expect(claude.closed).toBe(false)
  expect(processes).toHaveLength(1)
  expect(claude.prompts).toHaveLength(1)
  claude.emit(...textResponse('msg_1', 'thought it through'))
  const message = await live.result()
  expect(message.stopReason).toBe('stop')
  expect(message.content).toEqual([{ type: 'text', text: 'thought it through' }])
})

test('a cache warm between turns starts no Claude Code turn and keeps the session', async () => {
  const { stream, processes } = harness()
  const first = stream(model, context([user('hi')]), { sessionId: 's12' })
  const claude = processes[0]!
  await claude.nextPrompt(1)
  claude.emit(...textResponse('msg_1', 'hello'))
  const reply = (await first.result()) as AssistantMessage

  const warm = await stream(model, context([user('hi')]), { sessionId: 's12', maxTokens: 1 }).result()
  expect(warm.errorMessage).toBe(CLAUDE_CODE_SIDE_REQUEST)
  expect(processes).toHaveLength(1)
  expect(claude.prompts).toHaveLength(1)

  // The next real turn continues the same Claude Code process.
  const next = stream(model, context([user('hi'), reply, user('again')]), { sessionId: 's12' })
  expect((await claude.nextPrompt(2)).message.content).toEqual([{ type: 'text', text: 'again' }])
  claude.emit(...textResponse('msg_2', 'hello again'))
  expect((await next.result()).stopReason).toBe('stop')
  expect(processes).toHaveLength(1)
})

describe('Ficus tool labels in Claude Code', () => {
  const browserOpen = {
    name: 'browser_open',
    description: 'Open a URL in the browser',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  } as any
  const labelled = (messages: Message[]) =>
    normalizeContext({ systemPrompt: 'You are a Ficus worker.', tools: [bash, browserOpen], messages })
  afterEach(() => clearClaudeCodeToolLabelsForTest())

  test('direct tools are always-load, deferrable ones are left to Claude Code tool search', async () => {
    registerClaudeCodeToolLabels('s-labels', { mode: 'claude-code', hidden: ['browser_open'], reason: 'test' })
    const { stream, processes } = harness()
    stream(model, labelled([user('hi')]), { sessionId: 's-labels' })
    const claude = processes[0]!
    expect(claude.options.env!.ENABLE_TOOL_SEARCH).toBe('true')
    const { tools } = await (await claude.tools()).listTools()
    expect(tools.find((tool) => tool.name === 'bash')!._meta).toEqual({ 'anthropic/alwaysLoad': true })
    expect(tools.find((tool) => tool.name === 'browser_open')!._meta).toEqual({
      'anthropic/searchHint': expect.stringContaining('Browser automation'),
    })
  })

  test('a session that holds nothing back loads every tool up front with Claude Code tool search off', async () => {
    registerClaudeCodeToolLabels('s-off', { mode: 'direct', hidden: [], reason: 'search is off' })
    const { stream, processes } = harness()
    stream(model, labelled([user('hi')]), { sessionId: 's-off' })
    const claude = processes[0]!
    expect(claude.options.env!.ENABLE_TOOL_SEARCH).toBe('false')
    const { tools } = await (await claude.tools()).listTools()
    expect(tools.map((tool) => tool._meta)).toEqual([
      { 'anthropic/alwaysLoad': true },
      { 'anthropic/alwaysLoad': true },
    ])
  })

  test('a session that holds tools back offers Claude Code’s tool search, pre-approved; one that does not stays without', async () => {
    registerClaudeCodeToolLabels('s-offer', { mode: 'claude-code', hidden: ['browser_open'], reason: 'test' })
    registerClaudeCodeToolLabels('s-plain', { mode: 'direct', hidden: [], reason: 'search is off' })
    const { stream, processes } = harness()
    stream(model, labelled([user('hi')]), { sessionId: 's-offer' })
    stream(model, labelled([user('hi')]), { sessionId: 's-plain' })
    expect(processes[0]!.options).toMatchObject({
      tools: ['ToolSearch'],
      allowedTools: ['ToolSearch', 'mcp__ficus__bash', 'mcp__ficus__browser_open'],
    })
    expect(processes[1]!.options).toMatchObject({
      tools: [],
      allowedTools: ['mcp__ficus__bash', 'mcp__ficus__browser_open'],
    })
  })

  /** The model calls Claude Code's tool search; Claude Code runs it and sends its result back. */
  function toolSearchResponse(id: string, toolUseId: string, extra: any[] = []) {
    const query = { query: 'select:mcp__ficus__browser_open' }
    return [
      event({
        type: 'message_start',
        message: {
          id,
          model: 'claude-opus-5-5',
          usage: { input_tokens: 30, output_tokens: 1, cache_read_input_tokens: 100 },
        },
      }),
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Loading the browser.' } }),
      event({ type: 'content_block_stop', index: 0 }),
      event({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: toolUseId, name: 'ToolSearch', input: {} },
      }),
      event({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(query) },
      }),
      event({ type: 'content_block_stop', index: 1 }),
      ...extra,
      event({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }),
      event({ type: 'message_stop' }),
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: toolUseId, name: 'ToolSearch', input: query }] },
        parent_tool_use_id: null,
        session_id: 'cc-1',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: [{ type: 'tool_reference', tool_name: 'mcp__ficus__browser_open' }],
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: 'cc-1',
      },
    ]
  }

  test('Claude Code’s tool search stays inside Claude Code: pi sees only the loaded tool’s call, and the process carries on', async () => {
    registerClaudeCodeToolLabels('s-search', { mode: 'claude-code', hidden: ['browser_open'], reason: 'test' })
    const { stream, processes } = harness()
    const first = stream(model, labelled([user('open the page')]), { sessionId: 's-search' })
    const events: string[] = []
    void (async () => {
      for await (const part of first) events.push(part.type)
    })()
    const claude = processes[0]!
    await claude.nextPrompt(1)
    claude.emit(
      ...toolSearchResponse('msg_1', 'toolu_search'),
      ...toolResponse('msg_2', 'toolu_1', { url: 'https://example.com' }, 'mcp__ficus__browser_open')
    )
    const call = (await first.result()) as AssistantMessage
    // One pi turn holds both model responses; the search call and its result are not in it.
    expect(call.stopReason).toBe('toolUse')
    expect(call.content).toEqual([
      { type: 'text', text: 'Loading the browser.' },
      { type: 'toolCall', id: 'toolu_1', name: 'browser_open', arguments: { url: 'https://example.com' } },
    ])
    expect(call.responseId).toBe('msg_2')
    expect(call.usage).toMatchObject({ input: 50, output: 13, cacheRead: 100 })
    await Bun.sleep(0)
    expect(events).not.toContain('error')
    expect(events.filter((type) => type === 'toolcall_start')).toHaveLength(1)

    // The loaded tool runs through pi as usual and its result reaches the waiting MCP call.
    const pending = claude.callTool('browser_open', { url: 'https://example.com' }, 'toolu_1')
    const history = [user('open the page'), call, { ...toolResult('toolu_1', 'opened'), toolName: 'browser_open' }]
    const second = stream(model, labelled(history), { sessionId: 's-search' })
    expect(await pending).toEqual({ content: [{ type: 'text', text: 'opened' }], isError: false })
    claude.emit(...textResponse('msg_3', 'Opened it'))
    const reply = (await second.result()) as AssistantMessage
    expect(reply.stopReason).toBe('stop')

    // The following user turn continues the same process: nothing restarted or re-seeded it.
    const third = stream(model, labelled([...history, reply, user('thanks')]), { sessionId: 's-search' })
    expect((await claude.nextPrompt(2)).message.content).toEqual([{ type: 'text', text: 'thanks' }])
    claude.emit(...textResponse('msg_4', 'Any time'))
    expect((await third.result()).stopReason).toBe('stop')
    expect(processes).toHaveLength(1)
    expect(claude.closed).toBe(false)
  })

  test('a tool search next to an agent tool call hides only the search', async () => {
    registerClaudeCodeToolLabels('s-both', { mode: 'claude-code', hidden: ['browser_open'], reason: 'test' })
    const { stream, processes } = harness()
    const first = stream(model, labelled([user('check and open')]), { sessionId: 's-both' })
    const claude = processes[0]!
    await claude.nextPrompt(1)
    claude.emit(
      ...toolSearchResponse('msg_1', 'toolu_search', [
        event({
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'toolu_2', name: 'mcp__ficus__bash', input: {} },
        }),
        event({
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
        }),
        event({ type: 'content_block_stop', index: 2 }),
      ])
    )
    const call = (await first.result()) as AssistantMessage
    expect(call.stopReason).toBe('toolUse')
    expect(call.content).toEqual([
      { type: 'text', text: 'Loading the browser.' },
      { type: 'toolCall', id: 'toolu_2', name: 'bash', arguments: { command: 'ls' } },
    ])
  })

  test('any other Claude Code tool, and tool search where it is not offered, is still reported as unknown', async () => {
    registerClaudeCodeToolLabels('s-other', { mode: 'claude-code', hidden: ['browser_open'], reason: 'test' })
    const { stream, processes } = harness()
    const other = stream(model, labelled([user('run it')]), { sessionId: 's-other' })
    await processes[0]!.nextPrompt(1)
    processes[0]!.emit(...toolResponse('msg_1', 'toolu_1', { command: 'ls' }, 'Bash'))
    expect((await other.result()).content).toEqual([
      { type: 'toolCall', id: 'toolu_1', name: 'claude-code-unknown:Bash', arguments: { command: 'ls' } },
    ])

    const plain = stream(model, labelled([user('search')]), { sessionId: 's-not-offered' })
    await processes[1]!.nextPrompt(1)
    processes[1]!.emit(...toolResponse('msg_2', 'toolu_2', { query: 'browser' }, 'ToolSearch'))
    expect((await plain.result()).content).toEqual([
      { type: 'toolCall', id: 'toolu_2', name: 'claude-code-unknown:ToolSearch', arguments: { query: 'browser' } },
    ])
  })

  test('calling a deferred tool keeps the signature, so the same Claude Code process carries on', async () => {
    registerClaudeCodeToolLabels('s-stable', { mode: 'claude-code', hidden: ['browser_open'], reason: 'test' })
    const { stream, processes } = harness()
    const first = stream(model, labelled([user('open the page')]), { sessionId: 's-stable' })
    const claude = processes[0]!
    await claude.nextPrompt(1)
    // Claude Code found browser_open with its own tool search and calls it.
    claude.emit(...toolResponse('msg_1', 'toolu_1', { url: 'https://example.com' }, 'mcp__ficus__browser_open'))
    const call = (await first.result()) as AssistantMessage
    expect(call.content).toEqual([
      { type: 'toolCall', id: 'toolu_1', name: 'browser_open', arguments: { url: 'https://example.com' } },
    ])
    const pending = claude.callTool('browser_open', { url: 'https://example.com' }, 'toolu_1')
    const history = [user('open the page'), call, { ...toolResult('toolu_1', 'opened'), toolName: 'browser_open' }]
    const second = stream(model, labelled(history), { sessionId: 's-stable' })
    expect(await pending).toEqual({ content: [{ type: 'text', text: 'opened' }], isError: false })
    claude.emit(...textResponse('msg_2', 'Opened it'))
    const reply = (await second.result()) as AssistantMessage
    const third = stream(model, labelled([...history, reply, user('thanks')]), { sessionId: 's-stable' })
    expect((await claude.nextPrompt(2)).message.content).toEqual([{ type: 'text', text: 'thanks' }])
    claude.emit(...textResponse('msg_3', 'Any time'))
    expect((await third.result()).stopReason).toBe('stop')
    expect(processes).toHaveLength(1)
    expect(claude.closed).toBe(false)
  })
})
