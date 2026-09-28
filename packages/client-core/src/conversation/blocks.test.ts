import { describe, expect, it, test } from 'bun:test'
import { createStreamingBlockState, reduceStreamingBlocks } from './blocks'
import type { StreamEvent } from '@ficus/shared'

function reduceAll(events: StreamEvent[]) {
  return events.reduce((state, event) => reduceStreamingBlocks(state, event, 1_000), createStreamingBlockState())
}

describe('streaming block reducer', () => {
  it('interleaves thinking, text, and tool calls in stream order', () => {
    const state = reduceAll([
      { type: 'thinking', text: 'plan', streamGroupId: 'g1' },
      { type: 'thinking_end', durationMs: 1200, streamGroupId: 'g1' },
      { type: 'text', text: 'Hello ', streamGroupId: 'g1' },
      { type: 'text', text: 'world', streamGroupId: 'g1' },
      { type: 'tool_start', toolCallId: 'tool-1', toolName: 'bash', args: '{"command":"ls"', streamGroupId: 'g1' },
      { type: 'tool_args_delta', toolCallId: 'tool-1', delta: '}', streamGroupId: 'g1' },
      { type: 'tool_update', toolCallId: 'tool-1', result: 'file.txt', streamGroupId: 'g1' },
      { type: 'tool_end', toolCallId: 'tool-1', result: 'file.txt', isError: false, streamGroupId: 'g1' },
    ])

    expect(state.blocks.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use'])
    expect(state.blocks[0]).toMatchObject({ type: 'thinking', content: 'plan', durationMs: 1200 })
    expect(state.blocks[1]).toMatchObject({ type: 'text', content: 'Hello world' })
    expect(state.blocks[2]).toMatchObject({
      type: 'tool_use',
      _done: true,
      toolCall: { toolName: 'bash', args: '{"command":"ls"}', result: 'file.txt', isError: false },
    })
  })

  it('flush_agent snapshots and clears current blocks', () => {
    const state = reduceAll([
      { type: 'text', text: 'before' },
      { type: 'flush_agent' },
      { type: 'text', text: 'after' },
    ])

    expect(state.lastFlushed?.map((b) => ('content' in b ? b.content : ''))).toEqual(['before'])
    expect(state.blocks).toHaveLength(1)
    expect(state.blocks[0]).toMatchObject({ type: 'text', content: 'after' })
  })
})

describe('blocks reducer — replay from fresh state is deterministic', () => {
  test('replaying the same delta sequence into a fresh state yields identical blocks', () => {
    const events = [
      { type: 'text', text: 'Hel', streamGroupId: 'S' },
      { type: 'text', text: 'lo', streamGroupId: 'S' },
      { type: 'tool_start', toolCallId: 't1', toolName: 'bash', args: '', streamGroupId: 'S' },
      { type: 'tool_end', toolCallId: 't1', result: 'ok', isError: false, streamGroupId: 'S' },
    ] as const

    const run = () => {
      let s = createStreamingBlockState()
      for (const e of events) s = reduceStreamingBlocks(s, e, 1000)
      return s.blocks
    }

    expect(run()).toEqual(run())
  })
})
