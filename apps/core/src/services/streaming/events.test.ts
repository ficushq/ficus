import { describe, it, expect, beforeEach } from 'bun:test'
import type { StreamEvent } from '@ficus/shared'
import { StreamEventCollector } from './events'

// ---------------------------------------------------------------------------
// Mock StreamBuffer
// ---------------------------------------------------------------------------

class MockStreamBuffer {
  events: StreamEvent[] = []

  push(event: StreamEvent): void {
    this.events.push(event)
  }

  clear(): void {
    this.events = []
  }

  removeEvents(predicate: (event: StreamEvent) => boolean): void {
    this.events = this.events.filter((event) => !predicate(event))
  }

  findEvents(type: string): StreamEvent[] {
    return this.events.filter((e) => e.type === type)
  }
}

// ---------------------------------------------------------------------------
// Event factories (partial mocks — only include fields the collector uses)
// ---------------------------------------------------------------------------

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'

function thinkingDelta(delta: string): AgentSessionEvent {
  return {
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta },
  } as AgentSessionEvent
}

function textDelta(delta: string): AgentSessionEvent {
  return {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta },
  } as AgentSessionEvent
}

function toolcallStart(contentIndex: number, toolCallId: string, toolName: string): AgentSessionEvent {
  return {
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_start',
      contentIndex,
      partial: {
        content: Array.from({ length: contentIndex + 1 }, (_, i) =>
          i === contentIndex ? { type: 'toolCall', id: toolCallId, name: toolName } : null
        ),
      },
    },
  } as AgentSessionEvent
}

function toolcallDelta(contentIndex: number, delta: string): AgentSessionEvent {
  return {
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_delta', contentIndex, delta },
  } as AgentSessionEvent
}

function toolcallEnd(contentIndex: number, args: Record<string, unknown>): AgentSessionEvent {
  return {
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_end',
      contentIndex,
      toolCall: { arguments: args },
    },
  } as AgentSessionEvent
}

function toolExecutionStart(toolCallId: string, toolName: string, args: Record<string, unknown>): AgentSessionEvent {
  return { type: 'tool_execution_start', toolCallId, toolName, args } as AgentSessionEvent
}

function toolExecutionUpdate(toolCallId: string, partialResult: string): AgentSessionEvent {
  return { type: 'tool_execution_update', toolCallId, partialResult } as AgentSessionEvent
}

function toolExecutionEnd(toolCallId: string, result: string, isError = false): AgentSessionEvent {
  return { type: 'tool_execution_end', toolCallId, result, isError } as AgentSessionEvent
}

function agentEnd(messages: any[] = []): AgentSessionEvent {
  return { type: 'agent_end', messages } as AgentSessionEvent
}

function autoCompactionStart(reason: 'manual' | 'threshold' | 'overflow' = 'threshold'): AgentSessionEvent {
  return { type: 'compaction_start', reason } as AgentSessionEvent
}

function autoCompactionEnd(opts: {
  willRetry?: boolean
  aborted?: boolean
  errorMessage?: string
  result?: string
  reason?: 'manual' | 'threshold' | 'overflow'
}): AgentSessionEvent {
  return {
    type: 'compaction_end',
    reason: opts.reason ?? 'threshold',
    result: opts.result ? ({ summary: opts.result } as any) : undefined,
    aborted: opts.aborted ?? false,
    willRetry: opts.willRetry ?? false,
    errorMessage: opts.errorMessage,
  } as AgentSessionEvent
}

function autoRetryStart(attempt = 1, maxAttempts = 5, errorMessage = 'WebSocket closed 1012'): AgentSessionEvent {
  return { type: 'auto_retry_start', attempt, maxAttempts, errorMessage } as AgentSessionEvent
}

function autoRetryEnd(success: boolean, finalError?: string): AgentSessionEvent {
  return { type: 'auto_retry_end', success, finalError } as AgentSessionEvent
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamEventCollector', () => {
  let buffer: MockStreamBuffer
  let collector: StreamEventCollector

  beforeEach(() => {
    buffer = new MockStreamBuffer()
    collector = new StreamEventCollector(buffer as any)
  })

  describe('thinking events', () => {
    it('accumulates thinking deltas into a single block', () => {
      collector.handleEvent(thinkingDelta('Hello '))
      collector.handleEvent(thinkingDelta('world'))

      const flushed = collector.flush()
      expect(flushed).not.toBeNull()
      expect(flushed!.metadata?.content).toHaveLength(1)
      expect(flushed!.metadata?.content![0].type).toBe('thinking')
      expect((flushed!.metadata?.content![0] as any).content).toBe('Hello world')
    })

    it('emits thinking events to buffer', () => {
      collector.handleEvent(thinkingDelta('test'))

      const thinkingEvents = buffer.findEvents('thinking')
      expect(thinkingEvents).toHaveLength(1)
      expect((thinkingEvents[0] as any).text).toBe('test')
    })

    it('calculates thinking duration on finalization', async () => {
      collector.handleEvent(thinkingDelta('thinking...'))

      // Wait a bit to get a measurable duration
      await new Promise((r) => setTimeout(r, 10))

      // Transition to text finalizes thinking
      collector.handleEvent(textDelta('done'))

      const thinkingEndEvents = buffer.findEvents('thinking_end')
      expect(thinkingEndEvents).toHaveLength(1)
      expect((thinkingEndEvents[0] as any).durationMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('text events', () => {
    it('accumulates text deltas into a single block', () => {
      collector.handleEvent(textDelta('Hello '))
      collector.handleEvent(textDelta('world'))

      const flushed = collector.flush()
      expect(flushed).not.toBeNull()
      expect(flushed!.response).toBe('Hello world')
      expect(flushed!.metadata?.content).toHaveLength(1)
      expect(flushed!.metadata?.content![0].type).toBe('text')
    })

    it('emits text events to buffer', () => {
      collector.handleEvent(textDelta('test'))

      const textEvents = buffer.findEvents('text')
      expect(textEvents).toHaveLength(1)
      expect((textEvents[0] as any).text).toBe('test')
    })

    it('finalizes thinking block when text starts', () => {
      collector.handleEvent(thinkingDelta('thinking...'))
      collector.handleEvent(textDelta('response'))

      const flushed = collector.flush()
      expect(flushed!.metadata?.content).toHaveLength(2)
      expect(flushed!.metadata?.content![0].type).toBe('thinking')
      expect(flushed!.metadata?.content![1].type).toBe('text')
    })
  })

  describe('streamed tool calls', () => {
    it('creates tool block on toolcall_start', () => {
      collector.handleEvent(toolcallStart(0, 'tc-1', 'read_file'))

      const flushed = collector.flush()
      expect(flushed!.metadata?.content).toHaveLength(1)
      expect(flushed!.metadata?.content![0].type).toBe('tool_use')
      expect((flushed!.metadata?.content![0] as any).toolCall.toolName).toBe('read_file')
    })

    it('emits tool_start to buffer', () => {
      collector.handleEvent(toolcallStart(0, 'tc-1', 'read_file'))

      const toolStartEvents = buffer.findEvents('tool_start')
      expect(toolStartEvents).toHaveLength(1)
      expect((toolStartEvents[0] as any).toolCallId).toBe('tc-1')
      expect((toolStartEvents[0] as any).toolName).toBe('read_file')
    })

    it('accumulates tool args from deltas', () => {
      collector.handleEvent(toolcallStart(0, 'tc-1', 'read_file'))
      collector.handleEvent(toolcallDelta(0, '{"path":'))
      collector.handleEvent(toolcallDelta(0, '"test.ts"}'))

      const flushed = collector.flush()
      const toolBlock = flushed!.metadata?.content![0] as any
      expect(toolBlock.toolCall.args).toBe('{"path":"test.ts"}')
    })

    it('emits tool_args_delta to buffer', () => {
      collector.handleEvent(toolcallStart(0, 'tc-1', 'read_file'))
      collector.handleEvent(toolcallDelta(0, '{"path":"test"}'))

      const deltaEvents = buffer.findEvents('tool_args_delta')
      expect(deltaEvents).toHaveLength(1)
      expect((deltaEvents[0] as any).delta).toBe('{"path":"test"}')
    })

    it('finalizes args on toolcall_end', () => {
      collector.handleEvent(toolcallStart(0, 'tc-1', 'read_file'))
      collector.handleEvent(toolcallDelta(0, '{"path":"test"}'))
      collector.handleEvent(toolcallEnd(0, { path: 'final.ts' }))

      const flushed = collector.flush()
      const toolBlock = flushed!.metadata?.content![0] as any
      expect(toolBlock.toolCall.args).toBe('{"path":"final.ts"}')
    })

    it('handles multiple concurrent tool calls', () => {
      collector.handleEvent(toolcallStart(0, 'tc-1', 'read_file'))
      collector.handleEvent(toolcallStart(1, 'tc-2', 'write_file'))
      collector.handleEvent(toolcallDelta(0, '{"a":1}'))
      collector.handleEvent(toolcallDelta(1, '{"b":2}'))

      const flushed = collector.flush()
      expect(flushed!.metadata?.content).toHaveLength(2)
    })
  })

  describe('tool execution events', () => {
    it('creates tool block on execution_start if not streamed', () => {
      collector.handleEvent(toolExecutionStart('tc-1', 'bash', { command: 'ls' }))

      const flushed = collector.flush()
      expect(flushed!.metadata?.content).toHaveLength(1)
      const toolBlock = flushed!.metadata?.content![0] as any
      expect(toolBlock.type).toBe('tool_use')
      expect(toolBlock.toolCall.toolName).toBe('bash')
      expect(toolBlock.toolCall.args).toBe('{"command":"ls"}')
    })

    it('emits tool_start for non-streamed tools', () => {
      collector.handleEvent(toolExecutionStart('tc-1', 'bash', { command: 'ls' }))

      const toolStartEvents = buffer.findEvents('tool_start')
      expect(toolStartEvents).toHaveLength(1)
    })

    it('does not duplicate tool_start for streamed tools', () => {
      // Streamed tool call
      collector.handleEvent(toolcallStart(0, 'tc-1', 'read_file'))

      // Then execution starts
      collector.handleEvent(toolExecutionStart('tc-1', 'read_file', { path: 'test.ts' }))

      // Should only have one tool_start
      const toolStartEvents = buffer.findEvents('tool_start')
      expect(toolStartEvents).toHaveLength(1)
    })

    it('updates args on execution_start for streamed tools', () => {
      collector.handleEvent(toolcallStart(0, 'tc-1', 'read_file'))
      collector.handleEvent(toolcallDelta(0, '{"partial":true}'))

      // Execution start has final args
      collector.handleEvent(toolExecutionStart('tc-1', 'read_file', { path: 'final.ts' }))

      const flushed = collector.flush()
      const toolBlock = flushed!.metadata?.content![0] as any
      expect(toolBlock.toolCall.args).toBe('{"path":"final.ts"}')
    })

    it('updates result on execution_update', () => {
      collector.handleEvent(toolExecutionStart('tc-1', 'bash', { command: 'ls' }))
      collector.handleEvent(toolExecutionUpdate('tc-1', 'partial output'))

      const flushed = collector.flush()
      const toolBlock = flushed!.metadata?.content![0] as any
      expect(toolBlock.toolCall.result).toBe('partial output')
    })

    it('emits tool_update to buffer', () => {
      collector.handleEvent(toolExecutionStart('tc-1', 'bash', { command: 'ls' }))
      collector.handleEvent(toolExecutionUpdate('tc-1', 'output'))

      const updateEvents = buffer.findEvents('tool_update')
      expect(updateEvents).toHaveLength(1)
      expect((updateEvents[0] as any).result).toBe('output')
    })

    it('finalizes result and error status on execution_end', () => {
      collector.handleEvent(toolExecutionStart('tc-1', 'bash', { command: 'ls' }))
      collector.handleEvent(toolExecutionEnd('tc-1', 'final output', false))

      const flushed = collector.flush()
      const toolBlock = flushed!.metadata?.content![0] as any
      expect(toolBlock.toolCall.result).toBe('final output')
      expect(toolBlock.toolCall.isError).toBe(false)
    })

    it('marks error on execution_end with isError=true', () => {
      collector.handleEvent(toolExecutionStart('tc-1', 'bash', { command: 'bad' }))
      collector.handleEvent(toolExecutionEnd('tc-1', 'command failed', true))

      const flushed = collector.flush()
      const toolBlock = flushed!.metadata?.content![0] as any
      expect(toolBlock.toolCall.isError).toBe(true)
    })

    it('emits tool_end to buffer', () => {
      collector.handleEvent(toolExecutionStart('tc-1', 'bash', { command: 'ls' }))
      collector.handleEvent(toolExecutionEnd('tc-1', 'done', false))

      const endEvents = buffer.findEvents('tool_end')
      expect(endEvents).toHaveLength(1)
      expect((endEvents[0] as any).isError).toBe(false)
    })
  })

  describe('agent_end', () => {
    it('returns true to signal completion', () => {
      const isEnd = collector.handleEvent(agentEnd())
      expect(isEnd).toBe(true)
    })

    it('tracks settled assistant errors independently from the derived error text', () => {
      collector.handleEvent(agentEnd([{ role: 'assistant', stopReason: 'error', errorMessage: 'Rate limit exceeded' }]))
      collector.lastError = null

      expect(collector.settledWithAssistantError).toBe(true)
    })

    it('captures error from assistant stop_reason=error', () => {
      collector.handleEvent(agentEnd([{ role: 'assistant', stopReason: 'error', errorMessage: 'Rate limit exceeded' }]))

      expect(collector.lastError).toBe('Rate limit exceeded')
    })

    it('joins multiple error messages', () => {
      collector.handleEvent(
        agentEnd([
          { role: 'assistant', stopReason: 'error', errorMessage: 'Error 1' },
          { role: 'assistant', stopReason: 'error', errorMessage: 'Error 2' },
        ])
      )

      expect(collector.lastError).toBe('Error 1\nError 2')
    })

    it('ignores non-error messages', () => {
      collector.handleEvent(agentEnd([{ role: 'assistant', stopReason: 'end_turn' }]))

      expect(collector.lastError).toBeNull()
    })

    it('finalizes thinking block on agent_end', async () => {
      collector.handleEvent(thinkingDelta('thinking...'))
      await new Promise((r) => setTimeout(r, 5))
      collector.handleEvent(agentEnd())

      const thinkingEndEvents = buffer.findEvents('thinking_end')
      expect(thinkingEndEvents).toHaveLength(1)
    })
  })

  describe('compaction events', () => {
    it('emits flush_agent and compaction_start on compaction start', () => {
      collector.handleEvent(autoCompactionStart('threshold'))

      expect(buffer.findEvents('flush_agent')).toHaveLength(1)
      expect(buffer.findEvents('compaction_start')).toHaveLength(1)
      expect(buffer.findEvents('system_message')).toHaveLength(1)
    })

    it('emits success events on compaction end with result', () => {
      collector.handleEvent(autoCompactionEnd({ result: 'summary' }))

      const endEvents = buffer.findEvents('compaction_end')
      expect(endEvents).toHaveLength(1)
      expect((endEvents[0] as any).success).toBe(true)
    })

    it('stamps successful compaction system messages with a transient id when a stream group is active', () => {
      const keyedBuffer = new MockStreamBuffer()
      const keyedCollector = new StreamEventCollector(keyedBuffer as any, () => 'exec:run:2')

      keyedCollector.handleEvent(autoCompactionEnd({ result: 'summary' }))

      const systemEvents = keyedBuffer.findEvents('system_message')
      expect(systemEvents).toHaveLength(1)
      expect((systemEvents[0] as any).transientId).toBe('compaction:exec:run:2')
    })

    it('emits error events on compaction failure', () => {
      collector.handleEvent(autoCompactionEnd({ errorMessage: 'Compaction failed' }))

      const endEvents = buffer.findEvents('compaction_end')
      expect(endEvents).toHaveLength(1)
      expect((endEvents[0] as any).success).toBe(false)
      expect((endEvents[0] as any).error).toBe('Compaction failed')
    })

    it('emits aborted events on compaction abort', () => {
      collector.handleEvent(autoCompactionEnd({ aborted: true }))

      const endEvents = buffer.findEvents('compaction_end')
      expect(endEvents).toHaveLength(1)
      expect((endEvents[0] as any).aborted).toBe(true)
    })
  })

  describe('auto_retry events', () => {
    it('captures error on retry failure', () => {
      collector.handleEvent(autoRetryEnd(false, 'Max retries exceeded'))

      expect(collector.lastError).toBe('Max retries exceeded')
    })

    it('does not set error on retry success', () => {
      collector.handleEvent(autoRetryEnd(true))

      expect(collector.lastError).toBeNull()
    })

    it('clears transient retry system messages from the stream buffer after successful retry', () => {
      collector.handleEvent(autoRetryStart())
      expect(buffer.findEvents('system_message')).toHaveLength(1)

      collector.handleEvent(autoRetryEnd(true))

      expect(buffer.findEvents('system_message')).toHaveLength(0)
      expect(buffer.findEvents('system_message_clear')).toEqual([
        { type: 'system_message_clear', transientId: 'auto-retry' },
      ])
    })
  })

  describe('flush()', () => {
    it('returns null when no content', () => {
      const flushed = collector.flush()
      expect(flushed).toBeNull()
    })

    it('returns response text from text blocks only', () => {
      collector.handleEvent(thinkingDelta('thinking'))
      collector.handleEvent(textDelta('response'))

      const flushed = collector.flush()
      expect(flushed!.response).toBe('response')
    })

    it('includes all blocks in metadata', () => {
      collector.handleEvent(thinkingDelta('think'))
      collector.handleEvent(textDelta('text'))
      collector.handleEvent(toolExecutionStart('tc-1', 'bash', {}))

      const flushed = collector.flush()
      expect(flushed!.metadata?.content).toHaveLength(3)
    })

    it('resets state after flush', () => {
      collector.handleEvent(textDelta('first'))
      collector.flush()

      collector.handleEvent(textDelta('second'))
      const flushed = collector.flush()

      expect(flushed!.response).toBe('second')
      expect(flushed!.metadata?.content).toHaveLength(1)
    })

    it('clears lastError after flush', () => {
      collector.handleEvent(autoRetryEnd(false, 'error'))
      expect(collector.lastError).toBe('error')

      collector.handleEvent(textDelta('text'))
      collector.flush()

      expect(collector.lastError).toBeNull()
    })
  })

  describe('reset()', () => {
    it('clears all accumulated state', () => {
      collector.handleEvent(thinkingDelta('think'))
      collector.handleEvent(textDelta('text'))
      collector.handleEvent(autoRetryEnd(false, 'error'))

      collector.reset()

      const flushed = collector.flush()
      expect(flushed).toBeNull()
      expect(collector.lastError).toBeNull()
    })

    it('allows collecting new content after reset', () => {
      collector.handleEvent(textDelta('first'))
      collector.reset()
      collector.handleEvent(textDelta('second'))

      const flushed = collector.flush()
      expect(flushed!.response).toBe('second')
    })
  })

  describe('block transitions', () => {
    it('creates separate blocks for thinking → text → tool → text', () => {
      collector.handleEvent(thinkingDelta('thinking'))
      collector.handleEvent(textDelta('intro '))
      collector.handleEvent(toolExecutionStart('tc-1', 'bash', {}))
      collector.handleEvent(toolExecutionEnd('tc-1', 'output', false))
      collector.handleEvent(textDelta('conclusion'))

      const flushed = collector.flush()
      const types = flushed!.metadata?.content!.map((b) => b.type)
      expect(types).toEqual(['thinking', 'text', 'tool_use', 'text'])
    })

    it('continues same text block across multiple deltas', () => {
      collector.handleEvent(textDelta('a'))
      collector.handleEvent(textDelta('b'))
      collector.handleEvent(textDelta('c'))

      const flushed = collector.flush()
      expect(flushed!.metadata?.content).toHaveLength(1)
      expect(flushed!.response).toBe('abc')
    })

    it('continues same thinking block across multiple deltas', () => {
      collector.handleEvent(thinkingDelta('a'))
      collector.handleEvent(thinkingDelta('b'))

      const flushed = collector.flush()
      expect(flushed!.metadata?.content).toHaveLength(1)
      expect((flushed!.metadata?.content![0] as any).content).toBe('ab')
    })
  })

  describe('block IDs', () => {
    it('generates unique IDs for each block', () => {
      collector.handleEvent(thinkingDelta('think'))
      collector.handleEvent(textDelta('text'))

      const flushed = collector.flush()
      const ids = flushed!.metadata?.content!.map((b) => b.id)
      expect(ids![0]).not.toBe(ids![1])
      expect(ids![0]).toMatch(/^block-\d+-\d+$/)
    })

    it('uses toolCallId as block ID for tool_use blocks', () => {
      collector.handleEvent(toolExecutionStart('my-tool-id', 'bash', {}))

      const flushed = collector.flush()
      expect(flushed!.metadata?.content![0].id).toBe('my-tool-id')
    })
  })

  describe('edge cases', () => {
    it('handles unknown event types gracefully', () => {
      const isEnd = collector.handleEvent({ type: 'unknown_event' } as any)
      expect(isEnd).toBe(false)
    })

    it('handles empty delta strings', () => {
      collector.handleEvent(textDelta(''))
      collector.handleEvent(textDelta('text'))

      const flushed = collector.flush()
      expect(flushed!.response).toBe('text')
    })

    it('handles tool execution for unknown tool (no prior streaming)', () => {
      collector.handleEvent(toolExecutionUpdate('unknown-tc', 'result'))
      collector.handleEvent(toolExecutionEnd('unknown-tc', 'final', false))

      // Should not crash, just emit events
      expect(buffer.findEvents('tool_update')).toHaveLength(1)
      expect(buffer.findEvents('tool_end')).toHaveLength(1)
    })

    it('serializes non-string partialResult to JSON', () => {
      collector.handleEvent(toolExecutionStart('tc-1', 'api', {}))
      collector.handleEvent(toolExecutionUpdate('tc-1', { data: 'value' } as any))

      const flushed = collector.flush()
      const toolBlock = flushed!.metadata?.content![0] as any
      expect(toolBlock.toolCall.result).toBe('{"data":"value"}')
    })

    it('serializes non-string result to JSON on execution_end', () => {
      collector.handleEvent(toolExecutionStart('tc-1', 'api', {}))
      collector.handleEvent(toolExecutionEnd('tc-1', { success: true } as any, false))

      const flushed = collector.flush()
      const toolBlock = flushed!.metadata?.content![0] as any
      expect(toolBlock.toolCall.result).toBe('{"success":true}')
    })
  })
})
