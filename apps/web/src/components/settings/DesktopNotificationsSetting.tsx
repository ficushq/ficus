import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { desktopNotificationToggle } from '../../lib/desktop'
import { desktopQueryKeys } from '../../queryKeys'
import { queries } from '../../queryOptions'

/** Ficus Desktop's own OS-alert preference; renders only when the desktop build lets the web app change it. */
export function DesktopNotificationsSetting() {
  const setEnabled = desktopNotificationToggle()
  const queryClient = useQueryClient()
  const { data: enabled = false, isLoading } = useQuery({ ...queries.desktop.enabled(), enabled: !!setEnabled })
  const update = useMutation({
    mutationFn: (next: boolean) => setEnabled!(next),
    onSuccess: (applied) => queryClient.setQueryData(desktopQueryKeys.enabled(), applied),
    // The desktop app may refuse or adjust the change (for example, OS permission); re-read its answer.
    onSettled: () => queryClient.invalidateQueries({ queryKey: desktopQueryKeys.enabled() }),
  })
  if (!setEnabled) return null
  return (
    <section data-setting-target="desktop-notifications" className="space-y-2">
      <label className="flex items-center justify-between gap-4 text-sm font-medium text-primary">
        Desktop notifications
        <input
          type="checkbox"
          role="switch"
          checked={enabled}
          disabled={isLoading || update.isPending}
          onChange={(event) => update.mutate(event.target.checked)}
        />
      </label>
      <p className="text-sm text-muted">macOS alerts for inbox updates while Ficus is in the background.</p>
      {update.isError && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {update.error instanceof Error ? update.error.message : String(update.error)}
        </p>
      )}
    </section>
  )
}
