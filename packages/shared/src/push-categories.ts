/**
 * The kinds of push a user can mute independently. Every push Ficus sends to a person falls into
 * exactly one of these; the notification service derives the category from the built event and
 * checks it against the user's muted list alongside the raw routing event name (kept so mutes
 * stored before categories existed keep working).
 */
export const PUSH_CATEGORIES = [
  {
    id: 'question',
    label: 'Agent questions',
    description: 'An agent is blocked on a decision only you can make.',
  },
  {
    id: 'review',
    label: 'Review requests',
    description: 'A work stream you watch is ready for your review or is blocked on you.',
  },
  {
    id: 'done',
    label: 'Completions',
    description: 'A work stream you watch was completed.',
  },
  {
    id: 'assistant',
    label: 'Assistant task updates',
    description: 'A background task from an Assistant conversation needs input or finished.',
  },
  {
    id: 'fleet',
    label: 'Fleet alerts',
    description: 'Operator alerts about squads, sandboxes, or the instance itself.',
  },
  {
    id: 'message',
    label: 'Other inbox messages',
    description: 'Anything else that lands in your inbox, such as an agent writing to you directly.',
  },
] as const satisfies ReadonlyArray<{ id: string; label: string; description: string }>

export type PushCategory = (typeof PUSH_CATEGORIES)[number]['id']

export const PUSH_CATEGORY_IDS: readonly PushCategory[] = PUSH_CATEGORIES.map((category) => category.id)

export function isPushCategory(value: unknown): value is PushCategory {
  return typeof value === 'string' && (PUSH_CATEGORY_IDS as readonly string[]).includes(value)
}
