import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { eq, like, sql } from 'drizzle-orm'
import type { StorageSnapshot } from '@ficus/shared'
import { db } from '../../db'
import { storageMonitor, inbox } from '../../db/schema'
import { InboxMessage } from '../../entities/InboxMessage'
import { getSettingsStore } from '../settings'
import { evaluateStorageWarnings, runStorageMonitor, storageMonitorService } from './monitor'

const keys = ['STORAGE_SCAN_INTERVAL_HOURS', 'STORAGE_ALERT_THRESHOLDS', 'STORAGE_ALERTS_ENABLED']
let oldRuntime: string | undefined
const snapshot = (percent: number | null = 85): StorageSnapshot => ({
  supported: true,
  scanning: false,
  scannedAt: new Date().toISOString(),
  error: null,
  machines: [
    {
      id: 'storage-test-machine',
      name: 'Test host',
      status: percent === null ? 'unavailable' : 'available',
      usedBytes: percent,
      totalBytes: percent === null ? null : 100,
      squads: [],
      unattributedBytes: null,
    },
  ],
})
beforeEach(async () => {
  oldRuntime = process.env.FICUS_SANDBOX_RUNTIME
  process.env.FICUS_SANDBOX_RUNTIME = 'vm'
  await db.delete(storageMonitor).where(eq(storageMonitor.id, 'default'))
  for (const key of keys) await getSettingsStore().delete(key)
})
afterEach(async () => {
  if (oldRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
  else process.env.FICUS_SANDBOX_RUNTIME = oldRuntime
  await db.delete(storageMonitor).where(eq(storageMonitor.id, 'default'))
  await db.delete(inbox).where(like(inbox.idempotencyKey, 'storage-capacity:%:storage-test-machine'))
  for (const key of keys) await getSettingsStore().delete(key)
})

test('threshold crossings escalate once, rearm with hysteresis, and retain unknown readings', () => {
  const evaluate = (percent: number | null, previous = {}) =>
    evaluateStorageWarnings(snapshot(percent), previous, [80, 90, 95], true, 'scan')
  const first = evaluate(85)
  expect(first.alerts).toHaveLength(1)
  expect(evaluate(86, first.levels).alerts).toHaveLength(0)
  expect(evaluate(79, first.levels).alerts).toHaveLength(0)
  expect(evaluate(null, first.levels).levels['storage-test-machine']?.stale).toBe(true)
  expect(evaluate(91, first.levels).alerts[0]?.warning.threshold).toBe(90)
  const recovered = evaluate(77, first.levels)
  expect(recovered.levels['storage-test-machine']?.threshold).toBe(0)
  expect(evaluate(81, recovered.levels).alerts).toHaveLength(1)
  const muted = evaluateStorageWarnings(snapshot(96), {}, [80, 90, 95], false, 'muted')
  expect(muted.alerts).toHaveLength(0)
  expect(muted.levels['storage-test-machine']?.threshold).toBe(95)
  const low = evaluateStorageWarnings(snapshot(1), {}, [1], true, 'low')
  expect(
    evaluateStorageWarnings(snapshot(0), low.levels, [1], true, 'empty').levels['storage-test-machine']?.threshold
  ).toBe(0)
})

test('persists a scheduled scan without a viewer, reads do not rescan, and the 12-hour deadline survives workers', async () => {
  let scans = 0
  const scan = async () => {
    scans++
    return snapshot(30)
  }
  expect((await storageMonitorService.read()).scannedAt).toBeNull()
  await runStorageMonitor(scan)
  await runStorageMonitor(scan)
  expect(scans).toBe(1)
  expect((await storageMonitorService.read()).machines[0]?.usedBytes).toBe(30)
  const status = await storageMonitorService.status()
  expect(status.monitoring.intervalHours).toBe(12)
  expect(status).not.toHaveProperty('machines')
  await db.update(storageMonitor).set({ completedAt: sql`now() - interval '13 hours'` })
  await runStorageMonitor(scan)
  expect(scans).toBe(2)
})

test('manual scans are durable and throttled even when scheduled scans are disabled', async () => {
  await getSettingsStore().set('STORAGE_SCAN_INTERVAL_HOURS', '0')
  let scans = 0
  const scan = async () => {
    scans++
    return snapshot(20)
  }
  await runStorageMonitor(scan)
  expect(scans).toBe(0)
  expect((await storageMonitorService.refresh()).scanning).toBe(true)
  await runStorageMonitor(scan)
  await storageMonitorService.refresh()
  await runStorageMonitor(scan)
  expect(scans).toBe(1)
})

test('coalesces workers and fences a stale scanner after ownership changes', async () => {
  let entered!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  let finish!: (value: StorageSnapshot) => void
  const pending = new Promise<StorageSnapshot>((resolve) => {
    finish = resolve
  })
  const first = runStorageMonitor(async () => {
    entered()
    return pending
  })
  try {
    await ready
    let otherScans = 0
    await runStorageMonitor(async () => {
      otherScans++
      return snapshot(10)
    })
    expect(otherScans).toBe(0)
    await db.update(storageMonitor).set({ leaseId: crypto.randomUUID() })
  } finally {
    finish(snapshot(85))
    await first
  }
  expect((await storageMonitorService.read()).scannedAt).toBeNull()
})

test('reclaims a crashed manual scan with scheduling disabled and preserves good data on failure', async () => {
  await getSettingsStore().set('STORAGE_SCAN_INTERVAL_HOURS', '0')
  await db.insert(storageMonitor).values({
    id: 'default',
    snapshot: snapshot(88),
    leaseId: crypto.randomUUID(),
    leaseUntil: new Date(0),
    startedAt: new Date(0),
  })
  await runStorageMonitor(async () => {
    throw new Error('private details')
  })
  const result = await storageMonitorService.read()
  expect(result.machines[0]?.usedBytes).toBe(88)
  expect(result.error).toContain('last storage scan failed')
  expect(result.error).not.toContain('private details')
})

test('inbox outbox retries a post-send crash without duplicating the system message', async () => {
  const original = InboxMessage.sendOnce.bind(InboxMessage)
  const send = spyOn(InboxMessage, 'sendOnce').mockImplementation(async (...args) => {
    await original(...args)
    throw new Error('crash after durable send')
  })
  try {
    await runStorageMonitor(async () => snapshot(96))
  } finally {
    send.mockRestore()
  }
  expect((await db.select().from(storageMonitor))[0]?.pendingAlerts).toHaveLength(1)
  await runStorageMonitor(async () => snapshot(96))
  expect((await db.select().from(storageMonitor))[0]?.pendingAlerts).toHaveLength(0)
  expect(
    await db.select().from(inbox).where(like(inbox.idempotencyKey, 'storage-capacity:%:storage-test-machine'))
  ).toHaveLength(1)
})

test('validates scan frequency and ordered capacity thresholds at the settings boundary', async () => {
  for (const value of ['', '-1', '0.5', '169', 'NaN'])
    await expect(getSettingsStore().set(keys[0]!, value)).rejects.toThrow()
  for (const value of ['', '0', '101', '90,80', '80,80', '80,'])
    await expect(getSettingsStore().set(keys[1]!, value)).rejects.toThrow()
})
