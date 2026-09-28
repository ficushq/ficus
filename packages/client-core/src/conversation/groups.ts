import type { StreamEvent } from '@ficus/shared'
import { createStreamingBlockState, reduceStreamingBlocks, type StreamingBlockState } from './blocks'
import type { CompactionState, StreamGroupSnapshot, SystemMessageItem } from './types'

interface MutableGroup {
  streamGroupId: string
  agentId: string
  executionId?: string
  state: StreamingBlockState
  startedAt: number
  done: boolean
  doneMessageIds: string[] | null
  flushed: boolean
  errored: boolean
}

/** Events that carry a streamGroupId and feed the block accumulator. */
function streamGroupIdOf(event: StreamEvent): string | undefined {
  return 'streamGroupId' in event ? event.streamGroupId : undefined
}

/** A full catchup may extend local blocks, but must not roll back content already shown. */
function includesLocalProgress(replayed: StreamingBlockState, local: StreamingBlockState): boolean {
  if (replayed.blocks.length < local.blocks.length) return false
  return local.blocks.every((block, index) => {
    const candidate = replayed.blocks[index]
    if (candidate.type !== block.type) return false
    if (block.type === 'text' || block.type === 'thinking') {
      return candidate.type === block.type && candidate.content.startsWith(block.content)
    }
    return (
      candidate.type === 'tool_use' &&
      candidate.toolCall.toolCallId === block.toolCall.toolCallId &&
      candidate.toolCall.toolName === block.toolCall.toolName &&
      candidate.toolCall.args.startsWith(block.toolCall.args) &&
      (!block._done ||
        (candidate._done &&
          candidate.toolCall.result === block.toolCall.result &&
          candidate.toolCall.isError === block.toolCall.isError))
    )
  })
}

/**
 * Stateful router from the SSE event stream to per-streamGroupId block
 * accumulators. The only mutable piece of the reconciliation layer; everything
 * downstream (groupPersisted/combine) is pure over snapshot().
 */
export class StreamGroupStore {
  private groups = new Map<string, MutableGroup>()
  // Once durable history owns a group, old replay/deltas must not resurrect it
  // after a history revision/deletion. IDs only; no retained response content.
  private retired = new Set<string>()
  /** The agentId most recently seen on an `agent` event, stamped onto new groups. */
  private agentId = ''
  /** The execution most recently announced by an `agent` event. */
  private executionId: string | undefined
  /** The streamGroupId of the most recent delta — flush_agent targets it. */
  private lastActive: string | null = null
  private systemMsgs: SystemMessageItem[] = []
  private compaction: CompactionState = null
  private systemMsgCounter = 0

  ingest(event: StreamEvent, now: number = Date.now()): void {
    if (event.type === 'agent') {
      this.agentId = event.agentId
      this.executionId = event.executionId
      return
    }

    if (event.type === 'flush_agent') {
      if (this.lastActive) {
        const g = this.groups.get(this.lastActive)
        if (g) g.flushed = true
      }
      return
    }

    if (event.type === 'done') {
      const id = event.streamGroupId ?? this.lastActive
      if (!id || this.retired.has(id)) return
      const g = this.ensure(id, now)
      g.done = true
      g.doneMessageIds = event.messageIds ?? (event.messageId ? [event.messageId] : [])
      return
    }

    if (event.type === 'error') {
      if (this.lastActive) {
        const g = this.groups.get(this.lastActive)
        if (g) g.errored = true
      }
      return
    }

    if (event.type === 'compaction_start') {
      this.compaction = { reason: event.reason }
      return
    }
    if (event.type === 'compaction_end') {
      this.compaction = null
      return
    }
    if (event.type === 'system_message') {
      // While compacting, the banner (compactionState) represents status — don't also add inline.
      if (this.compaction === null) {
        this.systemMsgCounter += 1
        this.systemMsgs.push({
          id: `sys-${this.systemMsgCounter}`,
          text: event.text,
          transientId: event.transientId,
          at: now,
        })
      }
      return
    }

    if (event.type === 'system_message_clear') {
      this.systemMsgs = this.systemMsgs.filter((m) => m.transientId !== event.transientId)
      return
    }

    const id = streamGroupIdOf(event)
    if (!id) return // other non-streamGroupId events are not block deltas
    if (this.retired.has(id)) {
      this.lastActive = id
      return
    }
    const g = this.ensure(id, now)
    g.state = reduceStreamingBlocks(g.state, event, now)
    this.lastActive = id
  }

  /**
   * Replay in an isolated routing context: a historical unscoped lifecycle event must
   * never target the live cursor. Reconcile only groups actually reached by the replay.
   * Groups remain uncommitted until combine proves durable coverage, even after done.
   */
  applyCatchup(events: StreamEvent[], now: number = Date.now()): void {
    const replay = new StreamGroupStore()
    // Partial batches may omit the agent announcement, but never inherit lastActive.
    replay.agentId = this.agentId
    replay.executionId = this.executionId
    for (const [index, event] of events.entries()) replay.ingest(event, now + index)
    const previousIds = new Set(this.groups.keys())
    for (const [id, replayed] of replay.groups) {
      if (this.retired.has(id)) continue
      const existing = this.groups.get(id)
      if (!existing) {
        this.groups.set(id, replayed)
        continue
      }
      if (includesLocalProgress(replayed.state, existing.state)) existing.state = replayed.state
      // Missing earlier lifecycle events are not evidence of a reversal. Group IDs
      // identify a response, not a reusable slot. Durable handoff clears these flags.
      existing.done ||= replayed.done
      existing.flushed ||= replayed.flushed
      existing.errored ||= replayed.errored
      if (replayed.done)
        existing.doneMessageIds = [...new Set([...(existing.doneMessageIds ?? []), ...(replayed.doneMessageIds ?? [])])]
    }
    this.agentId = replay.agentId
    this.executionId = replay.executionId
    // An empty/lifecycle-only batch cannot retarget the next live unscoped event.
    // Nor should a stale prefix move the cursor behind a newer local group.
    if (
      replay.lastActive &&
      !this.retired.has(replay.lastActive) &&
      (!this.lastActive || !previousIds.has(replay.lastActive))
    ) {
      this.lastActive = replay.lastActive
    }

    // Preserve timestamps so replayed notices do not jump below the live response.
    const prevSysAt = this.systemMsgs.map((s) => s.at)
    this.systemMsgs = replay.systemMsgs
    this.compaction = replay.compaction
    this.systemMsgCounter = replay.systemMsgCounter
    for (let i = 0; i < this.systemMsgs.length && i < prevSysAt.length; i++) {
      this.systemMsgs[i].at = prevSysAt[i]
    }
  }

  /** Remove one group by id, or all groups when called with no argument (does not clear agentId — use reset() for full teardown). */
  clear(streamGroupId?: string): void {
    if (streamGroupId === undefined) {
      for (const id of this.groups.keys()) this.retired.add(id)
      this.groups.clear()
      this.lastActive = null
      return
    }
    this.retired.add(streamGroupId)
    this.groups.delete(streamGroupId)
    if (this.lastActive === streamGroupId) this.lastActive = null
  }

  reset(): void {
    this.retired.clear()
    this.groups.clear()
    this.agentId = ''
    this.executionId = undefined
    this.lastActive = null
    this.systemMsgs = []
    this.compaction = null
    this.systemMsgCounter = 0
  }

  systemMessages(): SystemMessageItem[] {
    return this.systemMsgs
  }

  compactionState(): CompactionState {
    return this.compaction
  }

  snapshot(): StreamGroupSnapshot[] {
    return [...this.groups.values()]
      .map((g) => ({
        streamGroupId: g.streamGroupId,
        agentId: g.agentId,
        executionId: g.executionId,
        blocks: g.state.blocks,
        startedAt: g.startedAt,
        done: g.done,
        doneMessageIds: g.doneMessageIds,
        flushed: g.flushed,
        errored: g.errored,
      }))
      .sort((a, b) => a.startedAt - b.startedAt || (a.streamGroupId < b.streamGroupId ? -1 : 1))
  }

  private ensure(streamGroupId: string, now: number): MutableGroup {
    let g = this.groups.get(streamGroupId)
    if (!g) {
      g = {
        streamGroupId,
        agentId: this.agentId,
        executionId: this.executionId,
        state: createStreamingBlockState(),
        startedAt: now,
        done: false,
        doneMessageIds: null,
        flushed: false,
        errored: false,
      }
      this.groups.set(streamGroupId, g)
    }
    return g
  }
}
