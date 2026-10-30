import type {
  IdleConsultantsDormancyResult,
  RemoveDormantAgentsResult,
  SquadStorageScan,
  StorageAgent,
  StorageFolder,
  StorageGrowth,
  StorageMachine,
} from '@ficus/shared'

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

/** Tooltip for a box home whose total is the sum of separately measured folders. */
export const APPROXIMATE_TOTAL_HINT =
  'Hard-linked files may be counted more than once: this home could not be measured in one go, so its total adds up folders measured separately.'

/** Tooltip for a squad total that includes an approximate home total. */
export const APPROXIMATE_SQUAD_HINT =
  'Includes an approximate home total: hard-linked files may be counted more than once.'

/** A squad's size, with ≈ when any of its homes' totals is approximate. */
export function squadSize(squad: { bytes: number | null; status?: string; totalExact?: boolean }): string {
  return `${squad.totalExact === false && squad.bytes !== null ? '≈ ' : ''}${measuredSize(squad)}`
}

const DAY_MS = 86_400_000

/** "45s", "12m", "3h", "2d". */
export function durationLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86_400)}d`
}

/** "+12.0 GiB in 24h", "−300.0 MiB in 3h", "no change in 1h". */
export function growthLabel(growth: StorageGrowth, now = Date.now()): string {
  const window = durationLabel(now - Date.parse(growth.since))
  if (growth.bytes === 0) return `no change in ${window}`
  return `${growth.bytes > 0 ? '+' : '−'}${storageSize(Math.abs(growth.bytes))} in ${window}`
}

/** Growth worth calling out: at least 1 GiB. */
export const fastGrowth = (growth: StorageGrowth | undefined) => Boolean(growth && growth.bytes >= 1024 ** 3)

/** "measured 12m ago · previous pass · +1.2 GiB in 24h" for a box home; empty before incremental scanning. */
export function homeFreshness(folder: Pick<StorageFolder, 'measuredAt' | 'freshness'>, now = Date.now()): string {
  if (!folder.measuredAt) return ''
  const parts = [`measured ${durationLabel(now - Date.parse(folder.measuredAt))} ago`]
  if (folder.freshness === 'previous') parts.push('previous pass')
  return parts.join(' · ')
}

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

/** "Pass 14: 180 of 234 homes measured, started 12m ago." */
export function scanProgressLabel(scan: NonNullable<StorageMachine['scan']>, now = Date.now()): string {
  const started = `${durationLabel(now - Date.parse(scan.passStartedAt))} ago`
  if (scan.state === 'running')
    return `Pass ${scan.generation}: ${scan.measuredHomes} of ${scan.totalHomes} homes measured, started ${started}.`
  return scan.lastCompletedAt
    ? `Last full pass finished ${durationLabel(now - Date.parse(scan.lastCompletedAt))} ago.`
    : `Pass ${scan.generation} started ${started}.`
}

/**
 * Scan timing for a squad's view of a machine, which omits home counts (they cover every squad):
 * "Pass 14 is measuring, started 12m ago." or "Last full pass finished 3h ago."
 */
export function squadScanLabel(scan: SquadStorageScan, now = Date.now()): string {
  const started = `${durationLabel(now - Date.parse(scan.passStartedAt))} ago`
  if (scan.state === 'running') return `Pass ${scan.generation} is measuring, started ${started}.`
  return scan.lastCompletedAt
    ? `Last full pass finished ${durationLabel(now - Date.parse(scan.lastCompletedAt))} ago.`
    : `Pass ${scan.generation} started ${started}.`
}
