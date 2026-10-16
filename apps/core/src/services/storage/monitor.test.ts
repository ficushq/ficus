import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { eq, like, sql } from 'drizzle-orm'
import type { StorageSnapshot } from '@ficus/shared'
import { db } from '../../db'
import { inbox, storageHomeResults, storageMonitor, storageScanPasses, storageUsageSamples } from '../../db/schema'
import { InboxMessage } from '../../entities/InboxMessage'
import type { Machine } from '../machines/queries'
import { getSettingsStore } from '../settings'
import { evaluateStorageWarnings, runStorageMonitor, storageMonitorService, type StorageMonitorDeps } from './monitor'
import { fakeRemote } from './scan.test-helper'

const keys = ['STORAGE_SCAN_INTERVAL_HOURS', 'STORAGE_ALERT_THRESHOLDS', 'STORAGE_ALERTS_ENABLED']
const machine = { id: crypto.randomUUID(), name: 'Test host', status: 'ready' } as Machine
const HOME = '/home/box_aaaaaaaaaaaa'
const dirs = new Map([
  [HOME, 4096],
  [`${HOME}/workspace`, 8192],
])
const owners = () => [{ home: HOME, squadId: 'squad', squadName: 'Product', label: 'Squad workspace' }]
const targets = async () => [{ machine, owners: owners() }]
const deps = (remote: ReturnType<typeof fakeRemote>): StorageMonitorDeps => ({
  runner: remote.runner,
  loadTargets: targets,
  sleep: async () => {},
})
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
async function reset() {
  await db.delete(storageMonitor).where(eq(storageMonitor.id, 'default'))
  await db.delete(storageScanPasses).where(eq(storageScanPasses.machineId, machine.id))
  await db.delete(storageHomeResults).where(eq(storageHomeResults.machineId, machine.id))
  await db.delete(storageUsageSamples).where(eq(storageUsageSamples.machineId, machine.id))
  await db.delete(inbox).where(like(inbox.idempotencyKey, `storage-capacity:%:${machine.id}`))
  for (const key of keys) await getSettingsStore().delete(key)
}
beforeEach(async () => {
  oldRuntime = process.env.FICUS_SANDBOX_RUNTIME
  process.env.FICUS_SANDBOX_RUNTIME = 'vm'
  await reset()
})
afterEach(async () => {
  if (oldRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
  else process.env.FICUS_SANDBOX_RUNTIME = oldRuntime
  await reset()
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

test('persists a pass without a viewer, reads never scan, and the pass interval survives workers', async () => {
  const remote = fakeRemote(dirs, { budget: 100, used: 30, size: 100 })
  expect((await storageMonitorService.read(targets)).scannedAt).toBeNull()
  expect(remote.calls).toHaveLength(0)
  await runStorageMonitor(deps(remote))
  const calls = remote.calls.length
  expect(calls).toBeGreaterThan(0)
  await runStorageMonitor(deps(remote))
  expect(remote.calls).toHaveLength(calls)
  const read = await storageMonitorService.read(targets)
  expect(remote.calls).toHaveLength(calls)
  expect(read.machines[0]).toMatchObject({ usedBytes: 30, totalBytes: 100, status: 'available' })
  expect(read.machines[0]!.squads[0]!.bytes).toBe(remote.total(HOME))
  const status = await storageMonitorService.status()
  expect(status.monitoring.intervalHours).toBe(1)
  expect(status.scanning).toBe(false)
  expect(status).not.toHaveProperty('machines')
  await db
    .update(storageScanPasses)
    .set({ startedAt: sql`now() - interval '2 hours'` })
    .where(eq(storageScanPasses.machineId, machine.id))
  await runStorageMonitor(deps(remote))
  expect(remote.calls.length).toBeGreaterThan(calls)
  expect((await storageMonitorService.read(targets)).machines[0]!.scan?.generation).toBe(2)
})

test('manual refresh requests a pass even when scheduled passes are disabled, at most once a minute', async () => {
  await getSettingsStore().set('STORAGE_SCAN_INTERVAL_HOURS', '0')
  const remote = fakeRemote(dirs, { budget: 100 })
  await runStorageMonitor(deps(remote))
  expect(remote.calls).toHaveLength(0)
  expect((await storageMonitorService.refresh(targets)).scanning).toBe(true)
  await runStorageMonitor(deps(remote))
  expect(remote.calls.length).toBeGreaterThan(0)
  const calls = remote.calls.length
  expect((await storageMonitorService.refresh(targets)).scanning).toBe(false)
  await runStorageMonitor(deps(remote))
  expect(remote.calls).toHaveLength(calls)
})

test('an offline machine keeps its pass and is reported as not ready', async () => {
  const remote = fakeRemote(dirs, { budget: 100 })
  remote.fail(() => ({ exitCode: 255, stdout: '', stderr: '' }))
  await runStorageMonitor(deps(remote))
  const calls = remote.calls.length
  expect(calls).toBe(1)
  const offline = async () => [{ machine: { ...machine, status: 'parked' } as Machine, owners: owners() }]
  await runStorageMonitor({ ...deps(remote), loadTargets: offline })
  expect(remote.calls).toHaveLength(calls)
  const read = await storageMonitorService.read(offline)
  expect(read.machines[0]!.diagnostics?.reasons).toContain('machine_not_ready')
  expect(read.machines[0]!.scan?.state).toBe('running')
})

test('coalesces workers and fences a stale scanner after ownership changes', async () => {
  const remote = fakeRemote(dirs, { budget: 100 })
  let entered!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = runStorageMonitor({
    ...deps(remote),
    runner: {
      run: async (...args) => {
        entered()
        await blocked
        return remote.runner.run(...args)
      },
    },
  })
  try {
    await ready
    const other = fakeRemote(dirs, { budget: 100 })
    await runStorageMonitor(deps(other))
    expect(other.calls).toHaveLength(0)
    await db.update(storageMonitor).set({ leaseId: crypto.randomUUID() })
  } finally {
    release()
    await first
  }
  expect((await storageMonitorService.read(targets)).machines[0]!.squads[0]!.bytes).toBeNull()
})

test('a failed tick keeps saved measurements and does not expose its details', async () => {
  await runStorageMonitor(deps(fakeRemote(dirs, { budget: 100, used: 88, size: 100 })))
  await db.update(storageMonitor).set({ leaseUntil: new Date(0), leaseId: crypto.randomUUID() })
  await runStorageMonitor({
    ...deps(fakeRemote(dirs, { budget: 100 })),
    loadTargets: async () => {
      throw new Error('private details')
    },
  })
  const result = await storageMonitorService.read(targets)
  expect(result.machines[0]!.usedBytes).toBe(88)
  expect(result.machines[0]!.squads[0]!.bytes).not.toBeNull()
  expect(result.error).toContain('storage scan step failed')
  expect(result.error).not.toContain('private details')
  await runStorageMonitor(deps(fakeRemote(dirs, { budget: 100 })))
  expect((await storageMonitorService.read(targets)).error).toBeNull()
})

test('inbox outbox retries a post-send crash without duplicating the system message', async () => {
  const original = InboxMessage.sendOnce.bind(InboxMessage)
  const send = spyOn(InboxMessage, 'sendOnce').mockImplementation(async (...args) => {
    await original(...args)
    throw new Error('crash after durable send')
  })
  try {
    await runStorageMonitor(deps(fakeRemote(dirs, { budget: 100, used: 96, size: 100 })))
  } finally {
    send.mockRestore()
  }
  expect((await db.select().from(storageMonitor))[0]?.pendingAlerts).toHaveLength(1)
  await runStorageMonitor(deps(fakeRemote(dirs, { budget: 100, used: 96, size: 100 })))
  expect((await db.select().from(storageMonitor))[0]?.pendingAlerts).toHaveLength(0)
  expect(
    await db
      .select()
      .from(inbox)
      .where(like(inbox.idempotencyKey, `storage-capacity:%:${machine.id}`))
  ).toHaveLength(1)
})

test('validates scan frequency and ordered capacity thresholds at the settings boundary', async () => {
  for (const value of ['', '-1', '0.5', '169', 'NaN'])
    await expect(getSettingsStore().set(keys[0]!, value)).rejects.toThrow()
  for (const value of ['', '0', '101', '90,80', '80,80', '80,'])
    await expect(getSettingsStore().set(keys[1]!, value)).rejects.toThrow()
})

test('reads describe agents from current owners and report dormant retention', async () => {
  await getSettingsStore().set('AGENT_DORMANT_RETENTION_DAYS', '3')
  try {
    await runStorageMonitor(deps(fakeRemote(dirs, { budget: 100 })))
    const agent = {
      id: crypto.randomUUID(),
      label: 'Plan launch',
      agentTypeId: 'consultant',
      status: 'dormant' as const,
      lastMessageAt: null,
      dormantAt: '2026-03-01T00:00:00.000Z',
      createdAt: null,
    }
    const read = await storageMonitorService.read(async () => [
      { machine, owners: [{ ...owners()[0]!, label: agent.label, kind: 'agent' as const, agent }] },
    ])
    expect(read.machines[0]!.squads[0]!.folders[0]).toMatchObject({ name: 'Plan launch', kind: 'agent', agent })
    expect(read.dormantRetentionDays).toBe(3)
  } finally {
    await getSettingsStore().delete('AGENT_DORMANT_RETENTION_DAYS')
  }
})
