import type { Command } from 'commander'
import { isJsonMode, outputError } from '../output'
import { decodeCursor } from '../watch/cursor'
import { runWatch, type RunnerDeps, type WatchResult } from '../watch/runner'
import { fetchSnapshot, type Snapshot } from '../watch/snapshot'
import { openAttentionSocket } from '../watch/ws'

export interface WatchOptions {
  squadId?: string
  follow: boolean
  pollMs: number
  timeoutMs?: number
  initial?: Snapshot
}

function seconds(flag: string, value: unknown): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number of seconds`)
  return Math.round(n * 1000)
}

export function parseWatchOptions(options: Record<string, unknown>): WatchOptions {
  const follow = options.follow === true
  const timeoutMs = seconds('--timeout', options.timeout)
  if (follow && timeoutMs !== undefined)
    throw new Error('--timeout applies to one-shot mode only; drop it or drop --follow')
  return {
    squadId: typeof options.squad === 'string' ? options.squad : undefined,
    follow,
    pollMs: seconds('--poll', options.poll) ?? 60_000,
    timeoutMs,
    initial: typeof options.cursor === 'string' ? decodeCursor(options.cursor) : undefined,
  }
}

export function formatResult(result: WatchResult, opts: { json: boolean; follow: boolean }): string | null {
  if (opts.json) return opts.follow ? JSON.stringify(result) : JSON.stringify(result, null, 2)
  if (result.events.length === 0) return null
  return result.events.map((e) => e.label).join('\n')
}

/** Test seams: print and openSocket default to real I/O. */
export interface WatchCommandDeps {
  print?: (line: string) => void
  openSocket?: RunnerDeps['openSocket']
}

export function registerWatchCommands(program: Command, deps: WatchCommandDeps = {}) {
  const print = deps.print ?? ((line: string) => console.log(line))
  const openSocket = deps.openSocket ?? ((onHint, onError) => openAttentionSocket({ onHint, onError }))

  // ficus watch [-q <squadId>] [--cursor <c>] [--follow] [--poll <s>] [--timeout <s>]
  program
    .command('watch')
    .description(
      'Block until your attention surface changes (pending actions, agent inbox messages, work-stream waits), then print the delta'
    )
    .option('-q, --squad <squadId>', 'Only watch one squad')
    .option('--cursor <cursor>', 'Baseline from a previous result (chain calls without missing events)')
    .option('--follow', 'Keep running and print each change batch (NDJSON with --json)')
    .option('--poll <seconds>', 'Fallback re-check interval; WebSocket hints are the fast path', '60')
    .option('--timeout <seconds>', 'One-shot mode only: give up and print an empty batch after this long')
    .action(async (options) => {
      try {
        const parsed = parseWatchOptions(options)
        const json = isJsonMode()
        await runWatch({
          fetchSnapshot: () => fetchSnapshot({ squadId: parsed.squadId }),
          openSocket,
          emit: (result) => {
            const line = formatResult(result, { json, follow: parsed.follow })
            if (line !== null) print(line)
          },
          warn: (message) => console.error(`ficus watch: ${message}`),
          now: () => Date.now(),
          follow: parsed.follow,
          pollMs: parsed.pollMs,
          timeoutMs: parsed.timeoutMs,
          initial: parsed.initial,
        })
      } catch (error) {
        outputError(error as Error)
      }
    })
}
