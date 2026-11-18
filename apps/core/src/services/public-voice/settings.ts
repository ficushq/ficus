import {
  PUBLIC_VOICE_MAX_BYTES,
  fitPublicVoiceToCap,
  isEmptyPublicVoiceLayer,
  publicVoiceBytes,
  renderPublicVoicePrompt,
  type PublicSurface,
  type PublicVoiceSurfaces,
  type SquadPublicVoice,
  type SquadPublicVoicePatch,
  type SquadPublicVoiceState,
} from '@ficus/shared'
import { PublicVoice } from '../../entities/PublicVoice'
import { resolveSquadPublicVoice, type PublicVoiceSquad } from '../../lib/prompts/public-voice-prompt'
import { createLogger } from '../../lib/infra/logger'
import type { Identity } from '../rbac'
import { getGitHubPersonalIdentity } from '../integrations/github/personal-identity'

const log = createLogger('public-voice')

export interface SquadVoiceSetting {
  voiceId: string | null
  local: SquadPublicVoice | null
}

/**
 * Apply a PATCH to a squad's voice setting. The base comes from exactly one
 * place: a non-null custom base clears the assignment, and an assignment or an
 * explicit `voiceId: null` (the instance default) clears the custom base. A null surface entry
 * deletes the squad's entry. An empty layer is stored as null.
 */
export function mergePublicVoicePatch(current: SquadVoiceSetting, patch: SquadPublicVoicePatch): SquadVoiceSetting {
  let voiceId = patch.voiceId !== undefined ? patch.voiceId : current.voiceId
  let base = patch.base !== undefined ? patch.base : (current.local?.base ?? null)
  if (patch.base) voiceId = null
  // Assigning a profile, or choosing the instance default (an explicit null), replaces a custom base
  // unless the same request sets one.
  if (patch.voiceId || (patch.voiceId === null && patch.base === undefined)) base = null

  const surfaces: PublicVoiceSurfaces = { ...(current.local?.surfaces ?? {}) }
  for (const [surface, entry] of Object.entries(patch.surfaces ?? {}) as Array<
    [PublicSurface, PublicVoiceSurfaces[PublicSurface] | null | undefined]
  >) {
    if (entry === undefined) continue
    if (entry === null) delete surfaces[surface]
    else surfaces[surface] = { mode: entry.mode, text: entry.text.trim() }
  }

  const local: SquadPublicVoice = { base: base?.trim() || null, surfaces }
  return { voiceId: voiceId ?? null, local: isEmptyPublicVoiceLayer(local) ? null : local }
}

/** UTF-8 bytes the squad's voice would render to with this setting, before any fitting. */
export async function renderedBytesFor(squadId: string, setting: SquadVoiceSetting): Promise<number> {
  const { resolved } = await resolveSquadPublicVoice({
    id: squadId,
    publicVoiceId: setting.voiceId,
    publicVoice: setting.local,
  })
  return publicVoiceBytes(renderPublicVoicePrompt(resolved))
}

export async function linkedGitHubLogin(identity: Identity | undefined): Promise<string | null> {
  try {
    return (await getGitHubPersonalIdentity(identity))?.login ?? null
  } catch (error) {
    // Not a human identity, or no link: nothing to prefill.
    log.debug('No linked GitHub login for voice settings', { error: String(error) })
    return null
  }
}

/** The `GET /api/squads/:id/voice` body. */
export async function describeSquadVoice(
  squad: PublicVoiceSquad,
  identity: Identity | undefined
): Promise<SquadPublicVoiceState> {
  const [resolution, available, login] = await Promise.all([
    resolveSquadPublicVoice(squad),
    PublicVoice.list(),
    linkedGitHubLogin(identity),
  ])
  // Bytes are measured before fitting, so an over-cap voice is reported as such.
  const bytes = publicVoiceBytes(renderPublicVoicePrompt(resolution.resolved))
  const fitted = fitPublicVoiceToCap(resolution.resolved, PUBLIC_VOICE_MAX_BYTES)
  return {
    voiceId: squad.publicVoiceId,
    local: squad.publicVoice ?? { base: null, surfaces: {} },
    profile: resolution.profile,
    fallback: resolution.fallback,
    availableVoices: available.map((p) => ({ id: p.id, name: p.name, description: p.description })),
    resolved: {
      ...fitted.resolved,
      rendered: renderPublicVoicePrompt(fitted.resolved),
      bytes,
      maxBytes: PUBLIC_VOICE_MAX_BYTES,
      overCap: bytes > PUBLIC_VOICE_MAX_BYTES,
      dropped: fitted.dropped,
    },
    linkedGitHubLogin: login,
  }
}
