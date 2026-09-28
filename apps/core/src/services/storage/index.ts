import type { StorageMachine, StorageSnapshot } from '@ficus/shared'
import { agents, db, squads } from '../../db'
import { mapWithConcurrency } from '../../lib/infra/mapWithConcurrency'
import { parseDfOutput } from '../machines/machine-health'
import { listAllMachineBoxes, listMachines } from '../machines/queries'
import type { Machine } from '../machines/queries'
import type { SshRunner } from '../machines/ssh'
import { defaultSshRunner, SshTimeoutError } from '../machines/ssh'
import { isVmRuntime } from '../sandbox/runtime'
import { attributeStorage, parseDirectoryUsage, type StorageOwner } from './accounting'

// One traversal per machine: GNU du deduplicates hardlinks within the scan.
// -x avoids mounted filesystems, -P (the default) avoids symlink traversal.
// Best-effort CPU and I/O priorities let foreground work take precedence.
// Remote timeout also terminates the traversal if the SSH connection is lost.
export const STORAGE_SCAN_COMMAND =
  "export LC_ALL=C; df -B1 --output=used,size /home; printf '\\0'; sudo -n timeout 45s nice -n 19 ionice -c 3 du -x -B1 --max-depth=4 --null /home"

function unmeasuredMachine(
  machine: Machine,
  owners: StorageOwner[],
  reason: 'machine_not_ready' | 'ssh_failed' | 'ssh_timeout'
): StorageMachine {
  const homes = [...new Set(owners.map((owner) => owner.home))]
  return {
    id: machine.id,
    name: machine.name,
    status: 'unavailable',
    usedBytes: null,
    totalBytes: null,
    squads: attributeStorage(new Map(), owners),
    unattributedBytes: null,
    diagnostics: {
      exitCode: null,
      reasons: [reason],
      expectedHomes: homes.length,
      measuredHomes: 0,
      missingHomes: homes,
    },
  }
}

export async function scanStorage(): Promise<StorageSnapshot> {
  if (!isVmRuntime())
    return {
      supported: false,
      scanning: false,
      scannedAt: new Date().toISOString(),
      error: null,
      machines: [],
    }
  const [machines, boxes, squadRows, agentRows] = await Promise.all([
    listMachines(),
    listAllMachineBoxes(),
    db.select({ id: squads.id, name: squads.name }).from(squads),
    db.select({ id: agents.id, squadId: agents.squadId }).from(agents),
  ])
  const names = new Map(squadRows.map((squad) => [squad.id, squad.name]))
  const agentSquads = new Map(agentRows.map((agent) => [agent.id, agent.squadId]))
  const results = await mapWithConcurrency(
    machines.filter((machine) => machine.status !== 'terminated'),
    2,
    async (machine): Promise<StorageMachine> => {
      const owners: StorageOwner[] = []
      for (const box of boxes.filter((box) => box.machineId === machine.id)) {
        const squadId = box.sandboxId.startsWith('squad_')
          ? box.sandboxId.slice(6)
          : box.sandboxId.startsWith('agent_')
            ? agentSquads.get(box.sandboxId.slice(6))
            : null
        if (!squadId || !names.has(squadId) || !/^box_[a-f0-9]{12}$/.test(box.unixUser)) continue
        owners.push({
          home: `/home/${box.unixUser}`,
          squadId,
          squadName: names.get(squadId)!,
          label: box.sandboxId.startsWith('squad_') ? 'Squad workspace and tools' : 'Agent files',
        })
      }
      // Inspection must never provision, wake or start workloads.
      if (machine.status !== 'ready') return unmeasuredMachine(machine, owners, 'machine_not_ready')
      return measureMachineStorage(machine, owners)
    }
  )
  return { supported: true, scanning: false, scannedAt: new Date().toISOString(), error: null, machines: results }
}

export async function measureMachineStorage(
  machine: Machine,
  owners: StorageOwner[],
  runner: SshRunner = defaultSshRunner
): Promise<StorageMachine> {
  const empty = unmeasuredMachine(machine, owners, 'ssh_failed')
  try {
    const result = await runner.run(machine, STORAGE_SCAN_COMMAND, { timeoutMs: 55_000 })
    const separator = result.stdout.indexOf('\0')
    const disk = separator < 0 ? null : parseDfOutput(result.stdout.slice(0, separator))
    const entries = parseDirectoryUsage(separator < 0 ? '' : result.stdout.slice(separator + 1))
    const homes = [...new Set(owners.map((owner) => owner.home))]
    const missingHomes = homes.filter((home) => !entries.has(home))
    const reasons: NonNullable<StorageMachine['diagnostics']>['reasons'] = []
    if (result.exitCode === 124) reasons.push('scan_timeout')
    // Never expose raw SSH/du stderr (it can contain sensitive paths). The
    // remote command uses the C locale so these fixed classifications are stable.
    if (/permission denied|operation not permitted/i.test(result.stderr)) reasons.push('permission_denied')
    if (result.exitCode !== 0 && !reasons.length) reasons.push('scan_failed')
    if (separator < 0 || !entries.has('/home') || !result.stdout.endsWith('\0')) reasons.push('incomplete_output')
    if (missingHomes.length) reasons.push('missing_home_totals')
    if (!disk) reasons.push('disk_usage_unavailable')
    const complete = reasons.length === 0
    const attributed = attributeStorage(entries, owners, !complete)
    const measuredBytes = attributed.reduce((sum, squad) => sum + (squad.bytes ?? 0), 0)
    return {
      ...empty,
      status: complete ? 'available' : 'partial',
      usedBytes: disk?.usedBytes ?? null,
      totalBytes: disk?.totalBytes ?? null,
      squads: attributed,
      unattributedBytes: complete && disk ? Math.max(0, disk.usedBytes - measuredBytes) : null,
      diagnostics: {
        exitCode: result.exitCode,
        reasons,
        expectedHomes: homes.length,
        measuredHomes: homes.length - missingHomes.length,
        missingHomes,
      },
    }
  } catch (error) {
    return unmeasuredMachine(machine, owners, error instanceof SshTimeoutError ? 'ssh_timeout' : 'ssh_failed')
  }
}
