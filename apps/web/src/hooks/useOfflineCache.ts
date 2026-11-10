import { useState, useEffect, useCallback } from 'react'
import { usePWA } from './usePWA'
import { getApiCacheStats, clearApiCache, type ApiCacheStats } from '../lib/serviceWorker'

export interface UseOfflineCacheReturn {
  /** Whether currently offline */
  isOffline: boolean
  /** Whether viewing cached data (offline with cache available) */
  isViewingCachedData: boolean
  /** Cache statistics */
  cacheStats: ApiCacheStats | null
  /** Clear the API cache */
  clearCache: () => Promise<boolean>
  /** Refresh cache stats */
  refreshStats: () => Promise<void>
}

/**
 * Hook for managing offline cache state and operations.
 *
 * Use this to:
 * - Check if viewing cached data while offline
 * - Display cache statistics in settings
 * - Clear API cache manually
 */
export function useOfflineCache(): UseOfflineCacheReturn {
  const { isOnline } = usePWA()
  const [cacheStats, setCacheStats] = useState<ApiCacheStats | null>(null)
  const [hasCachedData, setHasCachedData] = useState(false)

  const refreshStats = useCallback(async () => {
    const stats = await getApiCacheStats()
    setCacheStats(stats)
    setHasCachedData((stats?.entryCount ?? 0) > 0)
  }, [])

  // Fetch cache stats on mount and when online status changes
  useEffect(() => {
    // An async task: refreshStats sets state only after the stats are read.
    void (async () => {
      await refreshStats()
    })()
  }, [refreshStats, isOnline])

  const handleClearCache = useCallback(async () => {
    const success = await clearApiCache()
    if (success) {
      setCacheStats({ entryCount: 0, totalSize: 0, oldestTimestamp: null, newestTimestamp: null })
      setHasCachedData(false)
    }
    return success
  }, [])

  return {
    isOffline: !isOnline,
    isViewingCachedData: !isOnline && hasCachedData,
    cacheStats,
    clearCache: handleClearCache,
    refreshStats,
  }
}
