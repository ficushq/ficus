import type { PushCategory } from '@ficus/shared'
import type { NotificationEvent } from '../../channels/provider'

/**
 * Which mutable category a push belongs to. Derived after the event is built so inbox pushes can
 * be told apart by what they carry (work-stream kind, fleet source, Assistant recipient) rather
 * than by the single routing event they all share.
 */
export function pushCategoryFor(eventType: string, event: NotificationEvent | null, data: unknown): PushCategory {
  if (eventType === 'agent-question.created') return 'question'
  const recipientType = (data as { recipientType?: unknown } | null | undefined)?.recipientType
  if (recipientType === 'voice_assistant') return 'assistant'
  if (event?.source === 'fleet-alert') return 'fleet'
  // A manual wait is a decision waiting on a person, like a review — one mute covers both.
  if (event?.notificationKind === 'workStream.review' || event?.notificationKind === 'workStream.blocked')
    return 'review'
  if (event?.notificationKind === 'workStream.done') return 'done'
  return 'message'
}
