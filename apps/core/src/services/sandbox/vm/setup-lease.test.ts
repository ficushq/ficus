import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { withVmSetupLease } from './setup-state'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Lease progress deadline exceeded')), 2_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('VM setup lease contention', () => {
  test('returns the shared slot before waiting without losing the original lock', async () => {
    const key = randomUUID()
    const entered = deferred()
    const release = deferred()
    const contended = deferred()
    const retry = deferred()
    const events: string[] = []
    const first = withVmSetupLease(key, async () => {
      events.push('first-enter')
      entered.resolve()
      await release.promise
      events.push('first-exit')
    })
    const pending: Promise<unknown>[] = [first]
    let settled: PromiseSettledResult<unknown>[] = []
    try {
      await bounded(entered.promise)
      const second = withVmSetupLease(
        key,
        async () => {
          events.push('second-enter')
        },
        {
          sleep: async () => {
            contended.resolve()
            await retry.promise
          },
        }
      )
      pending.push(second)
      await bounded(contended.promise)
      const unrelated = withVmSetupLease(randomUUID(), async () => {
        events.push('unrelated')
      })
      pending.push(unrelated)
      await bounded(unrelated)
      expect(events).toEqual(['first-enter', 'unrelated'])
    } finally {
      release.resolve()
      retry.resolve()
      settled = await Promise.allSettled(pending)
    }
    expect(settled.every((result) => result.status === 'fulfilled')).toBe(true)
    expect(events).toEqual(['first-enter', 'unrelated', 'first-exit', 'second-enter'])
  })

  for (const interruption of ['abort', 'timeout'] as const) {
    test(`${interruption} while contended never enters the callback or leaks a slot`, async () => {
      const key = randomUUID()
      const entered = deferred()
      const release = deferred()
      const abort = new AbortController()
      let now = 0
      let calls = 0
      const first = withVmSetupLease(key, async () => {
        entered.resolve()
        await release.promise
      })
      const pending: Promise<unknown>[] = [first]
      try {
        await bounded(entered.promise)
        const second = withVmSetupLease(
          key,
          async () => {
            calls++
          },
          {
            signal: abort.signal,
            now: () => now,
            sleep: async () => {
              if (interruption === 'abort') abort.abort(new Error('Canceled lease wait'))
              else now = 15 * 60_000
            },
          }
        )
        pending.push(second)
        await expect(bounded(second)).rejects.toThrow(
          interruption === 'abort' ? 'Canceled lease wait' : 'acquisition timed out'
        )
        expect(calls).toBe(0)
        const unrelated = withVmSetupLease(randomUUID(), async () => 'unrelated')
        pending.push(unrelated)
        await bounded(unrelated)
      } finally {
        release.resolve()
        await Promise.allSettled(pending)
      }
      await bounded(
        withVmSetupLease(key, async () => {
          calls++
        })
      )
      expect(calls).toBe(1)
    })
  }

  test('callback failure releases only its own lease and does not replay the callback', async () => {
    const key = randomUUID()
    let calls = 0
    await expect(
      withVmSetupLease(key, async () => {
        calls++
        throw new Error('reconcile failed')
      })
    ).rejects.toThrow('reconcile failed')
    expect(
      await bounded(
        withVmSetupLease(key, async () => {
          calls++
          return 'next owner'
        })
      )
    ).toBe('next owner')
    expect(calls).toBe(2)
  })

  test('aborting an acquired callback does not release ownership before it settles', async () => {
    const key = randomUUID()
    const entered = deferred()
    const release = deferred()
    const contended = deferred()
    const retry = deferred()
    const abort = new AbortController()
    let secondEntered = false
    const first = withVmSetupLease(
      key,
      async () => {
        entered.resolve()
        await release.promise
      },
      { signal: abort.signal }
    )
    const pending: Promise<unknown>[] = [first]
    let settled: PromiseSettledResult<unknown>[] = []
    try {
      await bounded(entered.promise)
      abort.abort()
      const second = withVmSetupLease(
        key,
        async () => {
          secondEntered = true
        },
        {
          sleep: async () => {
            contended.resolve()
            await retry.promise
          },
        }
      )
      pending.push(second)
      await bounded(contended.promise)
      expect(secondEntered).toBe(false)
    } finally {
      release.resolve()
      retry.resolve()
      settled = await Promise.allSettled(pending)
    }
    expect(settled.every((result) => result.status === 'fulfilled')).toBe(true)
    expect(secondEntered).toBe(true)
  })
})
