import { apiFetch } from './client'

/** Longer than Core's 45s control budget, which includes Docker's 40s stop budget. */
const CONTROL_TIMEOUT_MS = 50_000

/** Never replay destructive controls automatically: an aborted request may have taken effect. */
export async function sandboxControlRequest(
  path: string,
  options: RequestInit,
  timeoutMs = CONTROL_TIMEOUT_MS
): Promise<void> {
  const controller = new AbortController()
  const cancel = () => controller.abort(options.signal?.reason)
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error('Sandbox control timed out; the action may have taken effect. Refresh processes before retrying.')
      ),
    timeoutMs
  )
  options.signal?.addEventListener('abort', cancel, { once: true })
  let onAbort: () => void = () => {}
  try {
    if (options.signal?.aborted) cancel()
    controller.signal.throwIfAborted()
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    await Promise.race([apiFetch(path, { ...options, signal: controller.signal }), cancelled])
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
    controller.signal.removeEventListener('abort', onAbort)
  }
}
