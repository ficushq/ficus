import {
  GOOGLE_CLOUD_CREDENTIAL,
  parseGoogleServiceAccount,
  requireGoogleCloudSpeechEnabled,
} from '../services/integrations/google-cloud/settings'
import { createSpeechClientPool } from '../services/integrations/google-cloud/speech-client'
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { TextToSpeechClient } from '@google-cloud/text-to-speech'
import { Agent } from '../entities/Agent'
import { AgentSession } from '../entities/AgentSession'
import { getSecretStore } from '../services/secrets'
import { createLogger } from '../lib/infra/logger'
import { requirePermission } from '../middleware/require-permission'
import { hasPermission } from '../services/rbac'
import type { Identity } from '../services/rbac'
import { recordInferenceUsage } from '../services/inference-usage'
import { attributionFromIdentity, type InferenceAttribution } from '../services/inference-usage/types'

const log = createLogger('tts')

const MAX_TEXT_LENGTH = 5000
const VOICE_NAME = 'en-US-Chirp3-HD-Schedar'
const LANGUAGE_CODE = 'en-US'

const speechClients = createSpeechClientPool({
  credential: () => getSecretStore().get(GOOGLE_CLOUD_CREDENTIAL),
  create: (credential) =>
    new TextToSpeechClient(credential ? { credentials: parseGoogleServiceAccount(credential) } : {}),
})

function stripEmojis(text: string): string {
  return text.replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, '')
}

function extractTextFromMessage(message: { content: string; metadata: any }): string {
  const content = message.metadata?.content
  if (content && Array.isArray(content)) {
    const textBlocks = content.filter((b: any) => b.type === 'text')
    if (textBlocks.length > 0) {
      return stripEmojis(textBlocks.map((b: any) => b.content).join('\n'))
    }
  }
  return stripEmojis(message.content)
}

const SPEECH_REFORMAT_PROMPT = `After each user prompt, prepare it for speech synthesis:
- If the input is already a straightforward (conversational) message with little to no information to summarize, it should not be changed at all.
- Otherwise, summarize the provided text to prepare it for text-to-speech. The output should be shorter than the input.
- Remove any URLs and file paths, maybe replacing them with a mention.
- Remove any markdown formatting (headers, bold, italic, links, tables, code, etc.)
- Your output will be read aloud, so ensure it makes sense when spoken.`

async function reformatForSpeech(text: string, attribution: InferenceAttribution): Promise<string> {
  try {
    const { pi: session } = await AgentSession.create({
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: SPEECH_REFORMAT_PROMPT,
      usage: { feature: 'tts-reformat', attribution: () => attribution },
    })

    const chunks: string[] = []

    const result = await new Promise<string>((resolve, reject) => {
      session.subscribe((event) => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          chunks.push(event.assistantMessageEvent.delta)
        } else if (event.type === 'agent_end') {
          resolve(chunks.join(''))
        }
      })

      session.prompt(text).catch(reject)
    })

    return result || text
  } catch (err) {
    log.error('Speech reformatting failed, using original text:', err)
    return text
  }
}

export const ttsRouter = new Hono().post('/', requirePermission('ai:tts'), async (c) => {
  const body = await c.req.json()
  const { messageId } = body

  if (typeof messageId !== 'string' || messageId.trim().length === 0) {
    return c.json({ error: 'Missing or empty messageId' }, 400)
  }

  // Look up the message
  const message = await Agent.findMessage(messageId)
  if (!message) {
    return c.json({ error: 'Message not found' }, 404)
  }

  // Squad-scope the disclosure: ai:tts is only the capability gate (unscoped).
  // Resolve the owning agent's squad and verify the caller can read it, so a
  // holder of ai:tts cannot synthesize/read back another squad's message text.
  const identity = c.get('identity') as Identity | undefined
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  const owningAgent = await Agent.find(message.agentId)
  const msgSquadId = owningAgent?.squadId ?? null
  const ttsAllowed = msgSquadId
    ? await hasPermission(identity, 'ai:tts', msgSquadId)
    : await hasPermission(identity, 'ai:tts')
  if (!ttsAllowed) return c.json({ error: 'Forbidden' }, 403)

  if (message.role !== 'assistant') {
    return c.json({ error: 'Can only synthesize assistant messages' }, 400)
  }

  const rawText = extractTextFromMessage(message).trim()
  if (!rawText) {
    return c.json({ error: 'Message has no text content' }, 400)
  }

  if (rawText.length > MAX_TEXT_LENGTH) {
    return c.json({ error: `Text exceeds maximum length of ${MAX_TEXT_LENGTH} characters` }, 400)
  }

  try {
    await requireGoogleCloudSpeechEnabled()
  } catch {
    await speechClients.retire()
    return c.json({ error: 'Enable Google Cloud in Settings → Integrations to use text-to-speech.' }, 503)
  }

  const attribution: InferenceAttribution = {
    ...attributionFromIdentity(identity),
    agentId: message.agentId,
    squadId: msgSquadId,
  }
  const text = await reformatForSpeech(rawText, attribution)

  let lease: Awaited<ReturnType<typeof speechClients.acquire>>
  try {
    // Recheck after formatting in case the integration was disabled meanwhile.
    await requireGoogleCloudSpeechEnabled()
    lease = await speechClients.acquire()
  } catch {
    return c.json({ error: 'Google Cloud speech is unavailable. Check Settings → Integrations → Google Cloud.' }, 503)
  }

  // Stream the response
  c.header('Content-Type', 'audio/L16;rate=24000;channels=1')

  return stream(c, async (responseStream) => {
    try {
      const grpcStream = lease.client.streamingSynthesize()

      // Send config first
      grpcStream.write({
        streamingConfig: {
          voice: {
            languageCode: LANGUAGE_CODE,
            name: VOICE_NAME,
          },
          audioEncoding: 'LINEAR16',
        },
      })

      // Send text input
      grpcStream.write({
        input: {
          text,
        },
      })
      // Google bills the characters sent, whether or not the client listens to the end.
      recordInferenceUsage({
        feature: 'tts',
        provider: 'google',
        model: VOICE_NAME,
        accountId: 'google-cloud',
        billing: 'api',
        units: { characters: text.length },
        attribution,
      })

      // End the write side
      grpcStream.end()

      // Pipe audio chunks to HTTP response
      for await (const response of grpcStream) {
        const audioContent = (response as any).audioContent
        if (audioContent && audioContent.length > 0) {
          const chunk = audioContent instanceof Uint8Array ? audioContent : new Uint8Array(audioContent as ArrayBuffer)
          await responseStream.write(chunk)
        }
      }
    } catch (error) {
      log.error('TTS streaming error:', error)
    } finally {
      await lease.release()
    }
  })
})
