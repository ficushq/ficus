import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import {
  safeDerivationReason,
  acceptsVoiceDerivationProgress,
  safeDerivationFailure,
  derivationFiltersSchema,
} from '@ficus/shared'
import { createLogger } from '../lib/infra/logger'
import { derivePublicVoice } from '../services/public-voice/derive'
import { DerivationError } from '../services/public-voice/github-activity'
import { acquireDerivation, abortable } from '../services/public-voice/operation'
import { safeDerivationDiagnostic } from '../services/public-voice/diagnostics'
import { createProgressWriter, DerivationStreamError } from '../services/public-voice/progress-stream'
import { withDeviceStreamRevocation } from '../services/streaming/device-revocation'
import type { GitHubTokenSource } from '../services/github/api-client'
const log = createLogger('squad-voice')

export const deriveSchema = z
  .object({
    login: z.string().regex(/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i, 'Not a GitHub login'),
    filters: derivationFiltersSchema.optional(),
  })
  .strict()

/** Shared JSON/SSE lifecycle: the caller authorizes and selects a token source first. */
export async function respondWithVoiceDerivation(
  c: Context,
  source: GitHubTokenSource,
  userId: string | null,
  body: z.infer<typeof deriveSchema>
) {
  const squadId = source.kind === 'squad' ? source.squadId : null
  // Ties account derivation logs to the selected connection. Never log the GitHub login.
  const logContext = source.kind === 'squad' ? { squadId } : { squadId, connectionId: source.connectionId }
  const lockKey = source.kind === 'squad' ? source.squadId : `connection:${source.connectionId}`
  const operation = acquireDerivation(lockKey, c.req.raw.signal, source.kind === 'connection' ? 90_000 : undefined)
  const args = {
    ...(source.kind === 'squad' ? { squadId: source.squadId } : { source }),
    userId,
    login: body.login,
    filters: body.filters ?? {},
    signal: operation.signal,
  }
  const failure = (error: unknown, stage: 'derivation' | 'terminal_publication' | 'stream_setup' = 'derivation') => {
    const safe =
      error instanceof DerivationError
        ? safeDerivationFailure(error.code, error.details)
        : safeDerivationFailure('derivation_failed')
    if (error instanceof DerivationError)
      log.warn('Voice derivation failed', {
        ...logContext,
        code: safe.code,
        reason: safeDerivationReason(safe.code, safe.reason),
      })
    else
      log.error('Voice derivation failed', {
        ...logContext,
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
      log.warn('Voice derivation timed out', { ...logContext, code: reason.code })
    else
      log.info('Voice derivation cancelled', {
        ...logContext,
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
