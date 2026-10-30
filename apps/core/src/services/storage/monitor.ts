import { and, eq, sql } from 'drizzle-orm'
import {
  STORAGE_ALERT_HYSTERESIS_POINTS,
  SYSTEM_RECIPIENT_ID,
  type StorageSnapshot,
  type StorageStatus,
} from '@ficus/shared'
import { db } from '../../db'
import { storageMonitor, storageScanPasses } from '../../db/schema'
import { createLogger } from '../../lib/infra/logger'
import { mapWithConcurrency } from '../../lib/infra/mapWithConcurrency'
import { InboxMessage } from '../../entities/InboxMessage'
import type { SshRunner } from '../machines/ssh'
import { defaultSshRunner } from '../machines/ssh'
import { getSettingsStore } from '../settings'
import { isVmRuntime } from '../sandbox/runtime'
import { loadStorageTargets, type StorageTarget } from './index'
import { pruneRemovedMachines, scanMachine } from './scanner'
import { buildStorageSnapshot } from './view'

const ID = 'default'
const log = createLogger('storage-monitor')
/** Chunks start only within this window of each one-minute worker tick. */
const TICK_BUDGET_MS = 40_000
type Row = typeof storageMonitor.$inferSelect
type StatusRow = Pick<Row, 'requestedAt' | 'error' | 'levels'>

export function storageMonitoringSettings() {
  const store = getSettingsStore()
  return {
    intervalHours: Number(store.get('STORAGE_SCAN_INTERVAL_HOURS')),
    alertsEnabled: store.get('STORAGE_ALERTS_ENABLED') === 'true',
    thresholds: store.get('STORAGE_ALERT_THRESHOLDS').split(',').map(Number),
  }
}

/** Same fallback as runDormantAgentSweep: invalid or non-positive values mean the 7-day default. */
export function dormantRetentionDays(): number {
  const configured = Number(getSettingsStore().getTyped('AGENT_DORMANT_RETENTION_DAYS'))
  return Number.isFinite(configured) && configured > 0 ? configured : 7
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
    // Hysteresis prevents repeated alerts around a boundary.
    if (
      old &&
      thresholds.includes(old.threshold) &&
      percent > Math.max(0, old.threshold - STORAGE_ALERT_HYSTERESIS_POINTS)
    )
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

async function readRow(): Promise<StatusRow | undefined> {
  return (
    await db
      .select({ requestedAt: storageMonitor.requestedAt, error: storageMonitor.error, levels: storageMonitor.levels })
      .from(storageMonitor)
      .where(eq(storageMonitor.id, ID))
  )[0]
}

/** Pass timing across machines: the latest pass start, and whether any pass is measuring. */
async function passActivity() {
  const [row] = await db
    .select({
      lastStartedAt: sql<string | null>`max(${storageScanPasses.startedAt})`,
      running: sql<boolean>`coalesce(bool_or(${storageScanPasses.status} = 'running'), false)`,
    })
    .from(storageScanPasses)
  return { lastStartedAt: row?.lastStartedAt ? new Date(row.lastStartedAt) : null, running: Boolean(row?.running) }
}

async function status(row: StatusRow | undefined, scannedAt: string | null): Promise<StorageStatus> {
  const config = storageMonitoringSettings()
  const interval = config.intervalHours * 3_600_000
  const activity = isVmRuntime() ? await passActivity() : { lastStartedAt: null, running: false }
  const requested = Boolean(row?.requestedAt && (!activity.lastStartedAt || row.requestedAt > activity.lastStartedAt))
  const next =
    isVmRuntime() && interval && !activity.running
      ? Math.max(Date.now(), (activity.lastStartedAt?.getTime() ?? 0) + interval)
      : null
  return {
    supported: isVmRuntime(),
    scanning: activity.running || requested,
    scannedAt,
    error: row?.error ?? null,
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

async function lastScannedAt(): Promise<string | null> {
  const [row] = await db
    .select({ at: sql<string | null>`max(${storageScanPasses.diskMeasuredAt})` })
    .from(storageScanPasses)
  return row?.at ? new Date(row.at).toISOString() : null
}

export const storageMonitorService = {
  /** Latest persisted measurements; never starts or waits for a scan. */
  async read(loadTargets: () => Promise<StorageTarget[]> = loadStorageTargets): Promise<StorageSnapshot> {
    const row = await readRow()
    if (!isVmRuntime())
      return {
        ...(await status(row, null)),
        machines: [],
        warnings: [],
        dormantRetentionDays: dormantRetentionDays(),
      }
    const snapshot = await buildStorageSnapshot(await loadTargets())
    const current = await status(row, snapshot.scannedAt)
    return {
      ...snapshot,
      ...current,
      scanning: snapshot.scanning || current.scanning,
      dormantRetentionDays: dormantRetentionDays(),
    }
  },
  async status(): Promise<StorageStatus> {
    return status(await readRow(), isVmRuntime() ? await lastScannedAt() : null)
  },
  /** Ask for a pass now (once a minute at most); the worker starts it on its next tick. */
  async refresh(loadTargets?: () => Promise<StorageTarget[]>): Promise<StorageSnapshot> {
    if (isVmRuntime()) {
      await db.insert(storageMonitor).values({ id: ID }).onConflictDoNothing()
      await db
        .update(storageMonitor)
        .set({ requestedAt: sql`now()` })
        .where(
          and(
            eq(storageMonitor.id, ID),
            sql`(${storageMonitor.requestedAt} is null or ${storageMonitor.requestedAt} < now() - interval '1 minute')`
          )
        )
    }
    return this.read(loadTargets)
  },
}

async function drainAlerts() {
  if (!storageMonitoringSettings().alertsEnabled) return
  const [row] = await db
    .select({ pendingAlerts: storageMonitor.pendingAlerts })
    .from(storageMonitor)
    .where(eq(storageMonitor.id, ID))
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

export interface StorageMonitorDeps {
  runner?: SshRunner
  loadTargets?: () => Promise<StorageTarget[]>
  /** How long this tick may start chunks. */
  budgetMs?: number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Worker-only scheduler tick (every minute). HTTP reads never start filesystem
 * work. One worker at a time holds the lease and advances each ready machine's
 * pass by a few paced chunks; all progress is in the database, so the next tick
 * (in any worker, after any restart) continues where this one stopped.
 */
export async function runStorageMonitor(deps: StorageMonitorDeps = {}): Promise<void> {
  if (!isVmRuntime()) return
  await db.insert(storageMonitor).values({ id: ID }).onConflictDoNothing()
  await drainAlerts().catch(() => log.warn('Storage alert delivery deferred; durable alerts will retry.'))
  const { intervalHours, thresholds, alertsEnabled } = storageMonitoringSettings()
  const token = crypto.randomUUID()
  const [claim] = await db
    .update(storageMonitor)
    .set({ leaseId: token, leaseUntil: sql`now() + interval '3 minutes'`, startedAt: sql`now()` })
    .where(
      and(
        eq(storageMonitor.id, ID),
        sql`(${storageMonitor.leaseUntil} is null or ${storageMonitor.leaseUntil} < now())`
      )
    )
    .returning()
  if (!claim) return
  const fence = and(
    eq(storageMonitor.id, ID),
    eq(storageMonitor.leaseId, token),
    sql`${storageMonitor.leaseUntil} > now()`
  )
  const heartbeat = setInterval(() => {
    void db
      .update(storageMonitor)
      .set({ leaseUntil: sql`now() + interval '3 minutes'` })
      .where(fence)
      .catch(() => {})
  }, 30_000)
  try {
    const targets = await (deps.loadTargets ?? loadStorageTargets)()
    await pruneRemovedMachines(targets.map((target) => target.machine.id))
    const deadline = Date.now() + (deps.budgetMs ?? TICK_BUDGET_MS)
    // Offline or parked machines are skipped; their pass resumes when they are ready again.
    const readings = await mapWithConcurrency(
      targets.filter((target) => target.machine.status === 'ready'),
      2,
      async ({ machine, owners }) => ({
        machine,
        disk: await scanMachine(
          { machine, homes: owners.map((owner) => owner.home) },
          {
            runner: deps.runner ?? defaultSshRunner,
            deadline,
            intervalMs: intervalHours * 3_600_000,
            requestedAt: claim.requestedAt,
            sleep: deps.sleep,
            holdsLease: async (tx) =>
              (await tx.select({ id: storageMonitor.id }).from(storageMonitor).where(fence).for('update')).length > 0,
          }
        ),
      })
    )
    const measuredAt = new Date().toISOString()
    const result = evaluateStorageWarnings(
      {
        supported: true,
        scanning: true,
        scannedAt: measuredAt,
        error: null,
        machines: readings.flatMap(({ machine, disk }) =>
          disk
            ? [
                {
                  id: machine.id,
                  name: machine.name,
                  status: 'available' as const,
                  ...disk,
                  squads: [],
                  unattributedBytes: null,
                },
              ]
            : []
        ),
      },
      claim.levels,
      thresholds,
      alertsEnabled,
      token
    )
    await db
      .update(storageMonitor)
      .set({
        // Machines without a reading this tick keep their level.
        levels: { ...claim.levels, ...result.levels },
        error: null,
        completedAt: sql`now()`,
        leaseId: null,
        leaseUntil: null,
        pendingAlerts: sql`${storageMonitor.pendingAlerts} || ${JSON.stringify(result.alerts)}::jsonb`,
      })
      .where(fence)
  } catch (error) {
    log.warn('Storage scan tick failed; progress is saved and the next tick resumes.', error)
    await db
      .update(storageMonitor)
      .set({
        error: 'The last storage scan step failed. Saved measurements are kept, and scanning resumes automatically.',
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
