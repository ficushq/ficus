import { expect, test } from 'bun:test'
import { readVoiceDerivation } from './public-voice-progress'
const started = { version: 1, runId: 'fixture', seq: 1, type: 'started' }
const error = {
  version: 1,
  runId: 'fixture',
  seq: 2,
  type: 'error',
  error: { code: 'derivation_invalid_output', reason: 'not_json' },
}
function response(text: string, chunk = 1) {
  const bytes = new TextEncoder().encode(text)
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk))
        c.close()
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
}
const frame = (event: unknown) => `event: derivation\r\ndata: ${JSON.stringify(event)}\r\n\r\n`
test('fragmented UTF-8 and CRLF preserve events and typed failures', async () => {
  const events: unknown[] = []
  await expect(
    readVoiceDerivation(
      response(
        ': heartbeat\r\n\r\n' +
          frame(started) +
          frame({ version: 1, runId: 'fixture', seq: 2, type: 'finding', index: 0, text: 'Uses café language.' }) +
          frame({ ...error, seq: 3 })
      ),
      {
        onProgress: (e) => {
          events.push(e)
        },
      }
    )
  ).rejects.toMatchObject({ code: 'derivation_invalid_output', payload: { reason: 'not_json' } })
  expect(events).toHaveLength(2)
  expect(JSON.stringify(events)).toContain('café')
})
for (const [name, text] of [
  ['truncated', frame(started)],
  ['bad sequence', frame(started) + frame({ ...error, seq: 1 })],
  ['bad run', frame(started) + frame({ ...error, runId: 'other' })],
  ['duplicate terminal', frame(started) + frame(error) + frame({ ...error, seq: 3 })],
  ['unknown fields', frame({ ...started, text: 'private' })],
  ['oversize', 'data: ' + 'x'.repeat(65537)],
] as const)
  test(`fails closed on ${name}`, async () => {
    await expect(readVoiceDerivation(response(text, 4096))).rejects.toMatchObject({
      code: 'derivation_stream_interrupted',
    })
  })
test('an aborted reader drops already-buffered callbacks and cancels the body', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await expect(
    readVoiceDerivation(response(frame(started) + frame(error)), {
      signal: controller.signal,
      onProgress: () => {
        calls++
      },
    })
  ).rejects.toBeDefined()
  expect(calls).toBe(0)
})

const result = {
  login: 'octo',
  draft: { base: 'Lead with the result.', surfaces: {} },
  observations: ['Use complete sentences.'],
  exemplars: [],
  sampling: {
    filters: {},
    counts: {
      collected: 20,
      kept: 20,
      droppedByFilter: { date: 0, repository: 0 },
      droppedAsToolAuthored: 0,
      droppedAsTemplate: 0,
    },
    dateRange: {},
    publicRepositories: [],
    privateRepositories: [],
    pagingCapped: false,
  },
  bytes: 20,
  maxBytes: 2000 as const,
}
test('successful terminal and same-request legacy JSON yield the same final result', async () => {
  const complete = { version: 1, runId: 'fixture', seq: 2, type: 'complete', result }
  expect(await readVoiceDerivation(response(frame(started) + frame(complete), 7))).toEqual(result)
  let legacy = false
  expect(
    await readVoiceDerivation(Response.json(result), {
      onLegacyResponse: () => {
        legacy = true
      },
    })
  ).toEqual(result)
  expect(legacy).toBe(true)
})
test('idle frames, not a partial byte dribble, own the deadline and cancellation', async () => {
  let cancelled = false
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('event: deri'))
      },
      cancel() {
        cancelled = true
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
  await expect(readVoiceDerivation(response, { idleMs: 5, deadlineMs: 100 })).rejects.toMatchObject({
    code: 'derivation_stream_interrupted',
  })
  expect(cancelled).toBe(true)
})
test('outer deadline cancels even an idle connection', async () => {
  const response = new Response(new ReadableStream({ start() {} }), {
    headers: { 'Content-Type': 'text/event-stream' },
  })
  await expect(readVoiceDerivation(response, { idleMs: 100, deadlineMs: 5 })).rejects.toMatchObject({
    code: 'derivation_stream_interrupted',
  })
})

test('unknown nested draft fields fail closed rather than being silently stripped', async () => {
  const bad = {
    ...result,
    draft: {
      base: 'Lead with the result.',
      surfaces: { commits: { mode: 'add', text: 'Use complete sentences.', raw: 'private sentinel' } },
    },
  }
  await expect(
    readVoiceDerivation(
      response(frame(started) + frame({ version: 1, runId: 'fixture', seq: 2, type: 'complete', result: bad }))
    )
  ).rejects.toMatchObject({ code: 'derivation_stream_interrupted' })
})
