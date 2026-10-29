import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Spawn the actual entrypoint: the CLI test preload mocks output/client in this
// process, so importing a command here would not exercise stdout or exit handling.
// Optional runtime override is for offline cross-version diagnosis, not a live API.
const runtime = process.env.FICUS_CLI_TEST_BUN || process.execPath
const entrypoint = join(import.meta.dir, 'index.ts')
// Owned installed-layout validation can execute the same host wrapper used in
// boxes. Never interpreted as a live host target; capture still uses fake auth.
const installedWrapper = process.env.FICUS_CLI_TEST_WRAPPER
type Destination = 'file' | 'pipe' | 'slow-pipe'
const large = {
  version: 7,
  padding: 'a'.repeat(65510) + '🙂é漢\n' + 'b'.repeat(131067) + '🙂é漢',
  tail: 'row🙂é漢\n'.repeat(10000),
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function capture(payload: unknown, destination: Destination, flags = ['--json'], status = 200) {
  const dir = mkdtempSync(join(tmpdir(), 'ficus-stdout-'))
  const path = join(dir, 'stdout')
  let fd: number | undefined
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    fd = destination === 'file' ? openSync(path, 'w', 0o600) : undefined
    const requests: string[] = []
    const body = Buffer.from(JSON.stringify(payload))
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        requests.push(`${request.method} ${new URL(request.url).pathname}`)
        // Deliberately split the response independently of JSON and UTF-8 boundaries.
        return new Response(
          new ReadableStream({
            start(controller) {
              for (let offset = 0; offset < body.length; offset += 8191) {
                controller.enqueue(body.subarray(offset, offset + 8191))
              }
              controller.close()
            },
          }),
          { status, headers: { 'Content-Type': 'application/json' } }
        )
      },
    })
    const command = [
      ...(installedWrapper ? [installedWrapper] : [runtime, entrypoint]),
      ...flags,
      'workstream',
      'flow',
      'synthetic',
    ]
    // Bun's subprocess capture can mask the older runtime's real OS-pipe failure.
    // Python uses os.pipe and forwards raw bytes without decoding/reformatting.
    const argv =
      destination === 'file'
        ? command
        : ['python3', join(import.meta.dir, 'test-fixtures/capture-pipe.py'), destination, ...command]
    const child = Bun.spawn(argv, {
      cwd: dir,
      // Never inherit real credentials, auth stores, or API targets from the caller.
      env: {
        HOME: dir,
        PATH: process.env.PATH || '',
        FICUS_AGENT_CONTEXT: '1',
        FICUS_API_URL: `http://127.0.0.1:${server.port}`,
        FICUS_TOKEN: 'synthetic-only',
        FICUS_AUTH_STORE: join(dir, 'auth.json'),
      },
      stdin: 'ignore',
      stdout: fd ?? 'pipe',
      stderr: 'pipe',
    })
    // Bound stalled readers/children independently of the test runner timeout.
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 12000)
    try {
      const [pipeBytes, stderr, code] = await Promise.all([
        destination === 'file'
          ? Promise.resolve(undefined)
          : new Response(child.stdout as ReadableStream<Uint8Array>).arrayBuffer().then((bytes) => Buffer.from(bytes)),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(timedOut).toBe(false)
      expect(requests).toEqual(['GET /api/workflows/runs/synthetic'])
      return { stdout: pipeBytes ?? readFileSync(path), stderr, code }
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill('SIGKILL')
      await child.exited
    }
  } finally {
    await server?.stop(true)
    if (fd !== undefined) closeSync(fd)
    rmSync(dir, { recursive: true, force: true })
  }
}

function expectComplete(result: Awaited<ReturnType<typeof capture>>, payload: unknown) {
  const expected = Buffer.from(JSON.stringify(payload, null, 2) + '\n')
  // Compact diagnostics on failure: never dump a huge or operational JSON value.
  expect({
    exit: result.code,
    stderr: result.stderr,
    bytes: result.stdout.length,
    hash: sha256(result.stdout),
  }).toEqual({
    exit: 0,
    stderr: '',
    bytes: expected.length,
    hash: sha256(expected),
  })
  expect(result.stdout.equals(expected)).toBe(true)
  expect(JSON.stringify(JSON.parse(result.stdout.toString())) === JSON.stringify(payload)).toBe(true)
}

for (const destination of ['file', 'pipe', 'slow-pipe'] as const) {
  test(`real CLI completes >200KB Unicode JSON to ${destination}`, async () => {
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(200 * 1024)
    expectComplete(await capture(large, destination), large)
  }, 15000) // Includes real CLI startup and a deliberately throttled reader, with a 10s producer kill bound.
}

for (const size of [0, 65509, 65510, 65511]) {
  test(`real CLI preserves small/boundary JSON (padding ${size})`, async () => {
    // Pretty-printed UTF-8 lengths are 26, 65535, 65536, and 65537 bytes.
    const payload = { text: 'x'.repeat(size) + '🙂é漢' }
    expect(Buffer.byteLength(JSON.stringify(payload, null, 2) + '\n')).toBe(size + 26)
    expectComplete(await capture(payload, 'pipe'), payload)
  }, 15000)
}

test('JSON still takes precedence over quiet', async () => {
  expectComplete(await capture({ ok: true }, 'pipe', ['--json', '--quiet']), { ok: true })
}, 15000)

test('quiet success remains silent', async () => {
  const result = await capture({ ok: true }, 'pipe', ['--quiet'])
  expect({ code: result.code, stdout: result.stdout.toString(), stderr: result.stderr }).toEqual({
    code: 0,
    stdout: '',
    stderr: '',
  })
}, 15000)

test('API failure stays on stderr with a nonzero exit and no stdout', async () => {
  const result = await capture({ error: 'synthetic failure' }, 'pipe', ['--json'], 503)
  expect({ code: result.code, stdout: result.stdout.toString(), stderr: result.stderr }).toEqual({
    code: 1,
    stdout: '',
    stderr: '{"error":"synthetic failure"}\n',
  })
}, 15000)
