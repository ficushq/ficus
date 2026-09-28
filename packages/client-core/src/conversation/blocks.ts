import type { ContentBlock, StreamEvent } from '@ficus/shared'

export type StreamingContentBlock =
  | (Extract<ContentBlock, { type: 'thinking' | 'text' }> & { streamGroupId?: string })
  | (Extract<ContentBlock, { type: 'tool_use' }> & { _done?: boolean; streamGroupId?: string })

interface CurrentBlockRef {
  id: string
  type: 'thinking' | 'text'
}

export interface StreamingBlockState {
  blocks: StreamingContentBlock[]
  lastFlushed: StreamingContentBlock[] | null
  currentBlock: CurrentBlockRef | null
  thinkingStartedAt: number | null
  nextId: number
}

export function createStreamingBlockState(): StreamingBlockState {
  return {
    blocks: [],
    lastFlushed: null,
    currentBlock: null,
    thinkingStartedAt: null,
    nextId: 1,
  }
}

function generatedId(state: StreamingBlockState): string {
  return `stream-block-${state.nextId}`
}

function withNextId(state: StreamingBlockState): StreamingBlockState {
  return { ...state, nextId: state.nextId + 1 }
}

function finalizeCurrentThinking(state: StreamingBlockState, now: number): StreamingBlockState {
  if (state.currentBlock?.type !== 'thinking' || !state.thinkingStartedAt) return state
  const durationMs = now - state.thinkingStartedAt
  return {
    ...state,
    blocks: state.blocks.map((block) =>
      block.type === 'thinking' && block.id === state.currentBlock?.id ? { ...block, durationMs } : block
    ),
    thinkingStartedAt: null,
  }
}

export function reduceStreamingBlocks(
  state: StreamingBlockState,
  event: StreamEvent,
  now: number = Date.now()
): StreamingBlockState {
  switch (event.type) {
    case 'thinking': {
      if (state.currentBlock?.type === 'thinking') {
        return {
          ...state,
          blocks: state.blocks.map((block) =>
            block.type === 'thinking' && block.id === state.currentBlock?.id
              ? { ...block, content: block.content + event.text }
              : block
          ),
        }
      }

      const id = generatedId(state)
      return withNextId({
        ...state,
        blocks: [...state.blocks, { type: 'thinking', id, content: event.text, streamGroupId: event.streamGroupId }],
        currentBlock: { id, type: 'thinking' },
        thinkingStartedAt: now,
      })
    }

    case 'thinking_end': {
      if (state.currentBlock?.type !== 'thinking') return state
      const id = state.currentBlock.id
      return {
        ...state,
        blocks: state.blocks.map((block) =>
          block.type === 'thinking' && block.id === id ? { ...block, durationMs: event.durationMs } : block
        ),
        currentBlock: null,
        thinkingStartedAt: null,
      }
    }

    case 'text': {
      const next = finalizeCurrentThinking(state, now)
      if (next.currentBlock?.type === 'text') {
        return {
          ...next,
          blocks: next.blocks.map((block) =>
            block.type === 'text' && block.id === next.currentBlock?.id
              ? { ...block, content: block.content + event.text }
              : block
          ),
        }
      }

      const id = generatedId(next)
      return withNextId({
        ...next,
        blocks: [...next.blocks, { type: 'text', id, content: event.text, streamGroupId: event.streamGroupId }],
        currentBlock: { id, type: 'text' },
      })
    }

    case 'tool_start': {
      const next = finalizeCurrentThinking(state, now)
      return {
        ...next,
        blocks: [
          ...next.blocks,
          {
            type: 'tool_use',
            id: event.toolCallId,
            toolCall: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
              result: '',
              isError: false,
            },
            _done: false,
            streamGroupId: event.streamGroupId,
          },
        ],
        currentBlock: null,
        thinkingStartedAt: null,
      }
    }

    case 'tool_args_delta':
      return {
        ...state,
        blocks: state.blocks.map((block) =>
          block.type === 'tool_use' && block.id === event.toolCallId
            ? { ...block, toolCall: { ...block.toolCall, args: block.toolCall.args + event.delta } }
            : block
        ),
      }

    case 'tool_update':
      return {
        ...state,
        blocks: state.blocks.map((block) =>
          block.type === 'tool_use' && block.id === event.toolCallId
            ? { ...block, toolCall: { ...block.toolCall, result: event.result } }
            : block
        ),
      }

    case 'tool_end':
      return {
        ...state,
        blocks: state.blocks.map((block) =>
          block.type === 'tool_use' && block.id === event.toolCallId
            ? {
                ...block,
                toolCall: { ...block.toolCall, result: event.result, isError: event.isError },
                _done: true,
              }
            : block
        ),
      }

    case 'flush_agent': {
      return {
        ...state,
        blocks: [],
        lastFlushed: state.blocks.length > 0 ? [...state.blocks] : state.lastFlushed,
        currentBlock: null,
        thinkingStartedAt: null,
      }
    }

    default:
      return state
  }
}
