import { afterEach, describe, expect, jest, test } from 'bun:test'
import { fetchInProtocolPhase, waitForProtocolReady } from './node-conformance-readiness'

afterEach(() => jest.useRealTimers())

describe('fetchInProtocolPhase', () => {
  test('reports URL, status, and server diagnostics for a rejected response', async () => {
    await expect(
      fetchInProtocolPhase(
        'http://tau/handles',
        {
          phase: 'ficus-peer-handles-proxy',
          timeoutMs: 10,
          requireOk: true,
          diagnostics: () => 'node pid=42; tau port=1234',
        },
        async () => new Response('unavailable', { status: 503 })
      )
    ).rejects.toThrow('ficus-peer-handles-proxy: http://tau/handles returned status=503; node pid=42; tau port=1234')
  })

  test('aborts a request that accepts a connection but never responds', async () => {
    await expect(
      fetchInProtocolPhase(
        'http://tau/handles',
        {
          phase: 'ficus-peer-handles-proxy',
          timeoutMs: 10,
          diagnostics: () => 'node pid=42; tau port=1234',
        },
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
          })
      )
    ).rejects.toThrow('node pid=42; tau port=1234')
  })
})

describe('waitForProtocolReady', () => {
  test('requires health and the expected identity after the listener exists', async () => {
    let now = 0
    const requested: string[] = []
    const responses = [
      new Error('connection refused'),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
      new Response(JSON.stringify({ instanceId: 'expected-node' }), { status: 200 }),
    ]

    await waitForProtocolReady(
      {
        phase: 'node-http-ready',
        timeoutMs: 1_000,
        probes: [
          { url: 'http://node/healthz', validate: async (response) => response.ok },
          {
            url: 'http://node/amtp/identity',
            validate: async (response) => (await response.json()).instanceId === 'expected-node',
          },
        ],
      },
      {
        fetch: async (url, init) => {
          requested.push(String(url))
          expect(init?.signal).toBeInstanceOf(AbortSignal)
          const response = responses.shift()
          if (response instanceof Error) throw response
          return response!
        },
        now: () => now,
        sleep: async (ms) => {
          now += ms
        },
      }
    )

    expect(requested).toEqual(['http://node/healthz', 'http://node/healthz', 'http://node/amtp/identity'])
  })

  test('cancels rejected response bodies before retrying', async () => {
    let now = 0
    let cancelled = false
    const rejectedBody = new ReadableStream({
      cancel() {
        cancelled = true
      },
    })
    const responses = [new Response(rejectedBody, { status: 503 }), new Response('{}')]

    await waitForProtocolReady(
      {
        phase: 'node-http-ready',
        timeoutMs: 100,
        probes: [{ url: 'http://node/healthz', validate: async () => true }],
      },
      {
        fetch: async () => responses.shift()!,
        now: () => now,
        sleep: async (ms) => {
          now += ms
        },
      }
    )

    expect(cancelled).toBe(true)
  })

  test('parent abort clears the pending fetch deadline timer', async () => {
    const timers = new Set<ReturnType<typeof setTimeout> | number>()
    const timer = {} as ReturnType<typeof setTimeout>
    const controller = new AbortController()
    const readiness = waitForProtocolReady(
      {
        phase: 'node-http-ready',
        timeoutMs: 30_000,
        signal: controller.signal,
        probes: [{ url: 'http://node/healthz', validate: async () => true }],
      },
      {
        setTimeout: () => {
          timers.add(timer)
          return timer
        },
        clearTimeout: (handle) => {
          timers.delete(handle)
        },
        fetch: async () => new Promise<Response>(() => {}),
        now: Date.now,
        sleep: Bun.sleep,
      }
    )
    expect(timers.size).toBe(1)
    await Promise.resolve()
    controller.abort('scenario cancelled')

    await expect(readiness).rejects.toMatchObject({ code: 'PROTOCOL_PHASE_FAILED' })
    expect(timers.size).toBe(0)
  })

  test('parent abort cancels a pending fetch that ignores its signal', async () => {
    const controller = new AbortController()
    let now = 0
    let fetchSignal: AbortSignal | undefined
    const readiness = waitForProtocolReady(
      {
        phase: 'node-http-ready',
        timeoutMs: 30_000,
        signal: controller.signal,
        probes: [{ url: 'http://node/healthz', validate: async () => true }],
      },
      {
        fetch: async (_url, init) => {
          fetchSignal = init?.signal ?? undefined
          return new Promise<Response>(() => {})
        },
        now: () => now,
        sleep: async (ms) => {
          now += ms
        },
      }
    )
    await Promise.resolve()
    controller.abort('scenario cancelled')
    await expect(readiness).rejects.toMatchObject({ code: 'PROTOCOL_PHASE_FAILED', phase: 'node-http-ready' })
    expect(fetchSignal?.aborted).toBe(true)
  })

  test('parent abort cancels a pending validator and response body', async () => {
    const controller = new AbortController()
    let bodyCancelled = false
    let validatorSignalObserved = false
    const body = new ReadableStream({
      cancel() {
        bodyCancelled = true
      },
    })
    const readiness = waitForProtocolReady(
      {
        phase: 'node-http-ready',
        timeoutMs: 30_000,
        signal: controller.signal,
        probes: [
          {
            url: 'http://node/identity',
            validate: async () => {
              validatorSignalObserved = true
              return new Promise<boolean>(() => {})
            },
          },
        ],
      },
      {
        fetch: async () => new Response(body),
        now: Date.now,
        sleep: Bun.sleep,
      }
    )
    await Bun.sleep(1)
    controller.abort('scenario cancelled')
    await expect(readiness).rejects.toMatchObject({ code: 'PROTOCOL_PHASE_FAILED' })
    expect(validatorSignalObserved).toBe(true)
    expect(bodyCancelled).toBe(true)
  })

  test('fails immediately with child state when the child dies', async () => {
    let fetches = 0
    let now = 0

    await expect(
      waitForProtocolReady(
        {
          phase: 'node-http-ready',
          timeoutMs: 30_000,
          probes: [{ url: 'http://node/healthz', validate: async () => true }],
          isDead: () => true,
          diagnostics: () => 'pid=42 exit=1 signal=null',
        },
        {
          fetch: async () => {
            fetches++
            return new Response('{}')
          },
          now: () => now,
          sleep: async (ms) => {
            now += ms
          },
        }
      )
    ).rejects.toThrow('node-http-ready: child exited before readiness; pid=42 exit=1 signal=null')
    expect(fetches).toBe(0)
  })

  test('rejects an identity payload whose public key does not match the expected schema', async () => {
    let now = 0
    await expect(
      waitForProtocolReady(
        {
          phase: 'identity-schema-ready',
          timeoutMs: 2,
          probes: [
            {
              url: 'http://peer/identity',
              validate: async (response) => {
                const identity = (await response.json()) as { instanceId?: string; publicKeyPem?: string }
                return {
                  valid: identity.instanceId === 'expected-node' && identity.publicKeyPem === 'expected-key',
                  detail: `publicKeyMatches=${identity.publicKeyPem === 'expected-key'}`,
                }
              },
            },
          ],
        },
        {
          fetch: async () =>
            new Response(JSON.stringify({ instanceId: 'expected-node', publicKeyPem: 'stale-key' }), {
              headers: { 'content-type': 'application/json' },
            }),
          now: () => now,
          sleep: async (ms) => {
            now += ms
          },
        }
      )
    ).rejects.toThrow('publicKeyMatches=false')
  })

  test('reports expected and actual identity when identity never matches', async () => {
    let now = 0

    await expect(
      waitForProtocolReady(
        {
          phase: 'node-http-ready',
          timeoutMs: 100,
          probes: [
            {
              url: 'http://node/amtp/identity',
              validate: async (response) => {
                const actual = (await response.json()).instanceId
                return {
                  valid: actual === 'expected-node',
                  detail: `expected identity=expected-node actual identity=${String(actual)}`,
                }
              },
            },
          ],
          diagnostics: () => 'pid=42 stderr tail=booted',
        },
        {
          fetch: async () => new Response(JSON.stringify({ instanceId: 'wrong-node' })),
          now: () => now,
          sleep: async (ms) => {
            now += ms
          },
        }
      )
    ).rejects.toThrow('expected identity=expected-node actual identity=wrong-node')
  })
})
