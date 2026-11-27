import { QueryClient } from '@tanstack/react-query'
import { queryRetryDelay, shouldRetryQuery } from '@ficus/client-core'

/** The app's one query client and its defaults. */
export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Refetch when window regains focus
        refetchOnWindowFocus: true,
        // Refetch when reconnecting to network - critical for offline support
        refetchOnReconnect: true,
        // Keep data fresh for 5 minutes before considering stale
        staleTime: 5 * 60 * 1000,
        // Keep unused data in cache for 30 minutes
        gcTime: 30 * 60 * 1000,
        // Failed requests retry 3 times with exponential backoff. A busy Core's 503 waits for its
        // Retry-After, backs off from there and retries at most twice (client-core retry.ts).
        retry: shouldRetryQuery,
        retryDelay: queryRetryDelay,
      },
    },
  })
}
