import { useMutation, useQuery, useQueryClient } from '../../reactQueryHooks'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { usePermissions } from '../../hooks/usePermissions'
import { useSettingsApi } from './settingsApi'

export const STREAM_SUMMARIES_SETTING = 'STREAM_SUMMARIES_ENABLED'

/**
 * The instance switch for one-line work stream summaries, which run on the Lite tier.
 * `usableCandidates` is the tier's signed-in, usable models (undefined when unknown): with none,
 * no summaries are written, so say so beside the switch while leaving the saved preference alone.
 */
export function StreamSummariesSetting({ usableCandidates }: { usableCandidates?: string[] }) {
  const { can } = usePermissions()
  const client = useQueryClient()
  const { setSetting } = useSettingsApi()
  const settings = useQuery({ ...queries.settings.list(), enabled: can('settings:read') })
  const update = useMutation({
    mutationFn: (enabled: boolean) => setSetting(STREAM_SUMMARIES_SETTING, String(enabled)),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.settings.all })
      // Saved summaries come and go with the switch (the server leaves them out while it is off).
      void client.invalidateQueries({ queryKey: queryKeys.squads.all })
      void client.invalidateQueries({ queryKey: queryKeys.activity.presence() })
    },
  })
  const setting = settings.data?.find((item) => item.key === STREAM_SUMMARIES_SETTING)
  if (!setting) return null
  const enabled = setting.value === 'true'
  return (
    <div data-setting-target="stream-summaries" className="mt-4 space-y-1">
      <label className="flex items-center justify-between gap-4 text-sm font-medium text-primary">
        Work stream summaries
        <input
          type="checkbox"
          role="switch"
          checked={enabled}
          disabled={!can('settings:write') || update.isPending}
          onChange={(event) => update.mutate(event.target.checked)}
        />
      </label>
      <p className="text-sm text-muted">
        Write one line about what each active work stream is doing, from its participants&apos; messages, and show it on
        work lists and in the stream. Each update is one small call to this tier, at most every few minutes per busy
        stream; turning this off stops them and hides the lines already written.
      </p>
      {enabled && usableCandidates?.length === 0 && (
        <p className="text-sm text-status-warning-600 dark:text-status-warning-400">
          No Lite model is signed in, so no summaries are written. Sign in to a provider in this tier to use them.
        </p>
      )}
      {update.error && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {update.error.message}
        </p>
      )}
    </div>
  )
}
