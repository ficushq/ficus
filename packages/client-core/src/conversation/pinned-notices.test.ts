import { describe, expect, test } from 'bun:test'
import type { ContentBlock, Message, StreamEvent } from '@ficus/shared'
import { createStreamingBlockState, reduceStreamingBlocks, segmentAtNotices, lastBlocksSegmentIndex } from './blocks'
import { combine, completedGroupIds, groupPersisted, pinNoticesInSavedBlocks } from './combine'
import { StreamGroupStore } from './groups'
import type { CombineSession, RenderItem } from './types'

const SESSION: CombineSession = { agentId: 'a', streamStatus: 'live' }
const SG = 'S1'

const text = (value: string): StreamEvent => ({ type: 'text', text: value, streamGroupId: SG })
const toolStart = (id: string): StreamEvent => ({
  type: 'tool_start',
  toolCallId: id,
  toolName: 'bash',
  args: '{}',
  streamGroupId: SG,
})
const toolEnd = (id: string): StreamEvent => ({
  type: 'tool_end',
  toolCallId: id,
  result: 'ok',
  isError: false,
  streamGroupId: SG,
})
const notice = (value: string, transientId?: string): StreamEvent => ({
  type: 'system_message',
  text: value,
  ...(transientId ? { transientId } : {}),
})

function ingestAll(store: StreamGroupStore, events: StreamEvent[], start = 100): void {
  events.forEach((event, index) => store.ingest(event, start + index))
}

const kinds = (blocks: Array<{ type: string }>) => blocks.map((block) => block.type)
const noticeTexts = (items: RenderItem[]) =>
  items.flatMap((item) =>
    item.kind === 'system'
      ? [`timeline:${item.text}`]
      : item.kind === 'streaming' || item.kind === 'persisted'
        ? item.blocks.flatMap((block) => (block.type === 'system_notice' ? [`inline:${block.text}`] : []))
        : []
  )

function savedTurn(content: ContentBlock[]): Message {
  return {
    id: 'm1',
    agentId: 'a',
    role: 'assistant',
    content: '',
    pending: false,
    createdAt: new Date('2026-06-25T00:00:01.000Z'),
    metadata: { streamGroupId: SG, content },
  }
}

describe('system notices pinned inside a live response', () => {
  test('the reducer pins a notice after the block in progress, which keeps streaming above it', () => {
    const state = [text('Checking '), notice('Precompaction started'), text('the logs.'), toolStart('t1')].reduce(
      (s, event) => reduceStreamingBlocks(s, event, 1),
      createStreamingBlockState()
    )
    expect(kinds(state.blocks)).toEqual(['text', 'system_notice', 'tool_use'])
    expect(state.blocks[0]).toMatchObject({ type: 'text', content: 'Checking the logs.' })
    expect(state.blocks[1]).toMatchObject({ type: 'system_notice', text: 'Precompaction started' })
  })

  test('a notice during a response is pinned in it; outside a response it stays on the timeline', () => {
    const store = new StreamGroupStore()
    ingestAll(store, [
      notice('Recovered provider available'),
      text('Hi'),
      notice('Precompaction started'),
      toolStart('t1'),
    ])

    expect(store.systemMessages().map((m) => m.text)).toEqual(['Recovered provider available'])
    expect(kinds(store.snapshot()[0].blocks)).toEqual(['text', 'system_notice', 'tool_use'])
  })

  test('a notice after the response was flushed (compaction) is not pinned into it', () => {
    const store = new StreamGroupStore()
    ingestAll(store, [text('before'), { type: 'flush_agent' }, notice('Context compacted — continuing...')])
    expect(store.systemMessages().map((m) => m.text)).toEqual(['Context compacted — continuing...'])
    expect(kinds(store.snapshot()[0].blocks)).toEqual(['text'])
  })

  test('a cleared transient notice leaves the response', () => {
    const store = new StreamGroupStore()
    ingestAll(store, [
      text('Hi'),
      notice('Retrying (attempt 1/3)', 'retry'),
      { type: 'system_message_clear', transientId: 'retry' },
    ])
    expect(kinds(store.snapshot()[0].blocks)).toEqual(['text'])
  })

  test('the live response renders the notice between the content it split, not below the response', () => {
    const store = new StreamGroupStore()
    ingestAll(store, [
      text('Checking'),
      toolStart('t1'),
      notice('Precompaction started'),
      toolEnd('t1'),
      toolStart('t2'),
    ])

    const items = combine([], store.snapshot(), [], SESSION, store.systemMessages(), store.settledNotices())
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('streaming')
    expect(kinds((items[0] as Extract<RenderItem, { kind: 'streaming' }>).blocks)).toEqual([
      'text',
      'tool_use',
      'system_notice',
      'tool_use',
    ])
  })

  test('the response still hands over to its saved turn, and the notice stays where it was', () => {
    const store = new StreamGroupStore()
    ingestAll(store, [
      text('Checking'),
      toolStart('t1'),
      toolEnd('t1'),
      notice('Provider openai-codex exhausted — failed over to anthropic:claude-opus-5-5.'),
      toolStart('t2'),
      toolEnd('t2'),
      { type: 'done', response: '', streamGroupId: SG, messageIds: ['m1'] },
    ])
    const tool = (id: string): ContentBlock => ({
      type: 'tool_use',
      id,
      toolCall: { toolCallId: id, toolName: 'bash', args: '{}', result: 'ok', isError: false },
    })
    const history = groupPersisted([
      savedTurn([{ type: 'text', id: 'b1', content: 'Checking' }, tool('t1'), tool('t2')]),
    ])

    // The notice is render-only: it never blocks the hand-over.
    expect(completedGroupIds(history, store.snapshot(), SESSION)).toEqual([SG])
    const handedOver = combine(history, store.snapshot(), [], SESSION, store.systemMessages(), store.settledNotices())
    expect(handedOver.map((item) => item.kind)).toEqual(['persisted'])
    expect(kinds((handedOver[0] as Extract<RenderItem, { kind: 'persisted' }>).blocks)).toEqual([
      'text',
      'tool_use',
      'system_notice',
      'tool_use',
    ])

    // Once the store clears the group, the saved turn keeps the notice in place.
    store.clear(SG)
    const after = combine(history, store.snapshot(), [], SESSION, store.systemMessages(), store.settledNotices())
    expect(kinds((after[0] as Extract<RenderItem, { kind: 'persisted' }>).blocks)).toEqual([
      'text',
      'tool_use',
      'system_notice',
      'tool_use',
    ])
    expect(noticeTexts(after)).toEqual([
      'inline:Provider openai-codex exhausted — failed over to anthropic:claude-opus-5-5.',
    ])
  })

  test('a catchup replay of the same events pins the notice the same way, once', () => {
    const events: StreamEvent[] = [text('Hi'), notice('Precompaction started'), toolStart('t1')]
    const live = new StreamGroupStore()
    ingestAll(live, events)
    const replayed = new StreamGroupStore()
    replayed.applyCatchup(events, 100)
    expect(replayed.snapshot()[0].blocks).toEqual(live.snapshot()[0].blocks)

    // A partial batch (no delta before the notice) must not add a timeline copy.
    live.applyCatchup([notice('Precompaction started'), toolStart('t1')], 200)
    expect(live.systemMessages()).toEqual([])
    expect(kinds(live.snapshot()[0].blocks)).toEqual(['text', 'system_notice', 'tool_use'])
  })

  test('pinning into saved blocks is positional and deterministic', () => {
    const saved: ContentBlock[] = [
      { type: 'text', id: 'b1', content: 'one' },
      { type: 'text', id: 'b2', content: 'two' },
    ]
    const pin = (id: string) => ({ type: 'system_notice' as const, id, text: id })
    expect(kinds(pinNoticesInSavedBlocks(saved, [pin('first'), { type: 'text', id: 's1', content: 'one' }]))).toEqual([
      'system_notice',
      'text',
      'text',
    ])
    // An unmatched streamed block leaves the next notice after the last match.
    expect(
      pinNoticesInSavedBlocks(saved, [
        { type: 'text', id: 's1', content: 'one' },
        { type: 'text', id: 's2', content: 'missing' },
        pin('late'),
      ]).map((block) => block.id)
    ).toEqual(['b1', 'late', 'b2'])
    expect(pinNoticesInSavedBlocks(saved, [{ type: 'text', id: 's1', content: 'one' }])).toBe(saved)
  })

  test('segments split content runs at notices, and only the last run can be live', () => {
    const segments = segmentAtNotices([
      { type: 'text', id: 'a' },
      { type: 'system_notice', id: 'n', text: 'Precompaction started' },
      { type: 'tool_use', id: 'b' },
      { type: 'tool_use', id: 'c' },
    ])
    expect(segments.map((segment) => (segment.type === 'blocks' ? segment.blocks.map((b) => b.id) : 'notice'))).toEqual(
      [['a'], 'notice', ['b', 'c']]
    )
    expect(lastBlocksSegmentIndex(segments)).toBe(2)
    // A trailing notice: the run in progress above it is still the live one.
    expect(
      lastBlocksSegmentIndex(
        segmentAtNotices([
          { type: 'text', id: 'a' },
          { type: 'system_notice', id: 'n', text: 'x' },
        ])
      )
    ).toBe(0)
  })
})
