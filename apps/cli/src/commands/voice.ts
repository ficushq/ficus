import { readFileSync, writeFileSync } from 'fs'
import type { Command } from 'commander'
import {
  DERIVATION_SURFACES,
  PUBLIC_SURFACES,
  PUBLIC_SURFACE_CLI_NAMES,
  PUBLIC_SURFACE_LABELS,
  publicSurfaceFromCliName,
  type DerivationFilters,
  type PublicSurface,
  type PublicVoiceProfileJson,
  type PublicVoiceSurfaces,
} from '@ficus/shared'
import { apiDelete, apiGet, apiPost, apiPut } from '../client'
import { ApiRequestError } from '../client-errors'
import { isJsonMode, output, outputError, outputTable } from '../output'

/**
 * `ficus voice`: instance-level voice profiles (agent-types:read / agent-types:update),
 * and the shared helpers `ficus squad voice` uses. See docs/wiki/public-voice.md.
 */

const SURFACE_NAMES = PUBLIC_SURFACES.map((s) => PUBLIC_SURFACE_CLI_NAMES[s]).join(', ')

function collect(value: string, previous: string[] = []): string[] {
  return previous.concat([value])
}

export function parseSurfaceName(name: string): PublicSurface {
  const surface = publicSurfaceFromCliName(name)
  if (!surface) throw new Error(`Unknown surface "${name}". Use one of: ${SURFACE_NAMES}`)
  return surface
}

/** `--text` or `--file`, never both. */
export function readTextOption(opts: { text?: string; file?: string }, what: string): string | undefined {
  if (opts.text !== undefined && opts.file) throw new Error(`Give ${what} with --text or --file, not both`)
  if (opts.file) return readFileSync(opts.file, 'utf8').trim()
  return opts.text
}

/** Repeatable `--add <surface=text>` and `--override <surface=text>` into surface entries. */
export function parseSurfaceEntries(add: string[] = [], override: string[] = []): PublicVoiceSurfaces {
  const surfaces: PublicVoiceSurfaces = {}
  const put = (spec: string, mode: 'add' | 'override') => {
    const at = spec.indexOf('=')
    if (at <= 0) throw new Error(`Expected <surface>=<text>, got "${spec}"`)
    const surface = parseSurfaceName(spec.slice(0, at).trim())
    if (surfaces[surface]) throw new Error(`Surface "${spec.slice(0, at)}" is given twice`)
    surfaces[surface] = { mode, text: spec.slice(at + 1).trim() }
  }
  for (const spec of add) put(spec, 'add')
  for (const spec of override) put(spec, 'override')
  return surfaces
}

/** A draft written by `derive --out`: `{ draft: { base, surfaces } }` or `{ base, surfaces }`. */
export function readDraftFile(path: string): { base: string; surfaces: PublicVoiceSurfaces } {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const draft = (parsed.draft ?? parsed) as { base?: unknown; surfaces?: unknown }
  if (typeof draft.base !== 'string' || !draft.base.trim()) throw new Error(`${path} has no draft "base" text`)
  return { base: draft.base, surfaces: (draft.surfaces as PublicVoiceSurfaces) ?? {} }
}

interface DeriveOptions {
  github: string
  before?: string
  after?: string
  repo?: string[]
  excludeRepo?: string[]
  surfaces?: string
  includeToolAuthored?: boolean
  confirmOtherPerson?: boolean
  out?: string
}

export function buildDerivationFilters(opts: DeriveOptions): DerivationFilters {
  const filters: DerivationFilters = {}
  if (opts.before) filters.before = opts.before
  if (opts.after) filters.after = opts.after
  if (opts.repo?.length) filters.repositories = opts.repo
  if (opts.excludeRepo?.length) filters.excludeRepositories = opts.excludeRepo
  if (opts.surfaces) {
    const names = opts.surfaces
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const unknown = names.filter((n) => !(DERIVATION_SURFACES as readonly string[]).includes(n))
    if (unknown.length)
      throw new Error(`Unknown sampling surface(s): ${unknown.join(', ')}. Use: ${DERIVATION_SURFACES.join(', ')}`)
    filters.surfaces = names as DerivationFilters['surfaces']
  }
  if (opts.includeToolAuthored) filters.excludeToolAuthored = false
  return filters
}

export function addDeriveOptions(command: Command): Command {
  return command
    .requiredOption('--github <login>', 'GitHub login whose writing to sample')
    .option(
      '--before <date>',
      'Only items created before this date (YYYY-MM-DD), for example when Ficus started posting from the account'
    )
    .option('--after <date>', 'Only items created on or after this date (YYYY-MM-DD)')
    .option('--repo <owner/name>', 'Only this repository (repeatable)', collect, [])
    .option('--exclude-repo <owner/name>', 'Leave out this repository (repeatable)', collect, [])
    .option('--surfaces <list>', `Comma-separated: ${DERIVATION_SURFACES.join(', ')}`)
    .option('--include-tool-authored', 'Keep items that look written by an assistant or a bot')
    .option('--confirm-other-person', 'Confirm deriving from a login that is not your linked GitHub account')
    .option('--out <path>', 'Write the draft as JSON to this file')
}

interface DerivationResponse {
  login: string
  draft: { base: string; surfaces: PublicVoiceSurfaces }
  observations: string[]
  exemplars: Array<{ surface: PublicSurface; text: string; repository: string }>
  sampling: {
    filters: DerivationFilters
    counts: {
      collected: number
      kept: number
      droppedByFilter: { date: number; repository: number }
      droppedAsToolAuthored: number
      droppedAsTemplate: number
    }
    dateRange: Record<string, { oldest: string; newest: string }>
    publicRepositories: string[]
    privateRepositories: string[]
    pagingCapped: boolean
  }
  bytes: number
  maxBytes: number
}

/** Run a derivation through a squad's GitHub connection and print the draft; nothing is saved. */
export async function runDerivation(squadId: string, opts: DeriveOptions): Promise<void> {
  const body = {
    login: opts.github,
    ...(opts.confirmOtherPerson ? { confirmOtherPerson: true } : {}),
    filters: buildDerivationFilters(opts),
  }
  let result: DerivationResponse
  try {
    result = await apiPost<DerivationResponse>(`/api/squads/${squadId}/voice/derive`, body)
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 409) {
      throw new Error(
        `${opts.github} is not your linked GitHub account. The draft describes a writing style only; agents never sign as or claim to be that person. Re-run with --confirm-other-person to continue.`,
        { cause: error }
      )
    }
    throw error
  }
  if (opts.out) writeFileSync(opts.out, `${JSON.stringify(result, null, 2)}\n`)
  if (isJsonMode()) return output(result)

  const { counts } = result.sampling
  console.log(`Samples: kept ${counts.kept} of ${counts.collected} collected`)
  console.log(
    `  left out: ${counts.droppedByFilter.date} by date, ${counts.droppedByFilter.repository} by repository, ${counts.droppedAsToolAuthored} as tool-authored (heuristic), ${counts.droppedAsTemplate} as templates or too short`
  )
  for (const [surface, range] of Object.entries(result.sampling.dateRange)) {
    console.log(`  ${surface}: ${range.oldest} to ${range.newest}`)
  }
  if (result.sampling.pagingCapped) console.log('  Paging stopped at its limit; older items may exist.')
  console.log(`  public repositories: ${result.sampling.publicRepositories.join(', ') || 'none'}`)
  console.log(`  private repositories (paraphrased only): ${result.sampling.privateRepositories.join(', ') || 'none'}`)
  console.log('\nObservations:')
  for (const o of result.observations) console.log(`  - ${o}`)
  if (result.exemplars.length) {
    console.log('\nExemplars (public repositories only):')
    for (const e of result.exemplars) console.log(`  - [${e.repository}] ${e.text}`)
  }
  console.log(`\nDraft (${result.bytes} / ${result.maxBytes} bytes):\n`)
  console.log(result.draft.base)
  for (const surface of PUBLIC_SURFACES) {
    const entry = result.draft.surfaces[surface]
    if (entry) console.log(`- ${PUBLIC_SURFACE_LABELS[surface]} (${entry.mode}): ${entry.text}`)
  }
  console.log(
    `\nNothing was saved. Review and edit the draft, then save it with ficus voice create <id> --name <name> --from-draft <file> or ficus squad voice set ${squadId} --file <file>.`
  )
}

function printProfile(profile: PublicVoiceProfileJson): void {
  console.log(`${profile.name} (${profile.id})${profile.disabled ? ' [disabled]' : ''}`)
  if (profile.description) console.log(profile.description)
  console.log(`${profile.bytes} bytes; assigned squads: ${profile.assignedSquadCount ?? 0}`)
  if (profile.yamlFieldOverrides.length)
    console.log(`Edited from the shipped template: ${profile.yamlFieldOverrides.join(', ')}`)
  console.log(`\n${profile.base}`)
  for (const surface of PUBLIC_SURFACES) {
    const entry = profile.surfaces[surface]
    if (entry) console.log(`- ${PUBLIC_SURFACE_CLI_NAMES[surface]} (${entry.mode}): ${entry.text}`)
  }
}

interface ProfileOptions {
  name?: string
  description?: string
  text?: string
  file?: string
  fromDraft?: string
  add?: string[]
  override?: string[]
}

function addProfileOptions(command: Command): Command {
  return command
    .option('--name <name>', 'Display name')
    .option('--description <text>', 'Short description')
    .option('--text <voice>', 'The voice applied to every surface')
    .option('--file <path>', 'Read the voice from a file')
    .option('--from-draft <path>', 'Use the base and surface notes of a draft written by derive --out')
    .option(
      '--add <surface=text>',
      `Add to the voice on one surface (repeatable; surfaces: ${SURFACE_NAMES})`,
      collect,
      []
    )
    .option('--override <surface=text>', 'Replace the voice on one surface (repeatable)', collect, [])
}

function profileBody(opts: ProfileOptions, existing?: PublicVoiceProfileJson) {
  const draft = opts.fromDraft ? readDraftFile(opts.fromDraft) : null
  const base = readTextOption(opts, 'the voice') ?? draft?.base ?? existing?.base
  if (!base) throw new Error('Give the voice with --text, --file or --from-draft')
  const explicit = parseSurfaceEntries(opts.add, opts.override)
  const surfaces = Object.keys(explicit).length ? explicit : (draft?.surfaces ?? existing?.surfaces ?? {})
  const name = opts.name ?? existing?.name
  if (!name) throw new Error('Give the profile a --name')
  return {
    name,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    base,
    surfaces,
  }
}

export function registerVoiceCommands(program: Command) {
  const voice = program
    .command('voice')
    .description('Manage instance-level public voice profiles that squads are assigned to')

  const run =
    (fn: (...args: any[]) => Promise<void>) =>
    async (...args: any[]) => {
      try {
        await fn(...args)
      } catch (error) {
        outputError(error as Error)
      }
    }

  voice
    .command('list')
    .description('List voice profiles')
    .action(
      run(async () => {
        const profiles = await apiGet<PublicVoiceProfileJson[]>('/api/public-voices')
        if (isJsonMode()) return output(profiles)
        outputTable(
          profiles.map((p) => ({
            id: p.id,
            name: p.name,
            bytes: p.bytes,
            squads: p.assignedSquadCount ?? 0,
            disabled: p.disabled ? 'yes' : 'no',
          })),
          ['id', 'name', 'bytes', 'squads', 'disabled']
        )
      })
    )

  voice
    .command('show <id>')
    .description('Show a voice profile')
    .action(
      run(async (id: string) => {
        const profile = await apiGet<PublicVoiceProfileJson>(`/api/public-voices/${id}`)
        if (isJsonMode()) return output(profile)
        printProfile(profile)
      })
    )

  addProfileOptions(voice.command('create <id>').description('Create a voice profile')).action(
    run(async (id: string, opts: ProfileOptions) => {
      output(await apiPost(`/api/public-voices`, { id, ...profileBody(opts) }))
    })
  )

  addProfileOptions(
    voice.command('update <id>').description('Update a voice profile; unspecified fields keep their value')
  ).action(
    run(async (id: string, opts: ProfileOptions) => {
      const existing = await apiGet<PublicVoiceProfileJson>(`/api/public-voices/${id}`)
      output(await apiPut(`/api/public-voices/${id}`, profileBody(opts, existing)))
    })
  )

  voice
    .command('delete <id>')
    .description('Delete a profile; its squads fall back to the instance default')
    .action(run(async (id: string) => output(await apiDelete(`/api/public-voices/${id}`))))
  voice
    .command('disable <id>')
    .description('Disable a profile; its squads fall back to the instance default')
    .action(run(async (id: string) => output(await apiPost(`/api/public-voices/${id}/disable`, {}))))
  voice
    .command('enable <id>')
    .description('Enable a profile')
    .action(run(async (id: string) => output(await apiPost(`/api/public-voices/${id}/enable`, {}))))
  voice
    .command('revert <id>')
    .description('Revert a shipped profile to its template')
    .action(run(async (id: string) => output(await apiPost(`/api/public-voices/${id}/revert-to-template`, {}))))

  addDeriveOptions(
    voice
      .command('derive')
      .description("Draft a voice from a GitHub user's writing, through a squad's GitHub connection. Nothing is saved.")
      .requiredOption('--squad <squadId>', 'Squad whose GitHub connection to use')
  ).action(run(async (opts: DeriveOptions & { squad: string }) => runDerivation(opts.squad, opts)))
}
