import type { Topic } from '@ficus/shared'
export { isValidTopic } from '@ficus/shared'
export type { Topic, CollectionTopic, InstanceTopic } from '@ficus/shared'

// Client -> Server messages
export type ClientMessage = { type: 'subscribe'; topic: string } | { type: 'unsubscribe'; topic: string }

// Server -> Client messages
export type ServerMessage =
  | { type: 'subscribed'; topic: Topic }
  | { type: 'unsubscribed'; topic: Topic }
  | { type: 'event'; topic: Topic; event: string; data: unknown }
  | { type: 'error'; message: string; code?: 'FORBIDDEN_TOPIC'; topic?: Topic }
