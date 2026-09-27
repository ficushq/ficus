import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { updateMyNotificationPrefs } from '../../api/config'
import { PUSH_CATEGORIES } from '@ficus/shared'

const categoryById = new Map(PUSH_CATEGORIES.map((category) => [category.id as string, category]))

function humanizeEvent(event: string): string {
  return categoryById.get(event)?.label ?? event
}

function describeEvent(event: string): string | undefined {
  return categoryById.get(event)?.description
}

/**
 * Per-user notification preferences (self-service): a master push toggle and per-event mutes.
 * These apply to the user's account across all of their devices; device registration is separate.
 */
export function NotificationPreferences() {
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery(queries.notificationConfig.mine())

  const mutation = useMutation({
    mutationFn: (input: { showPreviews?: boolean; pushEnabled?: boolean; mutedEvents?: string[] }) =>
      updateMyNotificationPrefs(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.notificationConfig.mine() }),
  })

  if (isLoading || !data) return null

  const { pushEnabled } = data
  const muted = new Set(data.mutedEvents)

  const toggleEvent = (event: string) => {
    const next = new Set(muted)
    if (next.has(event)) next.delete(event)
    else next.add(event)
    mutation.mutate({ mutedEvents: [...next] })
  }

  return (
    <div className="ficus-section py-5">
      <h4 className="text-md font-medium text-primary mb-1">Notification preferences</h4>
      <p className="text-sm text-muted mb-4">
        Control which notifications are pushed to you. These apply to your account across all your devices.
      </p>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <p className="font-medium text-primary">Push notifications</p>
          <p className="text-sm text-muted">Master switch for push to your account. Turn off to stop all push.</p>
        </div>
        <button
          onClick={() => mutation.mutate({ pushEnabled: !pushEnabled })}
          disabled={mutation.isPending}
          className={clsx(
            'ficus-button',
            'px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0 shrink-0',
            pushEnabled
              ? 'bg-status-danger-100 dark:bg-status-danger-900/30 text-status-danger-700 dark:text-status-danger-300 hover:bg-status-danger-200 dark:hover:bg-status-danger-900/50'
              : 'bg-accent text-on-accent hover:bg-accent-hover'
          )}
        >
          {pushEnabled ? 'Disable' : 'Enable'}
        </button>
      </div>

      <label className="flex items-center justify-between gap-3 mt-5 text-sm">
        <span>
          Show work titles and message previews
          <span className="block text-muted">
            On by default. Turn off to hide titles and message text in device alerts.
          </span>
        </span>
        <input
          type="checkbox"
          checked={data.showPreviews ?? true}
          disabled={mutation.isPending}
          onChange={(event) => mutation.mutate({ showPreviews: event.target.checked })}
        />
      </label>

      {pushEnabled && data.pushEvents.length > 0 && (
        <div className="mt-5">
          <p className="text-sm font-medium text-secondary mb-2">Notify me about</p>
          <ul className="space-y-2">
            {data.pushEvents.map((event) => (
              <li key={event} className="flex items-center justify-between gap-3">
                <span className="text-sm text-primary">
                  {humanizeEvent(event)}
                  {describeEvent(event) && <span className="block text-muted">{describeEvent(event)}</span>}
                </span>
                <input
                  type="checkbox"
                  checked={!muted.has(event)}
                  onChange={() => toggleEvent(event)}
                  disabled={mutation.isPending}
                  className="h-4 w-4 shrink-0"
                  aria-label={`Notify about ${humanizeEvent(event)}`}
                />
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">
            Which squads and work streams notify you is set on each squad and work stream (Notify / Show / Mute).
          </p>
        </div>
      )}
    </div>
  )
}
