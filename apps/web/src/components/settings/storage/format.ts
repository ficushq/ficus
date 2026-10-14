import type { IdleConsultantsDormancyResult, RemoveDormantAgentsResult, StorageAgent } from '@ficus/shared'

export function storageSize(bytes: number | null): string {
  if (bytes === null) return 'Unavailable'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1)
  return `${(bytes / 1024 ** (index + 1)).toFixed(1)} ${units[index]}`
}

export function measuredSize(item: { bytes: number | null; status?: string }): string {
  if (item.bytes === null) return 'Not measured'
  return `${storageSize(item.bytes)}${item.status === 'partial' ? ' measured · Partial' : ''}`
}

const DAY_MS = 86_400_000

/** "today", "1 day ago", "12 days ago". */
export function daysAgoLabel(iso: string, now = Date.now()): string {
  const days = Math.max(0, Math.floor((now - Date.parse(iso)) / DAY_MS))
  return days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`
}

/** "consultant · idle · last active 3 days ago" */
export function agentDetails(agent: StorageAgent): string {
  const status = agent.status === 'terminated' ? 'removed' : agent.status.replace('-', ' ')
  const activity = agent.lastMessageAt ? `last active ${daysAgoLabel(agent.lastMessageAt)}` : 'never messaged'
  return `${agent.agentTypeId} · ${status} · ${activity}`
}

/** When retention removes the earliest of these dormant agents. */
export function automaticRemovalDate(dormantAt: Array<string | null>, retentionDays: number): string | null {
  const times = dormantAt.flatMap((value) => (value ? [Date.parse(value)] : []))
  if (!times.length) return null
  return new Date(Math.min(...times) + retentionDays * DAY_MS).toLocaleDateString()
}

export const sumBytes = (items: Array<{ bytes: number | null }>) =>
  items.reduce((sum, item) => sum + (item.bytes ?? 0), 0)

export function removalSummary(result: RemoveDormantAgentsResult): string {
  const parts = [`Removed ${result.removed.length} dormant agent${result.removed.length === 1 ? '' : 's'}.`]
  if (result.pending.length) parts.push(`${result.pending.length} are still stopping; try again shortly.`)
  for (const skipped of result.skipped) parts.push(`Not removed: ${skipped.reason}`)
  return parts.join(' ')
}

export function parseIdleDays(raw: string): number | null {
  const value = Number(raw.trim())
  return raw.trim() !== '' && Number.isInteger(value) && value >= 1 && value <= 3650 ? value : null
}

export function idleDormancySummary(result: IdleConsultantsDormancyResult): string {
  const parts = [`Made ${result.dormant.length} idle consultant${result.dormant.length === 1 ? '' : 's'} dormant.`]
  if (result.deferred.length) parts.push(`${result.deferred.length} will become dormant after their current turn.`)
  if (result.skipped.length) parts.push(`${result.skipped.length} were no longer idle and were left alone.`)
  return parts.join(' ')
}
