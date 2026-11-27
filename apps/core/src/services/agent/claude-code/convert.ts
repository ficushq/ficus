import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  ImageContent,
  Message,
  Model,
  StopReason,
  TextContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from '@earendil-works/pi-ai'
import { parseStreamingJson } from '@earendil-works/pi-ai'

/** The in-process MCP server name Claude Code sees the agent's tools under. */
export const TOOL_SERVER = 'ficus'
/** How Claude Code names the agent's tools. */
export const CLAUDE_TOOL_PREFIX = `mcp__${TOOL_SERVER}__`

/**
 * Claude Code's built-in tool search. Offered only to sessions that hold tools back; Claude Code runs
 * it itself, so its calls never reach pi (see `TurnTranslator.internalTools`).
 */
export const CLAUDE_CODE_TOOL_SEARCH = 'ToolSearch'

/** Marks a tool Claude Code called by a name it doesn't have, so pi can't match it to a real tool. */
export const UNKNOWN_CLAUDE_TOOL_PREFIX = 'claude-code-unknown:'

/**
 * The pi tool a Claude Code tool_use names. Claude Code offers the agent's tools only as
 * `mcp__ficus__<name>`, and rejects any other name itself ("No such tool available") without calling
 * the MCP server. Such a call must not run in Core either: pi answers it as an unknown tool, matching
 * what Claude told the model, instead of running a command the model was told failed.
 */
export const toolNameFromClaude = (name: string) =>
  name.startsWith(CLAUDE_TOOL_PREFIX) ? name.slice(CLAUDE_TOOL_PREFIX.length) : `${UNKNOWN_CLAUDE_TOOL_PREFIX}${name}`

/** The name Claude Code knows a pi tool by. */
export const toolNameForClaude = (name: string) =>
  name.startsWith(UNKNOWN_CLAUDE_TOOL_PREFIX)
    ? name.slice(UNKNOWN_CLAUDE_TOOL_PREFIX.length)
    : `${CLAUDE_TOOL_PREFIX}${name}`

/**
 * The system prompt Claude Code runs with. Ficus's prompt names tools by their short names
 * (`squad_bash`), which Claude Code rejects; a closing note gives the model the names it must call.
 * Deterministic for the same prompt and tools, so it never changes the session signature by itself.
 */
export function claudeSystemPrompt(systemPrompt: string | undefined, toolNames: readonly string[]) {
  const example = toolNames[0]
  if (!example) return systemPrompt
  const note =
    `Tool names: this prompt refers to your tools by short names such as ${example}. ` +
    `In this session they are named ${CLAUDE_TOOL_PREFIX}<name> (for example ${CLAUDE_TOOL_PREFIX}${example}); ` +
    'always call them by that full name.'
  return systemPrompt ? `${systemPrompt}\n\n${note}` : note
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    // The user's subscription pays; Ficus records tokens but no per-request price.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

type AnthropicUsage = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

function applyUsage(usage: Usage, raw: AnthropicUsage | undefined) {
  if (!raw) return
  if (raw.input_tokens != null) usage.input = raw.input_tokens
  if (raw.output_tokens != null) usage.output = raw.output_tokens
  if (raw.cache_read_input_tokens != null) usage.cacheRead = raw.cache_read_input_tokens
  if (raw.cache_creation_input_tokens != null) usage.cacheWrite = raw.cache_creation_input_tokens
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
}

/** `target = a + b`, token counts only (the subscription pays, so cost stays zero). */
function sumUsage(target: Usage, a: Usage, b: Usage) {
  target.input = a.input + b.input
  target.output = a.output + b.output
  target.cacheRead = a.cacheRead + b.cacheRead
  target.cacheWrite = a.cacheWrite + b.cacheWrite
  target.totalTokens = target.input + target.output + target.cacheRead + target.cacheWrite
}

function stopReasonFrom(raw: string | null | undefined): StopReason {
  if (raw === 'tool_use') return 'toolUse'
  if (raw === 'max_tokens' || raw === 'model_context_window_exceeded') return 'length'
  return 'stop'
}

/** One streamed Anthropic event, as Claude Code forwards it with `includePartialMessages`. */
export type StreamEvent = { type: string; [key: string]: any }

type OpenBlock = { contentIndex: number; kind: 'text' | 'thinking' | 'toolCall' | 'internal'; json: string }

/**
 * Feeds one model response from Claude Code into one pi assistant-message stream.
 * pi's contract: `start` first, block events in order, then exactly one `done` or `error`.
 *
 * A response whose only tool calls are Claude Code's own (`internalTools`, its tool search) does not
 * end the pi turn: Claude Code runs them itself and asks the model again, and that next response
 * continues the same pi message. pi never sees those calls or their results.
 */
export class TurnTranslator {
  readonly message: AssistantMessage
  /** Claude Code built-in tools it answers itself; their tool_use blocks are not shown to pi. */
  internalTools: ReadonlySet<string> = new Set()
  private readonly blocks = new Map<number, OpenBlock>()
  private finished = false
  private rawStop: string | null | undefined
  /** Tool calls in the current model response: Claude Code's own, and the agent's. */
  private internalCalls = 0
  private agentCalls = 0
  /** Usage of earlier model responses folded into this message, and of the current one. */
  private readonly earlierUsage = emptyUsage()
  private readonly responseUsage = emptyUsage()
  private responses = 0

  constructor(
    private readonly stream: AssistantMessageEventStream,
    model: Model<Api>
  ) {
    this.message = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: 'stop',
      timestamp: Date.now(),
    }
    stream.push({ type: 'start', partial: this.message })
  }

  get done() {
    return this.finished
  }

  get hasContent() {
    return this.message.content.length > 0
  }

  /** Returns the stop reason when this event ended the model response. */
  handle(event: StreamEvent): StopReason | undefined {
    if (this.finished) return undefined
    const partial = this.message
    switch (event.type) {
      case 'message_start':
        if (this.responses++ > 0) {
          // Claude Code answered its own tool search and asked again: count both responses.
          sumUsage(this.earlierUsage, this.earlierUsage, this.responseUsage)
          Object.assign(this.responseUsage, emptyUsage())
        }
        if (typeof event.message?.id === 'string') partial.responseId = event.message.id
        if (typeof event.message?.model === 'string') partial.responseModel = event.message.model
        this.applyResponseUsage(event.message?.usage)
        return undefined
      case 'content_block_start': {
        const block = event.content_block ?? {}
        const contentIndex = partial.content.length
        if (block.type === 'tool_use' && this.internalTools.has(block.name)) {
          this.internalCalls++
          this.blocks.set(event.index, { contentIndex: -1, kind: 'internal', json: '' })
        } else if (block.type === 'text') {
          partial.content.push({ type: 'text', text: '' })
          this.blocks.set(event.index, { contentIndex, kind: 'text', json: '' })
          this.stream.push({ type: 'text_start', contentIndex, partial })
        } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          const redacted = block.type === 'redacted_thinking'
          partial.content.push({
            type: 'thinking',
            thinking: '',
            ...(redacted ? { redacted: true, thinkingSignature: block.data } : {}),
          })
          this.blocks.set(event.index, { contentIndex, kind: 'thinking', json: '' })
          this.stream.push({ type: 'thinking_start', contentIndex, partial })
        } else if (block.type === 'tool_use') {
          this.agentCalls++
          partial.content.push({ type: 'toolCall', id: block.id, name: toolNameFromClaude(block.name), arguments: {} })
          this.blocks.set(event.index, { contentIndex, kind: 'toolCall', json: '' })
          this.stream.push({ type: 'toolcall_start', contentIndex, partial })
        }
        return undefined
      }
      case 'content_block_delta': {
        const open = this.blocks.get(event.index)
        if (!open || open.kind === 'internal') return undefined
        const delta = event.delta ?? {}
        const content = partial.content[open.contentIndex]!
        if (delta.type === 'text_delta' && content.type === 'text') {
          content.text += delta.text
          this.stream.push({ type: 'text_delta', contentIndex: open.contentIndex, delta: delta.text, partial })
        } else if (delta.type === 'thinking_delta' && content.type === 'thinking') {
          content.thinking += delta.thinking
          this.stream.push({ type: 'thinking_delta', contentIndex: open.contentIndex, delta: delta.thinking, partial })
        } else if (delta.type === 'signature_delta' && content.type === 'thinking') {
          content.thinkingSignature = (content.thinkingSignature ?? '') + delta.signature
        } else if (delta.type === 'input_json_delta' && content.type === 'toolCall') {
          open.json += delta.partial_json
          content.arguments = parseStreamingJson(open.json) as ToolCall['arguments']
          this.stream.push({
            type: 'toolcall_delta',
            contentIndex: open.contentIndex,
            delta: delta.partial_json,
            partial,
          })
        }
        return undefined
      }
      case 'content_block_stop': {
        const open = this.blocks.get(event.index)
        if (!open) return undefined
        this.blocks.delete(event.index)
        if (open.kind === 'internal') return undefined
        const content = partial.content[open.contentIndex]!
        if (content.type === 'text')
          this.stream.push({ type: 'text_end', contentIndex: open.contentIndex, content: content.text, partial })
        else if (content.type === 'thinking')
          this.stream.push({
            type: 'thinking_end',
            contentIndex: open.contentIndex,
            content: content.thinking,
            partial,
          })
        else {
          content.arguments = (open.json ? parseStreamingJson(open.json) : {}) as ToolCall['arguments']
          this.stream.push({ type: 'toolcall_end', contentIndex: open.contentIndex, toolCall: content, partial })
        }
        return undefined
      }
      case 'message_delta':
        this.rawStop = event.delta?.stop_reason ?? this.rawStop
        this.applyResponseUsage({
          ...event.usage,
          input_tokens: event.usage?.input_tokens ?? this.responseUsage.input,
        })
        return undefined
      case 'message_stop': {
        const reason = stopReasonFrom(this.rawStop)
        if (reason === 'toolUse' && this.internalCalls > 0 && this.agentCalls === 0) {
          // Only Claude Code's own tools were called: it runs them and the model's next response
          // continues this pi turn.
          this.rawStop = undefined
          this.internalCalls = 0
          this.blocks.clear()
          return undefined
        }
        this.finish(reason)
        return reason
      }
      default:
        return undefined
    }
  }

  private applyResponseUsage(raw: AnthropicUsage | undefined) {
    applyUsage(this.responseUsage, raw)
    sumUsage(this.message.usage, this.earlierUsage, this.responseUsage)
  }

  finish(reason: StopReason) {
    if (this.finished) return
    this.finished = true
    const partial = this.message
    partial.stopReason = reason
    if (this.rawStop) partial.rawStopReason = this.rawStop
    if (reason === 'error' || reason === 'aborted') this.stream.push({ type: 'error', reason, error: partial })
    else this.stream.push({ type: 'done', reason: reason as 'stop' | 'length' | 'toolUse', message: partial })
    this.stream.end(partial)
  }

  fail(reason: 'error' | 'aborted', errorMessage: string) {
    if (this.finished) return
    this.message.errorMessage = errorMessage
    this.finish(reason)
  }
}

type AnthropicContentBlock =
  { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

function anthropicContent(content: UserMessage['content'] | ToolResultMessage['content']): AnthropicContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data } }
  )
}

/** A pi user message as a Claude Code user message. */
export function claudeUserMessage(content: UserMessage['content'] | AnthropicContentBlock[]) {
  const blocks =
    Array.isArray(content) && content.some((part: any) => part.type === 'image' && 'source' in part)
      ? (content as AnthropicContentBlock[])
      : anthropicContent(content as UserMessage['content'])
  return {
    type: 'user' as const,
    message: { role: 'user' as const, content: blocks },
    parent_tool_use_id: null,
  }
}

/** A pi tool result as an MCP tool-call result. */
export function mcpToolResult(result: ToolResultMessage) {
  const content = result.content.map((part: TextContent | ImageContent) =>
    part.type === 'text'
      ? { type: 'text' as const, text: part.text }
      : { type: 'image' as const, data: part.data, mimeType: part.mimeType }
  )
  return { content: content.length ? content : [{ type: 'text' as const, text: '' }], isError: result.isError }
}

function textOf(content: UserMessage['content'] | ToolResultMessage['content']): string {
  if (typeof content === 'string') return content
  return content.map((part) => (part.type === 'text' ? part.text : `[image: ${part.mimeType}]`)).join('\n')
}

/**
 * The conversation so far as one prompt, for a fresh Claude Code session that cannot resume the
 * old one (a compacted or edited history, a worker restart mid-tool). Images are named, not resent.
 */
export function renderHistoryPrompt(messages: Message[]): string {
  const lines: string[] = []
  for (const message of messages) {
    if (message.role === 'user') lines.push(`<user>\n${textOf(message.content)}\n</user>`)
    else if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'text' && part.text) lines.push(`<assistant>\n${part.text}\n</assistant>`)
        else if (part.type === 'toolCall')
          // Claude Code's own tool names, so the seeded session calls the tools it actually has.
          lines.push(
            `<tool_call name="${toolNameForClaude(part.name)}" id="${part.id}">\n${JSON.stringify(part.arguments)}\n</tool_call>`
          )
      }
    } else if (message.role === 'toolResult')
      lines.push(
        `<tool_result id="${message.toolCallId}"${message.isError ? ' error="true"' : ''}>\n${textOf(message.content)}\n</tool_result>`
      )
  }
  return [
    'This conversation continues from an earlier session. Its transcript so far:',
    '<transcript>',
    ...lines,
    '</transcript>',
    'Continue from where the transcript ends.',
  ].join('\n')
}
