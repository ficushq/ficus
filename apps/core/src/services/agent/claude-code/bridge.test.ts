import { afterEach, expect, test } from 'bun:test'
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
import { isRetryableAssistantError } from '@earendil-works/pi-ai'
import { classifyCaughtProviderError } from '../../../lib/error'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'

const model = anthropicProvider()
  .getModels()
  .find((candidate) => candidate.id === 'claude-opus-5-5') as Model<Api>
const bash = {
  name: 'bash',
  description: 'Run a command',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
} as any

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
function toolResponse(id: string, toolUseId: string, input: Record<string, unknown>) {
  return [
    event({
      type: 'message_start',
      message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 20, output_tokens: 1 } },
    }),
    event({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolUseId, name: 'mcp__ficus__bash', input: {} },
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
      systemPrompt: 'You are a Ficus worker.',
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
    expect(classifyCaughtProviderError(message.errorMessage, { now: Date.parse('2026-09-29T01:00:00Z') })).toEqual({
      kind: 'plan-credit',
      retryAt: Date.parse('2026-09-29T02:20:00Z'),
    })
  })
}

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
