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

/** When retention removes the earliest of these dormant agents, or null when none has a dormancy time. */
export function automaticRemovalDate(dormantAt: Array<string | null>, retentionDays: number): Date | null {
  const times = dormantAt.flatMap((value) => (value ? [Date.parse(value)] : []))
  if (!times.length) return null
  return new Date(Math.min(...times) + retentionDays * DAY_MS)
}

export const sumBytes = (items: Array<{ bytes: number | null }>) =>
  items.reduce((sum, item) => sum + (item.bytes ?? 0), 0)

export function removalSummary(result: RemoveDormantAgentsResult & { error?: string }): string {
  const n = result.accepted.length
  const parts = [`Removing ${n} dormant agent${n === 1 ? '' : 's'} in the background.`]
  for (const skipped of result.skipped) parts.push(`Not removed: ${skipped.reason}`)
  if (result.error) parts.push(`Stopped after an error: ${result.error}`)
  return parts.join(' ')
}

export function parseIdleDays(raw: string): number | null {
  const value = Number(raw.trim())
  return raw.trim() !== '' && Number.isInteger(value) && value >= 1 && value <= 3650 ? value : null
}

export function idleDormancySummary(result: IdleConsultantsDormancyResult & { error?: string }): string {
  const parts = [`Made ${result.dormant.length} idle consultant${result.dormant.length === 1 ? '' : 's'} dormant.`]
  if (result.deferred.length) parts.push(`${result.deferred.length} will become dormant after their current turn.`)
  if (result.skipped.length) {
    const byReason = new Map<string, number>()
    for (const skipped of result.skipped) byReason.set(skipped.reason, (byReason.get(skipped.reason) ?? 0) + 1)
    parts.push(
      `Left alone: ${[...byReason].map(([reason, count]) => `${count} ${reason.replace(/\.$/, '')}`).join('; ')}.`
    )
  }
  if (result.error) parts.push(`Stopped after an error: ${result.error}`)
  return parts.join(' ')
}
