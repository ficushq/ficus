import { and, eq, sql } from 'drizzle-orm'
import { SYSTEM_RECIPIENT_ID, type StorageSnapshot, type StorageStatus } from '@ficus/shared'
import { db } from '../../db'
import { storageMonitor } from '../../db/schema'
import { createLogger } from '../../lib/infra/logger'
import { InboxMessage } from '../../entities/InboxMessage'
import { getSettingsStore } from '../settings'
import { isVmRuntime } from '../sandbox/runtime'
import { scanStorage } from './index'

const ID = 'default'
const log = createLogger('storage-monitor')
const empty: StorageSnapshot = { supported: true, scanning: false, scannedAt: null, error: null, machines: [] }
type Row = typeof storageMonitor.$inferSelect

export function storageMonitoringSettings() {
  const store = getSettingsStore()
  return {
    intervalHours: Number(store.get('STORAGE_SCAN_INTERVAL_HOURS')),
    alertsEnabled: store.get('STORAGE_ALERTS_ENABLED') === 'true',
    thresholds: store.get('STORAGE_ALERT_THRESHOLDS').split(',').map(Number),
  }
}

/** Missing measurements retain the last warning as stale; they are never recovery. */
export function evaluateStorageWarnings(
  snapshot: StorageSnapshot,
  previous: Row['levels'],
  thresholds: number[],
  alertsEnabled: boolean,
  scanId: string
) {
  const levels: Row['levels'] = {}
  const alerts: Row['pendingAlerts'] = []
  for (const machine of snapshot.machines) {
    const old = previous[machine.id]
    if (machine.usedBytes === null || machine.totalBytes === null || machine.totalBytes <= 0 || !snapshot.scannedAt) {
      if (old) levels[machine.id] = { ...old, stale: true }
      continue
    }
    const percent = Math.min(100, (machine.usedBytes / machine.totalBytes) * 100)
    let threshold = thresholds.filter((value) => percent >= value).at(-1) ?? 0
    // Three percentage points of hysteresis prevent repeated alerts around a boundary.
    if (old && thresholds.includes(old.threshold) && percent > Math.max(0, old.threshold - 3))
      threshold = Math.max(threshold, old.threshold)
    const warning = {
      machineId: machine.id,
      machineName: machine.name,
      percent,
      threshold,
      measuredAt: snapshot.scannedAt,
      stale: false,
    }
    levels[machine.id] = warning
    if (alertsEnabled && threshold > (old?.threshold ?? 0)) alerts.push({ id: `${scanId}:${machine.id}`, warning })
  }
  return { levels, alerts }
}

async function readRow(full = true) {
  return (
    await db
      .select({
        id: storageMonitor.id,
        snapshot: full
          ? storageMonitor.snapshot
          : sql<StorageSnapshot | null>`case when ${storageMonitor.snapshot} is null then null else jsonb_build_object('supported', ${storageMonitor.snapshot}->'supported', 'scannedAt', ${storageMonitor.snapshot}->'scannedAt', 'error', ${storageMonitor.snapshot}->'error') end`,
        requestedAt: storageMonitor.requestedAt,
        startedAt: storageMonitor.startedAt,
        completedAt: storageMonitor.completedAt,
        leaseId: storageMonitor.leaseId,
        leaseUntil: storageMonitor.leaseUntil,
        error: storageMonitor.error,
        levels: storageMonitor.levels,
        pendingAlerts: storageMonitor.pendingAlerts,
      })
      .from(storageMonitor)
      .where(eq(storageMonitor.id, ID))
  )[0]
}

function status(row: Row | undefined): StorageStatus {
  const config = storageMonitoringSettings()
  const snapshot = row?.snapshot ?? { ...empty, supported: isVmRuntime() }
  const interval = config.intervalHours * 3_600_000
  const delay = row?.error ? Math.min(interval, 15 * 60_000) : interval
  const next =
    isVmRuntime() && snapshot.supported && interval
      ? (row?.completedAt?.getTime() ?? Date.now()) + (row?.completedAt ? delay : 0)
      : null
  const scanning = Boolean(
    row &&
    ((row.leaseUntil && row.leaseUntil.getTime() > Date.now()) ||
      (row.requestedAt && (!row.startedAt || row.requestedAt > row.startedAt)))
  )
  return {
    supported: isVmRuntime() && snapshot.supported,
    scanning,
    scannedAt: snapshot.scannedAt,
    error: row?.error ?? snapshot.error,
    monitoring: { ...config, nextScanAt: next === null ? null : new Date(next).toISOString() },
    warnings: Object.values(row?.levels ?? {})
      .filter((level) => isVmRuntime() && level.threshold > 0)
      .map((level) => ({
        ...level,
        stale:
          level.stale ||
          Boolean(row?.error) ||
          Date.now() - Date.parse(level.measuredAt) > (interval || 12 * 3_600_000) * 1.5,
      })),
  }
}

export const storageMonitorService = {
  async read(): Promise<StorageSnapshot> {
    const row = await readRow()
    return { ...(row?.snapshot ?? empty), ...status(row), ...(!isVmRuntime() ? { machines: [], warnings: [] } : {}) }
  },
  async status(): Promise<StorageStatus> {
    return status(await readRow(false))
  },
  async refresh(): Promise<StorageSnapshot> {
    if (isVmRuntime()) {
      await db.insert(storageMonitor).values({ id: ID }).onConflictDoNothing()
      await db
        .update(storageMonitor)
        .set({ requestedAt: sql`now()` })
        .where(
          and(
            eq(storageMonitor.id, ID),
            sql`(${storageMonitor.leaseUntil} is null or ${storageMonitor.leaseUntil} < now())`,
            sql`(${storageMonitor.requestedAt} is null or ${storageMonitor.requestedAt} < now() - interval '1 minute')`,
            sql`(${storageMonitor.startedAt} is null or ${storageMonitor.startedAt} < now() - interval '1 minute')`
          )
        )
    }
    return this.read()
  },
}

async function drainAlerts() {
  if (!storageMonitoringSettings().alertsEnabled) return
  const row = await readRow(false)
  for (const alert of row?.pendingAlerts ?? []) {
    const w = alert.warning
    await InboxMessage.sendOnce(
      {
        recipientType: 'system',
        recipientId: SYSTEM_RECIPIENT_ID,
        senderType: 'system',
        wakeEligible: false,
        subject: `Storage capacity: ${w.machineName} reached ${w.threshold}%`,
        content: `${w.machineName} was ${w.percent.toFixed(1)}% full at ${w.measuredAt}.\n\nReview Settings → Storage for the measured squad and folder breakdown. No files were removed and no agents were started.`,
        metadata: {
          source: 'storage-capacity',
          machineId: w.machineId,
          threshold: w.threshold,
          measuredAt: w.measuredAt,
        },
      },
      `storage-capacity:${alert.id}`
    )
    // Remove only this delivered item, preserving alerts appended by another scan.
    await db
      .update(storageMonitor)
      .set({
        pendingAlerts: sql`coalesce((select jsonb_agg(item) from jsonb_array_elements(${storageMonitor.pendingAlerts}) item where item->>'id' <> ${alert.id}), '[]'::jsonb)`,
      })
      .where(eq(storageMonitor.id, ID))
  }
}

/** Worker-only scheduler. HTTP reads never start filesystem work. */
export async function runStorageMonitor(scan = scanStorage): Promise<void> {
  if (!isVmRuntime()) return
  await db.insert(storageMonitor).values({ id: ID }).onConflictDoNothing()
  await drainAlerts().catch(() => log.warn('Storage alert delivery deferred; durable alerts will retry.'))
  const { intervalHours, thresholds, alertsEnabled } = storageMonitoringSettings()
  const token = crypto.randomUUID()
  const intervalMs = intervalHours * 3_600_000
  const [claim] = await db
    .update(storageMonitor)
    .set({
      leaseId: token,
      leaseUntil: sql`now() + interval '3 minutes'`,
      startedAt: sql`now()`,
    })
    .where(
      and(
        eq(storageMonitor.id, ID),
        sql`(${storageMonitor.leaseUntil} is null or ${storageMonitor.leaseUntil} < now())`,
        sql`(
      (${storageMonitor.requestedAt} is not null and (${storageMonitor.startedAt} is null or ${storageMonitor.requestedAt} > ${storageMonitor.startedAt}))
      or ${storageMonitor.leaseId} is not null
      or (${intervalMs} > 0 and (${storageMonitor.completedAt} is null or ${storageMonitor.completedAt} <= now() - (case when ${storageMonitor.error} is null then ${intervalMs} else least(${intervalMs}, 900000) end) * interval '1 millisecond'))
    )`
      )
    )
    .returning()
  if (!claim) return
  const fence = and(
    eq(storageMonitor.id, ID),
    eq(storageMonitor.leaseId, token),
    sql`${storageMonitor.leaseUntil} > now()`
  )
  // Bound each traversal in the scanner, renewing only this worker's ownership.
  const heartbeat = setInterval(() => {
    void db
      .update(storageMonitor)
      .set({ leaseUntil: sql`now() + interval '3 minutes'` })
      .where(fence)
      .catch(() => {})
  }, 30_000)
  try {
    const snapshot = await scan()
    if (snapshot.error) throw new Error('scan failed')
    const result = evaluateStorageWarnings(snapshot, claim.levels, thresholds, alertsEnabled, token)
    await db
      .update(storageMonitor)
      .set({
        snapshot,
        levels: result.levels,
        error: null,
        completedAt: sql`now()`,
        leaseId: null,
        leaseUntil: null,
        pendingAlerts: sql`${storageMonitor.pendingAlerts} || ${JSON.stringify(result.alerts)}::jsonb`,
      })
      .where(fence)
  } catch {
    await db
      .update(storageMonitor)
      .set({
        error:
          'The last storage scan failed. Previous measurements are retained. Refresh to retry, or wait for the next scheduled attempt.',
        completedAt: sql`now()`,
        leaseId: null,
        leaseUntil: null,
      })
      .where(fence)
  } finally {
    clearInterval(heartbeat)
  }
  await drainAlerts().catch(() => log.warn('Storage alert delivery deferred; durable alerts will retry.'))
}
