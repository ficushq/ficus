import {
  DEFAULT_PUBLIC_VOICE_ID,
  PUBLIC_TEXT_SHARED_PROMPT_ID,
  PUBLIC_VOICE_MAX_BYTES,
  fitPublicVoiceToCap,
  renderPublicVoicePrompt,
  resolvePublicVoice,
  type PublicSurface,
  type PublicVoiceFallback,
  type PublicVoiceInstanceDefault,
  type PublicVoiceInstanceDefaultFallback,
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
  /** The shipped `default` profile. */
  findDefault(): Promise<PublicVoiceProfile | null>
  /** The id chosen as the instance default; absent or null means the shipped `default`. */
  findInstanceDefaultId?(): Promise<string | null>
}

const entityLoaders: PublicVoiceLoaders = {
  findProfile: async (id) => (await PublicVoice.find(id))?.toProfile() ?? null,
  findDefault: async () => (await PublicVoice.findDefault())?.toProfile() ?? null,
  findInstanceDefaultId: () => PublicVoice.instanceDefaultId(),
}

export interface InstanceDefaultResolution {
  /** The chosen id (`default` unless an admin chose another). */
  voiceId: string
  /** The chosen profile, disabled or not; null when it no longer exists. */
  chosen: PublicVoiceProfile | null
  /** The profile squads on the instance default use: the chosen one if enabled, else the shipped `default`. */
  profile: PublicVoiceProfile | null
  fallback: PublicVoiceInstanceDefaultFallback | null
}

/**
 * The instance default: the chosen profile while it is enabled, else the shipped `default`
 * (reported as `default_disabled` or `default_missing`). The shipped profile may itself be
 * disabled, in which case resolution renders no voice for squads on the instance default.
 */
export async function resolveInstanceDefaultVoice(
  loaders: PublicVoiceLoaders = entityLoaders
): Promise<InstanceDefaultResolution> {
  const [chosenId, shipped] = await Promise.all([
    loaders.findInstanceDefaultId ? loaders.findInstanceDefaultId() : Promise.resolve(null),
    loaders.findDefault(),
  ])
  const voiceId = chosenId || DEFAULT_PUBLIC_VOICE_ID
  if (voiceId === DEFAULT_PUBLIC_VOICE_ID) return { voiceId, chosen: shipped, profile: shipped, fallback: null }
  const chosen = await loaders.findProfile(voiceId)
  if (chosen && !chosen.disabled) return { voiceId, chosen, profile: chosen, fallback: null }
  return { voiceId, chosen, profile: shipped, fallback: chosen ? 'default_disabled' : 'default_missing' }
}

/** The API shape of an instance default resolution. */
export function describeInstanceDefault(instance: InstanceDefaultResolution): PublicVoiceInstanceDefault {
  const effective = instance.profile && !instance.profile.disabled ? instance.profile : null
  return {
    voiceId: instance.voiceId,
    name: instance.chosen?.name ?? null,
    effectiveVoiceId: effective?.id ?? null,
    effectiveName: effective?.name ?? null,
    fallback: instance.fallback,
  }
}

export interface SquadPublicVoiceResolution {
  resolved: ResolvedPublicVoice
  /** An unusable assignment, else (for a squad on the instance default) an unusable chosen default. */
  fallback: PublicVoiceFallback | null
  /** The effective profile (assigned, else the instance default) when the squad has no custom base. */
  profile: PublicVoiceProfile | null
  instanceDefault: InstanceDefaultResolution
}

/** Resolve a squad's voice from its layer, its assigned profile and the instance default. */
export async function resolveSquadPublicVoice(
  squad: PublicVoiceSquad | null,
  loaders: PublicVoiceLoaders = entityLoaders
): Promise<SquadPublicVoiceResolution> {
  const [assigned, instance] = await Promise.all([
    squad?.publicVoiceId ? loaders.findProfile(squad.publicVoiceId) : Promise.resolve(null),
    resolveInstanceDefaultVoice(loaders),
  ])
  const instanceDefault = instance.profile
  const resolved = resolvePublicVoice({ squad: squad?.publicVoice ?? null, assigned, instanceDefault })
  const usesInstanceDefault = resolved.baseSource === 'instance' || resolved.baseSource === 'none'
  const fallback: PublicVoiceFallback | null =
    squad?.publicVoiceId && !assigned
      ? 'assigned_missing'
      : assigned?.disabled
        ? 'assigned_disabled'
        : usesInstanceDefault
          ? instance.fallback
          : null
  const profile = resolved.profileId === null ? null : resolved.profileId === assigned?.id ? assigned : instanceDefault
  return { resolved, fallback, profile, instanceDefault: instance }
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
