import {
  DEFAULT_PUBLIC_VOICE_ID,
  PUBLIC_SURFACES,
  publicVoiceBytes,
  renderPublicVoicePrompt,
  resolvePublicVoice,
  type PublicVoiceSurfaces,
  type SquadPublicVoicePatch,
  type SquadPublicVoiceState,
} from '@ficus/shared'

/** Helpers for the squad Voice page, kept apart from the component for fast refresh and tests. */

export const INSTANCE = '__instance__'
export const CUSTOM = '__custom__'

/** The picker value for a stored state: the instance default, a profile, or the squad's own voice. */
export function pickerValueFor(state: Pick<SquadPublicVoiceState, 'voiceId' | 'local'>): string {
  if (state.local.base) return CUSTOM
  return state.voiceId ?? INSTANCE
}

/**
 * The rendered size of an edited voice, computed with the same shared
 * renderer the server uses. Null when the picked profile's text is not loaded
 * (a different profile than the stored one), so the size is known after saving.
 */
export function draftBytes(
  state: SquadPublicVoiceState,
  picker: string,
  customBase: string,
  surfaces: PublicVoiceSurfaces
): number | null {
  const squad = { base: picker === CUSTOM ? customBase.trim() || null : null, surfaces }
  if (picker === CUSTOM)
    return publicVoiceBytes(
      renderPublicVoicePrompt(resolvePublicVoice({ squad, assigned: null, instanceDefault: null }))
    )
  const storedPicker = state.local.base ? CUSTOM : (state.voiceId ?? INSTANCE)
  const pickedProfileId = picker === INSTANCE ? DEFAULT_PUBLIC_VOICE_ID : picker
  const profile =
    state.profile && (picker === storedPicker || state.profile.id === pickedProfileId) ? state.profile : null
  if (!profile) return null
  return publicVoiceBytes(
    renderPublicVoicePrompt(resolvePublicVoice({ squad, assigned: profile, instanceDefault: null }))
  )
}

/** The PATCH that turns the stored state into the edited one. */
export function buildVoicePatch(
  picker: string,
  customBase: string,
  surfaces: PublicVoiceSurfaces
): SquadPublicVoicePatch {
  const allSurfaces = Object.fromEntries(
    PUBLIC_SURFACES.map((s) => [s, surfaces[s] ?? null])
  ) as SquadPublicVoicePatch['surfaces']
  if (picker === CUSTOM) return { base: customBase.trim(), surfaces: allSurfaces }
  return { voiceId: picker === INSTANCE ? null : picker, base: null, surfaces: allSurfaces }
}
