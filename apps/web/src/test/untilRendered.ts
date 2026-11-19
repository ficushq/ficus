import { waitFor } from '@testing-library/dom'

/**
 * Waits for an observable rendered or request state instead of a wall-clock sleep. Each poll
 * flushes pending React work inside act, then asserts. It is bounded by waitFor's default timeout.
 */
export function untilRendered(dom: { act: (callback: () => Promise<void>) => Promise<unknown> }, check: () => void) {
  return waitFor(async () => {
    await dom.act(async () => {})
    check()
  })
}
