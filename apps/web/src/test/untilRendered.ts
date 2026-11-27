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

/**
 * Like {@link untilRendered}, for state a mocked request settles on a later task: each poll sleeps
 * briefly inside act before asserting. Fails with the check's own error after about two seconds.
 */
export async function untilSettled(
  dom: { act: (callback: () => Promise<void>) => Promise<unknown> },
  check: () => void
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await dom.act(async () => void (await Bun.sleep(10)))
    try {
      return check()
    } catch (error) {
      if (attempt >= 200) throw error
    }
  }
}
