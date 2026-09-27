import { useQuery } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import type { PublicMaintenanceStatus } from '../api/system'

export function maintenanceBannerText(data: PublicMaintenanceStatus): string | null {
  if (!data.effective) return null
  return data.phase === 'pausing'
    ? 'Maintenance is starting. Active work is being queued safely.'
    : 'Ficus is paused for maintenance. Work is queued and will resume automatically.'
}

export function MaintenanceBanner() {
  const { data } = useQuery({ ...queries.system.pause(), refetchInterval: 15_000 })
  const text = data ? maintenanceBannerText(data) : null
  if (!text) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="shrink-0 border-b border-status-attention-300 bg-status-attention-50 px-4 py-2 text-center text-sm text-status-attention-950 dark:border-status-attention-800 dark:bg-status-attention-950/40 dark:text-status-attention-100"
    >
      {text}
    </div>
  )
}
