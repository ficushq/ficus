import type { VmSetupState } from './setup-state'

/** Readiness is distinct from a reachable physical server. Wait without a setup
 * lease: the owner needs that lease to finish. Exhaustion requeues startup only. */
export async function waitForVmSetupReady(
  read: () => Promise<VmSetupState | null>,
  options: {
    signal?: AbortSignal
    fingerprint?: string
    timeoutMs?: number
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  } = {}
): Promise<VmSetupState> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms) => Bun.sleep(ms))
  const deadline = now() + (options.timeoutMs ?? 30_000)
  for (;;) {
    options.signal?.throwIfAborted()
    const state = await read()
    options.signal?.throwIfAborted()
    if (state && options.fingerprint && state.desiredFingerprint !== options.fingerprint) {
      const error = new Error('Sandbox setup fingerprint changed; startup will retry')
      error.name = 'SandboxReadinessPendingError'
      throw error
    }
    if (state && (state.readiness === 'ready' || state.readiness === 'ready_degraded') && !state.pendingInvocationId)
      return state
    if (now() >= deadline) {
      const error = new Error('Sandbox setup is still pending; startup will retry')
      error.name = 'SandboxReadinessPendingError'
      throw error
    }
    await sleep(Math.min(250, deadline - now()))
  }
}
