import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { handleUpload, handleStat } from '../../../../../packages/sandbox-server/src/services/filesystem'
import { handleDownload } from '../../../../../packages/sandbox-server/src/services/download'
import { stageWorkspaceMultipart } from '../../services/attachments/workspace-multipart'
import { publishWorkspaceUpload } from '../../services/squad/workspace-upload'
import { SandboxClient } from '../../services/sandbox/client/http-client'
import { requestBodyLimits } from '../../middleware/request-body-limits'
import { createSandboxFileResponse } from './file-download'

// Bounded local fixture; CI retains the separate 320 MiB memory/download regression.
test('8MiB multipart -> Core staging -> sandbox atomic upload -> streaming download preserves bytes with limits on', async () => {
  const root = await mkdtemp(join(tmpdir(), 'transfer-budget-'))
  const previous = process.env.WORKSPACE_PATH
  process.env.WORKSPACE_PATH = root
  const box = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: Infinity,
    async fetch(req) {
      if (req.headers.get('authorization') !== 'Bearer fixture') return new Response('Unauthorized', { status: 401 })
      const url = new URL(req.url)
      if (url.pathname === '/upload') return handleUpload(url, req)
      if (url.pathname === '/download') return handleDownload(url, req)
      if (url.pathname === '/stat') return handleStat(await req.json())
      return new Response('Not found', { status: 404 })
    },
  })
  const client = new SandboxClient(`127.0.0.1:${box.port}`, 'fixture')
  const app = new Hono()
  app.use('*', requestBodyLimits)
  app.post('/api/squads/fixture/workspace/upload', async (c) => {
    const staged = await stageWorkspaceMultipart(c.req.raw)
    try {
      return c.json(
        await publishWorkspaceUpload({
          staged,
          workspacePath: root,
          targetDir: '',
          overwrite: true,
          client,
          signal: c.req.raw.signal,
        })
      )
    } finally {
      await staged.cleanup()
    }
  })
  app.get('/api/squads/fixture/workspace/download', (c) =>
    createSandboxFileResponse(client, join(root, c.req.query('path') ?? 'large.bin'), undefined, {
      range: c.req.header('range'),
      signal: c.req.raw.signal,
    })
  )
  const core = Bun.serve({ hostname: '127.0.0.1', port: 0, maxRequestBodySize: Infinity, fetch: app.fetch })
  const chunk = new Uint8Array(64 * 1024).fill(90)
  const expected = createHash('sha256')
  for (let i = 0; i < 128; i++) expected.update(chunk)
  const closingPrefixes = Buffer.from('\r\n--fixture--Xstill-file\r\n--fixture--\rXstill-file')
  expected.update(closingPrefixes)
  const expectedBytes = 8 * 1024 ** 2 + closingPrefixes.byteLength
  const text = new TextEncoder()
  async function* multipart() {
    yield text.encode('--fixture\r\nContent-Disposition: form-data; name="file"; filename="large.bin"\r\n\r\n')
    for (let i = 0; i < 128; i++) yield chunk
    yield closingPrefixes
    yield text.encode(
      '\r\n--fixture\r\nX-Padding: ' +
        'x'.repeat(82 * 1024) +
        '\r\n' +
        Array.from({ length: 2001 }, (_, i) => `X-${i}: x\r\n`).join('') +
        'Content-Disposition: form-data; name="later"; filename="later.txt"\r\n\r\nlater contents'
    )
    yield text.encode(
      '\r\n--fixture\r\nContent-Disposition: form-data; name="path_file"\r\n\r\nlarge.bin\r\n--fixture--\r\n'
    )
  }
  const parts = multipart()
  const uploadBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const part = await parts.next()
      if (part.done) controller.close()
      else controller.enqueue(part.value)
    },
    async cancel() {
      await parts.return(undefined)
    },
  })
  try {
    const upload = await fetch(`http://127.0.0.1:${core.port}/api/squads/fixture/workspace/upload`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=fixture' },
      body: uploadBody,
    })
    expect(upload.status).toBe(200)
    expect(await upload.json()).toEqual([
      { path: 'large.bin', status: 'created' },
      { path: 'later.txt', status: 'created' },
    ])
    expect(
      await (await fetch(`http://127.0.0.1:${core.port}/api/squads/fixture/workspace/download?path=later.txt`)).text()
    ).toBe('later contents')
    const download = await fetch(`http://127.0.0.1:${core.port}/api/squads/fixture/workspace/download`)
    expect(download.status).toBe(200)
    let bytes = 0
    const actual = createHash('sha256')
    for await (const part of download.body!) {
      bytes += part.byteLength
      actual.update(part)
    }
    expect(bytes).toBe(expectedBytes)
    expect(actual.digest('hex')).toBe(expected.digest('hex'))
    const range = await fetch(`http://127.0.0.1:${core.port}/api/squads/fixture/workspace/download`, {
      headers: { range: 'bytes=1048576-1048639' },
    })
    expect(range.status).toBe(206)
    expect(range.headers.get('content-range')).toBe(`bytes 1048576-1048639/${expectedBytes}`)
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(chunk.subarray(0, 64))
    await mkdir(join(root, 'archive'))
    await writeFile(join(root, 'archive/note.txt'), 'archive contents')
    const archive = await fetch(`http://127.0.0.1:${core.port}/api/squads/fixture/workspace/download?path=archive`)
    expect(archive.status).toBe(200)
    expect(archive.headers.get('content-disposition')).toContain('archive.tar.gz')
    const archivePath = join(root, 'archive.tar.gz')
    await Bun.write(archivePath, archive)
    const contents = Bun.spawnSync(['tar', '-xOzf', archivePath, 'archive/note.txt'])
    expect(contents.exitCode).toBe(0)
    expect(contents.stdout.toString()).toBe('archive contents')
    const cancelled = await fetch(`http://127.0.0.1:${core.port}/api/squads/fixture/workspace/download`)
    await cancelled.body!.cancel()
  } finally {
    client.close()
    await core.stop(true)
    await box.stop(true)
    if (previous === undefined) delete process.env.WORKSPACE_PATH
    else process.env.WORKSPACE_PATH = previous
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
