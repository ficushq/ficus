import { Hono } from 'hono'
import OpenAI from 'openai'
import { createLogger } from '../lib/infra/logger'
import { getOpenAIServiceKey } from '../services/integrations/openai-services/settings'
import { requirePermission } from '../middleware/require-permission'

import { getSettingsStore } from '../services/settings'
import { recordInferenceUsage } from '../services/inference-usage'
import { attributionFromIdentity } from '../services/inference-usage/types'
import type { Identity } from '../services/rbac/permissions'

const log = createLogger('routes')

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

const TRANSCRIPTION_MODEL = 'whisper-1'

export function createTranscribeRouter(
  /** `duration` is the audio length in seconds, which Whisper bills by (verbose_json reports it). */
  transcribe: (apiKey: string, audio: File) => Promise<{ text: string; duration?: number }> = async (apiKey, audio) =>
    new OpenAI({ apiKey }).audio.transcriptions.create({
      file: audio,
      model: TRANSCRIPTION_MODEL,
      response_format: 'verbose_json',
    })
) {
  return new Hono().post('/', requirePermission('ai:transcribe'), async (c) => {
    if (!getSettingsStore().getTyped('TRANSCRIPTION_ENABLED'))
      return c.json({ error: 'Voice dictation is disabled in Settings → Assistant & Memory.' }, 503)
    const formData = await c.req.formData()
    const audio = formData.get('audio')

    if (!audio || !(audio instanceof File)) {
      return c.json({ error: 'Missing audio file' }, 400)
    }

    if (audio.size > MAX_FILE_SIZE) {
      return c.json({ error: 'File too large (max 10MB)' }, 413)
    }

    const apiKey = getOpenAIServiceKey()
    if (!apiKey)
      return c.json({ error: 'Enable OpenAI API services and configure an API key in Settings → Integrations.' }, 503)

    try {
      const transcription = await transcribe(apiKey, audio)
      const duration = transcription.duration
      const known = typeof duration === 'number' && Number.isFinite(duration) && duration > 0
      recordInferenceUsage({
        feature: 'transcription',
        provider: 'openai',
        model: TRANSCRIPTION_MODEL,
        accountId: 'openai-services',
        billing: 'api',
        // Without a duration the call still happened: record it as an estimate with no price.
        ...(known ? { units: { audioSeconds: duration } } : { listCostUsd: null, tokensEstimated: true }),
        attribution: attributionFromIdentity(c.get('identity') as Identity | undefined),
      })

      return c.json({ text: transcription.text })
    } catch (error) {
      log.error('Transcription error:', error)
      return c.json({ error: 'Transcription failed' }, 502)
    }
  })
}
export const transcribeRouter = createTranscribeRouter()
