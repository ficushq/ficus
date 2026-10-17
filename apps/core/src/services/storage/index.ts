import { inArray } from 'drizzle-orm'
import { agents, db, squads } from '../../db'
import { listAllMachineBoxes, listMachines } from '../machines/queries'
import type { Machine, MachineBox } from '../machines/queries'
import type { StorageOwner } from './accounting'
import { storageAgentColumns, storageAgentInfo, type StorageAgentRow } from './agents'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The squad-owned box homes on one machine: the squad's workspace box, and each
 * agent's personal box labelled with that agent. Unknown squads/agents are skipped.
 */
export function buildStorageOwners(
  machineId: string,
  boxes: Array<Pick<MachineBox, 'machineId' | 'sandboxId' | 'unixUser'>>,
  squadRows: Array<{ id: string; name: string }>,
  agentRows: StorageAgentRow[]
): StorageOwner[] {
  const names = new Map(squadRows.map((squad) => [squad.id, squad.name]))
  const agentsById = new Map(agentRows.map((agent) => [agent.id, agent]))
  const owners: StorageOwner[] = []
  for (const box of boxes) {
    if (box.machineId !== machineId || !/^box_[a-f0-9]{12}$/.test(box.unixUser)) continue
    const home = `/home/${box.unixUser}`
    if (box.sandboxId.startsWith('squad_')) {
      const squadId = box.sandboxId.slice(6)
      if (names.has(squadId))
        owners.push({
          home,
          squadId,
          squadName: names.get(squadId)!,
          label: 'Squad workspace',
          kind: 'squad-workspace',
        })
      continue
    }
    if (!box.sandboxId.startsWith('agent_')) continue
    const agent = agentsById.get(box.sandboxId.slice(6))
    if (!agent?.squadId || !names.has(agent.squadId)) continue
    const info = storageAgentInfo(agent)
    owners.push({
      home,
      squadId: agent.squadId,
      squadName: names.get(agent.squadId)!,
      label: info.label,
      kind: 'agent',
      agent: info,
    })
  }
  return owners
}

export interface StorageTarget {
  machine: Machine
  owners: StorageOwner[]
}

/** Non-terminated machines with the squad-owned box homes bound to each. */
export async function loadStorageTargets(): Promise<StorageTarget[]> {
  const [machines, boxes, squadRows] = await Promise.all([
    listMachines(),
    listAllMachineBoxes(),
    db.select({ id: squads.id, name: squads.name }).from(squads),
  ])
  // Only agents that own a personal box on some machine.
  const agentIds = [
    ...new Set(boxes.flatMap((box) => (box.sandboxId.startsWith('agent_') ? [box.sandboxId.slice(6)] : []))),
  ].filter((id) => UUID.test(id))
  const agentRows = agentIds.length
    ? await db.select(storageAgentColumns).from(agents).where(inArray(agents.id, agentIds))
    : []
  return machines
    .filter((machine) => machine.status !== 'terminated')
    .map((machine) => ({ machine, owners: buildStorageOwners(machine.id, boxes, squadRows, agentRows) }))
}
