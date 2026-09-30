import type { ContentBlock, StreamEvent } from '@ficus/shared'

/**
 * A live system notice (precompaction, retry, failover) pinned where it arrived
 * inside a response: after the block that was in progress. Render-only — never
 * persisted, and skipped when matching a response against its saved rows.
 */
export interface SystemNoticeBlock {
  type: 'system_notice'
  id: string
  text: string
  /** Set for notices a later `system_message_clear` removes. */
  transientId?: string
}

export type StreamingContentBlock =
  | (Extract<ContentBlock, { type: 'thinking' | 'text' }> & { streamGroupId?: string })
  | (Extract<ContentBlock, { type: 'tool_use' }> & { _done?: boolean; streamGroupId?: string })
  | SystemNoticeBlock

/** A content block as rendered: saved or streamed content, or a pinned system notice. */
export type RenderedContentBlock = ContentBlock | SystemNoticeBlock

export function isSystemNoticeBlock(block: { type: string }): block is SystemNoticeBlock {
  return block.type === 'system_notice'
}

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

    case 'system_message': {
      // Pinned after the block in progress, which keeps streaming above it (its
      // deltas update it by id): streamed blocks stay one-to-one with the saved
      // ones, and the next block starts below the notice.
      const id = generatedId(state)
      const notice: SystemNoticeBlock = {
        type: 'system_notice',
        id,
        text: event.text,
        ...(event.transientId ? { transientId: event.transientId } : {}),
      }
      return withNextId({ ...state, blocks: [...state.blocks, notice] })
    }

    case 'system_message_clear': {
      const blocks = state.blocks.filter(
        (block) => !(block.type === 'system_notice' && block.transientId === event.transientId)
      )
      return blocks.length === state.blocks.length ? state : { ...state, blocks }
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

/** A run of content blocks, or a pinned notice between runs. */
export type BlockSegment<B> =
  | { type: 'blocks'; key: string; blocks: B[] }
  | { type: 'notice'; notice: SystemNoticeBlock }

/**
 * Split a response's blocks at its pinned notices, so a renderer can draw each
 * run of content with its own grouping and a notice row between runs, exactly
 * where the notice arrived. Only the last `blocks` segment can be live: pass
 * `streaming` to that one alone ({@link lastBlocksSegmentIndex}).
 */
export function segmentAtNotices<B extends { type: string; id: string }>(
  blocks: ReadonlyArray<B | SystemNoticeBlock>
): BlockSegment<B>[] {
  const out: BlockSegment<B>[] = []
  let run: B[] = []
  const flush = () => {
    if (run.length > 0) out.push({ type: 'blocks', key: run[0].id, blocks: run })
    run = []
  }
  for (const block of blocks) {
    if (isSystemNoticeBlock(block)) {
      flush()
      out.push({ type: 'notice', notice: block })
    } else {
      run.push(block as B)
    }
  }
  flush()
  return out
}

export function lastBlocksSegmentIndex<B>(segments: BlockSegment<B>[]): number {
  for (let i = segments.length - 1; i >= 0; i--) if (segments[i].type === 'blocks') return i
  return -1
}
