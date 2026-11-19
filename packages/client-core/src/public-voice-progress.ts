import { derivationEventSchema, formatDerivationError, voiceDerivationResultSchema, type DerivationEvent, type VoiceDerivationResult, type SafeDerivationFailure } from '@ficus/shared'

export class VoiceDerivationError extends Error {
  readonly payload: SafeDerivationFailure & { error: string }
  constructor(readonly code: SafeDerivationFailure['code'], failure: SafeDerivationFailure = { code }) {
    super(formatDerivationError(code, failure) ?? 'Voice derivation failed. Nothing was saved.')
    this.payload = { ...failure, error: code }
  }
}
export interface ReadVoiceDerivationOptions {
  signal?: AbortSignal
  onProgress?: (event: DerivationEvent) => void
  onLegacyResponse?: () => void
  idleMs?: number
  deadlineMs?: number
}

/** A narrow stateful SSE reader shared by web and CLI. Never reconnects or repeats the POST. */
export async function readVoiceDerivation(response: Response, options: ReadVoiceDerivationOptions = {}): Promise<VoiceDerivationResult> {
  const controller = new AbortController()
  const interrupted = () => new VoiceDerivationError('derivation_stream_interrupted')
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const reader = response.body?.getReader()
  if (!reader) throw interrupted()
  let idle: ReturnType<typeof setTimeout>
  const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(interrupted()), options.idleMs ?? 30_000) }
  const deadline = setTimeout(() => controller.abort(interrupted()), options.deadlineMs ?? 220_000)
  const onAbort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', onAbort, { once: true })
  resetIdle()
  let buffer = ''
  let total = 0
  let seq = 0
  let runId: string | undefined
  let terminal: Extract<DerivationEvent, { type: 'complete' | 'error' }> | undefined
  let findings = 0
  const sse = response.headers.get('Content-Type')?.split(';')[0]?.trim() === 'text/event-stream'
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    signal.throwIfAborted()
    for (;;) {
      // Cancellation cancels the reader, which resolves a pending read as done.
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) { buffer += decoder.decode(); break }
      total += value.byteLength
      if (total > 2_097_152) throw interrupted()
      buffer += decoder.decode(value, { stream: true })
      if (!sse) continue
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer)
        if (!match) break
        const frame = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        if (new TextEncoder().encode(frame).length > 65_536) throw interrupted()
        resetIdle()
        const lines = frame.split(/\r?\n/).filter(line => line && !line.startsWith(':'))
        if (!lines.length) continue // Heartbeats reset idle, byte dribbling does not.
        if (lines.length !== 2 || lines[0] !== 'event: derivation' || !lines[1]!.startsWith('data: ')) throw interrupted()
        const parsed = derivationEventSchema.safeParse(JSON.parse(lines[1]!.slice(6)))
        if (!parsed.success) throw interrupted()
        const event = parsed.data
        if (terminal || event.seq !== seq + 1 || event.seq > 512 || (runId && event.runId !== runId)) throw interrupted()
        if ((!seq && event.type !== 'started') || (seq && event.type === 'started')) throw interrupted()
        seq = event.seq; runId = event.runId
        if (event.type === 'finding' && event.index !== findings++) throw interrupted()
        if (event.type === 'complete' || event.type === 'error') terminal = event
        else { signal.throwIfAborted(); options.onProgress?.(event) }
      }
      if (new TextEncoder().encode(buffer).length > 65_536) throw interrupted()
    }
    signal.throwIfAborted()
    if (!sse) {
      const result = voiceDerivationResultSchema.parse(JSON.parse(buffer))
      options.onLegacyResponse?.()
      return result
    }
    if (buffer.trim() || !terminal) throw interrupted()
    if (terminal.type === 'error') throw new VoiceDerivationError(terminal.error.code, terminal.error)
    return terminal.result
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (error instanceof VoiceDerivationError) throw error
    throw interrupted()
  } finally {
    clearTimeout(idle!)
    clearTimeout(deadline)
    signal.removeEventListener('abort', onAbort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
