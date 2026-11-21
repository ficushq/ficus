import { VoiceDerivationCancelled } from '../voice-progress'
import { readFileSync } from 'fs'
import type { Command } from 'commander'
import {
  PUBLIC_SURFACES,
  PUBLIC_SURFACE_CLI_NAMES,
  PUBLIC_SURFACE_LABELS,
  type SquadPublicVoicePatch,
  type SquadPublicVoiceState,
} from '@ficus/shared'
import { apiDelete, apiGet, apiPatch, apiPost } from '../client'
import { isJsonMode, output, outputError } from '../output'
import { addDeriveOptions, describeInstanceDefaultLine, parseSurfaceName, readTextOption, runDerivation } from './voice'

/**
 * `ficus squad voice`: which voice profile a squad uses and its own layer
 * (squads:read to show, squads:update to change). See docs/wiki/public-voice.md.
 */

const SOURCE_LABEL: Record<SquadPublicVoiceState['resolved']['baseSource'], string> = {
  squad: "the squad's custom voice",
  profile: 'the assigned profile',
  instance: 'the instance default profile',
  none: 'no voice',
}

function printState(state: SquadPublicVoiceState): void {
  const { resolved } = state
  console.log(`Voice: ${SOURCE_LABEL[resolved.baseSource]}${resolved.profileId ? ` (${resolved.profileId})` : ''}`)
  if (state.fallback === 'assigned_disabled')
    console.log(`  The assigned profile ${state.voiceId} is disabled; using the instance default.`)
  if (state.fallback === 'assigned_missing')
    console.log(`  The assigned profile ${state.voiceId} no longer exists; using the instance default.`)
  // Older servers do not report the instance default.
  if (state.instanceDefault) console.log(describeInstanceDefaultLine(state.instanceDefault))
  console.log(
    `Size: ${resolved.bytes} / ${resolved.maxBytes} bytes${resolved.overCap ? ` (over the cap; dropped: ${resolved.dropped.join(', ')})` : ''}`
  )
  console.log(`\n${resolved.base || '(no base voice)'}`)
  for (const surface of PUBLIC_SURFACES) {
    const entry = resolved.entries[surface]
    if (!entry) continue
    const from = resolved.entrySources[surface] === 'squad' ? 'squad' : 'profile'
    console.log(`- ${PUBLIC_SURFACE_CLI_NAMES[surface]} (${entry.mode}, from the ${from}): ${entry.text}`)
  }
  if (state.availableVoices.length) {
    console.log(`\nProfiles: ${state.availableVoices.map((v) => v.id).join(', ')}`)
  }
}

interface SetOptions {
  text?: string
  file?: string
  surface?: string
  add?: boolean
  override?: boolean
}

/** A file written by derive --out sets the base and surface notes; plain text sets the base. */
function readVoiceFile(path: string): Pick<SquadPublicVoicePatch, 'base' | 'surfaces'> {
  const raw = readFileSync(path, 'utf8')
  if (!path.endsWith('.json')) return { base: raw.trim() }
  const parsed = JSON.parse(raw) as { draft?: unknown; base?: unknown; surfaces?: unknown }
  const draft = (parsed.draft ?? parsed) as { base?: string; surfaces?: SquadPublicVoicePatch['surfaces'] }
  if (!draft.base) throw new Error(`${path} has no draft "base" text`)
  return { base: draft.base, ...(draft.surfaces ? { surfaces: draft.surfaces } : {}) }
}

export function buildSetPatch(opts: SetOptions): SquadPublicVoicePatch {
  if (opts.surface) {
    if (opts.add === opts.override) throw new Error('With --surface, give exactly one of --add or --override')
    const text = readTextOption(opts, 'the surface text')
    if (!text) throw new Error('Give the surface text with --text or --file')
    return { surfaces: { [parseSurfaceName(opts.surface)]: { mode: opts.add ? 'add' : 'override', text } } }
  }
  if (opts.add || opts.override) throw new Error('--add and --override need --surface')
  if (opts.file && opts.text !== undefined) throw new Error('Give the voice with --text or --file, not both')
  if (opts.file) return readVoiceFile(opts.file)
  if (!opts.text) throw new Error('Give the voice with --text or --file')
  return { base: opts.text }
}

export function registerSquadVoiceCommands(squad: Command) {
  const voice = squad
    .command('voice')
    .description("Show or change a squad's public voice: a profile, or its own voice, plus per-surface entries")

  const run =
    (fn: (...args: any[]) => Promise<void>) =>
    async (...args: any[]) => {
      try {
        await fn(...args)
      } catch (error) {
        outputError(error as Error, error instanceof VoiceDerivationCancelled ? error.exitCode : 1)
      }
    }
  const show = (state: SquadPublicVoiceState) => (isJsonMode() ? output(state) : printState(state))

  voice
    .command('show <squadId>')
    .description('Show the assignment, the squad layer and the resolved voice per surface')
    .action(run(async (squadId: string) => show(await apiGet<SquadPublicVoiceState>(`/api/squads/${squadId}/voice`))))

  voice
    .command('use <squadId> [voiceId]')
    .description("Assign a voice profile (clears the squad's custom voice)")
    .option(
      '--instance-default',
      'Use the instance default (ficus voice default shows which profile that is) instead of an assigned one'
    )
    .action(
      run(async (squadId: string, voiceId: string | undefined, opts: { instanceDefault?: boolean }) => {
        if (!voiceId === !opts.instanceDefault) throw new Error('Give a profile id or --instance-default')
        show(await apiPatch<SquadPublicVoiceState>(`/api/squads/${squadId}/voice`, { voiceId: voiceId ?? null }))
      })
    )

  voice
    .command('set <squadId>')
    .description("Set the squad's own voice (clears the assignment), or one surface entry with --surface")
    .option('--text <text>', 'The voice text, or the surface text with --surface')
    .option('--file <path>', 'Read it from a file; a .json draft from derive --out also sets surface notes')
    .option('--surface <name>', `One surface: ${PUBLIC_SURFACES.map((s) => PUBLIC_SURFACE_CLI_NAMES[s]).join(', ')}`)
    .option('--add', 'With --surface: add to the voice on that surface')
    .option('--override', 'With --surface: replace the voice on that surface')
    .action(
      run(async (squadId: string, opts: SetOptions) => {
        show(await apiPatch<SquadPublicVoiceState>(`/api/squads/${squadId}/voice`, buildSetPatch(opts)))
      })
    )

  voice
    .command('clear <squadId>')
    .description("Clear the squad's custom voice, one surface entry (--surface), or everything (--all)")
    .option('--surface <name>', 'Clear only this surface entry')
    .option('--all', 'Clear the assignment and the whole squad layer')
    .action(
      run(async (squadId: string, opts: { surface?: string; all?: boolean }) => {
        if (opts.all) return output(await apiDelete(`/api/squads/${squadId}/voice`))
        const patch: SquadPublicVoicePatch = opts.surface
          ? { surfaces: { [parseSurfaceName(opts.surface)]: null } }
          : { base: null }
        show(await apiPatch<SquadPublicVoiceState>(`/api/squads/${squadId}/voice`, patch))
      })
    )

  voice
    .command('preview <squadId>')
    .description('Rewrite a sample comment in the resolved voice')
    .option('--surface <name>', 'Surface to preview', 'pull-requests')
    .option('--sample <text>', 'Text to rewrite (default: a built-in pull request comment)')
    .option('--voice <voiceId>', 'Preview a profile before assigning it')
    .action(
      run(async (squadId: string, opts: { surface: string; sample?: string; voice?: string }) => {
        const surface = parseSurfaceName(opts.surface)
        const result = await apiPost<{ text: string; model: string }>(`/api/squads/${squadId}/voice/preview`, {
          surface,
          ...(opts.sample ? { sample: opts.sample } : {}),
          ...(opts.voice ? { voiceId: opts.voice } : {}),
        })
        if (isJsonMode()) return output(result)
        console.log(`${PUBLIC_SURFACE_LABELS[surface]}:\n\n${result.text}`)
      })
    )

  addDeriveOptions(
    voice
      .command('derive <squadId>')
      .description(
        "Draft a voice from a GitHub user's writing through this squad's GitHub connection. Nothing is saved."
      )
  ).action(run(async (squadId: string, opts: Parameters<typeof runDerivation>[1]) => runDerivation(squadId, opts)))
}
