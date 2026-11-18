import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { Hono } from 'hono'
import { AgentSession } from '../entities/AgentSession'
import { SystemManagerRunner } from '../entities/agent-runners/system-manager-runner'
import { identityMiddleware } from '../middleware/identity'
import { authHeaders, cleanupTestRbac, createTestAdmin, type TestUser } from '../test-utils'
import { AI_EXTRACT_SYSTEM_PROMPT, aiExtractRouter } from './ai-extract'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/ai/extract', aiExtractRouter)

const prefix = `ai-extract-${crypto.randomUUID()}`
let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
})

afterAll(async () => {
  await cleanupTestRbac(prefix)
})

const spies: Array<{ mockRestore: () => void }> = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

describe('POST /api/ai/extract', () => {
  test('records its model calls as ai-extract, attributed to the caller', async () => {
    spies.push(spyOn(SystemManagerRunner, 'resolveModel').mockResolvedValue('anthropic:claude-sonnet-4-5'))
    const createSpy = spyOn(AgentSession, 'create').mockResolvedValue({
      pi: {
        subscribe: (listener: (event: unknown) => void) => {
          queueMicrotask(() => {
            listener({
              type: 'message_update',
              assistantMessageEvent: { type: 'text_delta', delta: '{"title":"x"}' },
            })
            listener({ type: 'agent_end', messages: [] })
          })
          return () => {}
        },
        prompt: async () => {},
      },
    } as never)
    spies.push(createSpy)

    const response = await app.request('/api/ai/extract', {
      method: 'POST',
      headers: { ...authHeaders(admin.token), 'content-type': 'application/json' },
      body: JSON.stringify({ transcript: 'title x', fields: { title: { type: 'string' } } }),
    })

    expect(response.status).toBe(200)
    const options = (
      createSpy.mock.calls[0] as unknown as [
        { systemPrompt: string; usage: { feature: string; attribution: () => unknown } },
      ]
    )[0]
    // Its own short prompt, not the system manager's full prompt with CLI help.
    expect(options.systemPrompt).toBe(AI_EXTRACT_SYSTEM_PROMPT)
    expect(options.usage.feature).toBe('ai-extract')
    expect(options.usage.attribution()).toEqual({ userId: admin.id })
  })
})

test('collection limits stop oversized fields and suggestions before model work', async () => {
  const prompt = spyOn(SystemManagerRunner, 'resolveModel').mockRejectedValue(new Error('must not reach model'))
  spies.push(prompt)
  for (const fields of [
    Object.fromEntries(Array.from({ length: 257 }, (_, i) => ['f' + i, null])),
    { field: { type: 'string', options: Array(101).fill('x') } },
    { field: { type: 'string', suggestions: Array(101).fill('x') } },
  ]) {
    const response = await app.request('/api/ai/extract', {
      method: 'POST',
      headers: { ...authHeaders(admin.token), 'content-type': 'application/json' },
      body: JSON.stringify({ transcript: 'hello', fields }),
    })
    expect(response.status).toBe(400)
  }
  expect(prompt).not.toHaveBeenCalled()
})
