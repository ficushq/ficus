import { afterEach, expect, spyOn, test } from 'bun:test'
import { restartSandbox } from './workspace'

const originalFetch = globalThis.fetch
const spies: Array<{ mockRestore: () => void }> = []
afterEach(() => {
  globalThis.fetch = originalFetch
  for (const spy of spies.splice(0)) spy.mockRestore()
})

test('restart is a bounded POST and does not treat accepted health as setup readiness', async () => {
  let request: RequestInit | undefined
  let target = ''
  globalThis.fetch = (async (url, options) => {
    target = String(url)
    request = options
    return Response.json({ ok: true })
  }) as typeof fetch
  await restartSandbox('s1')
  expect(target).toEndWith('/api/squads/s1/sandbox/restart')
  expect(request?.method).toBe('POST')
  expect(request?.signal).toBeInstanceOf(AbortSignal)
})

test('a timed-out transport reports unknown outcome, not successful or failed restart', async () => {
  const controller = new AbortController()
  const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
  spies.push(timeout)
  globalThis.fetch = (async (_url, options) =>
    new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('deadline', 'TimeoutError')), {
        once: true,
      })
    })) as typeof fetch
  const pending = restartSandbox('s1')
  controller.abort()
  await expect(pending).rejects.toThrow('outcome is unknown')
  expect(timeout).toHaveBeenCalledWith(100_000)
})

test('server conflict message survives to the recovery control', async () => {
  globalThis.fetch = (async () =>
    Response.json({ error: 'Sandbox lifecycle is busy' }, { status: 409 })) as typeof fetch
  await expect(restartSandbox('s1')).rejects.toThrow('Sandbox lifecycle is busy')
})
