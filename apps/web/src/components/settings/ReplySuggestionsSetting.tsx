import { useMutation, useQuery, useQueryClient } from '../../reactQueryHooks'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { usePermissions } from '../../hooks/usePermissions'
import { useSettingsApi } from './settingsApi'

export const REPLY_SUGGESTIONS_SETTING = 'REPLY_SUGGESTIONS_ENABLED'

/** The instance switch for reply chips, which run on the Lite tier. */
export function ReplySuggestionsSetting() {
  const { can } = usePermissions()
  const client = useQueryClient()
  const { setSetting } = useSettingsApi()
  const settings = useQuery({ ...queries.settings.list(), enabled: can('settings:read') })
  const update = useMutation({
    mutationFn: (enabled: boolean) => setSetting(REPLY_SUGGESTIONS_SETTING, String(enabled)),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.settings.all }),
  })
  const setting = settings.data?.find((item) => item.key === REPLY_SUGGESTIONS_SETTING)
  if (!setting) return null
  return (
    <div data-setting-target="reply-suggestions" className="mt-4 space-y-1">
      <label className="flex items-center justify-between gap-4 text-sm font-medium text-primary">
        Reply suggestions
        <input
          type="checkbox"
          role="switch"
          checked={setting.value === 'true'}
          disabled={!can('settings:write') || update.isPending}
          onChange={(event) => update.mutate(event.target.checked)}
        />
      </label>
      <p className="text-sm text-muted">
        When an agent asks you something in chat, offer a few one-tap replies above the composer. Each suggestion is one
        small call to this tier; turning this off stops them.
      </p>
      {update.error && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {update.error.message}
        </p>
      )}
    </div>
  )
}
