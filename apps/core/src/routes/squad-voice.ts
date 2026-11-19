import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import {
  PUBLIC_SURFACES,
  safeDerivationReason,
  acceptsVoiceDerivationProgress,
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
import { safeDerivationDiagnostic } from '../services/public-voice/diagnostics'
import { createProgressWriter, DerivationStreamError } from '../services/public-voice/progress-stream'
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
      const failure = (
        error: unknown,
        stage: 'derivation' | 'terminal_publication' | 'stream_setup' = 'derivation'
      ) => {
        const safe =
          error instanceof DerivationError
            ? safeDerivationFailure(error.code, error.details)
            : safeDerivationFailure('derivation_failed')
        if (error instanceof DerivationError)
          log.warn('Voice derivation failed', {
            squadId,
            code: safe.code,
            reason: safeDerivationReason(safe.code, safe.reason),
          })
        else
          log.error('Voice derivation failed', {
            squadId,
            code: safe.code,
            stage,
            ...safeDerivationDiagnostic(error),
            ...(error instanceof DerivationStreamError ? { streamReason: error.reason } : {}),
          })
        return safe
      }
      let cancelSource = 'stream_closed'
      const onCancel = () => {
        const reason = operation.signal.reason
        if (reason instanceof DerivationError && reason.code === 'derivation_timed_out')
          log.warn('Voice derivation timed out', { squadId, code: reason.code })
        else
          log.info('Voice derivation cancelled', {
            squadId,
            code: 'derivation_cancelled',
            source: c.req.raw.signal.aborted ? 'client_disconnect' : cancelSource,
          })
      }
      operation.signal.addEventListener('abort', onCancel, { once: true })
      if (operation.signal.aborted) onCancel()
      if (acceptsVoiceDerivationProgress(c.req.header('Accept'))) {
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
              cancelSource = 'stream_write'
              operation.cancel()
              stream.abort()
            },
            operation.signal
          )
          let started = false
          let stage: 'derivation' | 'terminal_publication' = 'derivation'
          try {
            await abortable(
              withDeviceStreamRevocation(c.get('authContext') ?? {}, stream, async (revoked) => {
                const onRevoke = () => {
                  cancelSource = 'credential_revoked'
                  operation.cancel()
                }
                revoked.addEventListener('abort', onRevoke, { once: true })
                if (revoked.aborted) onRevoke()
                try {
                  await writer.publish({ type: 'started' })
                  started = true
                  const result = await abortable(
                    derivePublicVoice({ ...args, onProgress: writer.publish }),
                    operation.signal
                  )
                  operation.signal.throwIfAborted()
                  stage = 'terminal_publication'
                  const sendComplete = writer.prepareTerminal({ type: 'complete', result })
                  // Validation and budgeting precede release; only the bounded transport write remains.
                  if (operation.complete()) await sendComplete()
                } catch (error) {
                  if (operation.signal.aborted && error === operation.signal.reason) return
                  const safe = failure(error, stage)
                  if (!operation.signal.aborted) {
                    const sendError = writer.prepareTerminal({ type: 'error', error: safe })
                    operation.complete()
                    await sendError()
                  }
                } finally {
                  revoked.removeEventListener('abort', onRevoke)
                }
              }),
              operation.signal
            ).catch(async (error) => {
              if (error instanceof DerivationError && error.code === 'derivation_timed_out') await writer.timeout()
              else if (!(operation.signal.aborted && error === operation.signal.reason)) {
                const safe = failure(error, 'stream_setup')
                if (!operation.signal.aborted) {
                  if (!started) await writer.publish({ type: 'started' })
                  const sendError = writer.prepareTerminal({ type: 'error', error: safe })
                  operation.complete()
                  await sendError()
                }
              }
            })
          } finally {
            writer.dispose()
            operation.signal.removeEventListener('abort', onCancel)
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
        // The requester has gone away; do not invent an application failure body.
        if (operation.signal.aborted && !(operation.signal.reason instanceof DerivationError))
          return new Response(null, { status: 499 })
        const safe = operation.signal.aborted ? safeDerivationFailure('derivation_timed_out') : failure(error)
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
        operation.signal.removeEventListener('abort', onCancel)
        operation.dispose()
      }
    }
  )

/** Test hook: the per-squad limiter. */
export const __derivationsInProgress = derivationsInProgress
