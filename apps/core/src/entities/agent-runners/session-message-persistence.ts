import { randomUUID } from 'crypto'
import type { SessionUsage, MessageMetadata } from '@ficus/shared'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { StreamBuffer } from '../../services/streaming/buffer'
import type { StreamEventCollector } from '../../services/streaming/events'
import type { Agent } from '../Agent'
import { createLogger } from '../../lib/infra/logger'
import { withoutDelta } from '../../services/execution/usage-delta'
import { db } from '../../db'
import { messages } from '../../db/schema'
import { and, eq } from 'drizzle-orm'
import { eventEmitter } from '../../lib/infra/event-emitter'
import type { ResponseGroupIdentity } from '../../services/agent/pending-delivery'
import { messageEventData } from '../message-event'

const log = createLogger('runner')

type PersistedMessageEvent = Extract<AgentSessionEvent, { type: 'session_message_persisted' }>

export interface SessionMessagePersistenceDeps {
  executionId: string
  agent: Pick<Agent, 'id' | 'recordMessage' | 'tryConfirmPendingMessage' | 'update'>
}

export interface SessionMessagePersistenceBindings {
  collector: StreamEventCollector
  buffer: StreamBuffer
  captureUsage: () => SessionUsage
  /**
   * Runner-side seam for initial-prompt confirmation (the delivery record
   * lives with sendPrompt). Returns true when the persisted user message was
   * the initial prompt and has been fully handled.
   */
  confirmInitialPrompt: (content: string | undefined, identity: ResponseGroupIdentity) => Promise<boolean>
}

/**
 * Owns everything about persisting a live session's messages to the DB:
 * the stream-group ids the frontend reconciles on, the per-group ledger of
 * persisted assistant row ids (enumerated on `done`), the last-persisted
 * assistant snapshot, the active tool-message lifecycle, and — critically —
 * the single serialized promise chain all persistence work runs through
 * (out-of-order DB writes are the failure mode this exists to prevent).
 *
 * Constructed with the runner (the collector's stream-group closure reads
 * `currentStreamGroupId`), bound to the live session pieces via `attach()`
 * at the top of `run()`.
 */
export class SessionMessagePersistence {
  private readonly streamGroupRunId = randomUUID()
  private streamGroupCounter = 1
  /** Persisted assistant row ids per streamGroupId, enumerated on `done`. */
  private readonly turnRowIds = new Map<string, string[]>()
  private chain: Promise<void> = Promise.resolve()
  private bindings: SessionMessagePersistenceBindings | undefined
  private lastPersistedAssistantState:
    | { response: string; metadata: MessageMetadata | undefined; messageId: string | undefined }
    | undefined
  private activeToolMessage: { messageId: string; pendingToolCallIds: Set<string> } | undefined

  constructor(private readonly deps: SessionMessagePersistenceDeps) {}

  attach(bindings: SessionMessagePersistenceBindings): void {
    this.bindings = bindings
  }

  get currentStreamGroupId(): string {
    return `${this.deps.executionId}:${this.streamGroupRunId}:${this.streamGroupCounter}`
  }

  rotateStreamGroup(): void {
    this.streamGroupCounter += 1
  }

  recordTurnRowId(messageId: string): void {
    const key = this.currentStreamGroupId
    const ids = this.turnRowIds.get(key) ?? []
    if (!ids.includes(messageId)) ids.push(messageId)
    this.turnRowIds.set(key, ids)
  }

  currentTurnRowIds(): string[] {
    return this.turnRowIds.get(this.currentStreamGroupId) ?? []
  }

  /** Every persistence side effect goes through this one serialized chain. */
  protected enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch((err) => {
      log.error(`Failed to handle persisted session message:`, err)
    })
  }

  /**
   * Settles after every task enqueued so far has settled (never rejects —
   * each chain link is caught). The chain is strictly serialized, so awaiting
   * its current tail covers every earlier link; tasks enqueued after this
   * call (including from inside a running task) need a fresh call.
   */
  async waitForAll(): Promise<void> {
    await this.chain
  }

  /** The bound session pieces; throws if used before attach() — a runner wiring bug. */
  protected get bound(): SessionMessagePersistenceBindings {
    if (!this.bindings) throw new Error('SessionMessagePersistence used before attach()')
    return this.bindings
  }

  /** Chain a persisted-session-message event through the serialized queue. */
  enqueuePersistedEvent(event: PersistedMessageEvent): void {
    this.enqueue(() => this.handleSessionMessagePersisted(event))
  }

  /** The last assistant row written this run (updated by tool-result patches too). */
  lastAssistant():
    | { response: string; metadata: MessageMetadata | undefined; messageId: string | undefined }
    | undefined {
    return this.lastPersistedAssistantState
  }

  enqueueCompactionNotice(): void {
    const systemMessageKey = `compaction:${this.currentStreamGroupId}`
    this.enqueue(async () => {
      await this.deps.agent.recordMessage({
        role: 'assistant',
        content: '[System] Context compacted — continuing...',
        // Deliberately NOT stamped with executionId: the completion inference in
        // dead-owner recovery treats an executionId-tagged assistant row as proof
        // the turn produced its response. A compaction notice is a mid-turn system
        // marker, not a response — tagging it would falsely complete (and discard)
        // a turn that compacted and then crashed before answering.
        metadata: { source: 'compaction', systemMessageKey },
      })
    })
  }

  async persistSessionUsage(reason: string): Promise<SessionUsage> {
    // The agent row is a session-cumulative snapshot: never persist a
    // per-execution delta on it, even if the bound capture carried one.
    const sessionUsage = withoutDelta(this.bound.captureUsage())
    await this.deps.agent.update({ sessionUsage }).catch((err) => {
      log.error(`Failed to persist session usage after ${reason}:`, err)
    })
    return sessionUsage
  }

  private async handleSessionMessagePersisted(event: PersistedMessageEvent): Promise<void> {
    const { message } = event
    if (message.role === 'user') {
      const content = typeof message.content === 'string' ? message.content : undefined
      this.bound.buffer.push({ type: 'flush_agent' })
      this.bound.collector.reset()
      this.rotateStreamGroup()
      const identity = {
        executionId: this.deps.executionId,
        streamGroupId: this.currentStreamGroupId,
      }
      if (await this.bound.confirmInitialPrompt(content, identity)) return
      await this.deps.agent.tryConfirmPendingMessage(content, identity)
      await this.persistSessionUsage('user message persisted')
      return
    }

    if (message.role === 'assistant') {
      await this.persistAssistantMessage(message)
      await this.persistSessionUsage('assistant message persisted')
      return
    }

    if (message.role === 'toolResult') {
      await this.updatePersistedToolMessage(message.toolCallId)
      await this.persistSessionUsage('tool result persisted')
    }
  }

  private async persistAssistantMessage(message: PersistedMessageEvent['message']): Promise<void> {
    const toolCallIds = this.getPersistedToolCallIds(message)
    const collected = toolCallIds.length > 0 ? this.bound.collector.snapshot() : this.bound.collector.flush()
    const flushed = collected ?? this.persistedAssistantFromMessage(message)
    if (!flushed) return

    const aborted = 'stopReason' in message && message.stopReason === 'aborted'
    const flushedMetadata = aborted
      ? this.markToolCallsAbortedInMetadata(flushed.metadata, new Set(toolCallIds))
      : flushed.metadata
    const metadata: MessageMetadata = {
      ...(flushedMetadata ?? {}),
      executionId: this.deps.executionId,
      streamGroupId: this.currentStreamGroupId,
    }
    const saved = await this.deps.agent.recordMessage({
      role: 'assistant',
      content: flushed.response,
      metadata,
    })
    this.lastPersistedAssistantState = { response: flushed.response, metadata, messageId: saved.id }
    this.recordTurnRowId(saved.id)

    if (toolCallIds.length > 0 && !aborted) {
      this.activeToolMessage = { messageId: saved.id, pendingToolCallIds: new Set(toolCallIds) }
    } else if (aborted) {
      this.bound.collector.reset()
    }
  }

  private async updatePersistedToolMessage(toolCallId: string): Promise<void> {
    const active = this.activeToolMessage
    if (!active?.pendingToolCallIds.has(toolCallId)) return

    const snapshot = this.bound.collector.snapshot()
    if (snapshot) {
      const updated = await this.updateActiveToolMessage(snapshot.response, snapshot.metadata)
      if (updated) {
        eventEmitter.emit(
          'message.updated',
          messageEventData({
            id: active.messageId,
            agentId: this.deps.agent.id,
            metadata: {
              ...(snapshot.metadata ?? {}),
              executionId: this.deps.executionId,
              streamGroupId: this.currentStreamGroupId,
            },
          })
        )
      }
    }

    active.pendingToolCallIds.delete(toolCallId)
    if (active.pendingToolCallIds.size === 0) {
      this.bound.collector.reset()
      this.activeToolMessage = undefined
    }
  }

  async markActiveToolAborted(reason = 'Command aborted'): Promise<void> {
    const active = this.activeToolMessage
    if (!active || active.pendingToolCallIds.size === 0) return

    const snapshot = this.bound.collector.snapshot()
    if (!snapshot?.metadata?.content) return

    const metadata = this.markToolCallsAbortedInMetadata(snapshot.metadata, active.pendingToolCallIds, reason)

    const updated = await this.updateActiveToolMessage(snapshot.response, metadata)
    if (updated) {
      eventEmitter.emit(
        'message.updated',
        messageEventData({
          id: active.messageId,
          agentId: this.deps.agent.id,
          metadata: {
            ...metadata,
            executionId: this.deps.executionId,
            streamGroupId: this.currentStreamGroupId,
          },
        })
      )
    }

    this.bound.collector.reset()
    this.activeToolMessage = undefined
  }

  private markToolCallsAbortedInMetadata(
    metadata: MessageMetadata | undefined,
    toolCallIds: Set<string>,
    reason = 'Command aborted'
  ): MessageMetadata | undefined {
    if (!metadata?.content || toolCallIds.size === 0) return metadata

    return {
      ...metadata,
      content: metadata.content.map((block) => {
        if (block.type !== 'tool_use' || !toolCallIds.has(block.toolCall.toolCallId)) return block
        return {
          ...block,
          toolCall: {
            ...block.toolCall,
            result: block.toolCall.result || reason,
            isError: true,
          },
        }
      }),
    }
  }

  private async updateActiveToolMessage(
    response: string,
    metadataWithoutStreamGroup: MessageMetadata | undefined
  ): Promise<boolean> {
    const active = this.activeToolMessage
    if (!active) return false

    const metadata: MessageMetadata = {
      ...(metadataWithoutStreamGroup ?? {}),
      executionId: this.deps.executionId,
      streamGroupId: this.currentStreamGroupId,
    }
    const updated = await db
      .update(messages)
      .set({ content: response, metadata })
      .where(and(eq(messages.id, active.messageId), eq(messages.agentId, this.deps.agent.id)))
      .returning({ id: messages.id })
    if (updated.length === 0) return false

    this.lastPersistedAssistantState = {
      response,
      metadata,
      messageId: active.messageId,
    }
    return true
  }

  private getPersistedToolCallIds(message: PersistedMessageEvent['message']): string[] {
    const content = 'content' in message ? message.content : undefined
    if (!Array.isArray(content)) return []
    return content.flatMap((block) => (block?.type === 'toolCall' && typeof block.id === 'string' ? [block.id] : []))
  }

  private persistedAssistantFromMessage(
    message: PersistedMessageEvent['message']
  ): { response: string; metadata: MessageMetadata | undefined } | null {
    const content = 'content' in message ? message.content : undefined
    if (typeof content === 'string') return content ? { response: content, metadata: undefined } : null
    if (!Array.isArray(content)) return null

    const response = content
      .filter(
        (block): block is { type: 'text'; text: string } => block?.type === 'text' && typeof block.text === 'string'
      )
      .map((block) => block.text)
      .join('')
    return response ? { response, metadata: undefined } : null
  }
}
