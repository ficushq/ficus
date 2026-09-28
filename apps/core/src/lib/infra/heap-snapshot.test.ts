import { describe, expect, mock, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { captureHeapSnapshot } from './heap-snapshot'

describe('captureHeapSnapshot', () => {
  test('creates a restricted operator-owned heap snapshot path', async () => {
    const order: string[] = []
    const mkdir = mock(async () => order.push('mkdir'))
    const chmod = mock(async (path: string) => order.push(`chmod:${path}`))
    const writeSnapshot = mock((path: string) => (order.push('write'), path))

    const result = await captureHeapSnapshot({
      role: 'api',
      directory: '/safe/heaps',
      now: () => new Date('2026-08-14T01:02:03.000Z'),
      pid: 42,
      mkdir,
      chmod,
      writeSnapshot,
    })

    expect(mkdir).toHaveBeenCalledWith('/safe/heaps', { recursive: true, mode: 0o700 })
    expect(result).toBe('/safe/heaps/tau-api-2026-08-14T01-02-03-000Z-42.heapsnapshot')
    expect(writeSnapshot).toHaveBeenCalledWith(result)
    expect(chmod).toHaveBeenCalledWith('/safe/heaps', 0o700)
    expect(chmod).toHaveBeenCalledWith(result, 0o600)
    expect(order).toEqual(['mkdir', 'chmod:/safe/heaps', 'write', `chmod:${result}`])
  })

  test('expands a leading ~ in the snapshot directory', async () => {
    // FICUS_HEAP_SNAPSHOT_DIR=~/heaps would otherwise mkdir a directory named
    // `~` beside the process, and the snapshot (which contains secrets) would
    // land somewhere nobody thinks to lock down or clean up.
    const mkdir = mock(async () => undefined)
    const chmod = mock(async () => undefined)
    const writeSnapshot = mock((path: string) => path)
    const expanded = join(homedir(), 'heaps')

    const result = await captureHeapSnapshot({
      role: 'worker',
      directory: '~/heaps',
      now: () => new Date('2026-08-14T01:02:03.000Z'),
      pid: 7,
      mkdir,
      chmod,
      writeSnapshot,
    })

    expect(mkdir).toHaveBeenCalledWith(expanded, { recursive: true, mode: 0o700 })
    expect(result).toBe(`${expanded}/tau-worker-2026-08-14T01-02-03-000Z-7.heapsnapshot`)
    expect(chmod).toHaveBeenCalledWith(expanded, 0o700)
  })

  test('rejects a concurrent capture', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const first = captureHeapSnapshot({
      role: 'api',
      directory: '/safe',
      mkdir: async () => undefined,
      chmod: async () => undefined,
      writeSnapshot: async () => blocked,
    })

    await expect(
      captureHeapSnapshot({ role: 'api', directory: '/safe', writeSnapshot: mock(() => '') })
    ).rejects.toThrow('already in progress')
    release()
    await first
  })
})
