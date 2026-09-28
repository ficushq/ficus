/**
 * System Logs WebSocket Handler
 *
 * Read-only streaming of Ficus's own system logs (API and worker) at
 * /ws/system/logs. Binary frames carry log chunks; JSON frames carry control
 * messages ({ type: 'info' | 'error', message }).
 *
 * Security: Only allowlisted logical components (api, worker, all) are accepted.
 * All concrete log target resolution is server-side via SystemLogProvider.
 */

import type { ServerWebSocket } from 'bun'
import type { Context } from 'hono'
import type { WSEvents } from 'hono/ws'
import { createLogger } from '../../lib/infra/logger'
import { getSystemLogProvider } from '../system-logs/factory'
import { DEFAULT_TAIL_LINES, MAX_TAIL_LINES, SystemLogProviderError } from '../system-logs/types'
import type { SystemLogComponent, SystemLogProvider } from '../system-logs/types'

const log = createLogger('system-logs-ws')

export interface SystemLogsParams {
  components: SystemLogComponent[]
  tailLines: number
  follow: boolean
}

const ALLOWED_COMPONENTS = new Set(['api', 'worker', 'all'])

export function getSystemLogsParams(c: Context): SystemLogsParams | null {
  const url = new URL(c.req.url)
  const componentRaw = url.searchParams.get('component') ?? 'all'
  if (!ALLOWED_COMPONENTS.has(componentRaw)) return null

  const components: SystemLogComponent[] =
    componentRaw === 'all' ? ['api', 'worker'] : [componentRaw as SystemLogComponent]
  const tailRaw = Number.parseInt(url.searchParams.get('tailLines') ?? '', 10)
  const tailLines = Number.isFinite(tailRaw) ? Math.min(Math.max(tailRaw, 1), MAX_TAIL_LINES) : DEFAULT_TAIL_LINES
  const followRaw = url.searchParams.get('follow')
  const follow = followRaw === null ? true : followRaw !== 'false' && followRaw !== '0'

  return { components, tailLines, follow }
}

function sendControl(
  ws: { raw?: ServerWebSocket },
  type: 'info' | 'error',
  message: string,
  details: Record<string, unknown> = {}
): void {
  ws.raw?.send(JSON.stringify({ type, message, ...details }))
}

export function createSystemLogsWebSocketHandlers(
  params: SystemLogsParams,
  providerFactory: () => SystemLogProvider = getSystemLogProvider
): WSEvents<ServerWebSocket> {
  let stream: { cancel: () => void } | null = null
  let finished = false
  const cancel = () => stream?.cancel()

  return {
    async onOpen(_event, ws) {
      if (!ws.raw) return
      try {
        const provider = providerFactory()
        log.info(
          `Streaming ${params.components.join(',')} via ${provider.name} (tail=${params.tailLines}, follow=${params.follow})`
        )

        const descriptor = provider.describe?.(params.components)
        sendControl(ws, 'info', `Streaming system logs via ${provider.name}`, {
          provider: descriptor?.provider ?? provider.name,
          targets: descriptor?.targets ?? [],
          tailLines: params.tailLines,
          follow: params.follow,
        })

        const started = provider.stream(
          params.components,
          { tailLines: params.tailLines, follow: params.follow },
          (chunk) => ws.raw?.send(chunk),
          (err) => {
            if (finished) return
            finished = true
            sendControl(ws, 'error', err.message, { code: 'code' in err ? err.code : 'STREAM_FAILED' })
            cancel()
            ws.raw?.close(4500, 'Log stream failed')
          },
          () => {
            if (!params.follow && !finished) {
              finished = true
              sendControl(ws, 'info', 'Tail complete')
              ws.raw?.close(1000, 'Tail complete')
            }
          }
        )
        stream = started
        if (finished) started.cancel()
      } catch (err) {
        finished = true
        cancel()
        log.error('Failed to start system log stream:', err)
        if (err instanceof SystemLogProviderError) {
          sendControl(ws, 'error', err.message, { code: err.code })
        } else {
          sendControl(ws, 'error', 'Failed to start log stream', { code: 'STREAM_FAILED' })
        }
        ws.raw.close(4500, 'Failed to start log stream')
      }
    },
    onMessage() {},
    onClose() {
      stream?.cancel()
      stream = null
    },
    onError() {
      stream?.cancel()
      stream = null
    },
  }
}
