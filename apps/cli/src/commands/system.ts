import { Command } from 'commander'
import type { StorageSnapshot } from '@ficus/shared'
import { apiGet, apiPost, apiPut } from '../client'
import { config } from '../config'
import { output, outputError } from '../output'

export interface SystemLogsWsUrlOptions {
  apiUrl: string
  token: string
  component: 'api' | 'worker' | 'all'
  tail: number
  follow: boolean
}

export function buildSystemLogsWsUrl(opts: Omit<SystemLogsWsUrlOptions, 'token'>): string {
  const wsBase = opts.apiUrl
    .replace(/^https:/, 'wss:')
    .replace(/^http:/, 'ws:')
    .replace(/\/$/, '')
  const params = new URLSearchParams()
  params.set('component', opts.component)
  params.set('tailLines', String(Math.min(Math.max(opts.tail, 1), 5000)))
  if (!opts.follow) params.set('follow', 'false')
  return `${wsBase}/ws/system/logs?${params}`
}

export function buildSystemLogsWsRequest(opts: SystemLogsWsUrlOptions): {
  url: string
  headers: Record<string, string>
} {
  return { url: buildSystemLogsWsUrl(opts), headers: { Authorization: `Bearer ${opts.token}` } }
}

function parseComponent(raw: string): 'api' | 'worker' | 'all' {
  if (raw === 'api' || raw === 'worker' || raw === 'all') return raw
  throw new Error(`Invalid component: ${raw}. Must be api, worker, or all.`)
}

function parseTail(raw: string): number {
  const tail = Number.parseInt(raw, 10)
  if (!Number.isFinite(tail) || tail < 1) throw new Error(`Invalid tail value: ${raw}`)
  return tail
}

async function streamSystemLogs(options: { component: string; tail: string; follow: boolean }): Promise<void> {
  const component = parseComponent(options.component)
  const tail = parseTail(options.tail)
  const request = buildSystemLogsWsRequest({
    apiUrl: config.apiUrl,
    token: config.password || '',
    component,
    tail,
    follow: options.follow,
  })

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(request.url, { headers: request.headers } as never)
    ws.binaryType = 'arraybuffer'

    const cleanup = () => {
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
    }
    const close = () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, 'client')
    }
    const onSigint = () => close()
    const onSigterm = () => close()
    process.once('SIGINT', onSigint)
    process.once('SIGTERM', onSigterm)

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        process.stdout.write(Buffer.from(event.data))
        return
      }
      if (Buffer.isBuffer(event.data)) {
        process.stdout.write(event.data)
        return
      }
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data) as { type?: string; message?: string }
          if (msg.type === 'error') process.stderr.write(`\x1b[31m[${msg.message ?? 'error'}]\x1b[0m\n`)
          else if (msg.type === 'info') process.stderr.write(`\x1b[33m[${msg.message ?? 'info'}]\x1b[0m\n`)
        } catch {
          process.stdout.write(event.data)
        }
      }
    }

    ws.onerror = () => {
      cleanup()
      reject(new Error('Connection error'))
    }

    ws.onclose = (event) => {
      cleanup()
      if (event.code === 1000) resolve()
      else reject(new Error(`Connection closed (code: ${event.code})`))
    }
  })
}

export function registerSystemCommands(program: Command) {
  const system = program.command('system').description('System management')

  system
    .command('storage')
    .description('Show disk usage, scan state, and last scan time (requires system:logs)')
    .option('--refresh', 'Request a background scan (rate-limited); returns scan state immediately')
    .addHelpText(
      'after',
      '\nUse --json for scripts. Read again while scanning is true to get the completed breakdown.\n' +
        'Cached results refresh after five minutes; --refresh has a one-minute cooldown.\n' +
        'Existing results remain visible during scans. Check scannedAt, error, and each machine status.'
    )
    .action(async (options: { refresh?: boolean }) => {
      try {
        const result = options.refresh
          ? await apiPost<StorageSnapshot>('/api/system/storage/refresh')
          : await apiGet<StorageSnapshot>('/api/system/storage')
        output(result, JSON.stringify(result, null, 2))
      } catch (error) {
        outputError(error as Error)
      }
    })

  system
    .command('pause-status')
    .description('Show global instance maintenance state')
    .action(async () => {
      try {
        const result = await apiGet('/api/system/pause')
        output(result)
      } catch (error) {
        outputError(error as Error)
      }
    })

  system
    .command('pause')
    .description('Pause instance execution and safely requeue active turns')
    .option('-r, --reason <reason>', 'Maintenance reason')
    .action(async (options: { reason?: string }) => {
      try {
        const result = await apiPut('/api/system/pause/admin', {
          active: true,
          ...(options.reason ? { reason: options.reason } : {}),
        })
        output(result, 'Instance maintenance pause requested')
      } catch (error) {
        outputError(error as Error)
      }
    })

  system
    .command('resume')
    .description('Release the administrator maintenance hold')
    .action(async () => {
      try {
        const result = await apiPut('/api/system/pause/admin', { active: false })
        output(result, 'Administrator maintenance hold released')
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus system restart
  system
    .command('restart')
    .description('Restart the server process (K8s will auto-restart the pod)')
    .action(async () => {
      try {
        const result = await apiPost<{ restarting: boolean }>('/api/system/restart')
        output(result, 'Restart initiated')
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus system logs
  system
    .command('logs')
    .description('Stream Ficus system logs (API/worker)')
    .option('-c, --component <component>', 'Component: api, worker, or all', 'all')
    .option('-t, --tail <n>', 'Number of recent lines', '500')
    .option('-f, --follow', 'Follow live logs', true)
    .option('--no-follow', 'Disable following (one-shot tail)')
    .action(async (options) => {
      try {
        await streamSystemLogs(options)
      } catch (error) {
        outputError(error as Error)
      }
    })
}
