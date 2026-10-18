import { and, asc, desc, inArray, lte, sql } from 'drizzle-orm'
import type { StorageGrowth, StorageMachine, StorageSnapshot } from '@ficus/shared'
import { db } from '../../db'
import { storageHomeResults, storageScanItems, storageScanPasses, storageUsageSamples } from '../../db/schema'
import type { Machine } from '../machines/queries'
import { attributeStorage, type HomeView, type StorageOwner } from './accounting'

export interface StorageViewTarget {
  machine: Pick<Machine, 'id' | 'name' | 'status'>
  owners: StorageOwner[]
}

type Reason = NonNullable<StorageMachine['diagnostics']>['reasons'][number]
const GROWTH_WINDOW_MS = 24 * 3_600_000
const key = (machineId: string, subject: string) => `${machineId}\0${subject}`

/**
 * Growth baselines: per subject, the newest sample at least 24 hours old, else
 * the oldest retained one. Samples are pruned after the retention period.
 */
async function growthBaselines(machineIds: string[]) {
  const columns = {
    machineId: storageUsageSamples.machineId,
    subject: storageUsageSamples.subject,
    bytes: storageUsageSamples.bytes,
    measuredAt: storageUsageSamples.measuredAt,
  }
  const scope = inArray(storageUsageSamples.machineId, machineIds)
  const [dayOld, oldest] = await Promise.all([
    db
      .selectDistinctOn([storageUsageSamples.machineId, storageUsageSamples.subject], columns)
      .from(storageUsageSamples)
      .where(and(scope, lte(storageUsageSamples.measuredAt, new Date(Date.now() - GROWTH_WINDOW_MS))))
      .orderBy(storageUsageSamples.machineId, storageUsageSamples.subject, desc(storageUsageSamples.measuredAt)),
    db
      .selectDistinctOn([storageUsageSamples.machineId, storageUsageSamples.subject], columns)
      .from(storageUsageSamples)
      .where(scope)
      .orderBy(storageUsageSamples.machineId, storageUsageSamples.subject, asc(storageUsageSamples.measuredAt)),
  ])
  const baselines = new Map<string, { bytes: number; measuredAt: Date }>()
  for (const row of oldest) baselines.set(key(row.machineId, row.subject), row)
  for (const row of dayOld) baselines.set(key(row.machineId, row.subject), row)
  return baselines
}

function growth(
  baseline: { bytes: number; measuredAt: Date } | undefined,
  bytes: number | null,
  measuredAt: Date | null
): StorageGrowth | undefined {
  if (!baseline || bytes === null || !measuredAt || baseline.measuredAt >= measuredAt) return undefined
  return { bytes: bytes - baseline.bytes, since: baseline.measuredAt.toISOString() }
}

/**
 * The storage view from persisted scan state: every box home's latest completed
 * value with when it was measured, whether it came from the current pass, and
 * its growth. Reads never start or wait for filesystem work.
 */
export async function buildStorageSnapshot(targets: StorageViewTarget[]): Promise<StorageSnapshot> {
  const machineIds = targets.map((target) => target.machine.id)
  if (!machineIds.length) return { supported: true, scanning: false, scannedAt: null, error: null, machines: [] }
  const [passes, results, baselines] = await Promise.all([
    db
      .select()
      .from(storageScanPasses)
      .where(inArray(storageScanPasses.machineId, machineIds))
      .orderBy(desc(storageScanPasses.generation)),
    db.select().from(storageHomeResults).where(inArray(storageHomeResults.machineId, machineIds)),
    growthBaselines(machineIds),
  ])
  const runningIds = passes.filter((pass) => pass.status === 'running').map((pass) => pass.id)
  const resolvedHomes = new Map<string, number>()
  if (runningIds.length) {
    const homes = await db
      .select({
        passId: storageScanItems.passId,
        resolved: sql<boolean>`bool_and(${storageScanItems.state} in ('done', 'split', 'failed'))`,
      })
      .from(storageScanItems)
      .where(inArray(storageScanItems.passId, runningIds))
      .groupBy(storageScanItems.passId, storageScanItems.home)
    for (const home of homes)
      if (home.resolved) resolvedHomes.set(home.passId, (resolvedHomes.get(home.passId) ?? 0) + 1)
  }

  let scannedAt: Date | null = null
  const later = (date: Date | null) => {
    if (date && (!scannedAt || date > scannedAt)) scannedAt = date
  }
  const machines = targets.map(({ machine, owners }): StorageMachine => {
    const own = passes.filter((pass) => pass.machineId === machine.id)
    const running = own.find((pass) => pass.status === 'running')
    const completed = own.find((pass) => pass.status === 'completed')
    const current = running ?? completed
    const disk = own.find((pass) => pass.diskMeasuredAt && pass.usedBytes !== null && pass.totalBytes !== null)
    later(completed?.completedAt ?? null)

    const homes = new Map<string, HomeView>()
    const errors = new Set<string>()
    for (const result of results) {
      if (result.machineId !== machine.id) continue
      later(result.measuredAt)
      for (const error of result.errors) errors.add(error)
      homes.set(result.home, {
        folder: result.folder,
        measuredAt: result.measuredAt.toISOString(),
        freshness: current && result.generation === current.generation ? 'current' : 'previous',
        totalExact: result.totalExact,
        // Baselines are exact samples only, so an approximate total is never compared with one.
        growth:
          result.status === 'available' && result.totalExact
            ? growth(baselines.get(key(machine.id, result.home)), result.bytes, result.measuredAt)
            : undefined,
      })
    }
    const expected = [...new Set(owners.map((owner) => owner.home))]
    const missingHomes = expected.filter((home) => !homes.has(home))
    const squads = attributeStorage(homes, owners)
    const allMeasured = !missingHomes.length
    const allAvailable = allMeasured && expected.every((home) => homes.get(home)!.folder.status === 'available')
    const measuredBytes = squads.reduce((sum, squad) => sum + (squad.bytes ?? 0), 0)

    const reasons: Reason[] = []
    if (machine.status !== 'ready') reasons.push('machine_not_ready')
    if (current?.lastError) reasons.push(current.lastError)
    if (errors.has('scan_timeout')) reasons.push('scan_timeout')
    if (errors.has('permission_denied')) reasons.push('permission_denied')
    if (missingHomes.length) reasons.push('missing_home_totals')
    if (!disk) reasons.push('disk_usage_unavailable')

    return {
      id: machine.id,
      name: machine.name,
      status: allAvailable && disk ? 'available' : homes.size || disk ? 'partial' : 'unavailable',
      usedBytes: disk?.usedBytes ?? null,
      totalBytes: disk?.totalBytes ?? null,
      diskMeasuredAt: disk?.diskMeasuredAt?.toISOString() ?? null,
      ...(disk
        ? { diskGrowth: growth(baselines.get(key(machine.id, 'host')), disk.usedBytes, disk.diskMeasuredAt) }
        : {}),
      squads,
      // Values from different moments: approximate, and never negative.
      unattributedBytes: allMeasured && disk ? Math.max(0, disk.usedBytes! - measuredBytes) : null,
      ...(current
        ? {
            scan: {
              state: running ? ('running' as const) : ('idle' as const),
              generation: current.generation,
              passStartedAt: current.startedAt.toISOString(),
              lastCompletedAt: completed?.completedAt?.toISOString() ?? null,
              measuredHomes: running ? (resolvedHomes.get(running.id) ?? 0) : current.homes,
              totalHomes: current.homes,
            },
          }
        : {}),
      diagnostics: {
        exitCode: null,
        reasons,
        expectedHomes: expected.length,
        measuredHomes: expected.length - missingHomes.length,
        missingHomes,
      },
    }
  })
  return {
    supported: true,
    scanning: runningIds.length > 0,
    scannedAt: (scannedAt as Date | null)?.toISOString() ?? null,
    error: null,
    machines,
  }
}
