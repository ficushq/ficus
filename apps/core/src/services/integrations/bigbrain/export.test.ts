import { expect, test } from 'bun:test'
import { encodeBigbrainSession, sendBigbrainSession } from './export'

test('session wire contains only role and text with a fixed protocol-safe cwd', async () => {
  const payload = encodeBigbrainSession([
    {
      role: 'user',
      text: 'hello',
      sourceMessageId: 'private-message-id',
      createdAt: new Date('2026-08-18T00:00:00Z'),
    },
  ])
  expect(new TextDecoder().decode(payload)).toBe('{"role":"user","text":"hello"}\n')

  let request: Request | undefined
  await sendBigbrainSession({
    payload,
    connection: {
      id: 'connection',
      squadId: 'private-squad-id',
      providerKey: 'bigbrain',
      adapterVersion: 1,
      configuration: { version: 1, apiBase: 'https://brain.example' },
    },
    credential: 'secret',
    agentId: 'private-agent-id',
    squadId: 'private-squad-id',
    streamId: 'stable-stream',
    fromLine: 1,
    fetch: async (input, init) => {
      request = new Request(input, init)
      return new Response(null, { status: 204 })
    },
  })
  expect(request?.headers.get('x-bigbrain-session')).toBe('ficus')
  expect(request?.headers.get('x-bigbrain-cwd')).toBe('.')
  expect(request?.headers.get('x-bigbrain-cwd')).not.toContain('private')
})
