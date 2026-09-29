import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createFileResponse, createSandboxFileResponse } from './file-download'

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
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="fixture.pdf"')
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

describe('createSandboxFileResponse', () => {
  it('downloads all binary bytes from sandbox reads instead of the default read window', async () => {
    const bytes = Buffer.alloc(80 * 1024)
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256

    const requestedLimits: Array<number | undefined> = []
    const client = {
      async stat() {
        return { size: bytes.length, isDirectory: false }
      },
      async read(request: { limit?: number }) {
        requestedLimits.push(request.limit)
        const limit = request.limit ?? 50 * 1024
        return {
          content: bytes.subarray(0, limit).toString('base64'),
          totalSize: bytes.length,
          isBinary: true,
        }
      },
    }

    const response = await createSandboxFileResponse(client, '/workspace/report.zip', 'report.zip')
    const downloaded = Buffer.from(await response.arrayBuffer())

    expect(requestedLimits).toEqual([bytes.length])
    expect(downloaded).toEqual(bytes)
    expect(response.headers.get('Content-Length')).toBe(String(bytes.length))
    expect(response.headers.get('Content-Type')).toBe('application/zip')
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="report.zip"')
  })
})
