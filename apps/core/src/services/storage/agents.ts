import { inArray, sql } from 'drizzle-orm'
import { formatAgentLabel, type StorageAgent, type StorageFolder, type StorageSnapshot } from '@ficus/shared'
import { agents, db } from '../../db'
import { REMOVE_NOW_DORMANT_AT_KEY } from '../../entities/agent-queries'

export const storageAgentColumns = {
  id: agents.id,
  squadId: agents.squadId,
  agentTypeId: agents.agentTypeId,
  status: agents.status,
  name: sql<string | null>`${agents.metadata}->>'name'`,
  purpose: sql<string | null>`${agents.metadata}->>'purpose'`,
  removeNowDormantAt: sql<string | null>`${agents.metadata}->>${REMOVE_NOW_DORMANT_AT_KEY}`,
  lastMessageAt: agents.lastMessageAt,
  dormantAt: agents.dormantAt,
  createdAt: agents.createdAt,
}

export type StorageAgentRow = Pick<
  typeof agents.$inferSelect,
  'id' | 'squadId' | 'agentTypeId' | 'status' | 'lastMessageAt' | 'dormantAt' | 'createdAt'
> & { name: string | null; purpose: string | null; removeNowDormantAt?: string | null }

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)

/** The storage view's description of an agent: who it is and how recently it was used. */
export function storageAgentInfo(row: StorageAgentRow): StorageAgent {
  return {
    id: row.id,
    label: formatAgentLabel({ name: row.name, purpose: row.purpose, agentTypeId: row.agentTypeId }),
    agentTypeId: row.agentTypeId,
    status: row.status,
    lastMessageAt: iso(row.lastMessageAt),
    dormantAt: iso(row.dormantAt),
    createdAt: iso(row.createdAt),
    // The request applies only to the dormancy episode it was made for.
    ...(row.status === 'dormant' &&
    row.dormantAt &&
    row.removeNowDormantAt != null &&
    Number(row.removeNowDormantAt) === row.dormantAt.getTime()
      ? { removalPending: true }
      : {}),
  }
}

function agentFolders(snapshot: StorageSnapshot): StorageFolder[] {
  return snapshot.machines.flatMap((machine) =>
    machine.squads.flatMap((squad) => squad.folders.filter((folder) => folder.agent))
  )
}

/**
 * Saved snapshots describe agents as they were at scan time. Refresh the agent
 * fields from the database so a status change (made dormant, removed) shows
 * immediately; sizes still update only on the next scan.
 */
export async function withCurrentAgentInfo(snapshot: StorageSnapshot): Promise<StorageSnapshot> {
  const folders = agentFolders(snapshot)
  if (!folders.length) return snapshot
  const ids = [...new Set(folders.map((folder) => folder.agent!.id))]
  const rows = await db.select(storageAgentColumns).from(agents).where(inArray(agents.id, ids))
  const current = new Map(rows.map((row) => [row.id, storageAgentInfo(row)]))
  for (const folder of folders) {
    const info = current.get(folder.agent!.id)
    if (!info) continue
    folder.agent = info
    folder.name = info.label
  }
  return snapshot
}

/** Latest measured bytes of each agent's box home(s), summed across machines. */
export function agentStorageBytes(snapshot: StorageSnapshot): Map<string, number> {
  const sizes = new Map<string, number>()
  for (const folder of agentFolders(snapshot))
    if (folder.bytes !== null) sizes.set(folder.agent!.id, (sizes.get(folder.agent!.id) ?? 0) + folder.bytes)
  return sizes
}
