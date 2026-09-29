import type { Topic } from '@ficus/shared'
export { isValidTopic } from '@ficus/shared'
export type { Topic, CollectionTopic, InstanceTopic } from '@ficus/shared'

// Client -> Server messages
export type ClientMessage =
  | { type: 'subscribe'; topic: string }
  | { type: 'unsubscribe'; topic: string }
  // The farm's presence: what this connection's person is focused on (validated
  // server-side; null is "around the farm"), or that they're leaving (single-player).
  | { type: 'presence'; focus: unknown }
  | { type: 'presence.leave' }
  // A wave at someone else on the farm (everyone on it sees it; never stored).
  | { type: 'presence.wave'; toUserId: unknown }
  // Farm chat: this person is typing in a room (passed on to the room's other people, never stored).
  | { type: 'farmChat.typing'; roomId: unknown }

// Server -> Client messages
export type ServerMessage =
  | { type: 'subscribed'; topic: Topic }
  | { type: 'unsubscribed'; topic: Topic }
  | { type: 'event'; topic: Topic; event: string; data: unknown }
  | { type: 'error'; message: string; code?: 'FORBIDDEN_TOPIC'; topic?: Topic }
