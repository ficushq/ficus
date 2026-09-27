import { useEffect, useState } from 'react'
import { createWsClient, type WsClient } from '@ficus/client-core'
import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import { client } from '../api/client'
import { dedupeKeys, GARDEN_TOPICS, isLiveEvent, keysForEvent } from './invalidation'

export type LiveStatus = 'connecting' | 'live' | 'offline'

const FLUSH_MS = 150
const MAX_BACKOFF_MS = 30_000

/**
 * Keeps the farm current over Core's `/ws` socket. Each connection needs a
 * fresh single-use ticket, so reconnects are driven here (the client-core
 * socket's own reconnect would replay a spent ticket). Invalidations are
 * batched so a burst of events costs one refetch per query.
 */
export function useLiveUpdates(enabled: boolean): LiveStatus {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<LiveStatus>('connecting')

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let socket: WsClient | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let flush: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    let pending: QueryKey[] = []

    const schedule = (keys: QueryKey[]) => {
      pending.push(...keys)
      flush ??= setTimeout(() => {
        flush = null
        const batch = dedupeKeys(pending)
        pending = []
        for (const queryKey of batch) void queryClient.invalidateQueries({ queryKey })
      }, FLUSH_MS)
    }

    const connect = async () => {
      setStatus('connecting')
      try {
        const { ticket } = await client.auth.fetchWsTicket()
        if (disposed) return
        socket = createWsClient({
          url: client.transport.wsUrl('/ws', { ticket }),
          topics: [...GARDEN_TOPICS],
          reconnect: false,
          onOpen: () => {
            attempt = 0
            setStatus('live')
            // Anything could have changed while we were away.
            if (retry !== null || pending.length) schedule([['squads'], ['actions'], ['agents']])
          },
          onMessage: (data) => {
            if (isLiveEvent(data)) schedule(keysForEvent(data))
          },
          onClose: () => {
            socket = null
            if (!disposed) reconnectLater()
          },
        })
      } catch {
        if (!disposed) reconnectLater()
      }
    }

    const reconnectLater = () => {
      setStatus('offline')
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt) * (0.8 + Math.random() * 0.4)
      attempt += 1
      retry = setTimeout(() => void connect(), delay)
    }

    void connect()
    return () => {
      disposed = true
      socket?.close()
      if (retry) clearTimeout(retry)
      if (flush) clearTimeout(flush)
    }
  }, [enabled, queryClient])

  return status
}
