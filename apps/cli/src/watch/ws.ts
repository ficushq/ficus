import { createWsClient } from '@ficus/client-core'
import { config } from '../config'

/** Collection topics whose invalidation hints cover the user's attention surface. */
export const ATTENTION_TOPICS = ['actions', 'inbox', 'workstreams'] as const

export function attentionSocketUrl(apiUrl: string, token: string): string {
  const base = apiUrl.replace(/\/+$/, '').replace(/^http/, 'ws')
  return `${base}/ws?token=${encodeURIComponent(token)}`
}

export function isHintFrame(frame: unknown): boolean {
  if (typeof frame !== 'object' || frame === null) return false
  const f = frame as { type?: unknown; topic?: unknown }
  if (f.type !== 'event' || typeof f.topic !== 'string') return false
  const collection = f.topic.split(':')[0]
  return (ATTENTION_TOPICS as readonly string[]).includes(collection)
}

export interface HintSocket {
  close(): void
}

/**
 * Frames are content-free invalidation hints; every one schedules a re-snapshot.
 * The server sends actions.invalidated on (re)subscribe, so onOpen also hints —
 * that is what recovers changes missed while disconnected.
 */
export function openAttentionSocket(opts: {
  onHint: () => void
  onError: (message: string) => void
}): HintSocket | null {
  const token = config.password
  if (!token) return null
  const client = createWsClient({
    url: attentionSocketUrl(config.apiUrl, token),
    topics: [...ATTENTION_TOPICS],
    onMessage: (frame) => {
      if (isHintFrame(frame)) opts.onHint()
      else if (typeof frame === 'object' && frame && (frame as { type?: string }).type === 'error') {
        opts.onError((frame as { message?: string }).message ?? 'websocket error frame')
      }
    },
    onOpen: () => opts.onHint(),
    onError: (error) => opts.onError(error instanceof Error ? error.message : String(error)),
  })
  return { close: () => client.close() }
}
