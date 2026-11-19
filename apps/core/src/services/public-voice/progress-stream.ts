import { derivationEventSchema, type DerivationProgress, type PublishDerivationProgress } from '@ficus/shared'
import { abortable } from './operation'

type TerminalProgress = Extract<DerivationProgress, { type: 'complete' | 'error' }>
export class DerivationStreamError extends Error {
  constructor(
    readonly reason: 'schema' | 'frame_limit' | 'event_limit' | 'byte_limit' | 'closed' | 'stale_preparation'
  ) {
    super(`Derivation stream ${reason}`)
    this.name = 'DerivationStreamError'
  }
}

/** One serialized bounded writer. Publishers await backpressure; heartbeats never build a queue. */
export function createProgressWriter(
  write: (frame: string) => Promise<unknown>,
  cancel: () => void,
  signal: AbortSignal,
  options: { writeMs?: number; heartbeatMs?: number } = {}
) {
  const runId = crypto.randomUUID()
  let seq = 0
  let bytes = 0
  let queued = 0
  let terminal = false
  let disposed = false
  let tail: Promise<void> = Promise.resolve()
  const enqueue = (frame: string, bestEffort = false): Promise<void> => {
    const writeSignal = bestEffort ? new AbortController().signal : signal
    if (disposed || writeSignal.aborted || queued >= 8) {
      cancel()
      return Promise.reject(new Error('Derivation stream closed'))
    }
    queued++
    const next = tail
      .then(async () => {
        writeSignal.throwIfAborted()
        const controller = new AbortController()
        const timer = setTimeout(
          () => {
            controller.abort()
            cancel()
          },
          bestEffort ? 1 : (options.writeMs ?? 15_000)
        )
        try {
          await abortable(Promise.resolve(write(frame)), AbortSignal.any([writeSignal, controller.signal]))
        } catch (error) {
          cancel()
          throw error
        } finally {
          clearTimeout(timer)
        }
      })
      .finally(() => {
        queued--
      })
    tail = next.catch(() => {})
    return next
  }
  // Reject without mutating sequence/budgets: a safe error frame must still be possible.
  // The last event and 1 KiB are reserved for a terminal diagnostic, never extra work.
  const prepare = (payload: DerivationProgress, bestEffort = false): (() => Promise<void>) => {
    if (terminal || disposed || (!bestEffort && signal.aborted)) throw new DerivationStreamError('closed')
    const nextSeq = seq + 1
    const parsed = derivationEventSchema.safeParse({ version: 1, runId, seq: nextSeq, ...payload })
    if (!parsed.success) throw new DerivationStreamError('schema')
    const event = parsed.data
    const isTerminal = event.type === 'complete' || event.type === 'error'
    const frame = `event: derivation\ndata: ${JSON.stringify(event)}\n\n`
    const size = new TextEncoder().encode(frame).length
    if (size > 65_536) throw new DerivationStreamError('frame_limit')
    if (nextSeq > 512 || (!isTerminal && nextSeq >= 512)) throw new DerivationStreamError('event_limit')
    if (bytes + size > 2_097_152 - (isTerminal ? 0 : 1024)) throw new DerivationStreamError('byte_limit')
    return () => {
      if (terminal || disposed || (!bestEffort && signal.aborted))
        return Promise.reject(new DerivationStreamError('closed'))
      if (nextSeq !== seq + 1) return Promise.reject(new DerivationStreamError('stale_preparation'))
      seq = nextSeq
      bytes += size
      terminal = isTerminal
      return enqueue(frame, bestEffort)
    }
  }
  const publish: PublishDerivationProgress = async (payload) => prepare(payload)()
  const timer = setInterval(() => {
    if (!queued && !terminal && !disposed) void enqueue(': heartbeat\n\n').catch(() => {})
  }, options.heartbeatMs ?? 10_000)
  return {
    publish,
    // Validate/encode/budget synchronously before the route releases its lock. Commit
    // immediately afterwards, with no await between preparation and ownership transition.
    prepareTerminal: (event: TerminalProgress) => prepare(event),
    // At the overall deadline, attempt one immediately writable terminal frame only.
    // Never queue behind a blocked write or extend work with a new delivery timeout.
    timeout: async () => {
      if (queued || terminal || disposed) return
      try {
        await prepare({ type: 'error', error: { code: 'derivation_timed_out' } }, true)()
      } catch {
        /* The connection may already be gone. */
      }
    },
    dispose: () => {
      disposed = true
      clearInterval(timer)
    },
  }
}
