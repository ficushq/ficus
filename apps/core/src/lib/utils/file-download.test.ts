import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  createDownloadResponse,
  createFileResponse,
  createSandboxFileResponse,
  DOWNLOAD_ARCHIVE_HEADER,
  DOWNLOAD_LENGTH_HEADER,
  SANDBOX_BUNDLE_OUTDATED_CODE,
  SANDBOX_READ_FALLBACK_MAX_BYTES,
  type SandboxFileClient,
} from './file-download'
import {
  SandboxDownloadRouteMissingError,
  SandboxHttpError,
  type SandboxDownloadResponse,
} from '../../services/sandbox/client/http-client'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ficus-file-download-'))
  tempDirs.push(dir)
  return dir
}

describe('createFileResponse', () => {
  it('returns exact bytes and binary headers for local binary files', async () => {
    const dir = makeTempDir()
    const filePath = path.join(dir, 'fixture.pdf')
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x80, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3])
    fs.writeFileSync(filePath, bytes)

    const response = createFileResponse(filePath)
    const downloaded = Buffer.from(await response.arrayBuffer())

    expect(downloaded).toEqual(bytes)
    expect(response.headers.get('Content-Length')).toBe(String(bytes.length))
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    expect(response.headers.get('Content-Disposition')).toBe(
      `attachment; filename="fixture.pdf"; filename*=UTF-8''fixture.pdf`
    )
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
  })

  it('streams a single range as 206 and answers 416 past EOF', async () => {
    const dir = makeTempDir()
    const filePath = path.join(dir, 'blob.bin')
    const bytes = Buffer.from(Array.from({ length: 100 }, (_, i) => i))
    fs.writeFileSync(filePath, bytes)

    const partial = createFileResponse(filePath, { range: 'bytes=90-' })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('Content-Range')).toBe('bytes 90-99/100')
    expect(partial.headers.get('Content-Length')).toBe('10')
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(bytes.subarray(90))

    const past = createFileResponse(filePath, { range: 'bytes=100-' })
    expect(past.status).toBe(416)
    expect(past.headers.get('Content-Range')).toBe('bytes */100')
  })

  it('continues to return exact text bytes and text content type for local text files', async () => {
    const dir = makeTempDir()
    const filePath = path.join(dir, 'notes.html')
    const text = '<!doctype html><p>workspace download ✓</p>'
    fs.writeFileSync(filePath, text, 'utf8')

    const response = createFileResponse(filePath)
    const downloaded = Buffer.from(await response.arrayBuffer())

    expect(downloaded.toString('utf8')).toBe(text)
    expect(response.headers.get('Content-Length')).toBe(String(Buffer.byteLength(text)))
    expect(response.headers.get('Content-Type')).toBe('text/html')
  })
})

describe('createDownloadResponse (local directories)', () => {
  it('streams zip by default and a tar.gz rooted at the directory on request', async () => {
    const dir = makeTempDir()
    const target = path.join(dir, 'project')
    fs.mkdirSync(path.join(target, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(target, 'nested', 'a.txt'), 'alpha')

    const zip = createDownloadResponse(target, 'workspace')
    expect(zip.headers.get('Content-Type')).toBe('application/zip')
    expect(zip.headers.get(DOWNLOAD_ARCHIVE_HEADER)).toBe('zip')
    await zip.arrayBuffer()

    const tgz = createDownloadResponse(target, 'workspace', { archive: 'tar.gz' })
    expect(tgz.headers.get('Content-Type')).toBe('application/gzip')
    expect(tgz.headers.get(DOWNLOAD_ARCHIVE_HEADER)).toBe('tar.gz')
    expect(tgz.headers.get('Content-Disposition')).toContain('filename="project.tar.gz"')
    const archivePath = path.join(dir, 'out.tar.gz')
    fs.writeFileSync(archivePath, Buffer.from(await tgz.arrayBuffer()))
    const listing = Bun.spawnSync(['tar', '-tzf', archivePath]).stdout.toString()
    expect(listing).toContain('project/nested/a.txt')
  })
})

type FakeCalls = { download: Array<{ path: string; range?: string }>; archive: string[]; read: number[] }

function fakeClient(options: {
  size: number
  isDirectory?: boolean
  exists?: boolean
  download?: (request: { path: string; range?: string }) => Promise<SandboxDownloadResponse>
  downloadArchive?: (request: { path: string }) => Promise<SandboxDownloadResponse>
  bytes?: Buffer
}): { client: SandboxFileClient; calls: FakeCalls } {
  const calls: FakeCalls = { download: [], archive: [], read: [] }
  const client: SandboxFileClient = {
    async stat() {
      return { exists: options.exists ?? true, size: options.size, isDirectory: options.isDirectory ?? false }
    },
    async read(request) {
      calls.read.push(request.limit ?? -1)
      const bytes = options.bytes ?? Buffer.alloc(0)
      return { content: bytes.subarray(0, request.limit).toString('base64'), totalSize: bytes.length }
    },
    async download(request) {
      calls.download.push({ path: request.path, range: request.range })
      if (!options.download) throw new Error('unexpected download')
      return options.download(request)
    },
    async downloadArchive(request) {
      calls.archive.push(request.path)
      if (!options.downloadArchive) throw new Error('unexpected archive')
      return options.downloadArchive(request)
    },
  }
  return { client, calls }
}

describe('createSandboxFileResponse', () => {
  it('passes the box body stream straight through (same stream object, never read in Core)', async () => {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls === 1) controller.enqueue(new Uint8Array([1, 2, 3]))
        else controller.close()
      },
    })
    const { client, calls } = fakeClient({
      size: 3,
      download: async () => ({
        status: 200,
        headers: new Headers({ 'content-length': '3', 'last-modified': 'Thu, 22 Oct 2026 10:00:00 GMT' }),
        body,
      }),
    })
    const response = await createSandboxFileResponse(client, '/workspace/report.zip', 'report.zip')
    expect(calls.read).toEqual([])
    expect(calls.download).toEqual([{ path: '/workspace/report.zip', range: undefined }])
    expect(response.status).toBe(200)
    expect(response.body as unknown).toBe(body)
    expect(pulls).toBeLessThanOrEqual(1)
    expect(response.headers.get('Content-Type')).toBe('application/zip')
    expect(response.headers.get('Content-Disposition')).toContain('attachment; filename="report.zip"')
    expect(response.headers.get('Content-Length')).toBe('3')
    expect(response.headers.get(DOWNLOAD_LENGTH_HEADER)).toBe('3')
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(response.headers.get('Last-Modified')).toBe('Thu, 22 Oct 2026 10:00:00 GMT')
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3])
  })

  it('forwards Range to the box and returns its 206 with Content-Range', async () => {
    const { client, calls } = fakeClient({
      size: 10,
      download: async () => ({
        status: 206,
        headers: new Headers({ 'content-length': '4', 'content-range': 'bytes 6-9/10' }),
        body: new Response(new Uint8Array([6, 7, 8, 9])).body!,
      }),
    })
    const response = await createSandboxFileResponse(client, '/workspace/a.bin', 'a.bin', { range: 'bytes=6-' })
    expect(calls.download[0].range).toBe('bytes=6-')
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe('bytes 6-9/10')
    expect(response.headers.get('Content-Length')).toBe('4')
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([6, 7, 8, 9])
  })

  it('answers 416 with the file size when the box rejects the range', async () => {
    const { client } = fakeClient({
      size: 10,
      download: async () => {
        throw new SandboxHttpError('Requested range not satisfiable', 416, 'range-not-satisfiable')
      },
    })
    const response = await createSandboxFileResponse(client, '/workspace/a.bin', 'a.bin', { range: 'bytes=10-' })
    expect(response.status).toBe(416)
    expect(response.headers.get('Content-Range')).toBe('bytes */10')
  })

  it('answers 404 for a missing path without touching /download', async () => {
    const { client, calls } = fakeClient({ size: 0, exists: false })
    const response = await createSandboxFileResponse(client, '/workspace/missing.bin')
    expect(response.status).toBe(404)
    expect(calls.download).toEqual([])
  })

  it('streams a directory as <name>.tar.gz', async () => {
    const { client, calls } = fakeClient({
      size: 4096,
      isDirectory: true,
      downloadArchive: async () => ({
        status: 200,
        headers: new Headers({ 'content-type': 'application/gzip' }),
        body: new Response('tgz-bytes').body!,
      }),
    })
    const response = await createSandboxFileResponse(client, '/workspace/project', 'project')
    expect(calls.archive).toEqual(['/workspace/project'])
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/gzip')
    expect(response.headers.get('Content-Disposition')).toContain('filename="project.tar.gz"')
    expect(response.headers.get(DOWNLOAD_ARCHIVE_HEADER)).toBe('tar.gz')
    expect(await response.text()).toBe('tgz-bytes')
  })

  it('falls back to the base64 /read on an old bundle for files up to 64 MiB', async () => {
    const bytes = Buffer.alloc(80 * 1024)
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256
    const { client, calls } = fakeClient({
      size: bytes.length,
      bytes,
      download: async () => {
        throw new SandboxDownloadRouteMissingError(405)
      },
    })
    const response = await createSandboxFileResponse(client, '/workspace/report.zip', 'report.zip', {
      range: 'bytes=5-',
    })
    // Requests the whole file (not the default 50 KB preview window) and
    // ignores the range: a full 200 the client can always use.
    expect(calls.read).toEqual([bytes.length])
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    expect(response.headers.get('Content-Length')).toBe(String(bytes.length))
    expect(response.headers.get('Content-Disposition')).toContain('attachment; filename="report.zip"')
  })

  it('answers 503 naming the fix on an old bundle above 64 MiB, never attempting /read', async () => {
    const { client, calls } = fakeClient({
      size: SANDBOX_READ_FALLBACK_MAX_BYTES + 1,
      download: async () => {
        throw new SandboxDownloadRouteMissingError(405)
      },
    })
    const response = await createSandboxFileResponse(client, '/workspace/big.tar', 'big.tar')
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: string; code: string }
    expect(body.code).toBe(SANDBOX_BUNDLE_OUTDATED_CODE)
    expect(body.error).toContain('outdated')
    expect(body.error).toContain("Restart the agent's sandbox")
    expect(body.error).toContain('recreate the squad sandbox')
    expect(calls.read).toEqual([])
  })

  it('serves exactly 64 MiB through the fallback (inclusive bound)', async () => {
    const { client, calls } = fakeClient({
      size: SANDBOX_READ_FALLBACK_MAX_BYTES,
      download: async () => {
        throw new SandboxDownloadRouteMissingError(404)
      },
    })
    const response = await createSandboxFileResponse(client, '/workspace/edge.bin', 'edge.bin')
    expect(response.status).toBe(200)
    expect(calls.read).toEqual([SANDBOX_READ_FALLBACK_MAX_BYTES])
  })

  it('answers 503 for a directory on an old bundle', async () => {
    const { client } = fakeClient({
      size: 4096,
      isDirectory: true,
      downloadArchive: async () => {
        throw new SandboxDownloadRouteMissingError(405)
      },
    })
    const response = await createSandboxFileResponse(client, '/workspace/project', 'project')
    expect(response.status).toBe(503)
  })
})
