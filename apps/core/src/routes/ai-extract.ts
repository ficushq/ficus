import { assertArrayLimit, assertRecordLimit } from '../lib/validation/request-collections'
import { Hono } from 'hono'
import { AgentSession } from '../entities/AgentSession'
import { SystemManagerRunner } from '../entities/agent-runners/system-manager-runner'
import { createLogger } from '../lib/infra/logger'
import { requirePermission } from '../middleware/require-permission'
import { attributionFromIdentity } from '../services/inference-usage/types'
import type { Identity } from '../services/rbac/permissions'

const log = createLogger('routes')

interface ExtractField {
  type: 'string' | 'number' | 'boolean'
  required?: boolean
  description?: string
  options?: string[]
  suggestions?: string[]
}

interface ExtractRequest {
  transcript: string
  fields: Record<string, ExtractField>
  context?: string
}

export const aiExtractRouter = new Hono().post('/', requirePermission('ai:extract'), async (c) => {
  const body = await c.req.json<ExtractRequest>()

  if (!body.transcript || typeof body.transcript !== 'string') {
    return c.json({ error: 'Missing or invalid transcript' }, 400)
  }
  if (!body.fields || typeof body.fields !== 'object') {
    return c.json({ error: 'Missing or invalid fields' }, 400)
  }

  try {
    assertRecordLimit(body.fields, 256, 'fields')
    for (const field of Object.values(body.fields)) {
      if (!field || typeof field !== 'object') continue
      assertArrayLimit(field.options, 100, 'options')
      assertArrayLimit(field.suggestions, 100, 'suggestions')
    }
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Invalid fields' }, 400)
  }

  try {
    const { systemPrompt, model } = await SystemManagerRunner.buildManagerPrompt()
    const attribution = attributionFromIdentity(c.get('identity') as Identity | undefined)
    const { pi: session } = await AgentSession.create({
      model,
      systemPrompt,
      usage: { feature: 'ai-extract', attribution: () => attribution },
    })

    const fieldsSchema = JSON.stringify(body.fields, null, 2)
    const userMessage = `Extract structured form fields from this voice input.
Return ONLY valid JSON matching the field schema below — no explanation, no markdown fences.
Field "options" are the only allowed values — you must pick one of them. Field "suggestions" are previously used values for reference — you may use a new value if it better matches the voice input.

Fields:
${fieldsSchema}
${body.context ? `\nContext:\n${body.context}` : ''}

Voice input:
"${body.transcript}"`

    const chunks: string[] = []

    const result = await new Promise<string>((resolve, reject) => {
      session.subscribe((event) => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          chunks.push(event.assistantMessageEvent.delta)
        } else if (event.type === 'agent_end') {
          resolve(chunks.join(''))
        }
      })

      session.prompt(userMessage).catch(reject)
    })

    // Parse JSON from response — strip markdown fences if present
    const cleaned = result
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '')
      .trim()
    const fields = JSON.parse(cleaned)

    return c.json({ fields })
  } catch (error) {
    log.error('AI extract error:', error)
    return c.json({ error: 'Extraction failed' }, 502)
  }
})
