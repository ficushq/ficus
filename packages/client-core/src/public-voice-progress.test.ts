import { expect, test } from 'bun:test'
import { readVoiceDerivation } from './public-voice-progress'
const started = { version: 1, runId: 'fixture', seq: 1, type: 'started' }
const error = { version: 1, runId: 'fixture', seq: 2, type: 'error', error: { code: 'derivation_invalid_output', reason: 'not_json' } }
function response(text: string, chunk = 1) {
  const bytes = new TextEncoder().encode(text)
  return new Response(new ReadableStream({ start(c) { for (let i=0; i<bytes.length; i+=chunk) c.enqueue(bytes.slice(i,i+chunk)); c.close() } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
const frame = (event: unknown) => `event: derivation\r\ndata: ${JSON.stringify(event)}\r\n\r\n`
test('fragmented UTF-8 and CRLF preserve events and typed failures', async () => {
  const events: unknown[] = []
  await expect(readVoiceDerivation(response(': heartbeat\r\n\r\n'+frame(started)+frame({ version:1, runId:'fixture', seq:2, type:'finding', index:0, text:'Uses café language.' })+frame({...error,seq:3})), { onProgress: e => {events.push(e)} })).rejects.toMatchObject({ code: 'derivation_invalid_output', payload: { reason: 'not_json' } })
  expect(events).toHaveLength(2)
  expect(JSON.stringify(events)).toContain('café')
})
for (const [name, text] of [
  ['truncated', frame(started)], ['bad sequence', frame(started)+frame({...error, seq:1})],
  ['bad run', frame(started)+frame({...error, runId:'other'})], ['duplicate terminal', frame(started)+frame(error)+frame({...error,seq:3})],
  ['unknown fields', frame({...started, text:'private'})], ['oversize', 'data: '+'x'.repeat(65537)],
] as const) test(`fails closed on ${name}`, async () => {
  await expect(readVoiceDerivation(response(text, 4096))).rejects.toMatchObject({ code: 'derivation_stream_interrupted' })
})
test('an aborted reader drops already-buffered callbacks and cancels the body', async () => {
  const controller = new AbortController(); controller.abort()
  let calls = 0
  await expect(readVoiceDerivation(response(frame(started)+frame(error)), { signal: controller.signal, onProgress: () => {calls++} })).rejects.toBeDefined()
  expect(calls).toBe(0)
})
