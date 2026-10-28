import { expect, test } from 'bun:test'
import { readBoundedBody, RequestBodyTooLargeError } from './read-bounded-body'

const request = (body: BodyInit, headers?: HeadersInit) =>
  new Request('http://localhost/', { method: 'POST', body, headers })
test('accepts exact byte budget and counts UTF-8 bytes rather than characters', async () => {
  expect(await readBoundedBody(request('12345678'), 8)).toEqual(new TextEncoder().encode('12345678'))
  await expect(readBoundedBody(request('😀😀😀'), 8)).rejects.toBeInstanceOf(RequestBodyTooLargeError)
})
test('counts actual chunks despite a dishonest small content length and cancels overflow', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(9))
    },
    cancel() {
      cancelled = true
    },
  })
  await expect(readBoundedBody(request(body, { 'Content-Length': '1' }), 8)).rejects.toBeInstanceOf(
    RequestBodyTooLargeError
  )
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
})
test('advertised oversize cancels without reading', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
  })
  await expect(readBoundedBody(request(body, { 'Content-Length': '9' }), 8)).rejects.toBeInstanceOf(
    RequestBodyTooLargeError
  )
  expect(cancelled).toBe(true)
})
test('empty and unknown-length bodies are handled; failures release locks', async () => {
  expect(await readBoundedBody(new Request('http://localhost/'), 8)).toHaveLength(0)
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.error(new Error('source failed'))
    },
  })
  await expect(readBoundedBody(request(body), 8)).rejects.toThrow('source failed')
  expect(body.locked).toBe(false)
})
test('abort cancels a stalled source and releases its lock', async () => {
  const controller = new AbortController()
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
  })
  const req = new Request('http://localhost/', { method: 'POST', body, signal: controller.signal })
  const reading = readBoundedBody(req, 8)
  controller.abort()
  await expect(reading).rejects.toThrow()
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
})
