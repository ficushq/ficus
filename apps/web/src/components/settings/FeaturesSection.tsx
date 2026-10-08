import { FormSkeleton } from '../loading/Skeleton'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '../../reactQueryHooks'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { usePermissions } from '../../hooks/usePermissions'
import { type SettingMetadata } from '../../api/settings'
import { useSettingsApi } from './settingsApi'

export function AgentExecutionSection() {
  const { data: settings, isLoading, isError } = useQuery(queries.settings.list())
  const { can } = usePermissions()
  if (isLoading) return <FormSkeleton label="Loading execution settings" sections={1} />
  if (isError)
    return (
      <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
        Unable to load the agent limit.
      </p>
    )
  const setting = settings?.find((item) => item.key === 'MAX_CONCURRENT_AGENTS')
  if (!setting) return null
  return (
    <div data-setting-target="execution" className="ficus-section py-5">
      <div data-setting-target="max-concurrent-agents">
        <NumberSetting setting={setting} label="Maximum active agents" canWrite={can('settings:write')} />
      </div>
    </div>
  )
}

/**
 * Editor for a numeric KNOWN_SETTING: owns the draft value and the write
 * mutations, and delegates all rendering to {@link NumberSettingFields}.
 *
 * Exported for tests: the behaviour it owns — trim-on-save, which key gets
 * written, delete-on-reset, and re-seeding the draft when the server value
 * changes — is entirely invisible to {@link NumberSettingFields}, which only
 * renders what it is handed.
 */
export function NumberSetting({
  setting,
  label,
  canWrite,
}: {
  setting: SettingMetadata
  label: string
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  const { setSetting, deleteSetting } = useSettingsApi()
  const [draft, setDraft] = useState(setting.value)

  // Re-seed when the server value changes (a save landing, or another operator).
  useEffect(() => {
    setDraft(setting.value)
  }, [setting.value])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.settings.all })

  const save = useMutation({
    mutationFn: (value: string) => setSetting(setting.key, value),
    onSuccess: invalidate,
  })
  const reset = useMutation({
    mutationFn: () => deleteSetting(setting.key),
    onSuccess: () => {
      save.reset()
      return invalidate()
    },
  })

  return (
    <NumberSettingFields
      setting={setting}
      label={label}
      canWrite={canWrite}
      draft={draft}
      onDraftChange={setDraft}
      onSave={() => save.mutate(draft.trim())}
      onReset={() => reset.mutate()}
      isSaving={save.isPending}
      isResetting={reset.isPending}
      errorMessage={save.error?.message}
    />
  )
}

/**
 * Presentational half of {@link NumberSetting} — deliberately free of
 * react-query so it can be rendered (and asserted on) from a plain test with no
 * QueryClient. That is not just tidiness: several other web test files call
 * `mock.module('@tanstack/react-query', ...)`, and bun applies module mocks
 * process-globally, so any component that calls `useQuery` renders empty once
 * the whole suite runs together.
 *
 * The acceptable range is NOT duplicated here: the server owns it, states it in
 * the setting's description, and rejects out-of-range writes with a 400 whose
 * message names the range — which is what `errorMessage` renders. Duplicating
 * the bounds client-side would just be a second place to drift.
 */
export function NumberSettingFields({
  setting,
  label,
  canWrite,
  draft,
  onDraftChange,
  onSave,
  onReset,
  isSaving,
  isResetting,
  errorMessage,
}: {
  setting: SettingMetadata
  label: string
  canWrite: boolean
  draft: string
  onDraftChange: (value: string) => void
  onSave: () => void
  onReset: () => void
  isSaving: boolean
  isResetting: boolean
  errorMessage?: string
}) {
  const disabled = !canWrite || isSaving || isResetting
  const isDirty = draft.trim() !== setting.value

  return (
    <div className="space-y-3">
      <div>
        <p className="font-medium text-primary">{label}</p>
        <p className="text-sm text-muted">{setting.description}</p>
        {!setting.isDefault && setting.updatedAt && (
          <p className="text-xs text-muted mt-1">
            Last changed {new Date(setting.updatedAt).toLocaleDateString()}
            {setting.updatedBy && ` by ${setting.updatedBy}`}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="number"
          min={1}
          step={1}
          value={draft}
          aria-label={label}
          aria-disabled={disabled}
          disabled={disabled}
          onInput={(e) => onDraftChange(e.currentTarget.value)}
          className="ficus-field w-28 rounded-md bg-surface-secondary px-3 py-1.5 text-sm text-primary  focus:ring-2 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <button
          onClick={onSave}
          disabled={disabled || !isDirty}
          className="ficus-button ficus-button-primary rounded-md px-3 py-1.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSaving ? 'Saving…' : 'Save'}
        </button>
        {!setting.isDefault && (
          <button
            onClick={onReset}
            disabled={disabled}
            className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isResetting ? 'Resetting…' : 'Reset to default'}
          </button>
        )}
        <span className="text-xs text-muted">Default: {setting.default}</span>
      </div>

      {errorMessage && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {errorMessage}
        </p>
      )}
      {!canWrite && <p className="text-xs text-muted">Requires the settings:write permission.</p>}
    </div>
  )
}
