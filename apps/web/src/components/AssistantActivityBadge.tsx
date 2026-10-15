/**
 * Unread-conversation count for the Assistant navigation button. Counts conversations with unread
 * updates, never executing tasks. The accessible label always carries the exact count.
 */
export function AssistantActivityBadge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span
      aria-label={`${count} Assistant conversation${count === 1 ? '' : 's'} with unread updates`}
      className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-badge px-1 text-[10px] font-bold text-on-badge"
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}
