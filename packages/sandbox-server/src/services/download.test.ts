import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { handleDownload, parseRangeHeader } from './download'

let testDir: string

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'sandbox-download-'))
  process.env.WORKSPACE_PATH = testDir
})

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  delete process.env.WORKSPACE_PATH
})

function request(path: string, init: { range?: string; archive?: string; signal?: AbortSignal } = {}) {
  const url = new URL('http://box/download')
  url.searchParams.set('path', path)
  if (init.archive) url.searchParams.set('archive', init.archive)
  const headers: Record<string, string> = {}
  if (init.range) headers.range = init.range
  return { url, req: new Request(url, { headers, signal: init.signal }) }
}

async function download(
  path: string,
  init: { range?: string; archive?: string; signal?: AbortSignal; tarCommand?: string } = {},
  hooks: { log?: (m: string) => void } = {}
) {
  const { url, req } = request(path, init)
  return handleDownload(url, req, { ...hooks, tarCommand: init.tarCommand })
}

function fixture(name: string, size: number): { path: string; bytes: Buffer } {
  const bytes = Buffer.alloc(size)
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + 7) % 256
  const filePath = join(testDir, name)
  writeFileSync(filePath, bytes)
  return { path: filePath, bytes }
}

describe('parseRangeHeader', () => {
  it('parses bounded, open-ended and suffix ranges and clamps the end', () => {
    expect(parseRangeHeader(null, 10)).toBeNull()
    expect(parseRangeHeader('bytes=2-5', 10)).toEqual({ start: 2, end: 5 })
    expect(parseRangeHeader('bytes=4-', 10)).toEqual({ start: 4, end: 9 })
    expect(parseRangeHeader('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
    expect(parseRangeHeader('bytes=-30', 10)).toEqual({ start: 0, end: 9 })
    expect(parseRangeHeader('bytes=8-100', 10)).toEqual({ start: 8, end: 9 })
  })

  it('rejects unsatisfiable, malformed and multi-range requests', () => {
    for (const header of ['bytes=10-', 'bytes=5-2', 'bytes=0-1,4-5', 'items=0-1', 'bytes=-', 'bytes=-0', 'bytes=x-']) {
      expect(parseRangeHeader(header, 10)).toBe('unsatisfiable')
    }
    expect(parseRangeHeader('bytes=0-', 0)).toBe('unsatisfiable')
  })
})

describe('handleDownload — regular files', () => {
  it('streams the whole file with download headers', async () => {
    const { path, bytes } = fixture('blob.bin', 300_000)
    const resp = await download(path)
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type')).toBe('application/octet-stream')
    expect(resp.headers.get('content-length')).toBe(String(bytes.length))
    expect(resp.headers.get('accept-ranges')).toBe('bytes')
    expect(resp.headers.get('last-modified')).toBe(statSync(path).mtime.toUTCString())
    expect(resp.headers.get('content-range')).toBeNull()
    expect(Buffer.from(await resp.arrayBuffer()).equals(bytes)).toBe(true)
  })

  it('answers a single range with 206 and Content-Range', async () => {
    const { path, bytes } = fixture('blob.bin', 1000)
    const resp = await download(path, { range: 'bytes=100-199' })
    expect(resp.status).toBe(206)
    expect(resp.headers.get('content-range')).toBe('bytes 100-199/1000')
    expect(resp.headers.get('content-length')).toBe('100')
    expect(Buffer.from(await resp.arrayBuffer()).equals(bytes.subarray(100, 200))).toBe(true)

    const open = await download(path, { range: 'bytes=900-' })
    expect(open.status).toBe(206)
    expect(open.headers.get('content-range')).toBe('bytes 900-999/1000')
    expect(Buffer.from(await open.arrayBuffer()).equals(bytes.subarray(900))).toBe(true)
  })

  it('answers 416 with the size for unsatisfiable and multi-range requests', async () => {
    const { path } = fixture('blob.bin', 1000)
    for (const range of ['bytes=1000-', 'bytes=0-1,5-6', 'bytes=garbage']) {
      const resp = await download(path, { range })
      expect(resp.status).toBe(416)
      expect(resp.headers.get('content-range')).toBe('bytes */1000')
      expect(await resp.json()).toMatchObject({ code: 'range-not-satisfiable' })
    }
  })

  it('serves an empty file as an empty 200', async () => {
    const { path } = fixture('empty.bin', 0)
    const resp = await download(path)
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-length')).toBe('0')
    expect((await resp.arrayBuffer()).byteLength).toBe(0)
  })

  it('404s a missing path and 400s a policy rejection with JSON codes', async () => {
    const missing = await download(join(testDir, 'nope.bin'))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: 'not-found' })

    const rejected = await download('/etc/passwd')
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toMatchObject({ code: 'path-rejected' })

    const traversal = await download(join(testDir, '../../etc/passwd'))
    expect(traversal.status).toBe(400)

    const noPath = await handleDownload(new URL('http://box/download'), new Request('http://box/download'))
    expect(noPath.status).toBe(400)
    expect(await noPath.json()).toMatchObject({ code: 'invalid-request' })
  })

  it('maps other stat failures to a 500 JSON error', async () => {
    if (process.getuid?.() === 0) return // root ignores directory permissions
    const locked = join(testDir, 'locked')
    mkdirSync(locked)
    writeFileSync(join(locked, 'f.bin'), 'x')
    chmodSync(locked, 0o000)
    try {
      const resp = await download(join(locked, 'f.bin'))
      expect(resp.status).toBe(500)
      expect(await resp.json()).toMatchObject({ code: 'download-failed' })
    } finally {
      chmodSync(locked, 0o755)
    }
  })
})

describe('handleDownload — directories', () => {
  function makeTree(): string {
    const dir = join(testDir, 'project')
    mkdirSync(join(dir, 'nested'), { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'alpha\n')
    writeFileSync(join(dir, 'nested', 'b.bin'), Buffer.from([0, 1, 2, 255]))
    return dir
  }

  it('rejects a directory without archive=tar.gz', async () => {
    const resp = await download(makeTree())
    expect(resp.status).toBe(400)
    expect(await resp.json()).toMatchObject({ code: 'is-directory' })
  })

  it('rejects an unsupported archive format', async () => {
    const resp = await download(makeTree(), { archive: 'zip' })
    expect(resp.status).toBe(400)
    expect(await resp.json()).toMatchObject({ code: 'unsupported-archive' })
  })

  it('streams a valid tar.gz rooted at the directory basename', async () => {
    const dir = makeTree()
    const resp = await download(dir, { archive: 'tar.gz' })
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type')).toBe('application/gzip')
    expect(resp.headers.get('content-length')).toBeNull()
    const archive = join(testDir, 'out.tar.gz')
    writeFileSync(archive, Buffer.from(await resp.arrayBuffer()))

    const extractTo = mkdtempSync(join(tmpdir(), 'sandbox-download-extract-'))
    try {
      const tar = Bun.spawnSync(['tar', '-xzf', archive, '-C', extractTo])
      expect(tar.exitCode).toBe(0)
      expect(readFileSync(join(extractTo, 'project', 'a.txt'), 'utf8')).toBe('alpha\n')
      expect(readFileSync(join(extractTo, 'project', 'nested', 'b.bin'))).toEqual(Buffer.from([0, 1, 2, 255]))
    } finally {
      rmSync(extractTo, { recursive: true, force: true })
    }
  })

  it('errors the stream (truncated body, not silent success) and logs when tar exits non-zero', async () => {
    const dir = makeTree()
    // Emits some bytes, then fails — the "headers already sent" case.
    const fakeTar = join(testDir, 'fake-tar.sh')
    writeFileSync(fakeTar, '#!/bin/sh\nprintf "partial-bytes"\necho "boom: cannot read" >&2\nexit 2\n')
    chmodSync(fakeTar, 0o755)
    const logs: string[] = []
    const resp = await download(dir, { archive: 'tar.gz', tarCommand: fakeTar }, { log: (m) => logs.push(m) })
    expect(resp.status).toBe(200)
    await expect(resp.arrayBuffer()).rejects.toThrow('tar exited 2')
    expect(logs.join('\n')).toContain('tar exited 2')
    expect(logs.join('\n')).toContain('boom: cannot read')
  })

  it('kills tar when the consumer cancels', async () => {
    const dir = makeTree()
    const fakeTar = join(testDir, 'slow-tar.sh')
    const marker = join(testDir, 'tar-finished')
    writeFileSync(fakeTar, `#!/bin/sh\nprintf "first"\nsleep 5\ntouch ${marker}\n`)
    chmodSync(fakeTar, 0o755)
    const resp = await download(dir, { archive: 'tar.gz', tarCommand: fakeTar })
    const reader = resp.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first')
    await reader.cancel()
    await Bun.sleep(200)
    expect(existsSync(marker)).toBe(false)
  })
})

describe('handleDownload — memory', () => {
  it('streams a large file without materializing it', async () => {
    const size = 128 * 1024 * 1024
    const filePath = join(testDir, 'big.bin')
    // Sparse file: no disk or memory cost to create.
    const fd = Bun.spawnSync(['truncate', '-s', String(size), filePath])
    expect(fd.exitCode).toBe(0)

    Bun.gc(true)
    const baseline = process.memoryUsage().rss
    let peak = baseline
    const hash = createHash('sha256')
    const resp = await download(filePath)
    const reader = resp.body!.getReader()
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      hash.update(value)
      if ((received & 0xffffff) < value.byteLength) peak = Math.max(peak, process.memoryUsage().rss)
    }
    expect(received).toBe(size)
    // A materialized copy would add >= 128 MiB.
    expect(peak - baseline).toBeLessThan(64 * 1024 * 1024)
  })
})
