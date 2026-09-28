import {
  StreamGroupStore,
  combine,
  completedGroupIds,
  groupPersisted,
  queryKeys,
  type CombineSession,
  type CompactionState,
  type PendingItem,
  type RenderItem,
  type StreamStatus,
} from '@ficus/client-core'
import type { ChatScope, DeliveryMode, ExecutionStatus, Message, MessageMetadata, SessionUsage } from '@ficus/shared'
import { focusManager, onlineManager, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useConversationEnvironment } from './ConversationClientProvider'
import {
  barrierHidesGroup,
  exactResponseIdentity,
  type CreatedMessageBarrier,
  type ExactResponseIdentity,
} from './created-message-barriers'
import { MessageRequestGenerations } from './messageRequestGenerations'
import {
  acquireSilentRecovery,
  coalesceForegroundRefresh,
  nextRecoveryBoundary,
  type RecoveryAttempt,
} from './silentConversationRecovery'

// How long the SSE stream must be silent before the server's execution status is allowed to
// terminalize a locally-busy state. Guards the backstop against a lagging activeExecution refetch
// clearing a turn that is actually mid-flight or was just sent (the refetch trails the SSE).
const STREAM_QUIET_MS = 4000
// Legacy creation events retain a bounded conservative post-arrival barrier.
const CREATED_MESSAGE_BARRIER_MS = 5000
const MESSAGE_RECONCILE_REQUEST_MS = 30_000
const LIVE_MESSAGE_RECONCILE_LIMIT = 100

export interface UseAgentConversationOptions {
  pagePath?: string
  agentId?: string
  scope?: ChatScope
  initialPending?: { content: string; imageIds?: string[] }
  onDone?: (response: string, metadata: MessageMetadata | null, messageId?: string) => void
}

export interface SendAcceptanceHandle {
  clientId: string
  accepted: Promise<void>
}

export interface UseAgentConversationResult {
  items: RenderItem[]
  streamStatus: StreamStatus
  agentId: string | undefined
  executionStatus: ExecutionStatus | null
  /** True while the server has signaled (execution_phase: waiting_sandbox / sandbox_recovery_wait)
   *  that the active turn is blocked on its sandbox ensure. The DB `executionStatus` stays
   *  'running' during a normal in-turn ensure, so header chrome that labels the execution must
   *  consult this to say "Waiting for sandbox" honestly. Cleared by sandbox_ready, any content
   *  event, or executionStatus leaving running/stopping. */
  waitingForSandbox: boolean
  /** Number of genuinely queued interrupts/follow-ups (excludes the lone send that starts a turn). Drives the clear-queue control. */
  queuedCount: number
  usage: SessionUsage | null
  compactionState: CompactionState
  isLoading: boolean
  hasOlder: boolean
  isFetchingOlder: boolean
  fetchOlder: () => void
  send: (content: string, opts?: { imageIds?: string[]; deliveryMode?: DeliveryMode }) => string
  sendAccepted: (
    content: string,
    opts?: { imageIds?: string[]; deliveryMode?: DeliveryMode; clientId?: string }
  ) => SendAcceptanceHandle
  retrySend: (clientId: string) => void
  cancelAllPending: () => Promise<void>
  refresh: () => void
  stop: () => void
  abortTool: () => void
}

interface SendOpts {
  imageIds?: string[]
  deliveryMode?: DeliveryMode
}

// Query cache pages can outlive a hook or be shared by multiple mounted views.
// Use one runtime clock/owner, not restartable per-hook counters, for read causality.
// The symbol is deliberately absent after JSON dehydration; those rows need a new read.
const collectionRequestGenerationRef = { current: 0 }
const collectionRequestOwner = Symbol('conversation-history')
// Strict causal ordering even when several events share one performance.now tick.
let conversationActivitySequence = 0

let pendingCounter = 0
function nextClientId(): string {
  pendingCounter += 1
  return `pending-${Date.now()}-${pendingCounter}`
}

type PendingAction =
  | { type: 'reset' }
  | { type: 'add'; item: PendingItem }
  | { type: 'status'; clientId: string; status: PendingItem['status']; queued?: boolean }
  | { type: 'remove'; clientIds: string[] }

function pendingReducer(state: PendingItem[], action: PendingAction): PendingItem[] {
  switch (action.type) {
    case 'reset':
      return []
    case 'add':
      return [...state.filter((item) => item.clientId !== action.item.clientId), action.item]
    case 'status':
      return state.map((p) =>
        p.clientId === action.clientId
          ? { ...p, status: action.status, ...(action.queued !== undefined ? { queued: action.queued } : {}) }
          : p
      )
    case 'remove': {
      const ids = new Set(action.clientIds)
      return state.filter((p) => !ids.has(p.clientId))
    }
    default:
      return state
  }
}

export function useAgentConversation(options: UseAgentConversationOptions): UseAgentConversationResult {
  const { client, subscribeToAgentEvents } = useConversationEnvironment()
  const queryClient = useQueryClient()
  const onDoneRef = useRef(options.onDone)
  useEffect(() => {
    onDoneRef.current = options.onDone
  })

  // Resolved agentId — starts from options.agentId, set after create flow resolves
  const [resolvedAgentId, setResolvedAgentId] = useState<string | undefined>(options.agentId)
  useEffect(() => {
    setResolvedAgentId(options.agentId)
  }, [options.agentId])

  const storeIdentityRef = useRef(resolvedAgentId)
  const conversationIdentityRef = useRef({ requested: options.agentId, resolved: resolvedAgentId })
  conversationIdentityRef.current = { requested: options.agentId, resolved: resolvedAgentId }
  const recoveryAttemptsRef = useRef(new Map<string, number>())
  const subscriptionGenerationRef = useRef(0)
  const recoveryAcceptanceFloorRef = useRef(0)
  const hasRecoveryScopeRef = useRef(false)
  // Timer ownership must change even when a replacement stream delivers no events.
  const [subscriptionGeneration, setSubscriptionGeneration] = useState(0)
  const createGenerationRef = useRef(0)
  useEffect(
    () => () => {
      createGenerationRef.current += 1
    },
    []
  )

  // 1. Stream → StreamGroupStore. The store is mutable; we bump a tick to re-render.
  const storeRef = useRef<StreamGroupStore | null>(null)
  if (storeRef.current === null) storeRef.current = new StreamGroupStore()
  const store = storeRef.current
  const [streamTick, bumpTick] = useReducer((n: number) => n + 1, 0)
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('live')
  // Bumped to force a fresh agent-stream subscription when a new execution starts. The per-execution
  // worker stream closes on a turn's 'done', so without re-subscribing only the first turn streams.
  const [streamEpoch, bumpStreamEpoch] = useReducer((n: number) => n + 1, 0)
  // The executionId the live subscription is following; lets us detect a new turn needing a reconnect.
  const streamedExecIdRef = useRef<string | null>(null)
  const previousLiveStatusRef = useRef<ExecutionStatus | null>(null)

  // Execution status and usage
  const [executionStatus, setExecutionStatus] = useState<ExecutionStatus | null>(null)
  const highestExecutionVersionRef = useRef(new Map<string, number>())
  const terminalExecutionStatusesRef = useRef(new Map<string, ExecutionStatus>())
  const announcedExecutionIdRef = useRef<string | null>(null)
  const executionStatusRef = useRef<ExecutionStatus | null>(null)
  // True while the server has signaled (via execution_phase:waiting_sandbox) that backend-reported
  // blocking sandbox setup/reconciliation outlasted its debounce — distinct from generic
  // queued/thinking. Cleared explicitly after successful batch completion by sandbox_ready, implicitly by any content event, and by
  // every transition of executionStatus away from running/stopping (below).
  const [waitingForSandbox, setWaitingForSandbox] = useState(false)
  const setExecutionStatusLocal = useCallback((status: ExecutionStatus | null) => {
    executionStatusRef.current = status
    // The sandbox-wait label only makes sense while the turn is actively busy (running/stopping);
    // any other transition — terminal or back to queued — means the ensure window (if any) is over.
    if (status !== 'running' && status !== 'stopping' && status !== 'waiting-sandbox') setWaitingForSandbox(false)
    setExecutionStatus(status)
  }, [])
  const [usage, setUsage] = useState<SessionUsage | null>(null)

  // Remember acceptance after retiring an optimistic row. Older servers expose the
  // runner-consumption pending flag even for first prompts; supply queued for those echoes.
  const [sendQueueStates, setSendQueueStates] = useState(new Map<string, boolean>())
  const rememberQueueState = useCallback((clientId: string, queued: boolean) => {
    setSendQueueStates((previous) => {
      if (previous.get(clientId) === queued) return previous
      return new Map(previous).set(clientId, queued)
    })
  }, [])

  // Track whether the create flow already seeded the store with events.
  // When resolvedAgentId is first set by the create flow, we skip the store.reset()
  // so that streaming items ingested via chat remain visible during handoff.
  const createdViaFlowRef = useRef(false)

  // Navigation hints append to a user turn only when the page changes. Never edit
  // the session's system prompt (which would invalidate its cached prefix).
  const sentPageContexts = useRef(new Map<string, { path: string; clientId: string }>())

  // True once the create-flow chat stream has resolved an agentId. After this point the agent
  // stream subscription (with its authoritative catchup replay) is the sole event source, so
  // create-flow chat callbacks must stop ingesting to prevent duplicate delivery.
  const createFlowHandedOffRef = useRef(false)

  // Dedup ref: prevents onDone/usage from firing twice for the same turn when both
  // the chat-create stream and the agent stream deliver a done event for the same turn.
  const firedDoneRef = useRef<Set<string>>(new Set())

  // Wall-clock of the last SSE activity (any stream event) or send. The execution-status backstop
  // only fires after this has been quiet for STREAM_QUIET_MS, so a lagging refetch can't clear a
  // live turn. Seeded non-zero is unnecessary; 0 reads as "long ago", which is fine pre-first-send.
  const lastStreamAtRef = useRef(0)
  const deferredReconnectRef = useRef(false)
  const deferredRefreshRef = useRef(false)
  // Monotonic liveness clock is independent of server/wall-clock timestamps.
  const activityAtRef = useRef(performance.now())
  const activitySequenceRef = useRef(0)
  const manualRequestedAtRef = useRef<number | null>(null)
  const [manualTick, requestManualDrain] = useReducer((n: number) => n + 1, 0)

  const isStreamLive = useCallback(() => {
    const status = executionStatusRef.current
    const busy = status === 'running' || status === 'queued' || status === 'waiting-sandbox' || status === 'stopping'
    const hasActiveGroup = storeRef
      .current!.snapshot()
      .some((group) => !group.done && !group.errored && !group.flushed && group.blocks.length > 0)
    const recentlyActive = lastStreamAtRef.current > 0 && Date.now() - lastStreamAtRef.current < STREAM_QUIET_MS
    return recentlyActive && (busy || hasActiveGroup)
  }, [])

  const invalidateConversationQueries = useCallback(() => {
    if (!resolvedAgentId) return
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents.messages(resolvedAgentId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(resolvedAgentId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents.activeExecution(resolvedAgentId) })
  }, [resolvedAgentId, queryClient])

  const [liveMessageState, dispatchLiveMessage] = useReducer(
    (
      state: { messages: Map<string, Message>; capEvictionEpoch: number },
      action: { type: 'upsert'; message: Message } | { type: 'retire'; messageIds: string[] } | { type: 'reset' }
    ) => {
      if (action.type === 'reset') return { messages: new Map(), capEvictionEpoch: 0 }
      const next = new Map(state.messages)
      let capEvictionEpoch = state.capEvictionEpoch
      if (action.type === 'upsert') {
        next.set(action.message.id, action.message)
        while (next.size > LIVE_MESSAGE_RECONCILE_LIMIT) {
          const oldestMessageId = next.keys().next().value
          if (oldestMessageId) next.delete(oldestMessageId)
          capEvictionEpoch += 1
        }
      } else {
        for (const messageId of action.messageIds) next.delete(messageId)
      }
      const unchanged =
        capEvictionEpoch === state.capEvictionEpoch &&
        next.size === state.messages.size &&
        [...next].every(([id, message]) => state.messages.get(id) === message)
      return unchanged ? state : { messages: next, capEvictionEpoch }
    },
    { messages: new Map<string, Message>(), capEvictionEpoch: 0 }
  )
  const liveMessages = liveMessageState.messages
  const [createdBarriers, dispatchCreatedBarrier] = useReducer(
    (
      state: Map<string, CreatedMessageBarrier>,
      action:
        | {
            type: 'set'
            messageId: string
            generation: number
            arrivedAt: number
            identity: ExactResponseIdentity | null
            preexistingGroupIds: ReadonlySet<string>
          }
        | { type: 'transfer'; messageId: string; generation: number; identity: ExactResponseIdentity | null }
        | { type: 'clear'; messageId: string; generation: number }
        | { type: 'reset' }
    ) => {
      if (action.type === 'reset') return new Map()
      const next = new Map(state)
      if (action.type === 'set') {
        next.set(action.messageId, {
          generation: action.generation,
          arrivedAt: action.arrivedAt,
          identity: action.identity,
          preexistingGroupIds: action.preexistingGroupIds,
        })
      } else if (action.type === 'transfer') {
        const barrier = next.get(action.messageId)
        if (barrier)
          next.set(action.messageId, {
            ...barrier,
            generation: action.generation,
            identity: action.identity,
          })
      } else if (next.get(action.messageId)?.generation === action.generation) {
        next.delete(action.messageId)
      }
      return next
    },
    new Map<string, CreatedMessageBarrier>()
  )
  const messageRequestGenerationsRef = useRef(new MessageRequestGenerations())
  // Starting a refresh is not completion evidence for its old cached rows.
  const terminalHistoryAfterRef = useRef(new Map<string, number>())
  const liveMessageCollectionGenerationsRef = useRef(new Map<string, number>())
  const capReconciliationRef = useRef<{
    agentId: string | undefined
    requestedEpoch: number
    reconciledEpoch: number
    running: boolean
  }>({ agentId: undefined, requestedEpoch: 0, reconciledEpoch: 0, running: false })

  useEffect(() => {
    dispatchLiveMessage({ type: 'reset' })
    dispatchCreatedBarrier({ type: 'reset' })
    messageRequestGenerationsRef.current.clear()
    liveMessageCollectionGenerationsRef.current.clear()
    if (!resolvedAgentId || !subscribeToAgentEvents) return
    let active = true
    const unsubscribe = subscribeToAgentEvents(resolvedAgentId, (entry) => {
      if (!active) return
      if (entry.event !== 'message.created' && entry.event !== 'message.updated') return
      const data = entry.data as Record<string, unknown> | null
      if (
        !data ||
        data.agentId !== resolvedAgentId ||
        typeof data.messageId !== 'string' ||
        data.messageId.length === 0
      )
        return
      const messageId = data.messageId
      const identity = exactResponseIdentity(data)
      const generation = messageRequestGenerationsRef.current.begin(messageId)
      if (entry.event === 'message.created') {
        // Groups already streaming when the event arrives were on screen first; a barrier only holds
        // back groups that begin afterwards (see barrierHidesGroup). Captured causally here because
        // the server persists the streaming group's own assistant rows with its exact identity.
        const preexistingGroupIds = new Set(storeRef.current!.snapshot().map((group) => group.streamGroupId))
        dispatchCreatedBarrier({
          type: 'set',
          messageId,
          generation,
          arrivedAt: Date.now(),
          identity,
          preexistingGroupIds,
        })
      } else {
        dispatchCreatedBarrier({ type: 'transfer', messageId, generation, identity })
      }
      const requestDeadline = setTimeout(
        () => messageRequestGenerationsRef.current.finish(messageId, generation),
        MESSAGE_RECONCILE_REQUEST_MS
      )
      void client.agents
        .getMessage(resolvedAgentId, messageId)
        .then((message) => {
          if (active && messageRequestGenerationsRef.current.isCurrent(messageId, generation)) {
            liveMessageCollectionGenerationsRef.current.set(messageId, collectionRequestGenerationRef.current)
            dispatchLiveMessage({ type: 'upsert', message })
          }
        })
        .catch(() => {
          if (active) invalidateConversationQueries()
        })
        .finally(() => {
          clearTimeout(requestDeadline)
          if (!active) return
          dispatchCreatedBarrier({ type: 'clear', messageId, generation })
          messageRequestGenerationsRef.current.finish(messageId, generation)
        })
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [resolvedAgentId, subscribeToAgentEvents, client, invalidateConversationQueries])

  useEffect(() => {
    const timers = [...createdBarriers]
      .filter(([, barrier]) => barrier.identity === null)
      .map(([messageId, barrier]) => {
        const remaining = Math.max(0, CREATED_MESSAGE_BARRIER_MS - (Date.now() - barrier.arrivedAt))
        return setTimeout(
          () => dispatchCreatedBarrier({ type: 'clear', messageId, generation: barrier.generation }),
          remaining
        )
      })
    return () => timers.forEach(clearTimeout)
  }, [createdBarriers])

  const flushDeferredReconnect = useCallback(() => {
    if (isStreamLive()) return
    const shouldRefresh = deferredRefreshRef.current
    const shouldReconnect = deferredReconnectRef.current || shouldRefresh
    deferredRefreshRef.current = false
    manualRequestedAtRef.current = null
    deferredReconnectRef.current = false
    if (shouldRefresh) invalidateConversationQueries()
    if (shouldReconnect) bumpStreamEpoch()
  }, [invalidateConversationQueries, isStreamLive])

  // Centralized done handler — fires onDone/usage at most once per turn (dedup by streamGroupId ?? messageId).
  const handleDone = useCallback((event: Extract<import('@ficus/shared').StreamEvent, { type: 'done' }>) => {
    const key = event.streamGroupId ?? event.messageId ?? ''
    if (key && firedDoneRef.current.has(key)) return
    if (key) firedDoneRef.current.add(key)
    if (event.usage) setUsage(event.usage)
    onDoneRef.current?.(event.response, event.metadata ?? null, event.messageId)
  }, [])

  const confirmTerminalHistory = useCallback(
    (executionId: string) => {
      if (terminalHistoryAfterRef.current.has(executionId)) return
      terminalHistoryAfterRef.current.set(executionId, collectionRequestGenerationRef.current)
      invalidateConversationQueries()
    },
    [invalidateConversationQueries]
  )

  // Keep executionStatus in sync with the live stream (both the agent stream and the create-flow
  // chat stream) so the activity indicator clears on turn end. Without this it would otherwise be
  // seeded once on mount and stick at 'running'.
  const applyExecStatus = useCallback(
    (event: import('@ficus/shared').StreamEvent) => {
      lastStreamAtRef.current = Date.now()
      activityAtRef.current = performance.now()
      activitySequenceRef.current = ++conversationActivitySequence
      if (event.type === 'agent') announcedExecutionIdRef.current = event.executionId ?? null
      const executionId = announcedExecutionIdRef.current
      // Runner done with saved row IDs is emitted after persistence (including
      // stop's aborted-tool update). A subsequent read can reconcile missed tool_end.
      if (
        event.type === 'done' &&
        executionId &&
        (event.messageId || event.messageIds?.length) &&
        storeRef
          .current!.snapshot()
          .some(
            (group) =>
              (group.executionId === executionId || group.streamGroupId === event.streamGroupId) &&
              group.blocks.some((block) => block.type === 'tool_use' && block._done === false)
          )
      )
        confirmTerminalHistory(executionId)
      const terminal = executionId ? terminalExecutionStatusesRef.current.get(executionId) : undefined
      if (event.type !== 'execution_snapshot' && terminal) {
        if (event.type === 'done' || event.type === 'error') streamedExecIdRef.current = null
        setExecutionStatusLocal(terminal)
        return
      }
      if (event.type === 'execution_snapshot') {
        const highest = highestExecutionVersionRef.current.get(event.executionId) ?? -1
        if (event.executionVersion < highest) return
        highestExecutionVersionRef.current.set(event.executionId, event.executionVersion)
        announcedExecutionIdRef.current = event.executionId
        if (['completed', 'failed', 'stopped'].includes(event.status)) {
          terminalExecutionStatusesRef.current.set(event.executionId, event.status)
          confirmTerminalHistory(event.executionId)
        } else {
          terminalExecutionStatusesRef.current.delete(event.executionId)
          terminalHistoryAfterRef.current.delete(event.executionId)
        }
        streamedExecIdRef.current = ['completed', 'failed', 'stopped'].includes(event.status) ? null : event.executionId
        setExecutionStatusLocal(event.status)
      } else if (event.type === 'done') {
        if (executionId) terminalExecutionStatusesRef.current.set(executionId, 'completed')
        streamedExecIdRef.current = null
        setExecutionStatusLocal('completed')
      } else if (event.type === 'error') {
        // The proxy uses the same event for connection failures as runner errors.
        // Keep an identified execution's status/pin until exact reconciliation;
        // neither English message text nor this event proves terminal failure.
        setStreamStatus('reconnecting')
        if (!executionId && !streamedExecIdRef.current) setExecutionStatusLocal('failed')
      } else if (event.type === 'agent' && event.executionStatus) {
        setStreamStatus('live')
        setExecutionStatusLocal(event.executionStatus)
      } else if (event.type === 'execution_phase') {
        if (event.phase === 'sandbox_recovery_wait') setExecutionStatusLocal('waiting-sandbox')
        if (event.phase === 'maintenance_queue') setExecutionStatusLocal('waiting-maintenance')
        setWaitingForSandbox(event.phase === 'waiting_sandbox' || event.phase === 'sandbox_recovery_wait')
      } else if (
        event.type !== 'system_message' &&
        event.type !== 'system_message_clear' &&
        event.type !== 'compaction_start' &&
        event.type !== 'compaction_end' &&
        event.type !== 'flush_agent'
      ) {
        // Any content event (agent/text/thinking/tool_*) means the turn is actively running — and,
        // if it arrived, the sandbox is definitely up, so the waiting label can't still apply.
        setStreamStatus('live')
        setExecutionStatusLocal('running')
        setWaitingForSandbox(false)
      }
    },
    [setExecutionStatusLocal, confirmTerminalHistory]
  )

  // Reset store state when the conversation identity changes (new agent) — NOT on a re-subscribe for
  // a follow-up turn, which must preserve the accumulated history. Skipped on the create-flow handoff
  // so streaming items ingested via chat survive the transition to the agent stream.
  useEffect(() => {
    storeIdentityRef.current = resolvedAgentId
    if (!createdViaFlowRef.current) {
      storeRef.current!.reset()
      firedDoneRef.current.clear()
      setSendQueueStates(new Map())
      dispatch({ type: 'reset' })
      streamedExecIdRef.current = null
      createFlowHandedOffRef.current = false
      createGenerationRef.current += 1
      highestExecutionVersionRef.current.clear()
      terminalHistoryAfterRef.current.clear()
      terminalExecutionStatusesRef.current.clear()
      announcedExecutionIdRef.current = null
      recoveryAttemptsRef.current.clear()
      previousLiveStatusRef.current = null
      lastStreamAtRef.current = 0
      deferredReconnectRef.current = false
      deferredRefreshRef.current = false
      manualRequestedAtRef.current = null
      activityAtRef.current = performance.now()
      activitySequenceRef.current = 0
      setExecutionStatusLocal(null)
      setUsage(null)
    }
    createdViaFlowRef.current = false
    if (!resolvedAgentId) return
    return () => {
      storeRef.current!.reset()
      firedDoneRef.current.clear()
      streamedExecIdRef.current = null
      createFlowHandedOffRef.current = false
    }
  }, [resolvedAgentId])

  // Subscribe to the agent stream. Re-runs on streamEpoch so a new execution (follow-up turn)
  // reconnects — the per-execution worker stream closes on 'done', so a single subscription would
  // only ever stream the first turn. Does NOT reset the store on teardown (that's the effect above).
  useEffect(() => {
    if (!resolvedAgentId) return
    const store = storeRef.current!
    if (streamedExecIdRef.current) announcedExecutionIdRef.current = streamedExecIdRef.current
    // Initial observers may share existing exact truth. Replacement of an
    // established scoped subscription needs a newer read, including cached reads.
    if (hasRecoveryScopeRef.current) recoveryAcceptanceFloorRef.current = nextRecoveryBoundary()
    const generation = ++subscriptionGenerationRef.current
    setSubscriptionGeneration(generation)
    const requestedIdentity = options.agentId
    let active = true
    const isCurrent = () =>
      active &&
      subscriptionGenerationRef.current === generation &&
      conversationIdentityRef.current.resolved === resolvedAgentId &&
      conversationIdentityRef.current.requested === requestedIdentity
    setStreamStatus('live')
    let reconciliationStarted = false
    const onTransportEnd = () => {
      if (!isCurrent()) return
      setStreamStatus('ended')
      const executionId = streamedExecIdRef.current
      const status = executionStatusRef.current
      // Parked executions deliberately close their transport; their resume query
      // already reconnects them. Terminal done/snapshots also need no recovery.
      if (!executionId || !['running', 'queued', 'stopping'].includes(status ?? '') || reconciliationStarted) return
      reconciliationStarted = true
      const attempts = recoveryAttemptsRef.current.get(executionId) ?? 0
      if (attempts >= 2) return
      recoveryAttemptsRef.current.set(executionId, attempts + 1)
      invalidateConversationQueries()
      void client.agents
        .getExecution(resolvedAgentId, executionId)
        .then((execution) => {
          if (
            !isCurrent() ||
            streamedExecIdRef.current !== executionId ||
            execution.executionId !== executionId ||
            execution.agentId !== resolvedAgentId
          )
            return
          const highest = highestExecutionVersionRef.current.get(executionId) ?? -1
          if (execution.executionVersion < highest) return
          highestExecutionVersionRef.current.set(executionId, execution.executionVersion)
          if (['completed', 'failed', 'stopped'].includes(execution.status)) {
            terminalExecutionStatusesRef.current.set(executionId, execution.status)
            confirmTerminalHistory(executionId)
          }
          setExecutionStatusLocal(execution.status)
          // Busy executions can replay missed events. Terminal exact streams only
          // send a status snapshot; their missing text/tools come from the durable
          // post-confirmation history refresh, not a final worker replay.
          bumpStreamEpoch()
        })
        .catch(() => {
          // Remain visibly interrupted. A failed request is not successful completion.
        })
    }

    const unsubscribe = client.agents.subscribeToAgentStream(
      resolvedAgentId,
      {
        onEvent: (event) => {
          if (!isCurrent()) return
          // Identified stream errors are transport-ambiguous. Do not mark the
          // live group terminal/retireable before exact execution truth arrives.
          if (event.type !== 'error' || !(streamedExecIdRef.current || announcedExecutionIdRef.current))
            store.ingest(event)
          if (event.type === 'agent' && event.executionId) streamedExecIdRef.current = event.executionId
          if (event.type === 'done') handleDone(event)
          applyExecStatus(event)
          if (event.type === 'done' || event.type === 'error') flushDeferredReconnect()
          bumpTick()
        },
        onCatchup: (events) => {
          if (!isCurrent()) return
          const identified = !!(
            streamedExecIdRef.current ||
            announcedExecutionIdRef.current ||
            events.some((event) => event.type === 'execution_snapshot' || (event.type === 'agent' && event.executionId))
          )
          store.applyCatchup(identified ? events.filter((event) => event.type !== 'error') : events)
          // Catchup replays the turn's events as one batch (on subscribe and every reconnect). It must
          // drive executionStatus exactly like live events — otherwise a turn whose 'done' lands in a
          // catchup batch never terminalizes and the activity indicator sticks at running.
          for (const event of events) {
            if (event.type === 'agent' && event.executionId) streamedExecIdRef.current = event.executionId
            if (event.type === 'done') handleDone(event)
            applyExecStatus(event)
          }
          if (events.some((event) => event.type === 'done' || event.type === 'error')) flushDeferredReconnect()
          bumpTick()
        },
        onDisconnect: () => {
          if (isCurrent()) setStreamStatus('reconnecting')
        },
        onReconnect: () => {
          if (isCurrent()) setStreamStatus('live')
        },
        onError: onTransportEnd,
        onDone: onTransportEnd,
      },
      streamedExecIdRef.current ?? undefined
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [
    resolvedAgentId,
    options.agentId,
    streamEpoch,
    confirmTerminalHistory,
    client,
    handleDone,
    applyExecStatus,
    flushDeferredReconnect,
    invalidateConversationQueries,
    setExecutionStatusLocal,
  ])

  // Reconnect the SSE stream when the app/window regains focus. While backgrounded the
  // OS may pause the fetch without closing it, so events that landed during that
  // window (including the terminal 'done') are never delivered. Re-subscribing forces
  // a fresh connection whose server-side catchup replay reconciles any gap.
  const wasFocusedRef = useRef(true)
  useEffect(() => {
    if (!resolvedAgentId) return
    return focusManager.subscribe((isFocused) => {
      const focused = !!isFocused
      if (!wasFocusedRef.current && focused) {
        // A backgrounded fetch can look recently active while its transport is
        // frozen. Always replace it and refetch durable history/status. This also
        // satisfies any earlier manual intent rather than scheduling a second refresh.
        deferredRefreshRef.current = false
        manualRequestedAtRef.current = null
        deferredReconnectRef.current = false
        bumpStreamEpoch()
        coalesceForegroundRefresh(queryClient, resolvedAgentId, invalidateConversationQueries)
      }
      wasFocusedRef.current = focused
    })
  }, [resolvedAgentId, queryClient, invalidateConversationQueries])

  // 2. Persisted history → memoized groupPersisted.
  const messagesQuery = useInfiniteQuery({
    queryKey: queryKeys.agents.messagesInfinite(resolvedAgentId ?? '__none__'),
    enabled: !!resolvedAgentId,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const generation = ++collectionRequestGenerationRef.current
      const page = await client.agents.getMessages(resolvedAgentId!, { cursor: pageParam, limit: 50 })
      return { ...page, __collectionRequestGeneration: generation, __collectionRequestOwner: collectionRequestOwner }
    },
    getNextPageParam: (last) => (last.pagination.hasMore ? last.pagination.nextCursor : undefined),
    refetchOnWindowFocus: () => !isStreamLive(),
  })

  const queriedMessages = useMemo(
    () => (messagesQuery.data?.pages ?? []).flatMap((page) => page.messages),
    [messagesQuery.data]
  )
  useEffect(() => {
    // Message has no updatedAt/version discriminator. A collection row may replace a live row only
    // when its request started after that live result; an older in-flight snapshot is not authoritative.
    const authoritativeIds = (messagesQuery.data?.pages ?? []).flatMap((page) => {
      const collectionGeneration = page.__collectionRequestGeneration
      return page.messages.flatMap((message) => {
        const liveGeneration = liveMessageCollectionGenerationsRef.current.get(message.id)
        return liveGeneration !== undefined && collectionGeneration > liveGeneration ? [message.id] : []
      })
    })
    if (authoritativeIds.length > 0) {
      for (const messageId of authoritativeIds) liveMessageCollectionGenerationsRef.current.delete(messageId)
      dispatchLiveMessage({ type: 'retire', messageIds: authoritativeIds })
    }
  }, [messagesQuery.data])
  useEffect(() => {
    for (const messageId of liveMessageCollectionGenerationsRef.current.keys()) {
      if (!liveMessages.has(messageId)) liveMessageCollectionGenerationsRef.current.delete(messageId)
    }
  }, [liveMessages])

  useEffect(() => {
    const reconciliation = capReconciliationRef.current
    if (reconciliation.agentId !== resolvedAgentId) {
      reconciliation.agentId = resolvedAgentId
      reconciliation.requestedEpoch = 0
      reconciliation.reconciledEpoch = 0
      reconciliation.running = false
    }
    reconciliation.requestedEpoch = liveMessageState.capEvictionEpoch
    if (!resolvedAgentId || reconciliation.requestedEpoch === 0 || reconciliation.running) return

    reconciliation.running = true
    const agentId = resolvedAgentId
    const drain = async () => {
      try {
        while (reconciliation.agentId === agentId && reconciliation.reconciledEpoch < reconciliation.requestedEpoch) {
          const targetEpoch = reconciliation.requestedEpoch
          await queryClient.invalidateQueries({ queryKey: queryKeys.agents.messagesInfinite(agentId) })
          if (reconciliation.agentId === agentId) reconciliation.reconciledEpoch = targetEpoch
        }
      } finally {
        if (reconciliation.agentId === agentId) reconciliation.running = false
      }
    }
    void drain()
  }, [liveMessageState.capEvictionEpoch, queryClient, resolvedAgentId])

  const persistedMessages = useMemo(() => {
    const byId = new Map(queriedMessages.map((message) => [message.id, message]))
    for (const message of liveMessages.values()) byId.set(message.id, message)
    return [...byId.values()].map((message) => {
      const queued = message.metadata?.clientId ? sendQueueStates.get(message.metadata.clientId) : undefined
      return queued !== undefined && message.queued === undefined
        ? { ...message, queued: message.pending && queued }
        : message
    })
  }, [queriedMessages, liveMessages, sendQueueStates])
  const history = useMemo(() => groupPersisted(persistedMessages), [persistedMessages])
  const persistedPagePath = useMemo(
    () =>
      [...persistedMessages]
        .filter((message) => message.role === 'human' && message.metadata?.pagePath)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]?.metadata?.pagePath,
    [persistedMessages]
  )

  // 2b. Server-truth execution status. Keyed under agents.all, so both apps' WS invalidators refetch
  // it on execution.* events — a live feed without coupling this hook to any websocket. Used to seed
  // the initial status and to terminalize a stuck-running state (a dropped SSE 'done'); the live
  // signal trails the SSE, so it never *drives* the indicator, only backs it up.
  const activeExecutionQuery = useQuery({
    queryKey: queryKeys.agents.activeExecution(resolvedAgentId ?? '__none__'),
    enabled: !!resolvedAgentId,
    queryFn: () => client.agents.getActiveExecution(resolvedAgentId!),
  })
  // `serverActive`: true/false once the query resolves, null while it hasn't. The endpoint only ever
  // reports a *busy* execution (queued/running/stopping); once the turn ends there is no active
  // execution, so it returns { active: false } with NO status. Treat that active:false as the idle
  // signal — keying the backstop on a terminal *status* would be dead code (the server never sends one).
  const serverActive = activeExecutionQuery.data?.active ?? null
  const liveStatus = activeExecutionQuery.data?.status ?? null
  const liveExecutionId = activeExecutionQuery.data?.active ? (activeExecutionQuery.data.executionId ?? null) : null

  // A new execution is active that the current subscription isn't following → reconnect so this turn
  // streams live (the prior turn's per-execution stream already closed on its 'done'). activeExecution
  // is refetched on execution.* WS events, so this fires for user sends, inbox, and autonomous turns.
  useEffect(() => {
    const previousStatus = previousLiveStatusRef.current
    if (liveExecutionId && liveExecutionId !== streamedExecIdRef.current) {
      streamedExecIdRef.current = liveExecutionId
      bumpStreamEpoch()
    } else if (
      liveExecutionId &&
      (previousStatus === 'waiting-sandbox' || previousStatus === 'waiting-maintenance') &&
      (liveStatus === 'queued' || liveStatus === 'running')
    ) {
      bumpStreamEpoch()
    }
    previousLiveStatusRef.current = liveStatus
  }, [liveExecutionId, liveStatus])

  useEffect(() => {
    if (serverActive === null) return // active-execution query hasn't resolved yet
    // Initial seed: no stream-driven status yet → trust the server (covers opening a chat whose
    // agent is already running). When idle (active:false) there's nothing to seed.
    if (executionStatus == null) {
      if (serverActive && liveStatus) setExecutionStatusLocal(liveStatus)
      return
    }
    if (
      serverActive &&
      liveStatus &&
      liveStatus !== executionStatus &&
      (liveStatus === 'waiting-sandbox' ||
        executionStatus === 'waiting-sandbox' ||
        liveStatus === 'waiting-maintenance' ||
        executionStatus === 'waiting-maintenance')
    ) {
      setExecutionStatusLocal(liveStatus)
      return
    }
    // Terminal backstop: the server says the turn is no longer running — a terminal status, OR (the
    // common idle case) no active execution at all — but our stream-driven status is stuck busy,
    // e.g. the SSE 'done' was missed across a reconnect (catchup doesn't re-drive executionStatus).
    // Only act once the SSE has been quiet for STREAM_QUIET_MS, so a lagging refetch can't clear a
    // turn that's actually mid-flight or was just sent.
    const serverDone =
      !serverActive || liveStatus === 'completed' || liveStatus === 'failed' || liveStatus === 'stopped'
    const localBusy =
      executionStatus === 'running' ||
      executionStatus === 'queued' ||
      executionStatus === 'waiting-sandbox' ||
      executionStatus === 'waiting-maintenance' ||
      executionStatus === 'stopping'
    if (serverDone && localBusy) {
      let active = true
      const generation = subscriptionGenerationRef.current
      const timer = setTimeout(() => {
        if (Date.now() - lastStreamAtRef.current < STREAM_QUIET_MS) return
        const executionId = streamedExecIdRef.current
        if (!executionId || !resolvedAgentId) {
          // Legacy streams have no exact identity to query.
          setExecutionStatusLocal(liveStatus ?? 'completed')
          invalidateConversationQueries()
          return
        }
        void client.agents
          .getExecution(resolvedAgentId, executionId)
          .then((execution) => {
            if (
              !active ||
              subscriptionGenerationRef.current !== generation ||
              streamedExecIdRef.current !== executionId ||
              execution.executionId !== executionId ||
              execution.agentId !== resolvedAgentId
            )
              return
            const highest = highestExecutionVersionRef.current.get(executionId) ?? -1
            if (execution.executionVersion < highest) return
            highestExecutionVersionRef.current.set(executionId, execution.executionVersion)
            if (['completed', 'failed', 'stopped'].includes(execution.status))
              terminalExecutionStatusesRef.current.set(executionId, execution.status)
            setExecutionStatusLocal(execution.status)
            if (['completed', 'failed', 'stopped'].includes(execution.status)) {
              confirmTerminalHistory(executionId)
              bumpStreamEpoch()
            }
          })
          .catch(() => {
            /* Failed reconciliation is not evidence of completion. */
          })
      }, STREAM_QUIET_MS)
      return () => {
        active = false
        clearTimeout(timer)
      }
    }
  }, [
    serverActive,
    liveStatus,
    executionStatus,
    streamTick,
    subscriptionGeneration,
    confirmTerminalHistory,
    resolvedAgentId,
    client,
    invalidateConversationQueries,
    setExecutionStatusLocal,
  ])

  // A silent *open* connection cannot rely on EOF, focus or a cached busy query.
  // Exact reads never replace the stream or erase local content. Three shared probes
  // per mounted execution: 15s quiet, then >=30s and >=60s backoff. Activity delays
  // a probe but does not refill its budget (including replay on resubscription).
  type RecoveryResult = {
    execution: Awaited<ReturnType<typeof client.agents.getExecution>>
    historyAfter: number
    activityThrough: number
  }
  const recoveryLeaseRef = useRef<ReturnType<typeof acquireSilentRecovery<RecoveryResult>> | null>(null)
  const observedRecoveryRef = useRef<RecoveryAttempt<RecoveryResult> | undefined>(undefined)
  const recoveryExecutionId = streamedExecIdRef.current ?? announcedExecutionIdRef.current
  useEffect(() => {
    if (!resolvedAgentId || !recoveryExecutionId) return
    const lease = acquireSilentRecovery<RecoveryResult>(
      queryClient,
      JSON.stringify([resolvedAgentId, recoveryExecutionId])
    )
    recoveryLeaseRef.current = lease
    hasRecoveryScopeRef.current = true
    recoveryAcceptanceFloorRef.current = 0
    observedRecoveryRef.current = undefined
    return () => {
      recoveryLeaseRef.current = null
      hasRecoveryScopeRef.current = false
      lease.release()
    }
  }, [queryClient, resolvedAgentId, recoveryExecutionId])

  useEffect(() => onlineManager.subscribe(() => requestManualDrain()), [])
  useEffect(() => {
    if (!resolvedAgentId || !onlineManager.isOnline()) return
    let active = true
    const generation = subscriptionGenerationRef.current
    const identity = conversationIdentityRef.current
    const executionId = recoveryExecutionId
    const activity = activityAtRef.current
    const recovery = recoveryLeaseRef.current?.recovery
    const cached = recovery?.peek()
    const eligibleCached = cached !== undefined && cached.boundary >= recoveryAcceptanceFloorRef.current
    const unseen = eligibleCached && cached !== observedRecoveryRef.current
    const manual = deferredRefreshRef.current
    const busy = ['running', 'queued', 'stopping'].includes(executionStatus ?? '')
    const now = performance.now()
    const delay = manual
      ? Math.max(
          cached && !eligibleCached ? recovery!.readDelay(now) : 0,
          Math.min(activity + STREAM_QUIET_MS, (manualRequestedAtRef.current ?? now) + 30_000) - now
        )
      : busy && streamStatus === 'live' && recovery
        ? unseen
          ? 0
          : recovery.delay(now, activity)
        : undefined
    if (delay === undefined) return
    const isCurrent = () =>
      active &&
      subscriptionGenerationRef.current === generation &&
      conversationIdentityRef.current.requested === identity.requested &&
      conversationIdentityRef.current.resolved === identity.resolved &&
      (streamedExecIdRef.current ?? announcedExecutionIdRef.current) === executionId
    const timer = setTimeout(() => {
      if (!isCurrent() || !onlineManager.isOnline()) return
      const explicit = deferredRefreshRef.current
      // Another view (or an event before React's next commit) may have renewed
      // the shared quiet deadline since this timer was armed.
      if (!explicit && !unseen && recovery && !recovery.hasRecentRead(performance.now())) {
        const remaining = recovery.delay(performance.now(), activityAtRef.current)
        if (remaining === undefined) return
        if (remaining > 0) {
          requestManualDrain()
          return
        }
      }
      const settleManual = () => {
        if (explicit) {
          deferredRefreshRef.current = false
          manualRequestedAtRef.current = null
        }
      }
      // A legacy stream can still honor explicit refresh without inventing exact identity.
      if (!executionId || !recovery) {
        settleManual()
        if (explicit) {
          invalidateConversationQueries()
          if (performance.now() - activityAtRef.current >= STREAM_QUIET_MS) bumpStreamEpoch()
        }
        return
      }
      const read =
        !explicit && unseen
          ? Promise.resolve(cached)
          : recovery.read(
              performance.now(),
              explicit,
              async (signal) => {
                const activityThrough = conversationActivitySequence
                const execution = await client.agents.getExecution(resolvedAgentId, executionId, signal)
                return {
                  execution,
                  activityThrough,
                  historyAfter: collectionRequestGenerationRef.current,
                }
              },
              invalidateConversationQueries
            )
      void read.then((attempt) => {
        if (!isCurrent()) return
        observedRecoveryRef.current = attempt
        if (attempt && attempt.boundary < recoveryAcceptanceFloorRef.current) {
          // Keep explicit intent pending until a post-replacement read is eligible.
          requestManualDrain()
          return
        }
        const result = attempt?.value
        settleManual()
        if (result && activityAtRef.current === activity && activitySequenceRef.current <= result.activityThrough) {
          const { execution, historyAfter } = result
          const highest = highestExecutionVersionRef.current.get(executionId) ?? -1
          if (
            execution.agentId === resolvedAgentId &&
            execution.executionId === executionId &&
            execution.executionVersion >= highest
          ) {
            highestExecutionVersionRef.current.set(executionId, execution.executionVersion)
            if (['completed', 'failed', 'stopped'].includes(execution.status)) {
              terminalExecutionStatusesRef.current.set(executionId, execution.status)
              setStreamStatus('ended')
              if (!terminalHistoryAfterRef.current.has(executionId))
                terminalHistoryAfterRef.current.set(executionId, historyAfter)
            }
            setExecutionStatusLocal(execution.status)
          }
        }
        // Even a failed exact read is not permission to drop content/clear busy.
        // Manual refresh still attempts history; automatic failures spend one probe.
        if (result || explicit) attempt?.refresh()
        if (explicit && performance.now() - activityAtRef.current >= STREAM_QUIET_MS) bumpStreamEpoch()
        requestManualDrain() // schedule the next bounded deadline, not an interval
      })
    }, delay)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [
    resolvedAgentId,
    recoveryExecutionId,
    subscriptionGeneration,
    streamTick,
    executionStatus,
    streamStatus,
    manualTick,
    client,
    invalidateConversationQueries,
    setExecutionStatusLocal,
  ])

  // 3. Pending store. An echo acknowledges an optimistic row permanently; merely
  // hiding it in combine() would resurrect it when Clear queue deletes the saved row.
  const [pending, dispatch] = useReducer(pendingReducer, [] as PendingItem[])
  useEffect(() => {
    const echoed = new Set(
      persistedMessages.flatMap((message) => (message.metadata?.clientId ? [message.metadata.clientId] : []))
    )
    const retired = pending.filter((item) => echoed.has(item.clientId)).map((item) => item.clientId)
    if (retired.length) dispatch({ type: 'remove', clientIds: retired })
  }, [persistedMessages, pending])

  const fireSend = useCallback(
    async (item: PendingItem): Promise<void> => {
      if (!resolvedAgentId) throw new Error('Agent is not resolved')
      const result = await client.agents.sendMessage(resolvedAgentId, item.content, {
        pagePath: item.pagePath,
        imageIds: item.imageIds,
        deliveryMode: item.deliveryMode,
        clientId: item.clientId,
      })
      if (result?.success) {
        const queued = result.queued ?? (result.status === 'running' || item.queued === true)
        rememberQueueState(item.clientId, queued)
        dispatch({ type: 'status', clientId: item.clientId, status: queued ? 'queued' : 'sending', queued })
      }
    },
    [resolvedAgentId, client, rememberQueueState]
  )

  const fireCreate = useCallback(
    (item: PendingItem): Promise<void> => {
      createFlowHandedOffRef.current = false
      const generation = ++createGenerationRef.current
      const requestedIdentity = options.agentId
      const isCurrent = () =>
        createGenerationRef.current === generation &&
        conversationIdentityRef.current.requested === requestedIdentity &&
        !createFlowHandedOffRef.current
      return client.chat.sendChatMessage(
        {
          message: item.content,
          scope: options.scope,
          pagePath: item.pagePath,
          imageIds: item.imageIds,
          deliveryMode: item.deliveryMode,
          clientId: item.clientId,
        },
        {
          onEvent: (event) => {
            if (!isCurrent()) return
            // The agent event resolves the agentId and triggers the agent-stream subscription.
            // From this point the agent stream is authoritative (its catchup replays the entire
            // turn), so the chat stream must stop ingesting to avoid double delivery.
            if (event.type === 'agent') {
              createdViaFlowRef.current = true
              createFlowHandedOffRef.current = true
              const context = sentPageContexts.current.get('__new__')
              if (context) sentPageContexts.current.set(event.agentId, context)
              setResolvedAgentId(event.agentId)
              return
            }
            storeRef.current!.ingest(event)
            if (event.type === 'done') handleDone(event)
            applyExecStatus(event)
            if (event.type === 'done' || event.type === 'error') flushDeferredReconnect()
            bumpTick()
          },
          onCatchup: (events) => {
            if (!isCurrent()) return
            storeRef.current!.applyCatchup(events)
            // Drive executionStatus from the replayed batch too (see agent-stream onCatchup).
            for (const event of events) {
              if (event.type === 'done') handleDone(event)
              applyExecStatus(event)
            }
            if (events.some((event) => event.type === 'done' || event.type === 'error')) flushDeferredReconnect()
            bumpTick()
          },
          onDone: () => {
            if (isCurrent()) setStreamStatus('ended')
          },
          onError: () => {
            if (!isCurrent()) return
            if (sentPageContexts.current.get('__new__')?.clientId === item.clientId)
              sentPageContexts.current.delete('__new__')
            dispatch({ type: 'status', clientId: item.clientId, status: 'failed' })
            setExecutionStatusLocal('failed')
          },
        }
      )
    },
    [
      client,
      options.scope,
      options.agentId,
      handleDone,
      applyExecStatus,
      flushDeferredReconnect,
      setExecutionStatusLocal,
    ]
  )

  const beginSend = useCallback(
    (item: PendingItem): Promise<void> => {
      const key = resolvedAgentId ?? '__new__'
      if (item.pagePath) sentPageContexts.current.set(key, { path: item.pagePath, clientId: item.clientId })
      const request = item.origin === 'create' || (!item.origin && !resolvedAgentId) ? fireCreate(item) : fireSend(item)
      return request.catch((error) => {
        if (sentPageContexts.current.get(key)?.clientId === item.clientId) sentPageContexts.current.delete(key)
        throw error
      })
    },
    [resolvedAgentId, fireSend, fireCreate]
  )

  const optimisticItem = useCallback(
    (content: string, opts?: SendOpts & { clientId?: string }): PendingItem => {
      const clientId = opts?.clientId ?? nextClientId()
      const status = executionStatusRef.current
      const queued =
        !!resolvedAgentId &&
        (status === 'running' ||
          status === 'queued' ||
          status === 'waiting-sandbox' ||
          status === 'waiting-maintenance' ||
          status === 'stopping')
      rememberQueueState(clientId, queued)
      return {
        clientId,
        content,
        pagePath:
          (sentPageContexts.current.get(resolvedAgentId ?? '__new__')?.path ?? persistedPagePath) === options.pagePath
            ? undefined
            : options.pagePath,
        imageIds: opts?.imageIds,
        deliveryMode: opts?.deliveryMode ?? 'steer',
        queued,
        origin: resolvedAgentId ? 'agent' : 'create',
        status: 'sending',
        createdAt: Date.now(),
      }
    },
    [resolvedAgentId, rememberQueueState, options.pagePath, persistedPagePath]
  )

  const markSendFailed = useCallback(
    (item: PendingItem) => {
      // A submission error says nothing about the execution already processing other work.
      if (item.queued === true) return
      if (storeRef.current!.snapshot().some((group) => !group.done && !group.errored && !group.flushed)) return
      setExecutionStatusLocal('failed')
    },
    [setExecutionStatusLocal]
  )

  const markOptimisticallyRunning = useCallback(() => {
    lastStreamAtRef.current = Date.now()
    activityAtRef.current = performance.now()
    activitySequenceRef.current = ++conversationActivitySequence
    setExecutionStatusLocal('running')
  }, [setExecutionStatusLocal])

  const send = useCallback(
    (content: string, opts?: SendOpts): string => {
      const item = optimisticItem(content, opts)
      dispatch({ type: 'add', item })
      markOptimisticallyRunning()
      void beginSend(item).catch(() => {
        dispatch({ type: 'status', clientId: item.clientId, status: 'failed' })
        markSendFailed(item)
      })
      return item.clientId
    },
    [optimisticItem, markOptimisticallyRunning, beginSend, markSendFailed]
  )

  const sendAccepted = useCallback(
    (content: string, opts?: SendOpts & { clientId?: string }): SendAcceptanceHandle => {
      const item = optimisticItem(content, opts)
      dispatch({ type: 'add', item })
      markOptimisticallyRunning()
      const accepted = beginSend(item).catch((error) => {
        // The composer still owns this pre-acceptance attempt and will retain its
        // local assets for retry, so remove the hook's duplicate optimistic row.
        dispatch({ type: 'remove', clientIds: [item.clientId] })
        markSendFailed(item)
        throw error
      })
      return { clientId: item.clientId, accepted }
    },
    [optimisticItem, markOptimisticallyRunning, beginSend, markSendFailed]
  )

  const retrySend = useCallback(
    (clientId: string) => {
      const item = pending.find((p) => p.clientId === clientId)
      if (!item) return
      const retryItem = { ...item, status: 'sending' as const }
      dispatch({ type: 'status', clientId, status: 'sending' })
      markOptimisticallyRunning()
      void beginSend(retryItem).catch(() => {
        dispatch({ type: 'status', clientId, status: 'failed' })
        markSendFailed(item)
      })
    },
    [pending, beginSend, markOptimisticallyRunning, markSendFailed]
  )

  // clientIds the clear-queue control should remove: genuinely queued interrupts/follow-ups (combine's
  // `queued` flag — NOT the lone send that started the turn) plus any failed sends. Kept on a ref so
  // the stable cancelAllPending callback reads the latest set without re-creating on every render.
  const clearableRef = useRef<string[]>([])

  const cancelAllPending = useCallback(async () => {
    const clearedIds = [...clearableRef.current]
    if (!resolvedAgentId) {
      sentPageContexts.current.delete('__new__')
      dispatch({ type: 'remove', clientIds: clearedIds })
      return
    }
    try {
      await client.agents.clearQueue(resolvedAgentId)
      sentPageContexts.current.delete(resolvedAgentId)
      dispatch({ type: 'remove', clientIds: clearedIds })
      // Point-read overlays outlive collection refreshes. Retire confirmed deletions
      // too, so a message.created fetch cannot leave a cleared row stuck on screen.
      dispatchLiveMessage({ type: 'retire', messageIds: clearedIds })
      for (const id of clearedIds) {
        liveMessageCollectionGenerationsRef.current.delete(id)
        messageRequestGenerationsRef.current.invalidate(id)
      }
    } catch {
      // Keep local queue entries until the server confirms the clear.
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.agents.messages(resolvedAgentId) })
  }, [resolvedAgentId, client, queryClient])

  // Manual refresh: invalidate the conversation's persisted data and force a fresh SSE
  // connection (catchup reconciles any missed events). During an active stream, defer
  // until quiet (or a bounded 30s read-only deadline); no stream buffer is reset.
  const refresh = useCallback(() => {
    if (!resolvedAgentId) return
    // Exact terminal recovery retains the execution pin for subscription/coverage
    // authority. That pin alone must not defer an idle caller's history request:
    // refresh() returns void, so callers observe their request before it returns.
    const executionId = streamedExecIdRef.current
    const terminal = executionId ? terminalExecutionStatusesRef.current.get(executionId) : undefined
    const settled = terminal !== undefined && terminal === executionStatusRef.current
    if (isStreamLive() || (executionId && !settled)) {
      deferredRefreshRef.current = true
      manualRequestedAtRef.current ??= performance.now()
      requestManualDrain()
      return
    }
    invalidateConversationQueries()
    // Exact terminal truth needs history, not a replacement of its retained SSE.
    if (!settled) bumpStreamEpoch()
  }, [resolvedAgentId, invalidateConversationQueries, isStreamLive])

  const stop = useCallback(() => {
    if (resolvedAgentId) void client.agents.stopAgent(resolvedAgentId).catch(() => {})
  }, [resolvedAgentId, client])

  const abortTool = useCallback(() => {
    if (resolvedAgentId) void client.agents.abortTool(resolvedAgentId).catch(() => {})
  }, [resolvedAgentId, client])

  // 4. Combine → items (memoized on inputs).
  // Identity changes render before their teardown effect. Never expose the old
  // store/status under the new identity during that intermediate render.
  const identityReady = storeIdentityRef.current === resolvedAgentId || createdViaFlowRef.current
  const groups = identityReady ? store.snapshot() : []
  const groupById = new Map(groups.map((group) => [group.streamGroupId, group]))
  const freshRows = new Map(
    (messagesQuery.data?.pages ?? [])
      .filter((page) => page.__collectionRequestOwner === collectionRequestOwner)
      .flatMap((page) =>
        page.messages
          .filter((message) => !liveMessages.has(message.id))
          .map((message) => [message.id, page.__collectionRequestGeneration] as const)
      )
  )
  const authoritativeCompletedGroupIds = new Set(
    history.flatMap((turn) => {
      if (!turn.streamGroupId) return []
      const group = groupById.get(turn.streamGroupId)
      const executionId = group?.executionId ?? turn.message.metadata?.executionId
      const after = executionId ? terminalHistoryAfterRef.current.get(executionId) : undefined
      return after !== undefined &&
        turn.mergedFrom.every(
          (row) =>
            (!row.metadata?.executionId || row.metadata.executionId === executionId) &&
            (freshRows.get(row.id) ?? -1) > after
        )
        ? [turn.streamGroupId]
        : []
    })
  )
  const session: CombineSession = useMemo(
    () => ({
      agentId: resolvedAgentId ?? '',
      streamStatus,
      executionStatus,
      waitingForSandbox,
      authoritativeCompletedGroupIds,
    }),
    [resolvedAgentId, streamStatus, executionStatus, waitingForSandbox, authoritativeCompletedGroupIds]
  )
  const visibleGroups = useMemo(
    () =>
      groups.filter(
        (group) => ![...createdBarriers.values()].some((barrier) => barrierHidesGroup(barrier, group, groups))
      ),
    [groups, createdBarriers]
  )
  const items = useMemo(
    () => (identityReady ? combine(history, visibleGroups, pending, session, store.systemMessages()) : []),
    [identityReady, history, visibleGroups, pending, session]
  )

  // Single source of truth for the clear-queue control: only genuinely queued interrupts/follow-ups
  // count (a lone send that started the turn is region A and must not be clearable — clearing it
  // would race the run it just triggered). Both apps gate the control on queuedCount.
  const queuedPendingIds = useMemo(
    () => items.flatMap((i) => (i.kind === 'pending' && i.queued ? [i.id] : [])),
    [items]
  )
  const queuedCount = queuedPendingIds.length
  clearableRef.current = [...queuedPendingIds, ...pending.filter((p) => p.status === 'failed').map((p) => p.clientId)]

  // 5. Cleanup: clear stream groups whose persisted turn is fully present (spec §8).
  useEffect(() => {
    const done = completedGroupIds(history, groups, session)
    if (done.length > 0) {
      for (const id of done) store.clear(id)
      bumpTick()
    }
  }, [history, session])

  return {
    items,
    streamStatus,
    agentId: resolvedAgentId,
    executionStatus: identityReady ? executionStatus : null,
    waitingForSandbox: identityReady && waitingForSandbox,
    queuedCount,
    usage: identityReady ? usage : null,
    compactionState: identityReady ? store.compactionState() : null,
    isLoading: messagesQuery.isLoading,
    hasOlder: messagesQuery.hasNextPage ?? false,
    isFetchingOlder: messagesQuery.isFetchingNextPage,
    fetchOlder: () => void messagesQuery.fetchNextPage(),
    send,
    sendAccepted,
    retrySend,
    cancelAllPending,
    refresh,
    stop,
    abortTool,
  }
}
