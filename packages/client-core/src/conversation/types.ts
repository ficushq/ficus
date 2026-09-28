import type { ContentBlock, DeliveryMode, ExecutionStatus, Message, MessageMetadata } from '@ficus/shared'
import type { StreamingContentBlock } from './blocks'

/** Connection state of the agent SSE stream, surfaced by the hook to the combiner. */
export type StreamStatus = 'live' | 'reconnecting' | 'ended'

/** Lifecycle of an optimistic / queued user message. */
export type PendingStatus = 'sending' | 'queued' | 'failed'

/** Visual status of a streaming render item. */
export type StreamingItemStatus = 'streaming' | 'flushed' | 'interrupted'

/** An optimistic send or a queued interrupt/follow-up held in the pending store. */
export interface PendingItem {
  pagePath?: string
  clientId: string
  content: string
  imageIds?: string[]
  deliveryMode?: DeliveryMode
  /** Endpoint family that owns retries for this attempt. */
  /** Per-send queue placement, captured on send and reconciled with server acceptance. */
  queued?: boolean
  origin?: 'agent' | 'create'
  status: PendingStatus
  /** Client clock (ms) when the user pressed send — orders a lone pending send in Region A. */
  createdAt: number
}

/** The single ordered output of the layer. One item per render row. */
export type RenderItem =
  | {
      kind: 'streaming'
      id: string // streamGroupId
      agentId: string
      blocks: StreamingContentBlock[]
      status: StreamingItemStatus
    }
  | {
      kind: 'persisted'
      id: string // first row id of the (possibly merged) turn
      message: Message
      mergedFrom?: Message[]
      blocks: ContentBlock[]
    }
  | {
      kind: 'pending'
      id: string // clientId
      content: string
      imageIds?: string[]
      deliveryMode?: DeliveryMode
      status: PendingStatus
      /** True only when the send is actually queued (interrupt/follow-up region), not a plain Region-A send. */
      queued?: boolean
      /** Server metadata for persisted pending rows, e.g. inbox delivery summaries used by renderers. */
      metadata?: MessageMetadata | null
    }
  | {
      kind: 'system'
      id: string // store-assigned, stable
      text: string
    }
  | {
      kind: 'queued'
      id: '__maintenance_queue__'
      reason: 'maintenance'
      label: 'Queued until maintenance completes'
    }
  // The agent-activity indicator (3-dot pulse). Emitted by combine() at one deterministic
  // position so every platform renders it identically — no per-app placement logic.
  | {
      kind: 'working'
      id: string // constant sentinel
      /** Set when the busy window is specifically the sandbox-ensure debounce (server-pushed
       *  execution_phase), not generic queued/thinking activity — lets platforms show a distinct
       *  "waiting for the sandbox" label instead of the default working copy. */
      waitingFor?: 'sandbox'
    }

/** One logical persisted turn produced by groupPersisted (assistant turns merge M1+M2). */
export interface PersistedTurn {
  /** First row id of the turn (render key). */
  id: string
  /** The first source row. */
  message: Message
  /** All source rows in createdAt order (length 1 for non-merged rows). */
  mergedFrom: Message[]
  /** Concatenated metadata.content of all rows (assistant turns); [] for rows without content. */
  blocks: ContentBlock[]
  /** Present for assistant turns grouped by stream group. */
  streamGroupId?: string
  /** Ordering key: see ordering.ts. */
  sortAt: number
}

/** An immutable view of a live stream group, consumed by the pure combiner. */
export interface StreamGroupSnapshot {
  streamGroupId: string
  agentId: string
  /** Execution announced by the agent event that preceded this group, when known. */
  executionId?: string
  blocks: StreamingContentBlock[]
  /** Client clock (ms) when the group's first event arrived — orders the streaming item. */
  startedAt: number
  /** A `done` event was received for this group. */
  done: boolean
  /** Row ids enumerated by the `done` event (prerequisite 1); null until done. */
  doneMessageIds: string[] | null
  /** A `flush_agent` boundary closed this group (interrupted by a steer). */
  flushed: boolean
  /** An `error` event terminated this group. */
  errored: boolean
}

/** A live (non-persisted) system notice — compaction status, retry, model-failover. */
export interface SystemMessageItem {
  id: string
  text: string
  /** Optional identifier for transient notices that can be cleared by a stream event. */
  transientId?: string
  /** Client clock (ms) at arrival — orders the item in Region A. */
  at: number
}

/** Session-level compaction status, surfaced by the hook for a banner. Null when not compacting. */
export type CompactionState = { reason: 'auto' | 'manual' } | null

/** Session/connection inputs to the combiner. */
export interface CombineSession {
  /** Groups whose saved rows were read after identified execution completion was confirmed.
   * Only this causal authority may replace a differing provisional tool result. */
  authoritativeCompletedGroupIds?: ReadonlySet<string>
  agentId: string
  streamStatus: StreamStatus
  /**
   * Server-truth execution status of the current turn (null until known). The combiner uses it to
   * place the agent-activity indicator: 'queued' | 'running' | 'stopping' mean the agent is working.
   */
  executionStatus?: ExecutionStatus | null
  /**
   * True while backend-reported blocking sandbox setup/reconciliation exceeds the server debounce (a
   * server-pushed execution_phase:waiting_sandbox event, cleared by successful sandbox_ready/content/terminal
   * status). Busy (executionStatus/sendInFlight) remains the gate for showing the indicator at all —
   * this only tags which sub-state it's in.
   */
  waitingForSandbox?: boolean
}
