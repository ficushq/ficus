import type { Command } from 'commander'
import type { SquadStorageView, StorageFolder, StorageGrowth } from '@ficus/shared'
import { apiGet } from '../client'
import { output, outputError } from '../output'

/** Subfolders listed under each box home in the human-readable view. */
const SUBFOLDERS_PER_HOME = 5

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'not measured'
  const sign = bytes < 0 ? '-' : ''
  let value = Math.abs(bytes)
  if (value < 1024) return `${sign}${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let unit = -1
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${sign}${value.toFixed(1)} ${units[unit]}`
}

function span(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 1440)}d`
}

/** "5m ago", "3h ago", "2d ago" relative to `now`. */
export function formatAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  return `${span(Math.max(0, Math.round((now - Date.parse(iso)) / 60_000)))} ago`
}

/** "in 20m", or "due now" once the time has passed. */
function formatUntil(iso: string, now: number): string {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000)
  return minutes > 0 ? `in ${span(minutes)}` : 'due now'
}

function formatGrowth(growth: StorageGrowth | undefined, now: number): string {
  if (!growth) return ''
  return ` (${growth.bytes >= 0 ? '+' : ''}${formatBytes(growth.bytes)} since ${formatAge(growth.since, now)})`
}

function homeLabel(folder: StorageFolder): string {
  if (folder.kind === 'squad-workspace') return 'Squad workspace'
  if (!folder.agent) return `${folder.name} [agent no longer exists]`
  const notes = [folder.agent.agentTypeId, folder.agent.status, folder.agent.id.slice(0, 8)]
  return `${folder.name} [${notes.join(', ')}]`
}

function sizeOf(folder: { bytes: number | null; status: string; totalExact?: boolean }): string {
  const approximate = folder.totalExact === false ? '≈' : ''
  const partial = folder.status === 'partial' ? ' (partial)' : ''
  return `${approximate}${formatBytes(folder.bytes)}${partial}`
}

/** Human-readable view of GET /api/squads/:id/storage. */
export function formatSquadStorage(view: SquadStorageView, now = Date.now()): string {
  const lines = [`Storage for squad ${view.squad.name} (${view.squad.id})`]
  if (!view.supported) {
    lines.push('Box measurements are not available on this runtime; only stored files are counted.')
  } else {
    lines.push(
      `Box homes: ${formatBytes(view.bytes)}. Newest measurement ${formatAge(view.scannedAt, now)}, oldest ${formatAge(view.oldestMeasuredAt, now)}.`
    )
    const cadence = view.monitoring.intervalHours
      ? `a pass every ${view.monitoring.intervalHours}h`
      : 'manual passes only'
    const next = view.monitoring.nextScanAt ? `, next pass ${formatUntil(view.monitoring.nextScanAt, now)}` : ''
    lines.push(`Scanning: ${view.scanning ? 'in progress' : 'idle'} (${cadence}${next}).`)
  }
  if (view.error) lines.push(`Scan error: ${view.error}`)

  for (const machine of view.machines) {
    lines.push('', `Machine ${machine.name}: ${sizeOf(machine.storage)}${formatGrowth(machine.storage.growth, now)}`)
    for (const home of machine.storage.folders) {
      const freshness = home.freshness === 'previous' ? ', from the previous pass' : ''
      lines.push(
        `  ${homeLabel(home)}: ${sizeOf(home)}, measured ${formatAge(home.measuredAt, now)}${freshness}${formatGrowth(home.growth, now)}`
      )
      for (const child of home.children.slice(0, SUBFOLDERS_PER_HOME)) {
        lines.push(`      ${child.path}: ${sizeOf(child)}`)
      }
      if (home.children.length > SUBFOLDERS_PER_HOME)
        lines.push(`      ... ${home.children.length - SUBFOLDERS_PER_HOME} more (use --json for the full tree)`)
    }
  }
  if (view.supported && view.machines.length === 0) lines.push('', 'No box homes measured for this squad yet.')

  lines.push('', `Stored files on the Ficus host: ${formatBytes(view.storedFiles.bytes)}`)
  for (const source of view.storedFiles.sources) lines.push(`  ${source.label}: ${formatBytes(source.bytes)}`)
  lines.push(
    '',
    `Dormant agents are removed ${view.dormantRetentionDays} days after they become dormant. Sizes are allocated-byte estimates, not deletion suggestions.`
  )
  return lines.join('\n')
}

/** Resolve the squad to read: an explicit id or name wins, else FICUS_SQUAD_ID (set inside squad boxes). */
export function resolveStorageSquad(explicit: string | undefined, environment = process.env.FICUS_SQUAD_ID): string {
  const squad = explicit ?? environment
  if (!squad) throw new Error('No squad context: pass a squad id or name, or run inside a squad agent box.')
  return squad
}

export function registerSquadStorageCommand(squad: Command): void {
  squad
    .command('storage [squad]')
    .description(
      "Show one squad's storage breakdown: box homes, folders, growth and stored files (requires storage:read in that squad)"
    )
    .addHelpText(
      'after',
      '\nDefaults to the current squad (FICUS_SQUAD_ID). Read-only: shows the latest measurements and their age,\n' +
        'and never starts a scan. Use --json for the full folder tree. Instance-wide storage is ficus system storage (system:logs).'
    )
    .action(async (squadArg: string | undefined) => {
      try {
        const squadId = resolveStorageSquad(squadArg)
        const view = await apiGet<SquadStorageView>(`/api/squads/${encodeURIComponent(squadId)}/storage`)
        output(view, formatSquadStorage(view))
      } catch (error) {
        outputError(error as Error)
      }
    })
}
