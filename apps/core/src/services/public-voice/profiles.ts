import { and, eq, isNotNull, isNull, or } from 'drizzle-orm'
import {
  PUBLIC_VOICE_MAX_BYTES,
  publicVoiceBytes,
  renderPublicVoicePrompt,
  resolvePublicVoice,
  type PublicVoiceProfile,
  type PublicVoiceProfileJson,
  type SquadPublicVoice,
} from '@ficus/shared'
import { db, publicVoices, squads } from '../../db'
import { PublicVoice } from '../../entities/PublicVoice'
import { resolveInstanceDefaultVoice } from '../../lib/prompts/public-voice-prompt'

/** Profiles as the API lists them, with how many squads are assigned to each and which is the instance default. */
export async function describeProfiles(profiles: PublicVoice[]): Promise<PublicVoiceProfileJson[]> {
  const [counts, instanceDefaultId] = await Promise.all([
    PublicVoice.assignedSquadCounts(profiles.map((p) => p.id)),
    PublicVoice.instanceDefaultId(),
  ])
  return profiles.map((profile) => ({
    ...profile.toJson(),
    assignedSquadCount: counts.get(profile.id) ?? 0,
    isInstanceDefault: profile.id === instanceDefaultId,
  }))
}

/** Stands in for the instance default while counting: only whether a squad falls through to it matters. */
const INSTANCE_DEFAULT_PROBE: PublicVoiceProfile = {
  id: 'instance-default-probe',
  name: 'Instance default',
  description: null,
  base: 'Instance default.',
  surfaces: {},
  disabled: false,
}

/**
 * How many squads are on the instance default, so a new default changes their voice: non-archived
 * squads without a custom base and without a usable assigned profile (none, or a disabled one).
 * Uses `resolvePublicVoice`, the same resolution prompts use, so the count cannot drift from it.
 * Counts every squad on the instance; callers only ever see the number.
 */
export async function instanceDefaultSquadCount(): Promise<number> {
  const rows = await db
    .select({ layer: squads.publicVoice, assignedId: publicVoices.id, assignedDisabled: publicVoices.disabled })
    .from(squads)
    .leftJoin(publicVoices, eq(publicVoices.id, squads.publicVoiceId))
    .where(isNull(squads.archivedAt))
  let onDefault = 0
  for (const row of rows) {
    const assigned = row.assignedId
      ? { ...INSTANCE_DEFAULT_PROBE, id: row.assignedId, disabled: Boolean(row.assignedDisabled) }
      : null
    const resolved = resolvePublicVoice({
      squad: row.layer as SquadPublicVoice | null,
      assigned,
      instanceDefault: INSTANCE_DEFAULT_PROBE,
    })
    if (resolved.baseSource === 'instance') onDefault++
  }
  return onDefault
}

/**
 * How many squads using this profile (assigned, or on the instance default when it is the
 * profile the instance default currently resolves to) would render over the cap with their own
 * surface entries. Squads with a custom base ignore profiles and are not counted.
 *
 * `asInstanceDefault` counts the squads on the instance default as users of this profile even
 * when it is not the instance default yet: the check made when choosing a new default.
 */
export async function overCapSquadCount(
  profile: PublicVoiceProfile,
  options: { asInstanceDefault?: boolean } = {}
): Promise<number> {
  const isInstanceDefault =
    options.asInstanceDefault || (await resolveInstanceDefaultVoice()).profile?.id === profile.id
  const usesProfile = isInstanceDefault
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
