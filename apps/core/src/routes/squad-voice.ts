import { deriveSchema, respondWithVoiceDerivation } from './voice-derivation'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  PUBLIC_SURFACES,
  PUBLIC_VOICE_MAX_BYTES,
  publicVoiceIdSchema,
  publicVoiceLayerSchema,
  squadPublicVoicePatchSchema,
} from '@ficus/shared'
import { PublicVoice } from '../entities/PublicVoice'
import { Squad } from '../entities/Squad'
import { zValidator } from '../lib/zod-validator'
import { requireSquadPermission } from '../middleware'
import { resolvedSquadId } from '../middleware/require-permission'
import type { Identity } from '../services/rbac'
import { derivationOwners } from '../services/public-voice/operation'
import { previewPublicVoice } from '../services/public-voice/preview'
import { describeSquadVoice, mergePublicVoicePatch, renderedBytesFor } from '../services/public-voice/settings'

const previewSchema = z
  .object({
    surface: z.enum(PUBLIC_SURFACES),
    sample: z.string().max(4000).optional(),
    draft: publicVoiceLayerSchema.optional(),
    // null previews the instance default, which works even while the `default` profile is disabled.
    voiceId: publicVoiceIdSchema.nullable().optional(),
  })
  .strict()

/** One derivation at a time per squad. */
const derivationsInProgress = derivationOwners

function userIdOf(identity: Identity | undefined): string | null {
  return identity?.type === 'user' ? (identity.userId ?? null) : null
}

/**
 * A squad's public voice: which profile it uses and its own layer
 * (docs/wiki/public-voice.md). Reads need `squads:read`; every change,
 * preview and derivation needs `squads:update` in that squad.
 */
export const squadVoiceRouter = new Hono()
  .get('/:id/voice', requireSquadPermission('squads:read'), async (c) => {
    const squad = await Squad.find(resolvedSquadId(c))
    if (!squad) return c.json({ error: 'Squad not found' }, 404)
    return c.json(await describeSquadVoice(squad, c.get('identity') as Identity | undefined))
  })
  .patch(
    '/:id/voice',
    requireSquadPermission('squads:update'),
    zValidator('json', squadPublicVoicePatchSchema),
    async (c) => {
      const squad = await Squad.find(resolvedSquadId(c))
      if (!squad) return c.json({ error: 'Squad not found' }, 404)
      if (squad.isArchived) return c.json({ error: 'Squad is archived' }, 410)
      const patch = c.req.valid('json')
      if (patch.voiceId) {
        const profile = await PublicVoice.find(patch.voiceId)
        if (!profile || profile.disabled) return c.json({ error: 'unknown_voice' }, 400)
      }
      const next = mergePublicVoicePatch({ voiceId: squad.publicVoiceId, local: squad.publicVoice }, patch)
      const bytes = await renderedBytesFor(squad.id, next)
      if (bytes > PUBLIC_VOICE_MAX_BYTES) {
        return c.json({ error: 'public_voice_too_long', bytes, maxBytes: PUBLIC_VOICE_MAX_BYTES }, 400)
      }
      const updated = await Squad.setPublicVoice(squad.id, { publicVoiceId: next.voiceId, publicVoice: next.local })
      return c.json(await describeSquadVoice(updated, c.get('identity') as Identity | undefined))
    }
  )
  .delete('/:id/voice', requireSquadPermission('squads:update'), async (c) => {
    const squad = await Squad.find(resolvedSquadId(c))
    if (!squad) return c.json({ error: 'Squad not found' }, 404)
    if (squad.isArchived) return c.json({ error: 'Squad is archived' }, 410)
    await Squad.setPublicVoice(squad.id, { publicVoiceId: null, publicVoice: null })
    return c.json({ ok: true })
  })
  .post('/:id/voice/preview', requireSquadPermission('squads:update'), zValidator('json', previewSchema), async (c) => {
    const squad = await Squad.find(resolvedSquadId(c))
    if (!squad) return c.json({ error: 'Squad not found' }, 404)
    const body = c.req.valid('json')
    if (body.voiceId) {
      const profile = await PublicVoice.find(body.voiceId)
      if (!profile || profile.disabled) return c.json({ error: 'unknown_voice' }, 400)
    }
    const result = await previewPublicVoice({
      squad,
      surface: body.surface,
      sample: body.sample,
      draft: body.draft,
      voiceId: body.voiceId,
      userId: userIdOf(c.get('identity') as Identity | undefined),
    })
    return 'error' in result ? c.json(result, 502) : c.json(result)
  })
  .post(
    '/:id/voice/derive',
    requireSquadPermission('squads:update'),
    requireSquadPermission('integrations:use'),
    zValidator('json', deriveSchema),
    async (c) => {
      const squadId = resolvedSquadId(c)
      const identity = c.get('identity') as Identity | undefined
      // Derivation is a person-reviewed draft, never an agent-initiated settings change.
      if (identity?.type !== 'user') return c.json({ error: 'derivation_requires_person' }, 403)
      const body = c.req.valid('json')
      if (derivationsInProgress.has(squadId)) return c.json({ error: 'derivation_in_progress' }, 429)
      return respondWithVoiceDerivation(c, { kind: 'squad', squadId }, userIdOf(identity), body)
    }
  )

/** Test hook: the per-squad limiter. */
export const __derivationsInProgress = derivationsInProgress
