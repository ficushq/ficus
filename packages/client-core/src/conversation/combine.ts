import type { ContentBlock, DeliveryMode, Message } from '@ficus/shared'
import { compareByKey, messageSortAt, ms } from './ordering'
import type {
  CombineSession,
  PendingItem,
  PersistedTurn,
  RenderItem,
  StreamGroupSnapshot,
  StreamingItemStatus,
  SystemMessageItem,
} from './types'

/** Stable ascending sort of messages by createdAt then id (no mutation of input). */
function sortedByCreatedAt(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => compareByKey(ms(a.createdAt), a.id, ms(b.createdAt), b.id))
}

function normalizeSystemText(text: string): string {
  return text.replace(/^\[System\]\s*/, '').trim()
}

function isPersistedSystemMessage(message: Message): boolean {
  return message.role === 'assistant' && message.content.startsWith('[System]')
}

/**
 * Merge persisted rows into logical turns. Assistant rows sharing a
 * metadata.streamGroupId become one turn (blocks concatenated in createdAt
 * order); every other row is its own turn. Grouping is by id, never adjacency,
 * so interposed system/steer/inbox rows cannot split a turn.
 */
export function groupPersisted(messages: Message[]): PersistedTurn[] {
  const ordered = sortedByCreatedAt(messages)
  const turnsBySgId = new Map<string, PersistedTurn>()
  const turns: PersistedTurn[] = []

  for (const message of ordered) {
    const sgId = message.role === 'assistant' ? message.metadata?.streamGroupId : undefined

    if (sgId) {
      const existing = turnsBySgId.get(sgId)
      const blocks = message.metadata?.content ?? []
      if (existing) {
        existing.mergedFrom.push(message)
        existing.blocks = [...existing.blocks, ...blocks]
        // sortAt is min(createdAt) of the turn; ordered iteration keeps the first.
      } else {
        const turn: PersistedTurn = {
          id: message.id,
          message,
          mergedFrom: [message],
          blocks: [...blocks],
          streamGroupId: sgId,
          sortAt: messageSortAt(message),
        }
        turnsBySgId.set(sgId, turn)
        turns.push(turn)
      }
      continue
    }

    turns.push({
      id: message.id,
      message,
      mergedFrom: [message],
      blocks: message.metadata?.content ?? [],
      sortAt: messageSortAt(message),
    })
  }

  return turns.sort((a, b) => compareByKey(a.sortAt, a.id, b.sortAt, b.id))
}

/** Does a committed block cover this streamed content (including missed final text deltas)? */
function blockContentMatches(
  streamed: StreamGroupSnapshot['blocks'][number],
  persisted: ContentBlock,
  authoritativeCompletion: boolean
): boolean {
  if (streamed.type !== persisted.type) return false
  switch (streamed.type) {
    case 'thinking':
    case 'text':
      return persisted.type === streamed.type && persisted.content.startsWith(streamed.content)
    case 'tool_use':
      return (
        persisted.type === 'tool_use' &&
        persisted.toolCall.toolCallId === streamed.toolCall.toolCallId &&
        persisted.toolCall.toolName === streamed.toolCall.toolName &&
        // Matching identity/args alone also describes the pre-tool saved row.
        // A differing provisional result needs a read begun after exact terminal
        // confirmation. Finalized tools (and legacy blocks) always require equality.
        (streamed._done === false
          ? persisted.toolCall.args.startsWith(streamed.toolCall.args) &&
            (authoritativeCompletion ||
              (persisted.toolCall.result === streamed.toolCall.result &&
                persisted.toolCall.isError === streamed.toolCall.isError))
          : persisted.toolCall.args === streamed.toolCall.args &&
            persisted.toolCall.result === streamed.toolCall.result &&
            persisted.toolCall.isError === streamed.toolCall.isError)
      )
  }
}

/** Does the persisted turn contain every streamed block in order? */
function persistedTurnIncludesStreamedBlocks(
  group: StreamGroupSnapshot,
  turn: PersistedTurn,
  authoritativeCompletion: boolean
): boolean {
  let persistedIndex = 0
  for (const streamedBlock of group.blocks) {
    let found = false
    while (persistedIndex < turn.blocks.length) {
      if (blockContentMatches(streamedBlock, turn.blocks[persistedIndex], authoritativeCompletion)) {
        found = true
        persistedIndex += 1
        break
      }
      persistedIndex += 1
    }
    if (!found) return false
  }
  return true
}

/**
 * Does a persisted turn exist for S containing all of its done message ids and finalized streamed
 * blocks? The row(s) can appear before their metadata has refreshed with the complete streamed
 * content; keep the streamed copy visible until committed history includes the same content so it
 * does not flicker out between back-to-back streams.
 */
function persistedTurnComplete(
  group: StreamGroupSnapshot,
  turn: PersistedTurn | undefined,
  session: CombineSession
): boolean {
  if (!turn) return false
  if (group.doneMessageIds && group.doneMessageIds.length > 0) {
    const have = new Set(turn.mergedFrom.map((m) => m.id))
    if (!group.doneMessageIds.every((id) => have.has(id))) return false
  }
  return persistedTurnIncludesStreamedBlocks(
    group,
    turn,
    session.authoritativeCompletedGroupIds?.has(group.streamGroupId) ?? false
  )
}

/** Decide whether a stream group should still render (vs. having swapped to persisted). */
function streamingStatusFor(
  group: StreamGroupSnapshot,
  turn: PersistedTurn | undefined,
  session: CombineSession
): StreamingItemStatus | null {
  // Swap to persisted once the complete persisted turn is present.
  if (group.done && persistedTurnComplete(group, turn, session)) return null

  // Transport/lifecycle termination does not prove the saved fragment covers the live tail.
  if (!group.done && session.streamStatus === 'ended') {
    const stillBusy = ['queued', 'running', 'stopping', 'waiting-sandbox', 'waiting-maintenance'].includes(
      session.executionStatus ?? ''
    )
    if (stillBusy && !group.flushed && !group.errored) return 'interrupted'
    if (persistedTurnComplete(group, turn, session)) return null
    return 'interrupted'
  }

  if (group.errored) return persistedTurnComplete(group, turn, session) ? null : 'interrupted'
  if (group.flushed) return persistedTurnComplete(group, turn, session) ? null : 'flushed'
  return 'streaming'
}

/**
 * streamGroupIds whose persisted turn is now fully present, so the hook can
 * clear them from the store (memory hygiene; spec §8). Pure — no side effects.
 */
export function completedGroupIds(
  history: PersistedTurn[],
  groups: StreamGroupSnapshot[],
  session: CombineSession
): string[] {
  const turnBySgId = new Map(history.filter((t) => t.streamGroupId).map((t) => [t.streamGroupId!, t]))
  return groups
    .filter((g) => streamingStatusFor(g, turnBySgId.get(g.streamGroupId), session) === null)
    .map((g) => g.streamGroupId)
}

/**
 * The deterministic core. Produces the single ordered RenderItem[]: streaming
 * xor persisted per streamGroupId, deduped pending, region-ordered.
 */
export function combine(
  history: PersistedTurn[],
  groups: StreamGroupSnapshot[],
  pending: PendingItem[],
  session: CombineSession,
  systemMessages: SystemMessageItem[] = []
): RenderItem[] {
  const turnBySgId = new Map(history.filter((t) => t.streamGroupId).map((t) => [t.streamGroupId!, t]))

  // 1. Streaming items + the set of streamGroupIds whose persisted turn is suppressed.
  const suppressedSgIds = new Set<string>()
  const streamingItems: Array<{ sortAt: number; item: RenderItem }> = []
  for (const group of groups) {
    const turn = turnBySgId.get(group.streamGroupId)
    const status = streamingStatusFor(group, turn, session)
    if (status === null) continue // swapped to persisted
    suppressedSgIds.add(group.streamGroupId)
    streamingItems.push({
      sortAt: group.startedAt,
      item: {
        kind: 'streaming',
        id: group.streamGroupId,
        agentId: group.agentId || session.agentId,
        blocks: group.blocks,
        status,
      },
    })
  }

  // 2. Persisted turns, minus the ones suppressed by an active streaming group.
  // A queued intervention is distinct from the still-pending prompt that starts a turn.
  // Public history supplies queued independently of the runner-consumption pending
  // flag. Legacy rows without queued retain their previous delivery-mode fallback.
  const persistedItems: Array<{ sortAt: number; id: string; item: RenderItem }> = []
  const persistedQueued: Message[] = []
  for (const turn of history) {
    if (turn.streamGroupId && suppressedSgIds.has(turn.streamGroupId)) continue
    const m = turn.message
    if (m.role === 'human' && (m.queued ?? (m.pending && !!m.metadata?.deliveryMode))) {
      persistedQueued.push(m)
      continue
    }
    persistedItems.push({
      sortAt: turn.sortAt,
      id: turn.id,
      item: { kind: 'persisted', id: turn.id, message: turn.message, mergedFrom: turn.mergedFrom, blocks: turn.blocks },
    })
  }

  // 3. Pending dedup: drop optimistic items already echoed by a persisted human row's clientId.
  const echoedClientIds = new Set(
    history.flatMap((t) => t.mergedFrom).flatMap((m) => (m.metadata?.clientId ? [m.metadata.clientId] : []))
  )
  const livePending = pending.filter((p) => !echoedClientIds.has(p.clientId))

  // Classify each send independently. A later queued send must never move an earlier
  // turn-starting prompt into the queue. Explicit per-send queue state wins;
  // timestamps only support older callers that have no queue state.
  const willQueue = (p: PendingItem) =>
    p.queued !== undefined
      ? p.queued
      : p.status === 'queued' || groups.some((g) => !g.done && !g.flushed && !g.errored && g.startedAt < p.createdAt)

  const lonePending = livePending.filter((p) => !willQueue(p))
  const queued = livePending.filter((p) => willQueue(p))

  const toPendingItem = (p: PendingItem, queued = false): RenderItem => ({
    kind: 'pending',
    id: p.clientId,
    content: p.content,
    imageIds: p.imageIds,
    deliveryMode: p.deliveryMode,
    status: p.status,
    queued,
    metadata: null,
  })

  const persistedSystemKeys = new Set(
    history
      .filter((turn) => isPersistedSystemMessage(turn.message))
      .flatMap((turn) => (turn.message.metadata?.systemMessageKey ? [turn.message.metadata.systemMessageKey] : []))
  )
  const persistedSystemNotices = history
    .filter((turn) => isPersistedSystemMessage(turn.message))
    .map((turn) => ({ text: normalizeSystemText(turn.message.content), at: turn.sortAt }))
  const isPersistedDuplicateSystemMessage = (sm: SystemMessageItem): boolean => {
    if (sm.transientId && persistedSystemKeys.has(sm.transientId)) return true
    const text = normalizeSystemText(sm.text)
    return persistedSystemNotices.some(
      (persisted) => persisted.text === text && Math.abs(persisted.at - sm.at) < 60_000
    )
  }

  // Region A — timeline (persisted + streaming + lone pending sends + live system notices), chronological.
  const regionA = [
    ...persistedItems,
    ...streamingItems.map((s) => ({ sortAt: s.sortAt, id: s.item.id, item: s.item })),
    ...lonePending.map((p) => ({ sortAt: p.createdAt, id: p.clientId, item: toPendingItem(p) })),
    ...systemMessages
      .filter((sm) => !isPersistedDuplicateSystemMessage(sm))
      .map((sm) => ({
        sortAt: sm.at,
        id: sm.id,
        item: { kind: 'system' as const, id: sm.id, text: sm.text },
      })),
  ]
    .sort((a, b) => {
      // A prompt and its first delta can arrive in the same millisecond. Human
      // rows must precede the response regardless of their unrelated generated IDs.
      const human = (item: RenderItem) =>
        item.kind === 'pending' || (item.kind === 'persisted' && item.message.role === 'human')
      if (a.sortAt === b.sortAt && human(a.item) !== human(b.item)) return human(a.item) ? -1 : 1
      return compareByKey(a.sortAt, a.id, b.sortAt, b.id)
    })
    .map((entry) => entry.item)

  // Region B — queued interrupts (steers) in send order; Region C — follow-ups in send order.
  // Both the optimistic pending sends and the server-persisted (not-yet-consumed) interventions feed
  // these regions; the two never describe the same message at once — a persisted row's clientId
  // dedupes its optimistic twin above.
  const persistedQueuedToItem = (m: Message): RenderItem => ({
    kind: 'pending',
    id: m.id,
    content: m.content,
    imageIds: m.metadata?.imageIds,
    deliveryMode: m.metadata?.deliveryMode,
    status: 'queued',
    queued: true,
    metadata: m.metadata ?? null,
  })
  type QueuedEntry = { sortAt: number; id: string; deliveryMode: DeliveryMode; item: RenderItem }
  const queuedEntries: QueuedEntry[] = [
    ...queued.map((p) => ({
      sortAt: p.createdAt,
      id: p.clientId,
      deliveryMode: p.deliveryMode ?? 'steer',
      item: toPendingItem(p, true),
    })),
    ...persistedQueued.map((m) => ({
      sortAt: messageSortAt(m),
      id: m.id,
      deliveryMode: m.metadata?.deliveryMode ?? 'steer',
      item: persistedQueuedToItem(m),
    })),
  ]
  const bySortKey = (a: QueuedEntry, b: QueuedEntry) => compareByKey(a.sortAt, a.id, b.sortAt, b.id)
  const regionB = queuedEntries
    .filter((e) => e.deliveryMode === 'steer')
    .sort(bySortKey)
    .map((e) => e.item)
  const regionC = queuedEntries
    .filter((e) => e.deliveryMode !== 'steer')
    .sort(bySortKey)
    .map((e) => e.item)

  // Agent-activity indicator. One deterministic row at the foot of the live timeline (below the
  // current turn, above any queued sends), so both apps render it identically without their own
  // placement logic. Shown when the agent is working — server execution is queued/running/stopping,
  // OR a lone send is still in flight (covers the gap before the first stream event; that pending
  // self-clears on echo or failure, so the indicator does too).
  const agentBusy =
    session.executionStatus === 'queued' ||
    session.executionStatus === 'waiting-sandbox' ||
    session.executionStatus === 'running' ||
    session.executionStatus === 'stopping'
  const sendInFlight = lonePending.some((p) => p.status === 'sending')
  const workingItems: RenderItem[] =
    session.executionStatus === 'waiting-maintenance'
      ? [
          {
            kind: 'queued',
            id: '__maintenance_queue__',
            reason: 'maintenance',
            label: 'Queued until maintenance completes',
          },
        ]
      : agentBusy || sendInFlight
        ? [
            session.waitingForSandbox || session.executionStatus === 'waiting-sandbox'
              ? { kind: 'working', id: '__working__', waitingFor: 'sandbox' }
              : { kind: 'working', id: '__working__' },
          ]
        : []

  return [...regionA, ...workingItems, ...regionB, ...regionC]
}
