import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import {
  PUBLIC_SURFACES,
  safeDerivationReason,
  safeDerivationFailure,
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
import { acquireDerivation, abortable, derivationOwners } from '../services/public-voice/operation'
import { createProgressWriter } from '../services/public-voice/progress-stream'
import { withDeviceStreamRevocation } from '../services/streaming/device-revocation'
import { previewPublicVoice } from '../services/public-voice/preview'
import { describeSquadVoice, mergePublicVoicePatch, renderedBytesFor } from '../services/public-voice/settings'

const log = createLogger('squad-voice')

const previewSchema = z
  .object({
    surface: z.enum(PUBLIC_SURFACES),
    sample: z.string().max(4000).optional(),
    draft: publicVoiceLayerSchema.optional(),
    // null previews the instance default, which works even while the `default` profile is disabled.
    voiceId: publicVoiceIdSchema.nullable().optional(),
  })
  .strict()

const deriveSchema = z
  .object({
    login: z.string().regex(/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i, 'Not a GitHub login'),
    filters: derivationFiltersSchema.optional(),
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
      const operation = acquireDerivation(squadId, c.req.raw.signal)
      const args = {
        squadId,
        userId: userIdOf(identity),
        login: body.login,
        filters: body.filters ?? {},
        signal: operation.signal,
      }
      const failure = (error: unknown) => {
        const safe =
          error instanceof DerivationError
            ? safeDerivationFailure(error.code, error.details)
            : safeDerivationFailure('derivation_failed')
        log.warn('Voice derivation failed', {
          squadId,
          code: safe.code,
          reason: safeDerivationReason(safe.code, safe.reason),
        })
        return safe
      }
      if (
        c.req
          .header('Accept')
          ?.split(',')
          .some((value) => value.trim().split(';')[0] === 'text/event-stream')
      ) {
        c.header('Cache-Control', 'no-store, no-transform')
        c.header('X-Accel-Buffering', 'no')
        c.header('Vary', 'Accept')
        return streamSSE(c, async (stream) => {
          c.header('Cache-Control', 'no-store, no-transform')
          stream.onAbort(() => operation.cancel())
          const writer = createProgressWriter(
            async (frame) => {
              if (stream.aborted) throw new Error('Derivation disconnected')
              await stream.write(frame)
              if (stream.aborted) throw new Error('Derivation disconnected')
            },
            () => {
              operation.cancel()
              stream.abort()
            },
            operation.signal
          )
          try {
            await abortable(
              withDeviceStreamRevocation(c.get('authContext') ?? {}, stream, async (revoked) => {
                const onRevoke = () => operation.cancel()
                revoked.addEventListener('abort', onRevoke, { once: true })
                if (revoked.aborted) onRevoke()
                try {
                  await writer.publish({ type: 'started' })
                  const result = await abortable(
                    derivePublicVoice({ ...args, onProgress: writer.publish }),
                    operation.signal
                  )
                  // Release ownership before waiting for a terminal write, fencing any late cleanup.
                  if (operation.complete()) await writer.publish({ type: 'complete', result })
                } catch (error) {
                  if (!operation.signal.aborted && operation.complete())
                    await writer.publish({ type: 'error', error: failure(error) })
                } finally {
                  revoked.removeEventListener('abort', onRevoke)
                }
              }),
              operation.signal
            ).catch(async (error) => {
              if (error instanceof DerivationError && error.code === 'derivation_timed_out') await writer.timeout()
              else if (!operation.signal.aborted)
                log.warn('Voice derivation stream setup failed', { squadId, code: 'derivation_failed' })
            })
          } finally {
            writer.dispose()
            operation.dispose()
          }
        })
      }
      c.header('Vary', 'Accept')
      try {
        const result = await abortable(derivePublicVoice(args), operation.signal)
        operation.signal.throwIfAborted()
        operation.complete()
        return c.json(result)
      } catch (error) {
        const safe = failure(error)
        return c.json(
          {
            error: safe.code,
            ...('reason' in safe ? { reason: safe.reason } : {}),
            ...(safe.counts ? { counts: safe.counts } : {}),
            ...(safe.minimum !== undefined ? { minimum: safe.minimum } : {}),
          },
          safe.code === 'derivation_failed' ? 500 : 422
        )
      } finally {
        operation.dispose()
      }
    }
  )

/** Test hook: the per-squad limiter. */
export const __derivationsInProgress = derivationsInProgress
