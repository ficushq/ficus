import { isatty } from 'tty'
import type { Command } from 'commander'
import type { IdleConsultant, IdleConsultantsDormancyResult, IdleConsultantsPreview } from '@ficus/shared'
import { apiGet, apiPost } from '../client'
import { ApiRequestError } from '../client-errors'
import { readLine, StdinClosedError } from '../local-server/prompt'
import { output, outputError } from '../output'
import { formatAge, formatBytes, resolveSquadContext } from './squad-storage'

/** The server accepts at most 100 ids per request and works synchronously; the web app also sends 25. */
const DORMANCY_CHUNK = 25
const MIN_ID_PREFIX = 8

export interface IdleConsultantsOptions {
  days?: string
  agent?: string[]
  makeDormant?: boolean
  yes?: boolean
}

export interface IdleConsultantsDeps {
  /** Ask a yes/no question. Throw when nobody can answer. */
  confirm: (question: string) => boolean
}

/** Dormancy result across chunks; `error` is set when a later chunk failed after earlier ones succeeded. */
export type IdleConsultantsDormancyRun = IdleConsultantsDormancyResult & { days: number; error?: string }

/** Parse --days locally so a typo never reaches the API: a whole number from 1 to 3650. */
export function parseIdleDays(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const days = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN
  if (!Number.isInteger(days) || days < 1 || days > 3650)
    throw new Error('--days must be a whole number from 1 to 3650')
  return days
}

/**
 * Narrow the preview to the consultants named by --agent (a full id or a unique id prefix of at least
 * 8 characters). A name that is not in the preview is refused, so only consultants the server has just
 * reported as idle are ever sent: never other agent types, and never agents with active work.
 */
export function selectIdleConsultants(preview: IdleConsultant[], requested: string[] | undefined): IdleConsultant[] {
  if (!requested || requested.length === 0) return preview
  const selected = new Map<string, IdleConsultant>()
  for (const raw of requested) {
    const wanted = raw.trim().toLowerCase()
    if (wanted.length < MIN_ID_PREFIX)
      throw new Error(`--agent ${raw}: use a full agent id or an id prefix of at least ${MIN_ID_PREFIX} characters`)
    const matches = preview.filter((consultant) => consultant.id.toLowerCase().startsWith(wanted))
    if (matches.length === 0)
      throw new Error(
        `--agent ${raw} is not in the idle preview: it is not a consultant in this squad that has been idle that long, or it has work in progress`
      )
    if (matches.length > 1) throw new Error(`--agent ${raw} matches ${matches.length} consultants; use a longer prefix`)
    selected.set(matches[0]!.id, matches[0]!)
  }
  return preview.filter((consultant) => selected.has(consultant.id))
}

function lastActive(consultant: IdleConsultant, now: number): string {
  return consultant.lastMessageAt
    ? `last active ${formatAge(consultant.lastMessageAt, now)}`
    : `never messaged, created ${formatAge(consultant.createdAt, now)}`
}

/** Human-readable preview. Nothing in it changes anything. */
export function formatIdleConsultantsPreview(
  squadId: string,
  days: number,
  consultants: IdleConsultant[],
  now = Date.now()
): string {
  if (consultants.length === 0) return `No consultants in squad ${squadId} have been idle for ${days} days or more.`
  const measured = consultants.filter((consultant) => consultant.bytes !== null)
  const total = measured.reduce((sum, consultant) => sum + consultant.bytes!, 0)
  const lines = [
    `${consultants.length} consultant${consultants.length === 1 ? '' : 's'} in squad ${squadId} idle for ${days} days or more:`,
  ]
  for (const consultant of consultants)
    lines.push(
      `  ${consultant.id.slice(0, MIN_ID_PREFIX)}  ${consultant.label}  (${lastActive(consultant, now)}; box ${formatBytes(consultant.bytes)})`
    )
  lines.push(
    `Measured box size: ${formatBytes(measured.length > 0 ? total : null)}. Dormancy stops these consultants and releases their compute; a new message wakes one again. Their history and files are kept until the dormant-retention period removes them.`
  )
  return lines.join('\n')
}

export function formatDormancyRun(run: IdleConsultantsDormancyRun): string {
  const lines = [`Made ${run.dormant.length} dormant.`]
  if (run.deferred.length > 0)
    lines.push(`${run.deferred.length} will become dormant after their current turn: ${run.deferred.join(', ')}`)
  if (run.skipped.length > 0) {
    lines.push(`Left ${run.skipped.length} unchanged:`)
    for (const skipped of run.skipped) lines.push(`  ${skipped.id}: ${skipped.reason}`)
  }
  if (run.error) lines.push(`Stopped early: ${run.error}. The remaining consultants were not changed.`)
  return lines.join('\n')
}

/** Make a forbidden response say which permission is missing, instead of a bare status. */
export function explainIdleConsultantsError(error: unknown, squadId: string): Error {
  if (error instanceof ApiRequestError && error.status === 403)
    return new Error(
      `Forbidden: idle consultants in squad ${squadId} can only be previewed or made dormant with the agents:terminate permission in that squad`
    )
  return error instanceof Error ? error : new Error(String(error))
}

/** Default confirmation: only a person at a terminal can say yes; anything else must pass --yes. */
export function confirmOnTerminal(question: string, interactive = isatty(0)): boolean {
  if (!interactive)
    throw new Error('Refusing to make consultants dormant without confirmation: pass --yes (no terminal to ask on)')
  try {
    // stderr, so --json output on stdout stays parseable.
    const answer = readLine(`${question} [y/N] `, 2).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } catch (error) {
    if (error instanceof StdinClosedError) return false
    throw error
  }
}

async function makeDormantInChunks(squadId: string, days: number, ids: string[]): Promise<IdleConsultantsDormancyRun> {
  const run: IdleConsultantsDormancyRun = { days, dormant: [], deferred: [], skipped: [] }
  for (let start = 0; start < ids.length; start += DORMANCY_CHUNK) {
    try {
      const result = await apiPost<IdleConsultantsDormancyResult>(
        `/api/squads/${encodeURIComponent(squadId)}/idle-consultants/dormant`,
        { days, agentIds: ids.slice(start, start + DORMANCY_CHUNK) }
      )
      run.dormant.push(...result.dormant)
      run.deferred.push(...result.deferred)
      run.skipped.push(...result.skipped)
    } catch (error) {
      if (start === 0) throw error
      run.error = explainIdleConsultantsError(error, squadId).message
      break
    }
  }
  return run
}

/**
 * Preview a squad's idle consultants (the default, which changes nothing) or, with --make-dormant and a
 * confirmation, make the previewed ones dormant through POST /api/squads/:id/idle-consultants/dormant.
 * The server recomputes the idle set and re-checks each consultant; the ids sent only narrow it.
 * Dormancy keeps history and archives. Returns the process exit code.
 */
export async function runIdleConsultants(
  squadArg: string | undefined,
  options: IdleConsultantsOptions,
  deps: IdleConsultantsDeps = { confirm: confirmOnTerminal }
): Promise<number> {
  if (options.yes && !options.makeDormant) throw new Error('--yes only applies together with --make-dormant')
  const squadId = resolveSquadContext(squadArg)
  const requestedDays = parseIdleDays(options.days)
  const query = requestedDays === undefined ? '' : `?days=${requestedDays}`
  let preview: IdleConsultantsPreview
  try {
    preview = await apiGet<IdleConsultantsPreview>(
      `/api/squads/${encodeURIComponent(squadId)}/idle-consultants${query}`
    )
  } catch (error) {
    throw explainIdleConsultantsError(error, squadId)
  }
  const selected = selectIdleConsultants(preview.agents, options.agent)
  const text = formatIdleConsultantsPreview(squadId, preview.days, selected)

  if (!options.makeDormant) {
    const hint =
      selected.length > 0
        ? '\nPreview only; nothing was changed. Add --make-dormant to make these consultants dormant.'
        : ''
    output({ dryRun: true, days: preview.days, agents: selected }, text + hint)
    return 0
  }
  if (selected.length === 0) {
    output({ dryRun: false, days: preview.days, dormant: [], deferred: [], skipped: [] }, text)
    return 0
  }
  if (!options.yes) {
    process.stderr.write(`${text}\n`)
    const count = `${selected.length} consultant${selected.length === 1 ? '' : 's'}`
    if (!deps.confirm(`Make ${count} dormant?`)) {
      output({ dryRun: false, aborted: true, days: preview.days, agents: selected }, 'Aborted; nothing was changed.')
      return 0
    }
  }
  let run: IdleConsultantsDormancyRun
  try {
    run = await makeDormantInChunks(
      squadId,
      preview.days,
      selected.map((consultant) => consultant.id)
    )
  } catch (error) {
    throw explainIdleConsultantsError(error, squadId)
  }
  output({ dryRun: false, ...run }, formatDormancyRun(run))
  return run.error ? 1 : 0
}

export function registerSquadIdleConsultantsCommand(squad: Command): void {
  squad
    .command('idle-consultants [squad-id]')
    .description(
      "Preview a squad's idle consultants, or make them dormant with --make-dormant (requires agents:terminate in that squad)"
    )
    .option('--days <n>', 'Idle for at least this many days, 1 to 3650 (default: the server default, 30)')
    .option(
      '--agent <id>',
      'Only this consultant from the preview (full id or a prefix of at least 8 characters); repeatable',
      (value: string, previous: string[] = []) => [...previous, value]
    )
    .option('--make-dormant', 'Make the previewed (or selected) consultants dormant after confirmation')
    .option('-y, --yes', 'With --make-dormant, skip the confirmation prompt (required without a terminal)')
    .addHelpText(
      'after',
      '\nPass a squad id or an id prefix of at least 8 characters; defaults to the current squad (FICUS_SQUAD_ID).\n' +
        'Without --make-dormant this is a preview and changes nothing.\n' +
        'Only idle consultants qualify: never other agent types, and never consultants with active work, a waiting\n' +
        'message or an open work stream. The server re-checks each one before making it dormant.\n' +
        'Dormancy keeps history and archives; a new message wakes the consultant again.'
    )
    .action(async (squadArg: string | undefined, options: IdleConsultantsOptions) => {
      try {
        const code = await runIdleConsultants(squadArg, options)
        if (code !== 0) process.exitCode = code
      } catch (error) {
        outputError(error as Error)
      }
    })
}
