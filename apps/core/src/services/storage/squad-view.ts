import type { SquadStorageMachine, SquadStorageView, StorageSnapshot, StorageStatus } from '@ficus/shared'
import { isVmRuntime } from '../sandbox/runtime'
import { loadStorageTargets, type StorageTarget } from './index'
import { dormantRetentionDays, storageMonitorService } from './monitor'
import { summarizeSquadStoredFiles } from './stored-files'
import { buildStorageSnapshot } from './view'

/**
 * Keep only one squad's box homes. Machines that hold none of them are dropped, so the
 * snapshot built from the result never reads or labels another squad's homes.
 */
export function scopeStorageTargets(targets: StorageTarget[], squadId: string): StorageTarget[] {
  return targets.flatMap(({ machine, owners }) => {
    const own = owners.filter((owner) => owner.squadId === squadId)
    return own.length ? [{ machine, owners: own }] : []
  })
}

/**
 * Project a snapshot onto one squad, field by field. Only the squad's own entry and the
 * machine identity and scan timing are copied: host used/total bytes, disk growth,
 * unattributed bytes, diagnostics, scan home counts and other squads are never carried.
 * This holds even for an unscoped snapshot, so a scoping mistake upstream cannot leak.
 */
export function projectSquadStorage(
  snapshot: Pick<StorageSnapshot, 'machines'>,
  squadId: string
): Pick<SquadStorageView, 'bytes' | 'machines' | 'scannedAt' | 'oldestMeasuredAt'> {
  const machines: SquadStorageMachine[] = []
  for (const machine of snapshot.machines) {
    const storage = machine.squads.find((squad) => squad.id === squadId)
    if (!storage) continue
    machines.push({
      id: machine.id,
      name: machine.name,
      storage: structuredClone(storage),
      ...(machine.scan
        ? {
            scan: {
              state: machine.scan.state,
              generation: machine.scan.generation,
              passStartedAt: machine.scan.passStartedAt,
              lastCompletedAt: machine.scan.lastCompletedAt,
            },
          }
        : {}),
    })
  }
  const measured = machines.filter((machine) => machine.storage.bytes !== null)
  const times = machines
    .flatMap((machine) => machine.storage.folders.flatMap((folder) => (folder.measuredAt ? [folder.measuredAt] : [])))
    .sort()
  return {
    bytes: measured.length ? measured.reduce((sum, machine) => sum + machine.storage.bytes!, 0) : null,
    machines,
    scannedAt: times.at(-1) ?? null,
    oldestMeasuredAt: times[0] ?? null,
  }
}

export interface SquadStorageDeps {
  loadTargets?: () => Promise<StorageTarget[]>
}

/**
 * One squad's storage from persisted measurements and database rows. Read-only: like
 * the system view it never starts, requests or waits for a scan, so squad callers
 * cannot drive instance-wide filesystem work.
 */
export async function readSquadStorage(
  squad: { id: string; name: string },
  deps: SquadStorageDeps = {}
): Promise<SquadStorageView> {
  const vm = isVmRuntime()
  const [status, storedFiles, snapshot] = await Promise.all([
    storageMonitorService.status(),
    summarizeSquadStoredFiles(squad.id),
    vm
      ? (deps.loadTargets ?? loadStorageTargets)().then((targets) =>
          buildStorageSnapshot(scopeStorageTargets(targets, squad.id))
        )
      : Promise.resolve({ machines: [] }),
  ])
  return {
    squad: { id: squad.id, name: squad.name },
    supported: vm,
    ...squadStatus(status),
    dormantRetentionDays: dormantRetentionDays(),
    ...projectSquadStorage(snapshot, squad.id),
    storedFiles,
  }
}

/** Instance scan state without its capacity warnings (host disk percentages) or host scan time. */
function squadStatus(status: StorageStatus): Pick<SquadStorageView, 'scanning' | 'error' | 'monitoring'> {
  return {
    scanning: status.scanning,
    error: status.error,
    monitoring: { intervalHours: status.monitoring.intervalHours, nextScanAt: status.monitoring.nextScanAt },
  }
}
