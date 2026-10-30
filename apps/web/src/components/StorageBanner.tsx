import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { STORAGE_ALERT_HYSTERESIS_POINTS, type StorageWarning } from '@ficus/shared'
import { queries } from '../queryOptions'
import { usePermissions } from '../hooks/usePermissions'

const DISMISS_KEY = 'ficus.storageBanner.dismissed'
const DISMISS_MS = 7 * 24 * 60 * 60 * 1000

interface Dismissal {
  until: number
  /** The highest warning level showing when it was dismissed; reaching a higher one shows the banner again. */
  threshold: number
}

type DismissalStorage = Pick<Storage, 'getItem' | 'setItem'>

/** The browser's localStorage, or null where it is blocked or absent. */
function browserStorage(): DismissalStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** Per-viewer convenience only: unreadable or blocked storage just means the banner shows. */
function readDismissal(storage: DismissalStorage | null): Dismissal | null {
  try {
    const value = JSON.parse(storage?.getItem(DISMISS_KEY) ?? 'null') as Dismissal | null
    return value && typeof value.until === 'number' && typeof value.threshold === 'number' ? value : null
  } catch {
    return null
  }
}

function saveDismissal(storage: DismissalStorage | null, dismissal: Dismissal) {
  try {
    storage?.setItem(DISMISS_KEY, JSON.stringify(dismissal))
  } catch {
    // Without storage the dismissal lasts for this page only.
  }
}

/** Names the warning level and, inside the hysteresis band, when it clears. */
export function storageWarningText(warning: StorageWarning): string {
  const percent = `${warning.percent.toFixed(1)}%`
  const level = `${warning.threshold}%`
  return warning.percent >= warning.threshold
    ? `${warning.machineName} is ${percent} full, above the ${level} warning level.`
    : `${warning.machineName} is ${percent} full. The ${level} warning clears below ${warning.threshold - STORAGE_ALERT_HYSTERESIS_POINTS}%.`
}

export function StorageBanner({ storage = browserStorage() }: { storage?: DismissalStorage | null } = {}) {
  const { can, isLoading } = usePermissions()
  const allowed = !isLoading && can('system:logs')
  const { data } = useQuery({ ...queries.system.storageStatus(), enabled: allowed })
  const [dismissal, setDismissal] = useState(() => readDismissal(storage))
  if (!allowed || !data?.warnings.length) return null
  const worst = [...data.warnings].sort((a, b) => b.threshold - a.threshold || b.percent - a.percent)[0]!
  if (dismissal && Date.now() < dismissal.until && worst.threshold <= dismissal.threshold) return null
  const dismiss = () => {
    const next = { until: Date.now() + DISMISS_MS, threshold: worst.threshold }
    saveDismissal(storage, next)
    setDismissal(next)
  }
  return (
    <div
      role="status"
      className="flex shrink-0 items-start gap-3 border-b border-status-attention-500/30 bg-status-attention-500/10 px-4 py-2 text-sm text-primary"
    >
      <p className="min-w-0 flex-1">
        Storage warning: {storageWarningText(worst)} Measured {new Date(worst.measuredAt).toLocaleString()}.
        {worst.stale ? ' This reading is stale; current usage is unknown.' : ''}
        {data.warnings.length > 1 ? ` ${data.warnings.length} machines need attention.` : ''}{' '}
        <Link to="/settings?section=storage" className="inline-flex items-center underline">
          Review storage
        </Link>
      </p>
      <button
        type="button"
        onClick={dismiss}
        title="Hide for a week, or until a higher warning level is reached"
        className="ficus-button ficus-button-ghost shrink-0 px-3 py-1 text-sm"
      >
        Dismiss
      </button>
    </div>
  )
}
