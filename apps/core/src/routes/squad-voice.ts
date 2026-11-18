import { Hono } from 'hono'
import { z } from 'zod'
import {
  PUBLIC_SURFACES,
  PUBLIC_VOICE_MAX_BYTES,
  derivationFiltersSchema,
  publicVoiceIdSchema,
  publicVoiceLayerSchema,
  squadPublicVoicePatchSchema,
} from '@ficus/shared'
import { PublicVoice } from '../entities/PublicVoice'
import { Squad } from '../entities/Squad'
import { createLogger } from '../lib/infra/logger'
import { zValidator } from '../lib/zod-validator'
import { requireSquadPermission } from '../middleware'
import { resolvedSquadId } from '../middleware/require-permission'
import type { Identity } from '../services/rbac'
import { derivePublicVoice } from '../services/public-voice/derive'
import { DerivationError } from '../services/public-voice/github-activity'
import { previewPublicVoice } from '../services/public-voice/preview'
import {
  describeSquadVoice,
  linkedGitHubLogin,
  mergePublicVoicePatch,
  renderedBytesFor,
} from '../services/public-voice/settings'

const log = createLogger('squad-voice')

const previewSchema = z
  .object({
    surface: z.enum(PUBLIC_SURFACES),
    sample: z.string().max(4000).optional(),
    draft: publicVoiceLayerSchema.optional(),
    voiceId: publicVoiceIdSchema.optional(),
  })
  .strict()

const deriveSchema = z
  .object({
    login: z.string().regex(/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i, 'Not a GitHub login'),
    confirmOtherPerson: z.boolean().optional(),
    filters: derivationFiltersSchema.optional(),
  })
  .strict()

/** One derivation at a time per squad. */
const derivationsInProgress = new Set<string>()

function userIdOf(identity: Identity | undefined): string | null {
  return identity?.type === 'user' ? (identity.userId ?? null) : null
}

const derivationStatus: Record<DerivationError['code'], 422 | 502> = {
  derivation_github_unavailable: 502,
  derivation_login_not_visible: 422,
  derivation_too_few_samples: 422,
  derivation_invalid_output: 502,
  derivation_model_unavailable: 502,
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
  .patch('/:id/voice', requireSquadPermission('squads:update'), zValidator('json', squadPublicVoicePatchSchema), async (c) => {
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
  })
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
      const body = c.req.valid('json')
      const linked = await linkedGitHubLogin(identity)
      if (!body.confirmOtherPerson && linked?.toLowerCase() !== body.login.toLowerCase()) {
        return c.json(
          {
            error: 'confirmation_required',
            linkedLogin: linked,
            message:
              'This login is not your linked GitHub account. The result describes a writing style only; agents never sign as or claim to be that person. Confirm to continue.',
          },
          409
        )
      }
      if (derivationsInProgress.has(squadId)) return c.json({ error: 'derivation_in_progress' }, 429)
      derivationsInProgress.add(squadId)
      try {
        const result = await derivePublicVoice({
          squadId,
          userId: userIdOf(identity),
          login: body.login,
          filters: body.filters ?? {},
        })
        return c.json(result)
      } catch (error) {
        if (error instanceof DerivationError) return c.json({ error: error.code, ...error.details }, derivationStatus[error.code])
        log.error('Voice derivation failed', { squadId, error: String(error) })
        return c.json({ error: 'derivation_failed' }, 500)
      } finally {
        derivationsInProgress.delete(squadId)
      }
    }
  )

/** Test hook: the per-squad limiter. */
export const __derivationsInProgress = derivationsInProgress
