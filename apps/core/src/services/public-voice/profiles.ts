import { and, eq, isNotNull, isNull, or } from 'drizzle-orm'
import {
  DEFAULT_PUBLIC_VOICE_ID,
  PUBLIC_VOICE_MAX_BYTES,
  publicVoiceBytes,
  renderPublicVoicePrompt,
  resolvePublicVoice,
  type PublicVoiceProfile,
  type PublicVoiceProfileJson,
  type SquadPublicVoice,
} from '@ficus/shared'
import { db, squads } from '../../db'
import { PublicVoice } from '../../entities/PublicVoice'

/** Profiles as the API lists them, with how many squads are assigned to each. */
export async function describeProfiles(profiles: PublicVoice[]): Promise<PublicVoiceProfileJson[]> {
  const counts = await PublicVoice.assignedSquadCounts(profiles.map((p) => p.id))
  return profiles.map((profile) => ({ ...profile.toJson(), assignedSquadCount: counts.get(profile.id) ?? 0 }))
}

/**
 * How many squads using this profile (assigned, or on the instance default when
 * it is `default`) would render over the cap with their own surface entries.
 * Squads with a custom base ignore profiles and are not counted.
 */
export async function overCapSquadCount(profile: PublicVoiceProfile): Promise<number> {
  const usesProfile =
    profile.id === DEFAULT_PUBLIC_VOICE_ID
      ? or(eq(squads.publicVoiceId, profile.id), isNull(squads.publicVoiceId))
      : eq(squads.publicVoiceId, profile.id)
  const rows = await db
    .select({ publicVoiceId: squads.publicVoiceId, publicVoice: squads.publicVoice })
    .from(squads)
    .where(and(usesProfile, isNotNull(squads.publicVoice), isNull(squads.archivedAt)))
  let over = 0
  for (const row of rows) {
    const layer = row.publicVoice as SquadPublicVoice | null
    if (!layer || layer.base?.trim()) continue
    const resolved = resolvePublicVoice({
      squad: layer,
      assigned: { ...profile, disabled: false },
      instanceDefault: null,
    })
    if (publicVoiceBytes(renderPublicVoicePrompt(resolved)) > PUBLIC_VOICE_MAX_BYTES) over++
  }
  return over
}
