/**
 * Drives the user's own signed-in Claude Code as a pi model backend.
 *
 * Claude Code runs with none of its built-in tools. The agent's tools are offered to it through an
 * in-process MCP server; when Claude calls one, the pi turn ends with that tool call, Core runs it
 * exactly as it runs any provider's tool calls (sandbox routing, secret redaction, Ficus tools), and
 * the next pi turn hands the result back to the MCP call Claude Code is waiting on. One long-lived
 * Claude Code query per pi session carries the conversation, so Claude Code's own prompt caching
 * applies. A worker restart resumes it by Claude Code session id; a history Claude Code never saw
 * (compaction, an edit, a restart mid-tool) starts a fresh session seeded with the transcript.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Api,
  type AssistantMessageEventStream,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type Tool,
  type ToolResultMessage,
  type TranscriptContext,
} from '@earendil-works/pi-ai'
import { query as sdkQuery, type Options, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createLogger } from '../../../lib/infra/logger'
import { getHomeDir } from '../../../lib/utils/home'
import { claudeChildEnv, claudeCodeExecutable } from './availability'
import { describeClaudeCodeFailure } from './failures'
import {
  CLAUDE_TOOL_PREFIX,
  TOOL_SERVER,
  TurnTranslator,
  claudeUserMessage,
  mcpToolResult,
  renderHistoryPrompt,
  type StreamEvent,
} from './convert'

const log = createLogger('claude-code')

/** Claude Code stamps each MCP tools/call with the tool_use id it answers. */
const TOOL_USE_ID_META = 'claudecode/toolUseId'
/** Close an idle Claude Code process; the session resumes on the next turn. */
const IDLE_CLOSE_MS = 10 * 60_000
/** Agent tools (a long build, a human answer) can run far past Claude Code's MCP default. */
const MCP_TOOL_TIMEOUT_MS = String(24 * 60 * 60_000)

type QueryFn = (params: { prompt: AsyncIterable<any>; options: Options }) => Query

type CallToolResult = ReturnType<typeof mcpToolResult>

/** A pushable async iterable of Claude Code user messages (its streaming input). */
class InputQueue implements AsyncIterable<any> {
  private items: any[] = []
  private waiting: ((result: IteratorResult<any>) => void) | undefined
  private closed = false

  push(item: any) {
    if (this.closed) return
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = undefined
      resolve({ value: item, done: false })
    } else this.items.push(item)
  }

  close() {
    this.closed = true
    this.waiting?.({ value: undefined, done: true })
    this.waiting = undefined
  }

  [Symbol.asyncIterator](): AsyncIterator<any> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => (this.waiting = resolve))
      },
    }
  }
}

/** The last assistant message this bridge produced, and how many later pi messages Claude Code has. */
type Anchor = { responseId: string; consumedAfter: number }

type Resumable = { claudeSessionId: string; anchor: Anchor }

class Bridge {
  readonly input = new InputQueue()
  readonly query: Query
  claudeSessionId: string | undefined
  anchor: Anchor | undefined
  turn: TurnTranslator | undefined
  /** Set when Claude Code and pi disagree about the conversation; the next turn starts over. */
  desynced = false
  /**
   * Claude Code turns that ended for pi but whose `result` has not arrived yet. pi can start the
   * next turn before it does, and that late `result` must not end the new turn.
   */
  private pendingResults = 0
  closed = false
  /** The `claude` this session runs, named in failures the user must fix. */
  readonly executable: string | undefined
  private readonly waiting = new Map<string, (result: CallToolResult) => void>()
  private readonly ready = new Map<string, CallToolResult>()
  private idleTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    readonly key: string,
    readonly signature: string,
    tools: Tool[],
    options: Options,
    runQuery: QueryFn,
    private readonly onSession: (bridge: Bridge) => void
  ) {
    this.executable = options.pathToClaudeCodeExecutable
    this.query = runQuery({
      prompt: this.input,
      options: { ...options, mcpServers: { [TOOL_SERVER]: this.toolServer(tools) } },
    })
    void this.pump()
  }

  private toolServer(tools: Tool[]) {
    const server = new McpServer({ name: TOOL_SERVER, version: '1.0.0' }, { capabilities: { tools: {} } })
    // Registered as raw protocol handlers: the tools' parameters are already JSON Schema, which the
    // Zod-only registerTool path would degrade. pi validates and runs the calls itself.
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: objectSchema(tool.parameters),
      })),
    }))
    server.server.setRequestHandler(CallToolRequestSchema, (request) => {
      const toolUseId = request.params._meta?.[TOOL_USE_ID_META]
      if (typeof toolUseId !== 'string') throw new Error(`${request.params.name}: missing tool_use id`)
      const ready = this.ready.get(toolUseId)
      if (ready) {
        this.ready.delete(toolUseId)
        return ready
      }
      return new Promise<CallToolResult>((resolve) => this.waiting.set(toolUseId, resolve))
    })
    return { type: 'sdk' as const, name: TOOL_SERVER, instance: server }
  }

  /** Hand pi's tool results to the MCP calls Claude Code is waiting on (or will make). */
  deliver(result: ToolResultMessage) {
    const payload = mcpToolResult(result)
    const waiting = this.waiting.get(result.toolCallId)
    if (waiting) {
      this.waiting.delete(result.toolCallId)
      waiting(payload)
    } else this.ready.set(result.toolCallId, payload)
  }

  send(content: Parameters<typeof claudeUserMessage>[0]) {
    this.clearIdle()
    this.input.push(claudeUserMessage(content))
  }

  begin(turn: TurnTranslator) {
    this.clearIdle()
    this.turn = turn
  }

  /** Stop the current Claude Code turn; its `result` still follows and belongs to that turn. */
  abortTurn(turn: TurnTranslator) {
    if (turn.done) return
    turn.fail('aborted', 'Aborted')
    if (this.turn === turn) this.turn = undefined
    this.pendingResults++
    this.interrupt()
    // pi keeps the aborted message in its history, and Claude Code keeps the interrupted turn.
    this.anchor = { responseId: (turn.message.responseId ??= `cc-${randomUUID()}`), consumedAfter: 0 }
    this.onSession(this)
  }

  interrupt() {
    void this.query.interrupt().catch(() => {})
    for (const resolve of this.waiting.values())
      resolve({ content: [{ type: 'text', text: 'Interrupted' }], isError: true })
    this.waiting.clear()
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.clearIdle()
    this.turn?.fail('error', 'Claude Code session closed')
    this.interrupt()
    this.input.close()
    try {
      this.query.close()
    } catch {
      // Already exited.
    }
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private scheduleIdleClose() {
    this.clearIdle()
    this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS)
    this.idleTimer.unref?.()
  }

  private async pump() {
    try {
      for await (const message of this.query) this.handle(message)
      this.turn?.fail('error', 'Claude Code exited')
    } catch (error) {
      log.warn(`Claude Code session ${this.key} failed`, error)
      this.turn?.fail('error', `Claude Code failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.closed = true
      this.clearIdle()
      this.input.close()
    }
  }

  private handle(message: SDKMessage) {
    if ('session_id' in message && typeof message.session_id === 'string' && message.session_id) {
      if (this.claudeSessionId !== message.session_id) {
        this.claudeSessionId = message.session_id
        this.onSession(this)
      }
    }
    if (message.type === 'stream_event') {
      if (message.parent_tool_use_id) return
      const turn = this.turn
      if (!turn || turn.done) {
        // Claude Code moved on without pi (for example it answered a tool call itself): the two
        // histories no longer match.
        this.desynced = true
        return
      }
      const stop = turn.handle(message.event as StreamEvent)
      if (stop) this.completed(turn)
      return
    }
    if (message.type === 'assistant' && message.error && this.turn && !this.turn.done) {
      // An API error (rate limit, billing, auth) arrives as a synthetic assistant message.
      const text = message.message.content
        .map((part: any) => (part.type === 'text' ? part.text : ''))
        .join('')
        .trim()
      const turn = this.turn
      turn.fail(
        'error',
        describeClaudeCodeFailure(text || `Claude Code error: ${message.error}`, message.error, this.executable)
      )
      this.completed(turn)
      return
    }
    if (message.type === 'result') {
      if (this.pendingResults > 0) {
        this.pendingResults--
        this.scheduleIdleClose()
        return
      }
      const turn = this.turn
      if (turn && !turn.done) {
        const aborted = message.subtype !== 'success' && message.terminal_reason?.startsWith('aborted')
        const detail =
          message.subtype === 'success'
            ? message.result
            : (message.errors?.join('\n') ?? `Claude Code stopped: ${message.subtype}`)
        turn.fail(
          aborted ? 'aborted' : 'error',
          describeClaudeCodeFailure(
            detail || 'Claude Code ended the turn without a response',
            undefined,
            this.executable
          )
        )
        this.completed(turn)
      }
      this.scheduleIdleClose()
    }
  }

  private completed(turn: TurnTranslator) {
    // A tool call leaves Claude Code's turn running; anything else ends it, and its result follows.
    if (turn.message.stopReason !== 'toolUse') this.pendingResults++
    this.anchor = {
      responseId: turn.message.responseId ?? (turn.message.responseId = `cc-${randomUUID()}`),
      consumedAfter: 0,
    }
    this.turn = undefined
    this.onSession(this)
  }
}

/** Claude Code's input schema must be an object schema; pi tools always declare one. */
function objectSchema(schema: unknown): Record<string, unknown> {
  const value = JSON.parse(JSON.stringify(schema ?? {})) as Record<string, unknown>
  return value.type === 'object' ? value : { type: 'object', properties: {} }
}

const EFFORT: Record<string, Options['effort']> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

export interface ClaudeCodeBridgeDeps {
  query?: QueryFn
  executable?: () => string | undefined
  stateDir?: () => string
}

/** The pi stream function for the `claude-code` provider. */
export function createClaudeCodeStream(deps: ClaudeCodeBridgeDeps = {}) {
  const runQuery = deps.query ?? (sdkQuery as unknown as QueryFn)
  const executable = deps.executable ?? (() => claudeCodeExecutable())
  const stateDir = deps.stateDir ?? (() => join(getHomeDir(), 'claude-code'))
  const bridges = new Map<string, Bridge>()
  const resumable = new ResumeStore(stateDir)

  return function streamClaudeCode(
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream()
    const turn = new TurnTranslator(stream, model)
    try {
      const claude = executable()
      if (!claude) {
        turn.fail('error', 'Claude Code is not installed')
        return stream
      }
      const key = options?.sessionId ?? `unsessioned-${randomUUID()}`
      const conversation = context.messages.filter((message) => message.role !== 'system') as Message[]
      const systemPrompt = getCurrentSystemPrompt(context.messages)
      const tools = getCurrentTools(context.messages)
      const effort = options?.reasoning ? EFFORT[options.reasoning] : undefined
      const signature = hash({ model: model.id, effort, systemPrompt, tools: tools.map(toolSignature) })

      let bridge = bridges.get(key)
      const tail = bridge && !bridge.closed && !bridge.desynced ? continuation(bridge.anchor, conversation) : undefined
      // A changed prompt, model, or tool set needs a new Claude Code process, resumed from this one.
      // Mid tool call the running process keeps going; the change applies from the next user turn.
      const changed = bridge?.signature !== signature && tail?.every((message) => message.role === 'user')
      if (bridge && (!tail || changed)) {
        // The live session cannot take this turn as is; carry its resume point over when it can.
        if (tail && bridge.claudeSessionId && bridge.anchor && !bridge.desynced)
          resumable.set(key, { claudeSessionId: bridge.claudeSessionId, anchor: bridge.anchor })
        else if (!tail) resumable.delete(key)
        bridge.close()
        bridges.delete(key)
        bridge = undefined
      }

      const baseOptions: Options = {
        model: model.id,
        ...(effort ? { effort, thinking: { type: 'adaptive', display: 'summarized' } } : {}),
        pathToClaudeCodeExecutable: claude,
        cwd: workDir(stateDir()),
        env: claudeChildEnv(process.env, {
          CLAUDE_AGENT_SDK_CLIENT_APP: 'ficus',
          // Ficus compacts the conversation itself; Claude Code compacting too would desync them.
          DISABLE_AUTO_COMPACT: '1',
          ENABLE_CLAUDEAI_MCP_SERVERS: '0',
          MCP_TOOL_TIMEOUT: MCP_TOOL_TIMEOUT_MS,
        }),
        systemPrompt,
        // No Claude Code built-in tools. The agent's own tools are pre-approved by name; anything
        // else is refused without prompting. Ficus applies its own policy when it runs each call.
        tools: [],
        allowedTools: tools.map((tool) => `${CLAUDE_TOOL_PREFIX}${tool.name}`),
        permissionMode: 'dontAsk',
        settingSources: [],
        strictMcpConfig: true,
        includePartialMessages: true,
        persistSession: true,
      }
      const onSession = (live: Bridge) => {
        if (live.claudeSessionId && live.anchor)
          resumable.set(live.key, { claudeSessionId: live.claudeSessionId, anchor: live.anchor })
      }

      if (!bridge) {
        const saved = resumable.get(key)
        const savedTail = saved ? continuation(saved.anchor, conversation) : undefined
        // Resuming is only sound when everything new is a user message: a pending tool result means
        // the old process died mid-call, and Claude Code's transcript has no answer for it.
        const canResume = saved && savedTail && savedTail.every((message) => message.role === 'user')
        bridge = new Bridge(
          key,
          signature,
          tools,
          canResume ? { ...baseOptions, resume: saved!.claudeSessionId } : baseOptions,
          runQuery,
          onSession
        )
        bridges.set(key, bridge)
        bridge.begin(turn)
        if (canResume) {
          bridge.anchor = { ...saved!.anchor, consumedAfter: saved!.anchor.consumedAfter + savedTail!.length }
          for (const message of savedTail!) bridge.send((message as Extract<Message, { role: 'user' }>).content)
        } else seed(bridge, conversation)
      } else {
        bridge.begin(turn)
        bridge.anchor!.consumedAfter += tail!.length
        for (const message of tail!) if (message.role === 'toolResult') bridge.deliver(message)
        for (const message of tail!) if (message.role === 'user') bridge.send(message.content)
      }

      const live = bridge
      options?.signal?.addEventListener('abort', () => live.abortTurn(turn), { once: true })
    } catch (error) {
      turn.fail('error', error instanceof Error ? error.message : String(error))
    }
    return stream
  }
}

/** Starts a fresh Claude Code session from pi's conversation. */
function seed(bridge: Bridge, conversation: Message[]) {
  const last = conversation.at(-1)
  if (conversation.length === 1 && last?.role === 'user') {
    bridge.send(last.content)
    return
  }
  const history = last?.role === 'user' ? conversation.slice(0, -1) : conversation
  const prompt = renderHistoryPrompt(history)
  if (last?.role === 'user') {
    const latest = typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : last.content
    bridge.send([{ type: 'text', text: prompt }, ...latest])
  } else bridge.send(prompt)
}

/**
 * The pi messages after the bridge's last response that Claude Code has not been given, or
 * undefined when pi's conversation is not a continuation of what Claude Code holds.
 */
function continuation(anchor: Anchor | undefined, conversation: Message[]): Message[] | undefined {
  if (!anchor) return undefined
  let index = -1
  for (let i = conversation.length - 1; i >= 0; i--) {
    if (conversation[i]!.role === 'assistant') {
      index = i
      break
    }
  }
  if (index < 0) return undefined
  const assistant = conversation[index] as Extract<Message, { role: 'assistant' }>
  if (assistant.responseId !== anchor.responseId) return undefined
  const tail = conversation.slice(index + 1 + anchor.consumedAfter)
  if (!tail.length || tail.some((message) => message.role !== 'user' && message.role !== 'toolResult')) return undefined
  return tail
}

function toolSignature(tool: Tool) {
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function workDir(stateDir: string) {
  // An empty working directory: Claude Code's own tools are off, and no project CLAUDE.md or
  // settings should leak into an agent's session. All Ficus sessions group under this one project.
  const dir = join(stateDir, 'workdir')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Where each pi session's Claude Code session can resume from, across worker restarts. */
class ResumeStore {
  private entries: Record<string, Resumable> | undefined
  constructor(private readonly stateDir: () => string) {}

  private file() {
    return join(this.stateDir(), 'sessions.json')
  }

  private load(): Record<string, Resumable> {
    if (this.entries) return this.entries
    try {
      this.entries = JSON.parse(readFileSync(this.file(), 'utf8')) as Record<string, Resumable>
    } catch {
      this.entries = {}
    }
    return this.entries
  }

  get(key: string) {
    return this.load()[key]
  }

  set(key: string, value: Resumable) {
    this.load()[key] = value
    this.save()
  }

  delete(key: string) {
    if (!(key in this.load())) return
    delete this.load()[key]
    this.save()
  }

  private save() {
    try {
      mkdirSync(this.stateDir(), { recursive: true })
      writeFileSync(this.file(), JSON.stringify(this.entries), { mode: 0o600 })
    } catch (error) {
      log.warn('Could not save Claude Code resume points', error)
    }
  }
}
