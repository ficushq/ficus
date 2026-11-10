import { useOfflineCache } from '../hooks/useOfflineCache'
import { WifiOffIcon } from './icons'

export function OfflineBanner() {
  const { isOffline, isViewingCachedData } = useOfflineCache()

  if (!isOffline) {
    return null
  }

  return (
    <div className="shrink-0 bg-status-review-500 text-status-review-900 px-4 py-2 flex items-center justify-center gap-2">
      <WifiOffIcon className="w-5 h-5 shrink-0" />
      <span className="text-sm font-medium">
        {isViewingCachedData ? "You're offline. Viewing cached data." : "You're offline. Some features may not work."}
      </span>
    </div>
  )
}
