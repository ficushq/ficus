import { eventEmitter } from '../../lib/infra/event-emitter'
import type { EventMap, CollectionTopic, InstanceTopic } from '@ficus/shared'
import type { WebSocketManager } from './manager'
import { listAgentQuestionAttentionUserIds } from '../agents/questions'
import { assistantInboxOwner } from '../assistant-inbox'

/** Discriminated union of all event entries — lets TS narrow `data` from `event`. */
type EventEntry = { [K in keyof EventMap]: { event: K; data: EventMap[K] } }[keyof EventMap]

interface ResolvedRoute {
  topic: CollectionTopic
  instanceTopic?: InstanceTopic
}

/**
 * Resolve the WebSocket broadcast topics and payload for an event.
 *
 * All events are forwarded as-is from the EventMap — always wrapped
 * (e.g. { task }, { agent }, { execution }, { message, agentId }).
 */
function resolve(entry: EventEntry): ResolvedRoute | null {
  const { event, data } = entry

  if (event === 'squadActivity.projected') {
    return { topic: 'squadActivity', instanceTopic: `squadActivity:${data.squadId}` }
  }
  if (event === 'squadActivity.accessRevoked' || event === 'actions.invalidated') return null

  // --- Message events ---
  if (event === 'message.created' || event === 'message.updated') {
    return { topic: 'agents', instanceTopic: `agents:${data.agentId}` }
  }

  // --- Agent events ---
  if (
    event === 'agent.created' ||
    event === 'agent.updated' ||
    event === 'agent.new-message' ||
    event === 'agent.waiting-input' ||
    event === 'agent.terminated' ||
    event === 'agent.deleted' ||
    event === 'agent.queue-cleared'
  ) {
    return { topic: 'agents', instanceTopic: `agents:${data.agentId}` }
  }

  // --- Agent question events ---
  if (
    event === 'agent-question.created' ||
    event === 'agent-question.answered' ||
    event === 'agent-question.delivery-failed' ||
    event === 'agent-question.delivery-retrying' ||
    event === 'agent-question.dismissed'
  ) {
    return { topic: 'agents', instanceTopic: `agents:${data.agentId}` }
  }

  // --- Artifact events ---
  if (event === 'artifact.updated') {
    return { topic: 'agents', instanceTopic: `agents:${data.agentId}` }
  }

  // --- Execution events ---
  if (
    event === 'execution.created' ||
    event === 'execution.queued' ||
    event === 'execution.started' ||
    event === 'execution.updated' ||
    event === 'execution.completed' ||
    event === 'execution.failed' ||
    event === 'execution.stopped'
  ) {
    return { topic: 'agents', instanceTopic: `agents:${data.agentId}` }
  }

  // --- Sandbox ensured (box (re)created at run start) ---
  if (event === 'sandbox.ensured') {
    return { topic: 'agents', instanceTopic: `agents:${data.agentId}` }
  }

  // --- Sandbox status (live pod-lifecycle transitions) ---
  if (event === 'sandbox.status') {
    const { sandboxId } = data
    if (sandboxId.startsWith('agent_')) {
      return { topic: 'agents', instanceTopic: `agents:${sandboxId.slice('agent_'.length)}` }
    }
    if (sandboxId.startsWith('consultants_')) return { topic: 'agents' }
    if (sandboxId.startsWith('system_manager_')) {
      // A per-user system-manager box backs many agents — collection topic only.
      return { topic: 'agents' }
    }
    if (sandboxId.startsWith('squad_')) {
      return { topic: 'squads', instanceTopic: `squads:${sandboxId.slice('squad_'.length)}` }
    }
    return null
  }

  // --- Squad events ---
  if (
    event === 'squad.created' ||
    event === 'squad.updated' ||
    event === 'slots.updated' ||
    event === 'squad.archived' ||
    event === 'squad.agentSpawned'
  ) {
    return { topic: 'squads', instanceTopic: `squads:${data.squadId}` }
  }

  // --- Sandbox local deployment events ---
  if (event === 'sandboxLocalDeployment.updated') {
    return { topic: 'squads', instanceTopic: `squads:${data.squadId}` }
  }

  // --- Squad relationship events ---
  if (event === 'squadRelationship.created') {
    return { topic: 'squads', instanceTopic: `squads:${data.sourceSquadId}` }
  }
  if (event === 'squadRelationship.deleted') {
    return { topic: 'squads' }
  }

  // --- Work Stream events ---
  if (event === 'workStream.deleted') {
    // Include squadId for squad-scoped subscriptions
    return { topic: 'workstreams', instanceTopic: `squads:${data.squadId}` }
  }
  if (
    event === 'workStream.created' ||
    event === 'workStream.updated' ||
    event === 'workStream.assigned' ||
    event === 'workStream.agentAdded' ||
    event === 'workStream.agentRemoved' ||
    event === 'workStream.blocked' ||
    event === 'workStream.review' ||
    event === 'workStream.responded' ||
    event === 'workStream.done' ||
    event === 'workStream.canceled' ||
    event === 'workStream.reopened'
  ) {
    return { topic: 'workstreams', instanceTopic: `workstreams:${data.workStreamId}` }
  }

  // --- Schedule events ---
  if (
    event === 'schedule.created' ||
    event === 'schedule.updated' ||
    event === 'schedule.triggered' ||
    event === 'schedule.webhook_triggered' ||
    event === 'schedule.deleted' ||
    event === 'schedule.failed' ||
    event === 'schedule.recovered' ||
    event === 'schedule.automatically_disabled'
  ) {
    return { topic: 'schedules', instanceTopic: `schedules:${data.scheduleId}` }
  }

  // --- Worker events ---
  if (event === 'worker.status') {
    return { topic: 'worker' }
  }

  // --- Onboarding events (admin-global "recompute now" signal, no instance topic) ---
  if (event === 'onboarding.updated') {
    return { topic: 'onboarding' }
  }

  // --- Inbox events ---
  if (event === 'inbox.messageReceived' || event === 'inbox.messageRead' || event === 'inbox.allRead') {
    return { topic: 'inbox', instanceTopic: `inbox:${data.recipientId}` }
  }
  // Saved Assistant activity rides the inbox topic family; the manager restricts its delivery
  // to the conversation owner on both the collection and the instance topic.
  if (event === 'assistant.activityChanged') {
    return { topic: 'inbox', instanceTopic: `inbox:${data.recipientId}` }
  }

  if (event === 'monitor.created' || event === 'monitor.updated' || event === 'monitor.ended') {
    return { topic: 'monitors', instanceTopic: `agents:${data.agentId}` }
  }

  // --- Machine / box lifecycle events ---
  // Admin-global (not squad-scoped). All 5 carry a machineId, so box.status is
  // keyed by its host machine too — the machine detail view shows its boxes.
  if (
    event === 'machine.created' ||
    event === 'machine.updated' ||
    event === 'machine.status' ||
    event === 'machine.deleted' ||
    event === 'box.status'
  ) {
    return { topic: 'machines', instanceTopic: `machines:${data.machineId}` }
  }

  // Internal worker nudges; no client-facing topic.
  if (
    event === 'sandbox.provision-transition' ||
    event === 'integration.projection-invalidated' ||
    event === 'liveActivity.interestChanged'
  )
    return null

  // Exhaustive check — if a new event is added to EventMap but not handled here,
  // TypeScript will error because `event` won't be `never`.
  const _exhaustive: never = event
  return null
}

const MAX_PENDING_ACTIVITY_DELIVERIES = 250

type PendingActivityDelivery = EventMap['squadActivity.projected'] | 'reconcile'

type QuestionLifecycleEntry = Extract<
  EventEntry,
  {
    event:
      | 'agent-question.created'
      | 'agent-question.answered'
      | 'agent-question.delivery-failed'
      | 'agent-question.delivery-retrying'
      | 'agent-question.dismissed'
  }
>

function isQuestionLifecycleEntry(entry: EventEntry): entry is QuestionLifecycleEntry {
  return (
    entry.event === 'agent-question.created' ||
    entry.event === 'agent-question.answered' ||
    entry.event === 'agent-question.delivery-failed' ||
    entry.event === 'agent-question.delivery-retrying' ||
    entry.event === 'agent-question.dismissed'
  )
}

interface EventBridgeDependencies {
  listAgentQuestionAttentionUserIds: typeof listAgentQuestionAttentionUserIds
  assistantInboxOwner: typeof assistantInboxOwner
}

const defaultDependencies: EventBridgeDependencies = { listAgentQuestionAttentionUserIds, assistantInboxOwner }

export function setupEventBridge(
  manager: WebSocketManager,
  overrides: Partial<EventBridgeDependencies> = {}
): () => void {
  const dependencies: EventBridgeDependencies = { ...defaultDependencies, ...overrides }
  const activityDelivery = new Map<string, { pending: PendingActivityDelivery[]; running: boolean }>()
  const enqueueActivity = (projected: EventMap['squadActivity.projected']) => {
    const queue = activityDelivery.get(projected.squadId) ?? { pending: [], running: false }
    activityDelivery.set(projected.squadId, queue)
    if (queue.pending.length >= MAX_PENDING_ACTIVITY_DELIVERIES) queue.pending = ['reconcile']
    else queue.pending.push(projected)
    if (queue.running) return
    queue.running = true
    void (async () => {
      try {
        while (queue.pending.length) {
          const next = queue.pending.shift()!
          try {
            if (next === 'reconcile') await manager.purgeActivitySubscriptions(projected.squadId)
            else await manager.broadcastActivity(next)
          } catch (err) {
            console.error('[ws] Activity broadcast failed:', err)
          }
        }
      } finally {
        queue.running = false
        if (queue.pending.length === 0) activityDelivery.delete(projected.squadId)
      }
    })()
  }
  return eventEmitter.onAny((event, data) => {
    if (event === 'agent.deleted' || event === 'agent.updated' || event === 'squad.archived') {
      const squadId = 'squadId' in data && typeof data.squadId === 'string' ? data.squadId : undefined
      void manager
        .revalidateActivitySubscriptions(squadId)
        .catch((err) => console.error('[ws] Activity subscription revalidation failed:', err))
    }
    const entry = { event, data } as EventEntry
    if (isQuestionLifecycleEntry(entry)) {
      void dependencies
        .listAgentQuestionAttentionUserIds(entry.data.questionId)
        .then((userIds) => manager.broadcastActionCenterInvalidation(userIds))
        .catch((err) => console.error('[ws] Action Center attention resolution failed:', err))
    }
    // A task entering or leaving needs-input changes the owner's Needs-you list; the owner alone hears it.
    if (entry.event === 'assistant.activityChanged') {
      void dependencies
        .assistantInboxOwner(entry.data.recipientId)
        .then((owner) => manager.broadcastActionCenterInvalidation(owner ? [owner] : []))
        .catch((err) => console.error('[ws] Assistant activity owner resolution failed:', err))
    }

    const route = resolve(entry)
    if (!route) return
    if (event === 'squadActivity.projected') {
      enqueueActivity(data as EventMap['squadActivity.projected'])
      return
    }

    // broadcast() is async (it awaits canReceive/topicScope DB calls); attach a
    // .catch so a DB error doesn't become an unhandled rejection that crashes
    // the process under strict rejection handling.
    void manager.broadcast(route.topic, event, data).catch((err) => {
      console.error(`[ws] broadcast failed for topic ${route.topic} event ${String(event)}:`, err)
    })
    if (route.instanceTopic) {
      void manager.broadcast(route.instanceTopic, event, data).catch((err) => {
        console.error(`[ws] broadcast failed for topic ${route.instanceTopic} event ${String(event)}:`, err)
      })
    }
  })
}
