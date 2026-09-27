import { describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DeviceConnectionRegistry } from './device-connection-registry'
import {
  crossProcessDeviceTokenEvents,
  localDeviceTokenEvents,
  type DeviceTokenEventAdapter,
  type DeviceTokenRevokedHandler,
} from './device-token-events'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function eventPair(): [DeviceTokenEventAdapter, DeviceTokenEventAdapter] {
  let handlerA: DeviceTokenRevokedHandler | undefined
  let handlerB: DeviceTokenRevokedHandler | undefined
  return [
    {
      publish: (id) => handlerB?.(id),
      subscribe: (handler) => {
        handlerA = handler
        return () => (handlerA = undefined)
      },
    },
    {
      publish: (id) => handlerA?.(id),
      subscribe: (handler) => {
        handlerB = handler
        return () => (handlerB = undefined)
      },
    },
  ]
}

describe('DeviceConnectionRegistry', () => {
  test('closes local connections immediately on the synchronous revocation event', async () => {
    const deviceId = randomUUID()
    const close = mock(() => {})
    const registry = new DeviceConnectionRegistry(async (ids) => new Set(ids))
    const unsubscribe = localDeviceTokenEvents.subscribe((id) => registry.revoke(id)) as () => void
    await registry.register(deviceId, close)

    localDeviceTokenEvents.publish(deviceId)

    expect(close).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  test('closes every local connection for only the revoked device', async () => {
    const deviceA = randomUUID()
    const deviceB = randomUUID()
    const closeA = mock(() => {})
    const closeA2 = mock(() => {})
    const closeB = mock(() => {})
    const registry = new DeviceConnectionRegistry(async (ids) => new Set(ids))

    const a = await registry.register(deviceA, closeA)
    await registry.register(deviceA, closeA2)
    await registry.register(deviceB, closeB)
    expect(a.isActive()).toBe(true)

    registry.revoke(deviceA)
    registry.revoke(deviceA)

    expect(closeA).toHaveBeenCalledTimes(1)
    expect(closeA2).toHaveBeenCalledTimes(1)
    expect(closeB).not.toHaveBeenCalled()
    expect(a.isActive()).toBe(false)
    expect(registry.connectionCount(deviceA)).toBe(0)
    expect(registry.connectionCount(deviceB)).toBe(1)
  })

  test('terminates every connection even when an earlier termination callback throws', async () => {
    const deviceId = randomUUID()
    const laterClose = mock(() => {})
    const registry = new DeviceConnectionRegistry(async (ids) => new Set(ids))
    await registry.register(deviceId, () => {
      throw new Error('close failed')
    })
    await registry.register(deviceId, laterClose)

    expect(() => registry.revoke(deviceId)).not.toThrow()
    expect(laterClose).toHaveBeenCalledTimes(1)
    expect(registry.connectionCount(deviceId)).toBe(0)
  })

  test('a revoke while authoritative registration is pending cannot reactivate it', async () => {
    const lookup = deferred<Set<string>>()
    const deviceId = randomUUID()
    const close = mock(() => {})
    const registry = new DeviceConnectionRegistry(() => lookup.promise)

    const registration = registry.register(deviceId, close)
    expect(registry.connectionCount(deviceId)).toBe(1)
    registry.revoke(deviceId)
    lookup.resolve(new Set([deviceId]))

    const handle = await registration
    expect(handle.isActive()).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
    expect(registry.connectionCount(deviceId)).toBe(0)
    handle.dispose()
    expect(close).toHaveBeenCalledTimes(1)
  })

  test('closes on the authenticated cross-process event fast path', async () => {
    const deviceId = randomUUID()
    const close = mock(() => {})
    const registry = new DeviceConnectionRegistry(async (ids) => new Set(ids), crossProcessDeviceTokenEvents)
    await registry.start()
    await registry.register(deviceId, close)

    const published = crossProcessDeviceTokenEvents.publish(deviceId)
    expect(published).toBeInstanceOf(Promise)
    await published

    expect(close).toHaveBeenCalledTimes(1)
    await registry.stop()
  })

  test('authenticated adapter ignores malformed non-UUID payloads', async () => {
    const deviceId = randomUUID()
    const close = mock(() => {})
    const registry = new DeviceConnectionRegistry(async (ids) => new Set(ids), crossProcessDeviceTokenEvents)
    await registry.start()
    await registry.register(deviceId, close)

    await crossProcessDeviceTokenEvents.publish('ficus_dev_secret-not-a-uuid')

    expect(close).not.toHaveBeenCalled()
    await registry.stop()
  })

  test('closes a paired process through the fast-path event', async () => {
    const [eventsA, eventsB] = eventPair()
    const deviceId = randomUUID()
    const close = mock(() => {})
    const a = new DeviceConnectionRegistry(async (ids) => new Set(ids), eventsA)
    const b = new DeviceConnectionRegistry(async (ids) => new Set(ids), eventsB)
    await a.start()
    await b.start()
    await b.register(deviceId, close)

    await eventsA.publish(deviceId)

    expect(close).toHaveBeenCalledTimes(1)
    await a.stop()
    await b.stop()
  })

  test('scheduled one-second runner performs authoritative revalidation', async () => {
    const deviceId = randomUUID()
    const close = mock(() => {})
    let active = true
    let scheduledTask!: () => Promise<void>
    let intervalMs = 0
    const runner = { start: mock(() => {}), stop: mock(async () => {}) }
    const registry = new DeviceConnectionRegistry(async (ids) => new Set(active ? ids : []), undefined, ((options: {
      intervalMs: number
      task: () => Promise<void>
    }) => {
      intervalMs = options.intervalMs
      scheduledTask = options.task
      return runner
    }) as any)
    await registry.register(deviceId, close)
    await registry.start()
    active = false

    await scheduledTask()

    expect(intervalMs).toBe(30_000)
    expect(runner.start).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    await registry.stop()
  })

  test('authoritative batch revalidation closes after a dropped event', async () => {
    const deviceId = randomUUID()
    let active = true
    const close = mock(() => {})
    const registry = new DeviceConnectionRegistry(async (ids) => new Set(active ? ids : []))
    await registry.register(deviceId, close)
    active = false

    await registry.revalidate()

    expect(close).toHaveBeenCalledTimes(1)
    expect(registry.connectionCount(deviceId)).toBe(0)
  })

  test('shutdown denies active and pending registrations without reactivation', async () => {
    const lookup = deferred<Set<string>>()
    const pendingId = randomUUID()
    const activeId = randomUUID()
    const pendingClose = mock(() => {})
    const activeClose = mock(() => {})
    const registry = new DeviceConnectionRegistry((ids) =>
      ids[0] === activeId ? Promise.resolve(new Set(ids)) : lookup.promise
    )
    await registry.register(activeId, activeClose)
    const pending = registry.register(pendingId, pendingClose)

    const stopping = registry.stop()
    lookup.resolve(new Set([pendingId]))
    await stopping
    expect((await pending).isActive()).toBe(false)
    expect(activeClose).toHaveBeenCalledTimes(1)
    expect(pendingClose).toHaveBeenCalledTimes(1)
  })

  test('fails closed and removes pending registration when authoritative lookup rejects', async () => {
    const deviceId = randomUUID()
    const close = mock(() => {})
    const registry = new DeviceConnectionRegistry(async () => {
      throw new Error('database unavailable')
    })

    await expect(registry.register(deviceId, close)).rejects.toThrow('database unavailable')

    expect(close).toHaveBeenCalledTimes(1)
    expect(registry.connectionCount(deviceId)).toBe(0)
  })

  test('denies registration when the source device is no longer active', async () => {
    const close = mock(() => {})
    const registry = new DeviceConnectionRegistry(async () => new Set())

    const handle = await registry.register(randomUUID(), close)

    expect(handle.isActive()).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
