import type { LocalDeployment } from '@ficus/shared'

type SortableLocalDeployment = Pick<LocalDeployment, 'id' | 'name' | 'status' | 'updatedAt'>

/** Lower ranks list first: live apps, then in-progress, then degraded, then stopped. */
const STATUS_RANK: Record<string, number> = {
  running: 0,
  starting: 1,
  restarting: 1,
  unhealthy: 2,
  crashed: 3,
  stopped: 4,
}
const UNKNOWN_STATUS_RANK = 5

function statusRank(status: string): number {
  return STATUS_RANK[status] ?? UNKNOWN_STATUS_RANK
}

/** Milliseconds since the epoch, or -Infinity for a missing or unparseable timestamp so it sorts last. */
function updatedAtTime(updatedAt: string | Date): number {
  const time = new Date(updatedAt).getTime()
  return Number.isNaN(time) ? -Infinity : time
}

/**
 * Orders local apps for display: by status (running first, unknown last), then
 * most recently updated first, then by name and id so the order is stable.
 */
export function compareLocalDeployments(a: SortableLocalDeployment, b: SortableLocalDeployment): number {
  const byStatus = statusRank(a.status) - statusRank(b.status)
  if (byStatus !== 0) return byStatus
  const aTime = updatedAtTime(a.updatedAt)
  const bTime = updatedAtTime(b.updatedAt)
  if (aTime !== bTime) return aTime < bTime ? 1 : -1
  const byName = a.name.localeCompare(b.name)
  if (byName !== 0) return byName
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** A sorted copy; the input array is left untouched. */
export function sortLocalDeployments<T extends SortableLocalDeployment>(localDeployments: readonly T[]): T[] {
  return [...localDeployments].sort(compareLocalDeployments)
}
