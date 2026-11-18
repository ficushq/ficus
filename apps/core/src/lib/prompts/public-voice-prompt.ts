import {
  PUBLIC_TEXT_SHARED_PROMPT_ID,
  PUBLIC_VOICE_MAX_BYTES,
  fitPublicVoiceToCap,
  renderPublicVoicePrompt,
  resolvePublicVoice,
  type PublicSurface,
  type PublicVoiceFallback,
  type PublicVoiceProfile,
  type ResolvedPublicVoice,
  type SquadPublicVoice,
} from '@ficus/shared'
import { PublicVoice } from '../../entities/PublicVoice'
import { SharedPrompt } from '../../entities/SharedPrompt'
import { createLogger } from '../infra/logger'

const log = createLogger('public-voice-prompt')

import { PUBLIC_VOICE_PROMPT_TOKEN, publicVoicePromptFallback } from './public-voice-render'

export { PUBLIC_VOICE_PROMPT_TOKEN, publicVoicePromptFallback }

/** The squad fields the voice depends on; null means "no squad" (the instance default). */
export type PublicVoiceSquad = { id: string; publicVoiceId: string | null; publicVoice: SquadPublicVoice | null }

export interface PublicVoiceLoaders {
  findProfile(id: string): Promise<PublicVoiceProfile | null>
  findDefault(): Promise<PublicVoiceProfile | null>
}

const entityLoaders: PublicVoiceLoaders = {
  findProfile: async (id) => (await PublicVoice.find(id))?.toProfile() ?? null,
  findDefault: async () => (await PublicVoice.findDefault())?.toProfile() ?? null,
}

export interface SquadPublicVoiceResolution {
  resolved: ResolvedPublicVoice
  fallback: PublicVoiceFallback | null
  /** The effective profile (assigned, else the instance default) when the squad has no custom base. */
  profile: PublicVoiceProfile | null
}

/** Resolve a squad's voice from its layer, its assigned profile and the instance default. */
export async function resolveSquadPublicVoice(
  squad: PublicVoiceSquad | null,
  loaders: PublicVoiceLoaders = entityLoaders
): Promise<SquadPublicVoiceResolution> {
  const [assigned, instanceDefault] = await Promise.all([
    squad?.publicVoiceId ? loaders.findProfile(squad.publicVoiceId) : Promise.resolve(null),
    loaders.findDefault(),
  ])
  const resolved = resolvePublicVoice({ squad: squad?.publicVoice ?? null, assigned, instanceDefault })
  const fallback: PublicVoiceFallback | null =
    squad?.publicVoiceId && !assigned ? 'assigned_missing' : assigned?.disabled ? 'assigned_disabled' : null
  const profile = resolved.profileId === null ? null : resolved.profileId === assigned?.id ? assigned : instanceDefault
  return { resolved, fallback, profile }
}

const warnedOverCap = new Set<string>()

/** Resolve and fit to the cap, warning once per squad per process when entries had to be dropped. */
export async function fitSquadPublicVoice(
  squad: PublicVoiceSquad | null,
  loaders: PublicVoiceLoaders = entityLoaders
): Promise<SquadPublicVoiceResolution & { dropped: PublicSurface[] }> {
  const resolution = await resolveSquadPublicVoice(squad, loaders)
  const { resolved, dropped } = fitPublicVoiceToCap(resolution.resolved, PUBLIC_VOICE_MAX_BYTES)
  const key = squad?.id ?? '(instance)'
  if (dropped.length > 0 && !warnedOverCap.has(key)) {
    warnedOverCap.add(key)
    log.warn('Public voice over the cap; surface entries dropped', { squadId: squad?.id, dropped })
  }
  return { ...resolution, resolved, dropped }
}

/**
 * The rendered "### Voice" section for a squad, or for the instance default
 * when there is no squad. Never throws: a read failure degrades to '' so a
 * prompt still builds, like the slot pools section.
 */
export async function buildPublicVoicePrompt(
  squad: PublicVoiceSquad | null,
  loaders: PublicVoiceLoaders = entityLoaders
): Promise<string> {
  try {
    return renderPublicVoicePrompt((await fitSquadPublicVoice(squad, loaders)).resolved)
  } catch (error) {
    log.warn('Public voice section unavailable', { squadId: squad?.id, error })
    return ''
  }
}

/** Whether the `public-text` include exists and is enabled. */
export async function publicTextIncludeEnabled(): Promise<boolean> {
  try {
    const rules = await SharedPrompt.find(PUBLIC_TEXT_SHARED_PROMPT_ID)
    return Boolean(rules && !rules.disabled)
  } catch {
    return false
  }
}
