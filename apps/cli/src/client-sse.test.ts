import { expect, test } from 'bun:test'

// Command tests preload a mocked client. Run the real boundary in a child,
// using only local Response/ReadableStream instances, never a network server.
function checkClient(script: string) {
  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `
      import { strict as assert } from 'node:assert'
      import { apiPostSSE } from './src/client.ts'
      const encoder = new TextEncoder()
      function respond(chunks) {
        const stream = new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
            controller.close()
          },
        })
        globalThis.fetch = async () => new Response(stream)
        return stream
      }
      async function collect(chunks) {
        respond(chunks)
        const events = []
        await apiPostSSE('/fixture', {}, (event, data) => events.push([event, data]))
        return events
      }
      ${script}
      `,
    ],
    { cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' }
  )
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
}

test('preserves event names across every byte boundary, including split UTF-8 and CRLF', () => {
  checkClient(String.raw`
    assert.deepEqual(await collect(['event: text\n', 'data: hé🌱\n\n']), [['text', 'hé🌱']])
    const bytes = encoder.encode('event: text\r\ndata: {"text":"hé🌱"}\r\n\r\nevent: done\ndata: {}\n\n')
    const expected = [['text', '{"text":"hé🌱"}'], ['done', '{}']]
    // Every possible two-chunk split, plus one transport read per byte.
    for (let split = 1; split < bytes.length; split++) {
      assert.deepEqual(await collect([bytes.slice(0, split), bytes.slice(split)]), expected, 'split ' + split)
    }
    assert.deepEqual(await collect(Array.from(bytes, byte => Uint8Array.of(byte))), expected)
  `)
})

test('resets the event name at blank lines, not comments, data lines, or transport reads', () => {
  checkClient(String.raw`
    assert.deepEqual(await collect([
      'event: progress\ndata: first\n',
      ': keepalive\nid: ignored\ndata: second\n\n',
      'data: default\n\nevent: result\ndata: {}\n\nevent: error\ndata: failed\n\n',
    ]), [
      ['progress', 'first'], ['progress', 'second'], ['message', 'default'],
      ['result', '{}'], ['error', 'failed'],
    ])
  `)
})

test('preserves per-data-line callbacks and ignores unsupported or unterminated lines at EOF', () => {
  checkClient(String.raw`
    assert.deepEqual(await collect([
      'garbage\n: comment\ndata:no-space\nevent:no-space\n',
      'data: \nevent: text\ndata:  leading space\ndata: not JSON\ndata: truncated',
    ]), [['message', ''], ['text', ' leading space'], ['text', 'not JSON']])
    assert.deepEqual(await collect(['event: unused\n\n']), [])
    assert.deepEqual(await collect([]), [])
  `)
})

test('delivers complete data lines immediately without waiting for a frame boundary or EOF', () => {
  checkClient(String.raw`
    let controller
    const stream = new ReadableStream({ start(c) { controller = c } })
    globalThis.fetch = async () => new Response(stream)
    let received
    const eventReceived = new Promise(resolve => { received = resolve })
    const request = apiPostSSE('/fixture', {}, (event, data) => received([event, data]))
    controller.enqueue(encoder.encode('event: text\ndata: hello\n'))
    assert.deepEqual(await eventReceived, ['text', 'hello'])
    controller.close()
    await request
    assert.equal(stream.locked, false)
  `)
})

test('cancels and unlocks the reader when a callback throws, preserving the original error', () => {
  checkClient(String.raw`
    const failure = new Error('callback failed')
    let cancelled = 0
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode('data: first\ndata: second\n')) },
      cancel() { cancelled++; throw new Error('cleanup failed') },
    })
    globalThis.fetch = async () => new Response(stream)
    let calls = 0
    await assert.rejects(apiPostSSE('/fixture', {}, () => { calls++; throw failure }), error => error === failure)
    assert.equal(calls, 1)
    assert.equal(cancelled, 1)
    assert.equal(stream.locked, false)
  `)
})

test('propagates reader errors and releases the lock', () => {
  checkClient(String.raw`
    const failure = new Error('disconnected')
    const stream = new ReadableStream({ start(controller) { controller.error(failure) } })
    globalThis.fetch = async () => new Response(stream)
    await assert.rejects(apiPostSSE('/fixture', {}, () => assert.fail('unexpected event')), error => error === failure)
    assert.equal(stream.locked, false)
  `)
})

test('optional caller abort cancels a pending read, rejects with its reason, and unlocks the reader', () => {
  checkClient(String.raw`
    const abort = new AbortController()
    const reason = new Error('caller stopped')
    let reading
    const readStarted = new Promise(resolve => { reading = resolve })
    let cancelled = 0
    const stream = new ReadableStream({
      pull() { reading() },
      cancel(value) { assert.equal(value, reason); cancelled++ },
    }, { highWaterMark: 0 })
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.signal, abort.signal)
      return new Response(stream)
    }
    const request = apiPostSSE('/fixture', {}, () => assert.fail('unexpected event'), { signal: abort.signal })
    const rejected = assert.rejects(request, error => error === reason)
    await readStarted
    abort.abort(reason)
    await rejected
    assert.equal(cancelled, 1)
    assert.equal(stream.locked, false)
  `)
})

test('rejects already-aborted callers without fetching and stops callbacks when aborted mid-chunk', () => {
  checkClient(String.raw`
    const abort = new AbortController()
    abort.abort()
    globalThis.fetch = async () => assert.fail('must not fetch')
    await assert.rejects(apiPostSSE('/fixture', {}, () => {}, { signal: abort.signal }), error => error === abort.signal.reason)

    const during = new AbortController()
    const stream = respond(['data: first\ndata: second\n'])
    const events = []
    await assert.rejects(apiPostSSE('/fixture', {}, (_event, data) => {
      events.push(data)
      during.abort()
    }, { signal: during.signal }), error => error === during.signal.reason)
    assert.deepEqual(events, ['first'])
    assert.equal(stream.locked, false)
  `)
})

test('keeps HTTP errors, missing bodies, and fetch failures as rejections', () => {
  checkClient(String.raw`
    globalThis.fetch = async () => Response.json({ error: 'forbidden' }, { status: 403 })
    await assert.rejects(apiPostSSE('/fixture', {}, () => {}), error => error.status === 403 && error.message === 'forbidden')
    globalThis.fetch = async () => new Response(null)
    await assert.rejects(apiPostSSE('/fixture', {}, () => {}), /No response body/)
    const failure = new Error('network failed')
    globalThis.fetch = async () => { throw failure }
    await assert.rejects(apiPostSSE('/fixture', {}, () => {}), error => error === failure)
  `)
})

test('cleans up when the signal aborts while fetch resolves, before reading starts', () => {
  checkClient(String.raw`
    const abort = new AbortController()
    let cancelled = 0
    const stream = new ReadableStream({ cancel() { cancelled++ } })
    globalThis.fetch = async () => {
      abort.abort()
      return new Response(stream)
    }
    await assert.rejects(apiPostSSE('/fixture', {}, () => assert.fail('unexpected event'), {
      signal: abort.signal,
    }), error => error === abort.signal.reason)
    assert.equal(cancelled, 1)
    assert.equal(stream.locked, false)
  `)
})

test('removes the abort listener and releases the reader on normal completion', () => {
  checkClient(String.raw`
    const { getEventListeners } = await import('node:events')
    const abort = new AbortController()
    const stream = respond(['event: done\ndata: {}\n\n'])
    const events = []
    await apiPostSSE('/fixture', {}, (event, data) => events.push([event, data]), { signal: abort.signal })
    assert.deepEqual(events, [['done', '{}']])
    assert.equal(stream.locked, false)
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
    abort.abort()
  `)
})
