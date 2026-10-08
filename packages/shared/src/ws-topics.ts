import type { EventMap } from './events'

// ---------------------------------------------------------------------------
// Topic definitions
// ---------------------------------------------------------------------------

/** Collection-level topics (no instance suffix). */
export const COLLECTION_TOPICS = [
  'actions',
  'agents',
  'schedules',
  'monitors',
  'squads',
  'workstreams',
  'squadSchedules',
  'worker',
  'inbox',
  'machines',
  'onboarding',
  'squadActivity',
  // The farm's multiplayer (people only): who's where, and chat.
  'presence',
  'farmChat',
] as const
export type CollectionTopic = (typeof COLLECTION_TOPICS)[number]

/** Instance-level topics — `<collection>:<id>`. */
export type InstanceTopic =
  | `agents:${string}`
  | `schedules:${string}`
  | `squads:${string}`
  | `workstreams:${string}`
  | `inbox:${string}`
  | `machines:${string}`
  | `squadActivity:${string}`

/** Any valid topic string. */
export type Topic = CollectionTopic | InstanceTopic

// ---------------------------------------------------------------------------
// Which events can arrive on which collection topic
// ---------------------------------------------------------------------------

/** Maps a collection topic to the EventMap keys that are broadcast on it. */
export type TopicEventMap = {
  actions: Extract<keyof EventMap, 'actions.invalidated'>
  agents: Extract<
    keyof EventMap,
    | 'agent.created'
    | 'agent.updated'
    | 'agent.new-message'
    | 'agent.waiting-input'
    | 'agent.mood'
    | 'agent.queue-cleared'
    | 'agent.terminated'
    | 'agent.deleted'
    | 'agent-question.created'
    | 'agent-question.answered'
    | 'agent-question.delivery-failed'
    | 'agent-question.delivery-retrying'
    | 'agent-question.dismissed'
    | 'artifact.updated'
    | 'execution.created'
    | 'execution.started'
    | 'execution.updated'
    | 'execution.completed'
    | 'execution.failed'
    | 'execution.stopped'
    | 'message.created'
    | 'message.updated'
    | 'sandbox.ensured'
    | 'sandbox.status'
  >
  schedules: Extract<
    keyof EventMap,
    'schedule.created' | 'schedule.updated' | 'schedule.triggered' | 'schedule.deleted'
  >
  monitors: Extract<keyof EventMap, 'monitor.created' | 'monitor.updated' | 'monitor.ended'>
  squads: Extract<
    keyof EventMap,
    | 'squad.created'
    | 'squad.updated'
    | 'slots.updated'
    | 'squad.archived'
    | 'squad.taskAssigned'
    | 'squad.agentSpawned'
    | 'squadRelationship.created'
    | 'squadRelationship.deleted'
    | 'sandboxLocalDeployment.updated'
    | 'sandbox.status'
  >
  workstreams: Extract<
    keyof EventMap,
    | 'workStream.created'
    | 'workStream.updated'
    | 'workStream.assigned'
    | 'workStream.agentAdded'
    | 'workStream.agentRemoved'
    | 'workStream.blocked'
    | 'workStream.review'
    | 'workStream.responded'
    | 'workStream.done'
    | 'workStream.canceled'
    | 'workStream.deleted'
  >
  squadSchedules: Extract<
    keyof EventMap,
    'squadSchedule.created' | 'squadSchedule.updated' | 'squadSchedule.triggered' | 'squadSchedule.deleted'
  >
  worker: Extract<keyof EventMap, 'worker.status'>
  inbox: Extract<
    keyof EventMap,
    'inbox.messageReceived' | 'inbox.messageRead' | 'inbox.allRead' | 'assistant.activityChanged'
  >
  machines: Extract<
    keyof EventMap,
    'machine.created' | 'machine.updated' | 'machine.status' | 'machine.deleted' | 'box.status'
  >
  // Collection-only (no instance topic) — a single global "recompute now" signal.
  onboarding: Extract<keyof EventMap, 'onboarding.updated'>
  squadActivity: Extract<keyof EventMap, 'squadActivity.projected' | 'squadActivity.accessRevoked'>
  presence: Extract<keyof EventMap, 'presence.snapshot' | 'presence.updated' | 'presence.left' | 'presence.waved'>
  farmChat: Extract<
    keyof EventMap,
    | 'farmChat.messageCreated'
    | 'farmChat.messageUpdated'
    | 'farmChat.messageDeleted'
    | 'farmChat.roomsChanged'
    | 'farmChat.typing'
  >
}

// ---------------------------------------------------------------------------
// Discriminated event entry — enables narrowing on `entry.event`
// ---------------------------------------------------------------------------

/** A single event entry for a topic — checking `entry.event` narrows `entry.data`. */
export type TopicEvent<T extends CollectionTopic> = {
  [E in TopicEventMap[T]]: { event: E; data: EventMap[E] }
}[TopicEventMap[T]]

/** Callback for a specific collection topic. Check `entry.event` to narrow `entry.data`. */
export type TopicCallback<T extends CollectionTopic> = (entry: TopicEvent<T>) => void

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

export function isValidTopic(topic: string): topic is Topic {
  const prefix = topic.split(':')[0]
  if (prefix === 'actions') return topic === 'actions'
  return (COLLECTION_TOPICS as readonly string[]).includes(prefix)
}
