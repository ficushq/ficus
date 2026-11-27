import { expect, test } from 'bun:test'
import { formatApiErrorPayload } from './client-errors'

test('formats bounded authoritative integration usage conflicts', () => {
  const message = formatApiErrorPayload(
    {
      error: 'Integration connection is assigned to squads',
      usage: {
        squadCount: 2,
        squads: [
          { id: 'a', name: 'Alpha' },
          { id: 'b', name: 'Beta' },
        ],
      },
    },
    'Request failed: 409'
  )
  expect(message).toBe('Integration connection is assigned to squads. Used by 2 squads: Alpha, Beta')
  expect(message.length).toBeLessThanOrEqual(500)
})

// The CLI preload replaces client.ts for command tests. A child exercises the real
// HTTP boundary without inheriting those module mocks; fetch stays entirely local.
test('preserves structured error payloads and legacy fallbacks across the real client boundary', () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `
    import { strict as assert } from 'node:assert'
    import { apiPost } from './src/client.ts'
    import { ApiRequestError } from './src/client-errors.ts'
    import { runDerivation } from './src/commands/voice.ts'
    const payload = { error: 'derivation_too_few_samples', counts: { kept: 2, collected: 10 }, minimum: 8 }
    globalThis.fetch = async () => Response.json(payload, { status: 422 })
    await assert.rejects(apiPost('/fixture'), error => {
      assert(error instanceof ApiRequestError)
      assert.equal(error.code, payload.error)
      assert.equal(error.status, 422)
      assert.deepEqual(error.payload, payload)
      return true
    })
    for (const [code, sentence] of [
      ['derivation_github_unavailable', 'GitHub is unavailable'],
      ['derivation_login_not_visible', 'not found or is not visible'],
      ['derivation_too_few_samples', 'kept 2 of 10 collected; at least 8'],
      ['derivation_invalid_output', 'overlapped private sample text'],
      ['derivation_model_unavailable', 'model is unavailable'],
    ]) {
      globalThis.fetch = async () => Response.json({ ...payload, error: code, reason: 'private_text_in_base' }, { status: 422 })
      await assert.rejects(runDerivation('fixture', { github: 'octocat' }), error => {
        assert(error.message.startsWith(code + ': '))
        assert(error.message.includes(sentence))
        return true
      })
    }
    globalThis.fetch = async () => Response.json({ code: 'forbidden', error: 'Permission denied' }, { status: 403 })
    await assert.rejects(apiPost('/fixture'), error => error.code === 'forbidden' && error.message === 'Permission denied')
    for (const body of ['<html>Bad gateway</html>', 'null']) {
      globalThis.fetch = async () => new Response(body, { status: 502 })
      await assert.rejects(apiPost('/fixture'), error => error.message === 'Request failed: 502')
    }
    const network = new Error('Network disconnected')
    globalThis.fetch = async () => { throw network }
    await assert.rejects(apiPost('/fixture'), error => error === network)
    globalThis.fetch = async () => Response.json({ draft: { base: 'Synthetic draft.' } })
    assert.deepEqual(await apiPost('/fixture'), { draft: { base: 'Synthetic draft.' } })
  `,
    ],
    { cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' }
  )
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
})

// Real client in a child process (the preload mocks client.ts); fetch is replaced and stays local.
test('idempotent POST retries dropped connections and in-progress answers with one key, and bounds its time', () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `
    import { strict as assert } from 'node:assert'
    import { apiPostIdempotent, IdempotentRequestIncompleteError } from './src/client.ts'
    import { ApiRequestError } from './src/client-errors.ts'
    const sleep = async () => {}
    const calls = []
    const answers = [
      () => { throw new TypeError('The socket connection was closed unexpectedly') },
      () => Response.json({ code: 'create_in_progress', error: 'still creating' }, { status: 409 }),
      () => new Response('bad gateway', { status: 502 }),
      () => Response.json({ id: 'stream-1', reusedFromIdempotencyKey: true }, { status: 200 }),
    ]
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), key: init.headers['Idempotency-Key'], body: init.body })
      return answers[calls.length - 1]()
    }
    const retries = []
    const created = await apiPostIdempotent('/api/workstreams', { title: 'T' }, {
      idempotencyKey: 'key-1', timeoutMs: 60_000, sleep, onRetry: (attempt) => retries.push(attempt),
    })
    assert.deepEqual(created, { id: 'stream-1', reusedFromIdempotencyKey: true })
    assert.equal(calls.length, 4)
    assert.deepEqual(new Set(calls.map((call) => call.key)), new Set(['key-1']))
    assert.deepEqual(new Set(calls.map((call) => call.body)), new Set([JSON.stringify({ title: 'T' })]))
    assert.deepEqual(retries, [1, 2, 3])

    // An answer whose body cannot be read is final, not retried.
    calls.length = 0
    globalThis.fetch = async (url, init) => {
      calls.push(init)
      return new Response('not json', { status: 201 })
    }
    await assert.rejects(apiPostIdempotent('/api/workstreams', {}, { idempotencyKey: 'k', timeoutMs: 60_000, sleep }))
    assert.equal(calls.length, 1)

    // Any other error answer is final: no retry.
    calls.length = 0
    globalThis.fetch = async (url, init) => {
      calls.push(init)
      return Response.json({ error: 'Squad not found' }, { status: 404 })
    }
    await assert.rejects(
      apiPostIdempotent('/api/workstreams', {}, { idempotencyKey: 'k', timeoutMs: 60_000, sleep }),
      (error) => error instanceof ApiRequestError && error.status === 404
    )
    assert.equal(calls.length, 1)

    // Retries are bounded.
    calls.length = 0
    globalThis.fetch = async (url, init) => {
      calls.push(init)
      throw new TypeError('connection refused')
    }
    await assert.rejects(
      apiPostIdempotent('/api/workstreams', {}, { idempotencyKey: 'k', timeoutMs: 60_000, maxRetries: 2, sleep }),
      (error) => error instanceof IdempotentRequestIncompleteError && error.reason === 'retries' && error.idempotencyKey === 'k'
    )
    assert.equal(calls.length, 3)

    // A server that never answers is abandoned at the time budget.
    globalThis.fetch = (url, init) =>
      new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
    const started = Date.now()
    await assert.rejects(
      apiPostIdempotent('/api/workstreams', {}, { idempotencyKey: 'k', timeoutMs: 200, sleep }),
      (error) => error instanceof IdempotentRequestIncompleteError && error.reason === 'timeout'
    )
    assert(Date.now() - started < 5_000)
  `,
    ],
    { cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' }
  )
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
})

// Real client in a child process (the preload mocks client.ts). The server is a local
// Bun listener whose idle timer drops a slow read, as Core's did before its read deadline.
test('a read whose connection is dropped says so, and a read deadline answer keeps its code', () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `
    import { strict as assert } from 'node:assert'
    import { apiGet, ReadConnectionDroppedError } from './src/client.ts'
    import { ApiRequestError } from './src/client-errors.ts'
    let release
    const held = new Promise((resolve) => { release = resolve })
    const server = Bun.serve({
      port: 0,
      idleTimeout: 1,
      async fetch(request) {
        if (new URL(request.url).pathname === '/slow') await held
        return Response.json(
          { error: 'Ficus is busy and did not finish this read within 25 seconds.', code: 'read_deadline_exceeded' },
          { status: 503, headers: { 'Retry-After': '5' } }
        )
      },
    })
    // Whatever API address the client resolves, send it to the local listener.
    const realFetch = globalThis.fetch
    globalThis.fetch = (url, init) => realFetch('http://127.0.0.1:' + server.port + new URL(String(url)).pathname, init)
    await assert.rejects(apiGet('/slow'), (error) => {
      assert(error instanceof ReadConnectionDroppedError)
      assert.match(error.message, /closed the connection before answering this read/)
      assert.match(error.message, /Nothing was changed/)
      return true
    })
    await assert.rejects(apiGet('/deadline'), (error) => {
      assert(error instanceof ApiRequestError)
      assert.equal(error.status, 503)
      assert.equal(error.code, 'read_deadline_exceeded')
      assert.match(error.message, /did not finish this read within 25 seconds/)
      return true
    })
    // Other network failures pass through unchanged.
    const refused = new TypeError('connection refused')
    globalThis.fetch = async () => { throw refused }
    await assert.rejects(apiGet('/x'), (error) => error === refused)
    release()
    server.stop(true)
  `,
    ],
    { cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' }
  )
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
}, 30_000)

// Real client in a child process (the preload mocks client.ts); fetch is replaced and stays local.
test('a capped list follows its Link header, then each page cursor, on its own path', () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `
    import { strict as assert } from 'node:assert'
    import { apiGetList } from './src/client.ts'
    const calls = []
    const answers = [
      () => Response.json([{ id: 'open' }, { id: 'h1' }], {
        headers: { Link: '</api/workstreams?squadId=s&statuses=done%2Ccanceled&limit=2&cursor=c1>; rel="next"' },
      }),
      () => Response.json({ items: [{ id: 'h2' }, { id: 'h3' }], hasMore: true, nextCursor: 'c2', totalCount: 4 }),
      () => Response.json({ items: [{ id: 'h4' }], hasMore: false, nextCursor: null, totalCount: 4 }),
    ]
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      return answers[calls.length - 1]()
    }
    const rows = await apiGetList('/api/workstreams?squadId=s')
    assert.deepEqual(rows.map((row) => row.id), ['open', 'h1', 'h2', 'h3', 'h4'])
    assert.deepEqual(calls, [
      'https://ficus.example/prefix/api/workstreams?squadId=s',
      'https://ficus.example/prefix/api/workstreams?squadId=s&statuses=done%2Ccanceled&limit=2&cursor=c1',
      'https://ficus.example/prefix/api/workstreams?squadId=s&statuses=done%2Ccanceled&limit=2&cursor=c2',
    ])

    // A server that does not cap answers in one request.
    calls.length = 0
    answers.splice(0, answers.length, () => Response.json([{ id: 'only' }]))
    assert.deepEqual(await apiGetList('/api/workstreams'), [{ id: 'only' }])
    assert.equal(calls.length, 1)

    // A page that repeats its cursor cannot loop forever.
    calls.length = 0
    answers.splice(0, answers.length,
      () => Response.json([], { headers: { Link: '</api/workstreams?limit=1&cursor=x>; rel="next"' } }),
      () => Response.json({ items: [{ id: 'a' }], nextCursor: 'x' }),
    )
    assert.deepEqual(await apiGetList('/api/workstreams'), [{ id: 'a' }])
    assert.equal(calls.length, 2)
  `,
    ],
    {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, FICUS_API_URL: 'https://ficus.example/prefix', FICUS_TOKEN: 'fixture-token' },
    }
  )
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
})
