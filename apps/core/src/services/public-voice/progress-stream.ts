import { derivationEventSchema, type PublishDerivationProgress } from '@ficus/shared'
import { abortable } from './operation'

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
  const publishEvent = async (payload: Parameters<PublishDerivationProgress>[0], bestEffort = false) => {
    if (terminal || disposed) throw new Error('Derivation stream closed')
    const event = derivationEventSchema.parse({ version: 1, runId, seq: ++seq, ...payload })
    const frame = `event: derivation\ndata: ${JSON.stringify(event)}\n\n`
    const size = new TextEncoder().encode(frame).length
    bytes += size
    if (seq > 512 || size > 65_536 || bytes > 2_097_152) {
      cancel()
      throw new Error('Derivation stream limit')
    }
    if (event.type === 'complete' || event.type === 'error') terminal = true
    await enqueue(frame, bestEffort)
  }
  const timer = setInterval(() => {
    if (!queued && !terminal && !disposed) void enqueue(': heartbeat\n\n').catch(() => {})
  }, options.heartbeatMs ?? 10_000)
  return {
    publish: ((event) => publishEvent(event)) satisfies PublishDerivationProgress,
    // At the overall deadline, attempt one immediately writable terminal frame only.
    // Never queue behind a blocked write or extend work with a new delivery timeout.
    timeout: async () => {
      if (queued || terminal || disposed) return
      await publishEvent({ type: 'error', error: { code: 'derivation_timed_out' } }, true).catch(() => {})
    },
    dispose: () => {
      disposed = true
      clearInterval(timer)
    },
  }
}
