/**
 * End-to-end streaming download: a REAL sandbox-server process (the box),
 * the real SandboxClient, and Core's `createSandboxFileResponse` served by
 * Bun.serve, consumed over HTTP. Proves the >= 300 MiB transfer is streamed
 * end to end: this process hosts Core and the consumer, so any materialized
 * copy (box JSON envelope, Core buffer, unthrottled fetch read-ahead) would
 * show up as RSS growth of the file size.
 *
 * The file is sparse (`truncate`), so it costs no disk or page cache on the
 * runner while still exercising every byte of the transport. Gated to CI (or
 * FICUS_STREAMING_INTEGRATION=1) because it moves a few hundred MiB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { SandboxClient } from '../../services/sandbox/client/http-client'
import { createSandboxFileResponse, DOWNLOAD_LENGTH_HEADER } from './file-download'

const enabled = Boolean(process.env.CI || process.env.FICUS_STREAMING_INTEGRATION)
const SERVER_ENTRY = resolve(import.meta.dir, '../../../../../packages/sandbox-server/src/server.ts')
const FILE_SIZE = 320 * 1024 * 1024
const MAX_GROWTH = 64 * 1024 * 1024
const GC_EVERY = 32 * 1024 * 1024
const TOKEN = 'download-integration-token'

describe.skipIf(!enabled)('streaming download through Core (real sandbox server)', () => {
  let workspace: string
  let box: ReturnType<typeof Bun.spawn>
  let core: ReturnType<typeof Bun.serve>
  let client: SandboxClient

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'core-download-it-'))
    box = Bun.spawn(['bun', SERVER_ENTRY], {
      env: {
        ...process.env,
        EXECUTOR_SOCKET: '',
        EXECUTOR_SERVICE_CGROUP: '',
        EXECUTOR_PORT: '0',
        EXECUTOR_BIND: '127.0.0.1',
        EXECUTOR_AUTH_TOKEN: TOKEN,
        FICUS_BOX_PORT: '',
        EXECUTOR_DOCKER_RUNTIME: '',
        FICUS_SANDBOX_ROLE: 'agent',
        FICUS_BOX_HOME: workspace,
        HOME: workspace,
        WORKSPACE_PATH: workspace,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      },
      stdout: 'pipe',
      stderr: 'inherit',
    })
    let port = 0
    const decoder = new TextDecoder()
    let stdout = ''
    const reader = (box.stdout as ReadableStream<Uint8Array>).getReader()
    const deadline = Date.now() + 15_000
    while (!port && Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break
      stdout += decoder.decode(value, { stream: true })
      const match = stdout.match(/HTTP server listening on [^\n]+:(\d+)/)
      if (match) port = Number(match[1])
    }
    // Keep draining so the box never blocks on a full stdout pipe.
    void (async () => {
      for (;;) if ((await reader.read().catch(() => ({ done: true }))).done) break
    })()
    if (!port) throw new Error(`sandbox server did not start:\n${stdout}`)
    client = new SandboxClient(`127.0.0.1:${port}`, TOKEN)
    await client.waitForReady(10_000)

    core = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        const filePath = join(workspace, url.searchParams.get('path') ?? '')
        return createSandboxFileResponse(client, filePath, undefined, {
          range: req.headers.get('range'),
          signal: req.signal,
        })
      },
    })
  })

  afterAll(async () => {
    core?.stop(true)
    client?.close()
    box?.kill()
    await box?.exited
    rmSync(workspace, { recursive: true, force: true })
  })

  it('streams a >= 300 MiB file with flat memory and exact bytes', async () => {
    const filePath = join(workspace, 'big.bin')
    expect(Bun.spawnSync(['truncate', '-s', String(FILE_SIZE), filePath]).exitCode).toBe(0)
    const expected = createHash('sha256')
    // A sparse file reads as zeros.
    const zeros = new Uint8Array(1024 * 1024)
    for (let i = 0; i < FILE_SIZE / zeros.length; i += 1) expected.update(zeros)

    Bun.gc(true)
    const baseline = process.memoryUsage().rss
    let peak = baseline
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss)
    }, 20)

    const response = await fetch(`http://127.0.0.1:${core.port}/?path=big.bin`)
    expect(response.status).toBe(200)
    expect(response.headers.get(DOWNLOAD_LENGTH_HEADER)).toBe(String(FILE_SIZE))
    const hash = createHash('sha256')
    let received = 0
    const reader = response.body!.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      hash.update(value)
      // Collect per-chunk garbage as we go so RSS reflects what is RETAINED;
      // a buffering regression keeps its references and still shows up.
      if (received % GC_EVERY < value.byteLength) Bun.gc(true)
    }
    clearInterval(sampler)
    peak = Math.max(peak, process.memoryUsage().rss)

    expect(received).toBe(FILE_SIZE)
    expect(hash.digest('hex')).toBe(expected.digest('hex'))
    expect(peak - baseline).toBeLessThan(MAX_GROWTH)
  }, 120_000)

  it('resumes with Range through Core (206 + Content-Range)', async () => {
    const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251))
    writeFileSync(join(workspace, 'resume.bin'), bytes)
    const response = await fetch(`http://127.0.0.1:${core.port}/?path=resume.bin`, {
      headers: { range: 'bytes=4000-' },
    })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 4000-4095/4096')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(4000))

    const done = await fetch(`http://127.0.0.1:${core.port}/?path=resume.bin`, { headers: { range: 'bytes=4096-' } })
    expect(done.status).toBe(416)
    expect(done.headers.get('content-range')).toBe('bytes */4096')
  })

  it('streams a directory as a valid tar.gz', async () => {
    mkdirSync(join(workspace, 'project', 'nested'), { recursive: true })
    writeFileSync(join(workspace, 'project', 'nested', 'a.txt'), 'alpha')
    const response = await fetch(`http://127.0.0.1:${core.port}/?path=project`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain('project.tar.gz')
    const archive = join(workspace, 'project.tar.gz')
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
    const listing = Bun.spawnSync(['tar', '-tzf', archive])
    expect(listing.exitCode).toBe(0)
    expect(listing.stdout.toString()).toContain('project/nested/a.txt')
  })
})
