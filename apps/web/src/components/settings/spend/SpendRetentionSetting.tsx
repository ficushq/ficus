import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { setSetting } from '../../../api/settings'
import { queryKeys, spendQueryKeys } from '../../../queryKeys'

/** INFERENCE_USAGE_RETENTION_DAYS: how long per-call cost rows are kept (daily totals are kept indefinitely). */
export function SpendRetentionSetting({ days }: { days: number }) {
  const [value, setValue] = useState(String(days))
  const client = useQueryClient()
  const save = useMutation({
    mutationFn: () => setSetting('INFERENCE_USAGE_RETENTION_DAYS', value.trim()),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: spendQueryKeys.all }),
        client.invalidateQueries({ queryKey: queryKeys.settings.list() }),
      ])
    },
  })
  return (
    <form
      className="space-y-3"
      data-setting-target="spend-retention"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <h3 className="text-sm font-medium text-primary">Keep per-call detail</h3>
      <label className="block space-y-1 text-sm">
        Days to keep each call’s row
        <input
          className="ficus-field block w-48 px-3 py-2"
          type="number"
          min="1"
          max="365"
          step="1"
          required
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <p className="text-xs text-secondary">
        Per-call rows are kept this long (180 days by default, up to a year); daily totals are kept indefinitely, so
        long-range charts and breakdowns still work after the detail is gone.
      </p>
      <button className="ficus-button ficus-button-primary px-3 py-2 text-sm" disabled={save.isPending}>
        {save.isPending ? 'Saving…' : 'Save retention'}
      </button>
      {save.isError && (
        <p role="alert" className="text-sm text-status-danger-400">
          {save.error.message}
        </p>
      )}
      {save.isSuccess && (
        <p role="status" className="text-sm text-secondary">
          Retention saved.
        </p>
      )}
    </form>
  )
}
