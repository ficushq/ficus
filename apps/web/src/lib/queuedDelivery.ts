import type { DeliveryMode } from '@ficus/shared'
import type { PopupOption } from '../components/ThemedPopup'

/** Choices for changing when an already-queued message is delivered (chat bubbles and inbox cards). */
export const QUEUED_DELIVERY_OPTIONS: readonly PopupOption<DeliveryMode>[] = [
  { value: 'steer', label: 'Interrupt', description: 'Deliver at the next point the agent can take a message.' },
  { value: 'follow-up', label: 'Follow up', description: 'Deliver after the agent finishes its current turn.' },
]

/** Lets a queued message's delivery label switch its mode in place. */
export interface QueuedDeliveryControl {
  onChange: (mode: DeliveryMode) => void
  disabled?: boolean
}
