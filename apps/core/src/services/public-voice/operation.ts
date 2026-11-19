import { DerivationError } from './github-activity'

/** Process-local ownership, not a distributed lock. Tokens fence late finally blocks. */
export const derivationOwners = new Map<string, symbol>()
export function acquireDerivation(squadId: string, requestSignal?: AbortSignal, deadlineMs = 210_000) {
  if (derivationOwners.has(squadId)) throw new Error('derivation_in_progress')
  const owner = Symbol('voice derivation')
  derivationOwners.set(squadId, owner)
  const controller = new AbortController()
  let settled = false
  const release = () => {
    if (derivationOwners.get(squadId) === owner) derivationOwners.delete(squadId)
  }
  const cancel = (reason: unknown = new DOMException('Derivation cancelled', 'AbortError')) => {
    if (controller.signal.aborted) return
    settled = true
    release()
    controller.abort(reason)
  }
  const onAbort = () => cancel(requestSignal?.reason)
  requestSignal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => cancel(new DerivationError('derivation_timed_out')), deadlineMs)
  if (requestSignal?.aborted) onAbort()
  return {
    signal: controller.signal,
    cancel,
    complete: () => {
      if (settled) return false
      settled = true
      release()
      return true
    },
    dispose: () => {
      cancel()
      clearTimeout(timer)
      requestSignal?.removeEventListener('abort', onAbort)
      release()
    },
  }
}

/** Observe late rejection, but never wait for an uncooperative provider after cancellation. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void
  return new Promise<T>((resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    if (signal.aborted) onAbort()
  }).finally(() => signal.removeEventListener('abort', onAbort))
}
// No global listeners are used; every operation owns its registrations.
