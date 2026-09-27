import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { StorageMonitoring } from '@ficus/shared'
import { setSetting } from '../../api/settings'
import { queryKeys } from '../../queryKeys'

export function StorageMonitorSettings({ config }: { config: StorageMonitoring }) {
  const [hours, setHours] = useState(String(config.intervalHours))
  const [thresholds, setThresholds] = useState(config.thresholds.join(','))
  const [alerts, setAlerts] = useState(config.alertsEnabled)
  const client = useQueryClient()
  const save = useMutation({
    mutationFn: async () => {
      await setSetting('STORAGE_ALERT_THRESHOLDS', thresholds)
      await setSetting('STORAGE_SCAN_INTERVAL_HOURS', hours)
      await setSetting('STORAGE_ALERTS_ENABLED', String(alerts))
    },
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.system.all }),
        client.invalidateQueries({ queryKey: queryKeys.settings.list() }),
      ])
    },
  })
  return (
    <form
      className="space-y-3 border-b border-th-border pb-5"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <h3 className="font-medium">Background monitoring</h3>
      <div className="flex flex-wrap gap-4">
        <label className="text-sm space-y-1">
          Scan interval (hours; 0 disables)
          <input
            className="ficus-field block w-48 px-3 py-2"
            type="number"
            min="0"
            max="168"
            step="any"
            required
            value={hours}
            onChange={(event) => setHours(event.target.value)}
          />
        </label>
        <label className="text-sm space-y-1">
          Capacity thresholds (%)
          <input
            className="ficus-field block w-48 px-3 py-2"
            required
            value={thresholds}
            onChange={(event) => setThresholds(event.target.value)}
          />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={alerts} onChange={(event) => setAlerts(event.target.checked)} />
        Send threshold alerts to the system inbox
      </label>
      <p className="text-xs text-secondary">
        Alerts fire on entry into a higher threshold. A drop of 3 percentage points rearms that threshold. Missing
        measurements never count as recovery.
      </p>
      <button className="ficus-button ficus-button-primary px-3 py-2 text-sm" disabled={save.isPending}>
        {save.isPending ? 'Saving…' : 'Save monitoring settings'}
      </button>
      {save.isError && (
        <p role="alert" className="text-sm text-status-danger-400">
          {save.error.message}
        </p>
      )}
      {save.isSuccess && (
        <p role="status" className="text-sm text-secondary">
          Monitoring settings saved.
        </p>
      )}
    </form>
  )
}
