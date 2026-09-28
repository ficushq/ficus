import { agentSlotWaitQueryKeys, assistantQueryKeys } from '../queryKeys'
import { desktopQueryKeys } from '../queryKeys'
import { parseAssistantInboxConversationId } from '@ficus/shared'
import { hashKey } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useQueryClient } from '../reactQueryHooks'
import { useWebSocket } from '../hooks/useWebSocket'
import { queryKeys, onboardingQueryKeys, integrationQueryKeys } from '../queryKeys'
import { invalidateSandboxStatus } from '../lib/sandboxStatusInvalidation'
import { createInvalidationCoalescer } from '../lib/invalidationCoalescer'
import { hasLiveConversation } from '../lib/messageInvalidationSuppression'

/**
 * Global component that subscribes to WebSocket events and invalidates
 * React Query caches. This is the single source of truth for all
 * event-driven cache invalidation.
 *
 * Components should NOT subscribe to WS topics for invalidation —
 * only for non-cache side effects (e.g. stream reconnection).
 *
 * Because every sub-key spreads the `all` prefix, invalidating `queryKeys.X.all`
 * automatically invalidates every query under that domain (list, detail, etc.).
 * That breadth is why agent-scoped events must NOT use it — see
 * `invalidateForAgent` below.
 *
 * Invalidations are routed through a coalescer rather than issued directly, so a
 * burst of WS frames costs one refetch round instead of one per frame.
 */
type QueryInvalidatorDependencies = {
  queryClient: Pick<ReturnType<typeof useQueryClient>, 'invalidateQueries' | 'getQueryCache'>
  subscribe: ReturnType<typeof useWebSocket>['subscribe']
  isConnected?: boolean
}

export function QueryInvalidator({ dependencies }: { dependencies?: QueryInvalidatorDependencies } = {}) {
  return dependencies ? <QueryInvalidatorEffects {...dependencies} /> : <DefaultQueryInvalidator />
}

function DefaultQueryInvalidator() {
  const queryClient = useQueryClient()
  const { subscribe, isConnected } = useWebSocket()
  return <QueryInvalidatorEffects queryClient={queryClient} subscribe={subscribe} isConnected={isConnected} />
}

/**
 * The queries an agent-scoped event can actually affect: that agent's own
 * queries, plus the collections whose contents include it.
 *
 * Deliberately NOT `queryKeys.agents.all`. That prefix also covers every OTHER
 * agent's detail, messages and sandbox status, so a single agent's status tick
 * made every agent mounted in the UI refetch — the measured storm was six
 * identical `GET /api/agents/:id` inside 8ms, driven by ~44 `agent.updated`
 * frames a minute.
 *
 * `messagesInfinite` is excluded here on purpose — refetching a whole message
 * list on every status tick is pure cost. Persisted tool-result patches now emit
 * `message.updated`; terminal `execution.*` events retain the existing history
 * backstop for missed/reordered delivery. See that branch before narrowing it.
 */
function invalidateForAgent(queue: (queryKey: readonly unknown[]) => void, agentId: string | undefined) {
  queue(queryKeys.agents.listPrefix())
  queue(queryKeys.agents.childrenPrefix())
  if (!agentId) return
  queue(queryKeys.agents.detail(agentId))
  queue(queryKeys.agents.activeExecution(agentId))
  queue(queryKeys.agents.context(agentId))
  queue(queryKeys.agents.sandboxStatus(agentId))
}

/**
 * Minimum spacing between squad-roster refetches driven by agent status ticks.
 *
 * `GET /squads/:id/agents` returns every agent's `toJson()`, which embeds
 * `status` — so a status tick genuinely changes the payload and the roster
 * cannot simply stop listening. But a busy squad emits `agent.updated`
 * continuously while any agent streams, so there is a pending key in EVERY
 * 150ms coalescer window: two roster keys sustained ~6.7 flushes/sec each,
 * which is the ~13 requests/sec of identical responses observed while merely
 * viewing the squad home page.
 *
 * The coalescer's 150ms window is right for keys where latency is felt (a
 * message, an action item). For a roster of status dots it buys nothing a
 * one-second cadence does not, at roughly 7x the requests. This is a
 * deliberately separate, longer window rather than a change to the shared
 * coalescer, which other keys depend on staying responsive.
 */
const ROSTER_INVALIDATION_WINDOW_MS = 1_000

/**
 * Leading-edge throttle per key: the first tick invalidates immediately (an
 * agent appearing busy must not lag a second behind), and further ticks inside
 * the window collapse into ONE trailing invalidation, so the roster still
 * converges on the final state.
 */
function createRosterThrottle(
  queue: (queryKey: readonly unknown[]) => void,
  windowMs: number = ROSTER_INVALIDATION_WINDOW_MS
) {
  const lastFlushedAt = new Map<string, number>()
  const trailing = new Map<string, ReturnType<typeof setTimeout>>()

  return {
    queue(queryKey: readonly unknown[]) {
      const hash = hashKey(queryKey)
      const now = Date.now()
      const last = lastFlushedAt.get(hash)
      if (last === undefined || now - last >= windowMs) {
        lastFlushedAt.set(hash, now)
        queue(queryKey)
        return
      }
      // Already flushed inside this window: make sure the LAST tick still
      // lands, without one refetch per tick in between.
      if (trailing.has(hash)) return
      trailing.set(
        hash,
        setTimeout(
          () => {
            trailing.delete(hash)
            lastFlushedAt.set(hash, Date.now())
            queue(queryKey)
          },
          Math.max(0, windowMs - (now - last))
        )
      )
    },
    dispose() {
      for (const handle of trailing.values()) clearTimeout(handle)
      trailing.clear()
      lastFlushedAt.clear()
    },
  }
}

const OPEN_RECONCILE_FALLBACK_MS = 150

type QueryInvalidationClient = QueryInvalidatorDependencies['queryClient']

function createQueryInvalidationCoalescer(queryClient: QueryInvalidationClient) {
  const coalescer = createInvalidationCoalescer((queryKey, exact) => {
    // Snapshot only requests that predate this logical invalidation. One broad
    // invalidate lets TanStack scan/batch the prefix once and immediately
    // refetch idle descendants; cancelRefetch:false leaves these requests alone.
    const filters = exact
      ? { queryKey, exact: true, fetchStatus: 'fetching' as const }
      : { queryKey, fetchStatus: 'fetching' as const }
    const alreadyFetching = queryClient.getQueryCache().findAll(filters)
    void queryClient.invalidateQueries(exact ? { queryKey, exact: true } : { queryKey }, { cancelRefetch: false })

    // Exact retries must not act as prefixes: an agent detail key is also an
    // ancestor of scopes, so broad retry would repeatedly refetch that child.
    for (const query of alreadyFetching) coalescer.queueExact(query.queryKey)
  })
  return coalescer
}

function QueryInvalidatorEffects({ queryClient, subscribe, isConnected = false }: QueryInvalidatorDependencies) {
  const coalescerRef = useRef<ReturnType<typeof createInvalidationCoalescer> | null>(null)
  const slotCoalescerRef = useRef<ReturnType<typeof createInvalidationCoalescer> | null>(null)
  const openFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const actionFrameBeforeOpenRef = useRef(false)
  const actionFrameExpiryRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Create one coalescer per effect setup. StrictMode replays setup after cleanup,
    // so reusing a memoized instance would leave the replayed subscriptions inert.
    const coalescer = createQueryInvalidationCoalescer(queryClient)
    coalescerRef.current = coalescer
    // Slot reconnect repair must not delay Action Center's independent open
    // snapshot. Its own coalescer also replays invalidations landing mid-fetch.
    const slotCoalescer = createQueryInvalidationCoalescer(queryClient)
    slotCoalescerRef.current = slotCoalescer
    const invalidate = coalescer.queue
    const rosterThrottle = createRosterThrottle(invalidate)
    const unsubscribes = [
      // ── Action Center content-free reconciliation ───────────────
      subscribe('actions', () => {
        // Core sends this empty snapshot immediately after subscribing. When an
        // authenticated open is waiting on its old-Core fallback, this frame is
        // the reconciliation and cancels that fallback rather than doubling it.
        if (coalescerRef.current === coalescer) {
          if (openFallbackRef.current !== null) {
            clearTimeout(openFallbackRef.current)
            openFallbackRef.current = null
          } else {
            // The transport can deliver the snapshot before React commits the
            // connected render. Remember it so that render does not arm a
            // redundant fallback after this reconciliation already started.
            actionFrameBeforeOpenRef.current = true
            if (actionFrameExpiryRef.current !== null) clearTimeout(actionFrameExpiryRef.current)
            const expiry = setTimeout(() => {
              if (actionFrameExpiryRef.current !== expiry) return
              actionFrameExpiryRef.current = null
              actionFrameBeforeOpenRef.current = false
            }, OPEN_RECONCILE_FALLBACK_MS)
            actionFrameExpiryRef.current = expiry
          }
        }
        invalidate(queryKeys.actions.all)
        invalidate(queryKeys.agentQuestions.all)
      }),

      // ── Agent events ────────────────────────────────────────────
      subscribe('agents', ({ event, data }) => {
        if (event.startsWith('agent-question.')) {
          invalidate(queryKeys.agentQuestions.all)
          invalidate(queryKeys.actions.all)
          return
        }

        // A message was persisted; the agents row did not change. The squad
        // roster renders lastMessageAt/lastMessagePreview so it must refresh,
        // but nothing else here can be affected — this used to arrive as
        // `agent.updated` and drag the agent's whole query family plus the
        // artifact and Action Center caches along with it, per message.
        if (event === 'agent.new-message') {
          if (data.squadId) {
            rosterThrottle.queue(queryKeys.squads.agents(data.squadId))
            rosterThrottle.queue(queryKeys.squads.agentsWithRecent(data.squadId))
          }
          return
        }

        if (
          event === 'agent.created' ||
          event === 'agent.updated' ||
          event === 'agent.waiting-input' ||
          event === 'agent.terminated' ||
          event === 'artifact.updated'
        ) {
          invalidateForAgent(invalidate, data.agentId)
          if (data.squadId) slotCoalescer.queue(agentSlotWaitQueryKeys.agent(data.squadId, data.agentId))
          invalidate(queryKeys.artifacts.all)
          if (event !== 'artifact.updated') invalidate(queryKeys.activity.presence())

          // Squad agents affect squad queries. Membership changes (an agent
          // appearing or disappearing) stay immediate; a mere status tick is
          // throttled, because it is the one that arrives continuously.
          if (data.squadId) {
            const membershipChanged = event === 'agent.created' || event === 'agent.terminated'
            const queueRoster = membershipChanged ? invalidate : rosterThrottle.queue
            queueRoster(queryKeys.squads.agents(data.squadId))
            queueRoster(queryKeys.squads.agentsWithRecent(data.squadId))
          }

          invalidate(queryKeys.actions.all)
          return
        }

        if (event === 'agent.queue-cleared' || event === 'agent.deleted') {
          invalidate(queryKeys.agents.detail(data.agentId))
          invalidate(queryKeys.agents.messagesInfinite(data.agentId))
          if (event === 'agent.deleted') {
            // Removal changes list membership, which `detail` alone does not cover.
            invalidate(queryKeys.agents.listPrefix())
            invalidate(queryKeys.agents.childrenPrefix())
            invalidate(queryKeys.artifacts.all)
            invalidate(queryKeys.activity.presence())
          }
          return
        }

        if (
          event === 'execution.created' ||
          event === 'execution.started' ||
          event === 'execution.updated' ||
          event === 'execution.completed' ||
          event === 'execution.failed' ||
          event === 'execution.stopped'
        ) {
          invalidate(queryKeys.workflows.all)
          // Execution frames carry no squadId, so they refresh agent-scoped
          // queries and the collections only — same narrowing as above.
          invalidateForAgent(invalidate, data.agentId)
          invalidate(queryKeys.actions.all)
          // Execution state affects scheduler order. The prefix reaches every
          // global, squad-scoped, and infinite active work-stream list.
          invalidate(queryKeys.squads.activeWorkStreamsPrefix())
          invalidate(queryKeys.squads.allWorkStreams())

          // Completed and aborted tool-result patches emit `message.updated`, but
          // terminal execution events remain an authoritative backstop for missed
          // or reordered delivery. An open conversation suppresses the collection
          // invalidation from `message.updated`, so this is its one reconciliation.
          // A closed conversation may receive one additional benign, coalesced
          // messagesInfinite refresh when the terminal event follows tool completion.
          if (event === 'execution.completed' || event === 'execution.failed' || event === 'execution.stopped') {
            invalidate(queryKeys.agents.messagesInfinite(data.agentId))
          }
          return
        }

        // Fired once the run's createSession has (re-)ensured the agent's
        // sandbox(es) — the actual moment a manually-stopped box is recreated.
        // Refetch sandbox status now so the box shows as coming up immediately
        // instead of waiting for the next poll tick (or a poll paused between turns).
        if (event === 'sandbox.ensured') {
          if (data?.agentId) {
            invalidate(queryKeys.agents.sandboxStatus(data.agentId))
          }
          return
        }

        // Live pod-lifecycle transitions (pending → starting → running → gone).
        if (event === 'sandbox.status') {
          invalidateSandboxStatus(queryClient, data.sandboxId)
          return
        }

        if (event === 'message.created' || event === 'message.updated') {
          if (!hasLiveConversation(data.agentId)) {
            invalidate(queryKeys.agents.messagesInfinite(data.agentId))
          }
        }
      }),

      // ── Squad events ──────────────────────────────────────────────
      subscribe('squads', ({ event, data }) => {
        if (event === 'slots.updated') {
          slotCoalescer.queue(agentSlotWaitQueryKeys.squad(data.squadId))
          return
        }
        if (event === 'squad.updated' || event === 'squad.archived') {
          slotCoalescer.queue(agentSlotWaitQueryKeys.squad(data.squadId))
        }
        // A sandbox-status tick is not squad-data churn — refetch only the
        // squad's sandbox status, not all squad queries.
        if (event === 'sandbox.status') {
          invalidateSandboxStatus(queryClient, data.sandboxId)
          return
        }

        invalidate(queryKeys.squads.all)
        if (event === 'squad.updated') invalidate(integrationQueryKeys.squadGitAuthorDefaults(data.squadId))
        invalidate(queryKeys.activity.presence())

        if (event === 'sandboxLocalDeployment.updated') {
          invalidate(queryKeys.squads.localDeployments(data.squadId))
          invalidate(queryKeys.sandbox.status(data.squadId))
          return
        }

        // Spawn only — there is no unspawn counterpart on this topic. Unspawning
        // terminates the agent, which arrives as `agent.terminated` on the `agents`
        // topic above and invalidates these same two keys.
        if (event === 'squad.agentSpawned') {
          invalidate(queryKeys.squads.agents(data.squadId))
          invalidate(queryKeys.squads.agentsWithRecent(data.squadId))
        }
      }),

      // ── Machine events (admin-global) ─────────────────────────────
      // machine.*/box.status are admin-global (only 'all'-access clients receive
      // them), so they drive the Machines admin fleet view — NOT per-member
      // sandbox status (that stays on the sandbox.status path above).
      subscribe('machines', ({ event, data }) => {
        // Any machine-row change churns the fleet list (status badges, box counts).
        // A box lifecycle change also churns the fleet list's box-count column, so
        // it invalidates `all` too — not just the one machine's detail below.
        if (
          event === 'machine.created' ||
          event === 'machine.updated' ||
          event === 'machine.status' ||
          event === 'machine.deleted' ||
          event === 'box.status'
        ) {
          invalidate(queryKeys.machines.all)
        }

        // A status flip or a box lifecycle change refreshes that machine's detail
        // (its status + hosted-box list/count).
        if (event === 'machine.status' || event === 'box.status') {
          invalidate(queryKeys.machines.detail(data.machineId))
        }
      }),

      // ── Work stream events ────────────────────────────────────────
      subscribe('workstreams', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.workflows.all })
        invalidate(queryKeys.squads.all)
        invalidate(queryKeys.actions.all)
        invalidate(queryKeys.activity.presence())
      }),

      // ── Schedule events ─────────────────────────────────────────
      subscribe('schedules', () => {
        invalidate(queryKeys.schedules.all)
      }),

      // ── Monitor events ─────────────────────────────────────────
      subscribe('monitors', ({ data }) => {
        invalidate(queryKeys.monitors.all)
        if (data?.agentId) invalidate(queryKeys.agents.detail(data.agentId))
      }),

      // ── Onboarding events (admin-global "recompute now" signal) ────
      // Status is always DERIVED server-side (see
      // apps/core/src/services/onboarding/status.ts) — this event carries no
      // payload, so there is nothing to branch on; just refetch.
      subscribe('onboarding', () => {
        invalidate(onboardingQueryKeys.all)
      }),

      // ── Inbox events ────────────────────────────────────────────
      subscribe('inbox', ({ event, data }) => {
        invalidate(desktopQueryKeys.notifications())
        if (event === 'assistant.activityChanged') {
          // Durable task/update state changed: refresh badges, the open conversation's activity,
          // and saved-conversation lists so ordering and previews follow.
          invalidate(assistantQueryKeys.activityPrefix)
          invalidate(assistantQueryKeys.all)
          return
        }
        if (data.recipientType === 'user' || data.recipientType === 'voice_assistant') {
          invalidate(queryKeys.inbox.minePrefix())
          // Compatibility fallback for Cores that deliver mailbox traffic without the activity event.
          if (parseAssistantInboxConversationId(data.recipientId)) invalidate(assistantQueryKeys.activityPrefix)
        } else if (data.recipientType === 'system') {
          invalidate(queryKeys.inbox.systemPrefix())
        }
      }),
    ]

    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe())
      rosterThrottle.dispose()
      coalescer.dispose()
      slotCoalescer.dispose()
      if (slotCoalescerRef.current === slotCoalescer) slotCoalescerRef.current = null
      if (coalescerRef.current === coalescer) {
        coalescerRef.current = null
        actionFrameBeforeOpenRef.current = false
        if (actionFrameExpiryRef.current !== null) {
          clearTimeout(actionFrameExpiryRef.current)
          actionFrameExpiryRef.current = null
        }
        if (openFallbackRef.current !== null) {
          clearTimeout(openFallbackRef.current)
          openFallbackRef.current = null
        }
      }
    }
  }, [subscribe, queryClient])

  useEffect(() => {
    if (!isConnected) {
      actionFrameBeforeOpenRef.current = false
      if (actionFrameExpiryRef.current !== null) {
        clearTimeout(actionFrameExpiryRef.current)
        actionFrameExpiryRef.current = null
      }
      return
    }
    const coalescer = coalescerRef.current
    if (!coalescer) return
    slotCoalescerRef.current?.queue(agentSlotWaitQueryKeys.all)
    // A reconnect may have missed activity events; badges must not stay stale until the fallback
    // interval. This rides the independent repair coalescer so it never delays the Action Center.
    slotCoalescerRef.current?.queue(assistantQueryKeys.activityPrefix)
    slotCoalescerRef.current?.queue(queryKeys.system.storageStatus())
    slotCoalescerRef.current?.queue(queryKeys.system.storage())
    if (actionFrameBeforeOpenRef.current) {
      actionFrameBeforeOpenRef.current = false
      if (actionFrameExpiryRef.current !== null) {
        clearTimeout(actionFrameExpiryRef.current)
        actionFrameExpiryRef.current = null
      }
      return
    }

    // Give the new Core subscription snapshot a short window to stand in for
    // reconnect repair. Older Core versions send no frame, so this bounded
    // fallback still reconciles every authenticated open.
    const handle = setTimeout(() => {
      if (openFallbackRef.current !== handle || coalescerRef.current !== coalescer) return
      openFallbackRef.current = null
      coalescer.queue(queryKeys.actions.all)
      coalescer.queue(queryKeys.agentQuestions.all)
    }, OPEN_RECONCILE_FALLBACK_MS)
    openFallbackRef.current = handle

    return () => {
      if (openFallbackRef.current !== handle) return
      clearTimeout(handle)
      openFallbackRef.current = null
    }
  }, [isConnected, queryClient, subscribe])

  return null
}
