import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exemptLongLivedStreamFromIdleTimeout, sandboxListenerIdleTimeout } from './streaming-routes'

test('only Unix listeners disable the listener-wide idle timeout', () => {
  expect(sandboxListenerIdleTimeout(true)).toBe(0)
  expect(sandboxListenerIdleTimeout(false)).toBe(255)
})

for (const unix of [false, true]) {
  test(`${unix ? 'Unix' : 'TCP'} bash stream survives the idle window without replaying`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ficus-stream-idle-'))
    const socket = join(dir, 'server.sock')
    const timers = new Set<ReturnType<typeof setTimeout>>()
    let requests = 0
    // Bun's Unix listener types exclude idleTimeout although the runtime
    // honors the listener-wide value. Match the production listener cast.
    const listen = (unix ? { unix: socket } : { hostname: '127.0.0.1', port: 0 }) as {
      hostname?: string
      port?: number
    }
    const server = Bun.serve({
      ...listen,
      // Shorten TCP's ordinary timeout so this exercises the exemption.
      // Unix must use the global zero; per-request overrides are ignored.
      idleTimeout: unix ? sandboxListenerIdleTimeout(true) : 1,
      fetch(req, server) {
        requests++
        exemptLongLivedStreamFromIdleTimeout(server, req, new URL(req.url).pathname)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('started\n'))
              // Deliberately outlive Bun's coarse idle timer (~4 seconds at
              // idleTimeout=1). This delay is the behavior under test.
              const timer = setTimeout(() => {
                timers.delete(timer)
                controller.enqueue(new TextEncoder().encode('completed\n'))
                controller.close()
              }, 6_000)
              timers.add(timer)
            },
            cancel() {
              for (const timer of timers) clearTimeout(timer)
              timers.clear()
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      },
    })
    const controller = new AbortController()
    try {
      const response = await fetch(`http://127.0.0.1:${server.port ?? 80}/bash`, {
        ...(unix ? { unix: socket } : {}),
        method: 'POST',
        signal: controller.signal,
      })
      expect(await response.text()).toBe('started\ncompleted\n')
      expect(requests).toBe(1)
    } finally {
      controller.abort()
      server.stop(true)
      for (const timer of timers) clearTimeout(timer)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000) // Two idle ticks plus listener startup/cleanup; unchanged command budgets.
}
