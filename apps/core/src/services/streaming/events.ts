import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { MessageToolCall, MessageMetadata, ContentBlock } from '@ficus/shared'
import type { StreamBuffer } from './buffer'

const AUTO_RETRY_TRANSIENT_ID = 'auto-retry'

let blockIdCounter = 0
function generateBlockId(): string {
  return `block-${Date.now()}-${++blockIdCounter}`
}

/**
 * Collects and transforms Pi SDK events into StreamEvents for clients.
 *
 * Owns a buffer reference and accumulates structured content blocks
 * (thinking, text, tool_use) for message persistence.
 */
export class StreamEventCollector {
  private blocks: ContentBlock[] = []
  private currentBlock: ContentBlock | null = null
  private thinkingStartedAt: number | null = null
  /** Maps Pi SDK contentIndex → toolCallId for streamed tool call dedup */
  private toolCallIndex = new Map<number, string>()
  /** Tool calls announced via streaming (avoid duplicate tool_start on execution) */
  private announcedToolCalls = new Set<string>()

  private sanitizeEvent?: (event: AgentSessionEvent) => AgentSessionEvent

  /** Last error captured from agent_end or auto_retry_end */
  lastError: string | null = null
  /** Direct settled signal; remains true even if defensive error-text derivation is empty. */
  settledWithAssistantError = false

  constructor(
    private readonly buffer: StreamBuffer,
    private readonly getStreamGroupId: () => string | undefined = () => undefined
  ) {}

  setEventSanitizer(sanitize: (event: AgentSessionEvent) => AgentSessionEvent): void {
    this.sanitizeEvent = sanitize
  }

  /**
   * Handle a Pi SDK event: push the corresponding StreamEvent to the buffer
   * and collect structured content blocks.
   *
   * @returns true if the event was an agent_end (caller should handle completion)
   */
  handleEvent(unsafeEvent: AgentSessionEvent): boolean {
    const event = this.sanitizeEvent ? this.sanitizeEvent(unsafeEvent) : unsafeEvent
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'thinking_delta') {
      const delta = event.assistantMessageEvent.delta
      if (this.currentBlock?.type !== 'thinking') {
        const block: ContentBlock = { type: 'thinking', id: generateBlockId(), content: '' }
        this.blocks.push(block)
        this.currentBlock = block
        this.thinkingStartedAt = Date.now()
      }
      if (this.currentBlock?.type === 'thinking') {
        this.currentBlock.content += delta
        if (delta) {
          this.buffer.push({ type: 'thinking', text: delta, streamGroupId: this.getStreamGroupId() })
        }
      }
      return false
    }

    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      const delta = event.assistantMessageEvent.delta
      this.maybeFinalizeCurrentBlock('text')
      if (this.currentBlock?.type !== 'text') {
        const block: ContentBlock = { type: 'text', id: generateBlockId(), content: '' }
        this.blocks.push(block)
        this.currentBlock = block
      }
      if (this.currentBlock?.type === 'text') {
        this.currentBlock.content += delta
        if (delta) {
          this.buffer.push({ type: 'text', text: delta, streamGroupId: this.getStreamGroupId() })
        }
      }
      return false
    }

    // --- Streaming tool argument events ---

    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'toolcall_start') {
      const { contentIndex, partial } = event.assistantMessageEvent
      const toolCallContent = partial.content[contentIndex]

      if (toolCallContent && toolCallContent.type === 'toolCall') {
        const { id: toolCallId, name: toolName } = toolCallContent
        this.toolCallIndex.set(contentIndex, toolCallId)
        this.announcedToolCalls.add(toolCallId)
        this.maybeFinalizeCurrentBlock()

        const tc: MessageToolCall = { toolCallId, toolName, args: '', result: '', isError: false }
        this.blocks.push({ type: 'tool_use', id: toolCallId, toolCall: tc })
        this.buffer.push({ type: 'tool_start', toolCallId, toolName, args: '', streamGroupId: this.getStreamGroupId() })
      }
      return false
    }

    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'toolcall_delta') {
      const { contentIndex, delta } = event.assistantMessageEvent
      const toolCallId = this.toolCallIndex.get(contentIndex)
      if (toolCallId) {
        const block = this.findToolBlock(toolCallId)
        if (block?.type === 'tool_use') block.toolCall.args += delta
        this.buffer.push({ type: 'tool_args_delta', toolCallId, delta, streamGroupId: this.getStreamGroupId() })
      }
      return false
    }

    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'toolcall_end') {
      const { contentIndex, toolCall } = event.assistantMessageEvent
      const toolCallId = this.toolCallIndex.get(contentIndex)
      if (toolCallId) {
        const block = this.findToolBlock(toolCallId)
        if (block?.type === 'tool_use') block.toolCall.args = JSON.stringify(toolCall.arguments)
      }
      return false
    }

    // --- Tool execution events ---

    if (event.type === 'tool_execution_start') {
      this.maybeFinalizeCurrentBlock()

      if (this.announcedToolCalls.has(event.toolCallId)) {
        // Already announced via streaming — just update args to final form
        const block = this.findToolBlock(event.toolCallId)
        if (block?.type === 'tool_use') block.toolCall.args = JSON.stringify(event.args)
        return false
      }

      // Tool not announced via streaming — create block now
      const tc: MessageToolCall = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: JSON.stringify(event.args),
        result: '',
        isError: false,
      }
      this.blocks.push({ type: 'tool_use', id: event.toolCallId, toolCall: tc })
      this.buffer.push({
        type: 'tool_start',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: tc.args,
        streamGroupId: this.getStreamGroupId(),
      })
      return false
    }

    if (event.type === 'tool_execution_update') {
      const result = typeof event.partialResult === 'string' ? event.partialResult : JSON.stringify(event.partialResult)
      const block = this.findToolBlock(event.toolCallId)
      if (block?.type === 'tool_use') block.toolCall.result = result
      this.buffer.push({
        type: 'tool_update',
        toolCallId: event.toolCallId,
        result,
        streamGroupId: this.getStreamGroupId(),
      })
      return false
    }

    if (event.type === 'tool_execution_end') {
      const block = this.findToolBlock(event.toolCallId)
      if (block?.type === 'tool_use') {
        block.toolCall.result = typeof event.result === 'string' ? event.result : JSON.stringify(event.result)
        block.toolCall.isError = event.isError
      }
      this.buffer.push({
        type: 'tool_end',
        toolCallId: event.toolCallId,
        result: block?.type === 'tool_use' ? block.toolCall.result : '',
        isError: event.isError,
        streamGroupId: this.getStreamGroupId(),
      })
      return false
    }

    if (event.type === 'auto_retry_start') {
      this.buffer.push({
        type: 'system_message',
        text: `Retrying (attempt ${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`,
        transientId: AUTO_RETRY_TRANSIENT_ID,
      })
      return false
    }

    if (event.type === 'auto_retry_end') {
      if (event.success) {
        this.buffer.removeEvents(
          (bufferedEvent) =>
            bufferedEvent.type === 'system_message' && bufferedEvent.transientId === AUTO_RETRY_TRANSIENT_ID
        )
        this.buffer.push({ type: 'system_message_clear', transientId: AUTO_RETRY_TRANSIENT_ID })
      } else if (event.finalError) {
        this.lastError = event.finalError
      }
      return false
    }

    if (event.type === 'compaction_start') {
      // Flush current assistant message before showing compaction system message
      this.buffer.push({ type: 'flush_agent' })
      const reason = event.reason === 'manual' ? 'manual' : 'auto'
      this.buffer.push({ type: 'compaction_start', reason })
      this.buffer.push({ type: 'system_message', text: `Compacting context (${event.reason})...` })
      return false
    }

    if (event.type === 'compaction_end') {
      if (event.errorMessage) {
        this.buffer.push({ type: 'compaction_end', success: false, aborted: false, error: event.errorMessage })
        this.buffer.push({ type: 'system_message', text: `Compaction failed: ${event.errorMessage}` })
      } else if (event.aborted) {
        this.buffer.push({ type: 'compaction_end', success: false, aborted: true })
        this.buffer.push({ type: 'system_message', text: 'Compaction aborted' })
      } else if (event.result) {
        this.buffer.push({ type: 'compaction_end', success: true, aborted: false })
        const streamGroupId = this.getStreamGroupId()
        this.buffer.push({
          type: 'system_message',
          text: 'Context compacted — continuing...',
          transientId: streamGroupId ? `compaction:${streamGroupId}` : undefined,
        })
      }
      return false
    }

    if (event.type === 'agent_end') {
      this.maybeFinalizeCurrentBlock()
      this.settledWithAssistantError = event.messages.some(
        (message) => message.role === 'assistant' && message.stopReason === 'error'
      )

      // Save error messages if any (likely 429 rate limit errors) so they are
      // processed after the stream ends.
      const errorMessage = event.messages
        .flatMap((m) =>
          m.role === 'assistant' && m.stopReason === 'error' ? m.errorMessage || 'Unknown assistant error' : []
        )
        .join('\n')
      if (errorMessage) {
        this.lastError = errorMessage
      }

      return true
    }

    return false
  }

  /**
   * Return the collected response and metadata without resetting state.
   *
   * @returns null if there's nothing to save
   */
  snapshot(): { response: string; metadata: MessageMetadata | undefined } | null {
    const response = this.getResponseText()
    const metadata: MessageMetadata | undefined = this.blocks.length > 0 ? { content: [...this.blocks] } : undefined

    if (!response && !metadata) {
      return null
    }

    return { response, metadata }
  }

  /**
   * Flush the collected response and metadata, then reset state.
   * Called when a user message_end arrives (steer/follow-up boundary)
   * and at agent_end (final response).
   *
   * @returns null if there's nothing to save
   */
  flush(): { response: string; metadata: MessageMetadata | undefined } | null {
    this.maybeFinalizeCurrentBlock()
    const snapshot = this.snapshot()
    this.reset()
    return snapshot
  }

  /**
   * Reset collector state for the next turn/response.
   * Called after flush() or when compaction retries.
   */
  reset(): void {
    this.blocks = []
    this.currentBlock = null
    this.thinkingStartedAt = null
    this.lastError = null
    this.settledWithAssistantError = false
    this.toolCallIndex = new Map()
    this.announcedToolCalls = new Set()
  }

  // --- Private helpers ---

  private findToolBlock(toolCallId: string): ContentBlock | undefined {
    return this.blocks.find((b) => b.type === 'tool_use' && b.id === toolCallId)
  }

  /**
   * Finalize the current thinking block by calculating duration.
   * Emits a thinking_end event so clients catching up get accurate timing.
   */
  private finalizeThinkingBlock(): void {
    if (this.currentBlock?.type === 'thinking' && this.thinkingStartedAt) {
      const durationMs = Date.now() - this.thinkingStartedAt
      this.currentBlock.durationMs = durationMs
      this.thinkingStartedAt = null
      this.buffer.push({ type: 'thinking_end', durationMs, streamGroupId: this.getStreamGroupId() })
    }
    this.currentBlock = null
  }

  /**
   * Finalize the current block.
   * Pass `except` to skip finalization when the block matches (e.g. text continuing).
   */
  private maybeFinalizeCurrentBlock(except?: string): void {
    if (this.currentBlock?.type === except) return
    if (this.currentBlock?.type === 'thinking') {
      this.finalizeThinkingBlock()
    } else {
      this.currentBlock = null
    }
  }

  /**
   * Extract plain text from collected blocks.
   */
  private getResponseText(): string {
    return this.blocks
      .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
      .map((b) => b.content)
      .join('')
  }
}
