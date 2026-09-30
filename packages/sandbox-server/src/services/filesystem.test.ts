import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync, statSync, symlinkSync, readFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { handleRead, handleWrite, handleUpload, handleMkdir, handleStat, handleList } from './filesystem'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `sandbox-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(testDir, { recursive: true })
  process.env.WORKSPACE_PATH = testDir
})

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true })
  }
  delete process.env.WORKSPACE_PATH
})

async function json(resp: Response) {
  return resp.json()
}

describe('handleRead', () => {
  it('should read a file', async () => {
    writeFileSync(join(testDir, 'test.txt'), 'hello world')
    const resp = await handleRead({ path: join(testDir, 'test.txt') })
    expect(resp.status).toBe(200)
    const data = await json(resp)
    expect(Buffer.from(data.content, 'base64').toString()).toBe('hello world')
    expect(data.totalSize).toBe(11)
    expect(data.isBinary).toBe(false)
  })

  it('should return 404 for missing file', async () => {
    const resp = await handleRead({ path: join(testDir, 'missing.txt') })
    expect(resp.status).toBe(404)
  })

  it('should read with offset and limit', async () => {
    writeFileSync(join(testDir, 'test.txt'), 'hello world')
    const resp = await handleRead({ path: join(testDir, 'test.txt'), offset: 6, limit: 5 })
    const data = await json(resp)
    expect(Buffer.from(data.content, 'base64').toString()).toBe('world')
  })

  it('should reject paths outside allowed directories', async () => {
    const resp = await handleRead({ path: '/etc/passwd' })
    expect(resp.status).toBe(500)
  })
})

describe('handleWrite', () => {
  it('should write a file', async () => {
    const content = Buffer.from('hello world').toString('base64')
    const resp = await handleWrite({ path: join(testDir, 'out.txt'), content })
    expect(resp.status).toBe(200)
    const data = await json(resp)
    expect(data.bytesWritten).toBe(11)
  })

  it('should create directories with createDirs', async () => {
    const content = Buffer.from('nested').toString('base64')
    const resp = await handleWrite({ path: join(testDir, 'a/b/c.txt'), content, createDirs: true })
    expect(resp.status).toBe(200)
    expect(existsSync(join(testDir, 'a/b/c.txt'))).toBe(true)
  })

  it('should reject paths outside allowed directories', async () => {
    const content = Buffer.from('bad').toString('base64')
    const resp = await handleWrite({ path: '/etc/bad', content })
    expect(resp.status).toBe(500)
  })

  it('applies an octal mode at file creation', async () => {
    const content = Buffer.from('secret').toString('base64')
    const p = join(testDir, 'identity.pem')
    const resp = await handleWrite({ path: p, content, mode: '0600' })
    expect(resp.status).toBe(200)
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })

  it('applies the mode on overwrite (not just first create)', async () => {
    const p = join(testDir, 'identity.pem')
    // Pre-create at the umask default (0644) to prove overwrite re-applies mode.
    writeFileSync(p, 'old')
    expect(statSync(p).mode & 0o777).not.toBe(0o600)

    const content = Buffer.from('new secret').toString('base64')
    const resp = await handleWrite({ path: p, content, mode: '0600' })
    expect(resp.status).toBe(200)
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect((await json(resp)).bytesWritten).toBe(10)
  })

  it('rejects an invalid mode with 400', async () => {
    const content = Buffer.from('x').toString('base64')
    const resp = await handleWrite({ path: join(testDir, 'x.txt'), content, mode: '999' })
    expect(resp.status).toBe(400)
  })

  it('absent mode keeps legacy behavior (no rejection, file written)', async () => {
    const content = Buffer.from('hello').toString('base64')
    const p = join(testDir, 'legacy.txt')
    const resp = await handleWrite({ path: p, content })
    expect(resp.status).toBe(200)
    expect(existsSync(p)).toBe(true)
  })

  it('accepts a large (>4MB) payload — Bun/JSC regex silently fails past ~5.6M base64 chars', async () => {
    // Bun's regex engine (JSC/Yarr) returns FALSE — without throwing — when
    // the canonical-base64 pattern's repeat quantifier runs on a subject
    // longer than ~5.6M chars, so every workspace upload past ~4MB of source
    // bytes was rejected as "Invalid write request". Canonicality must be
    // enforced without a whole-subject regex.
    const big = Buffer.alloc(6 * 1024 * 1024, 7)
    const p = join(testDir, 'big.bin')
    const resp = await handleWrite({ path: p, content: big.toString('base64'), createDirs: true })
    expect(resp.status).toBe(200)
    expect(statSync(p).size).toBe(big.byteLength)
    expect(createHash('sha256').update(readFileSync(p)).digest('hex')).toBe(
      createHash('sha256').update(big).digest('hex')
    )
  })

  it('still rejects non-canonical base64 (embedded whitespace, bad padding, wrong length)', async () => {
    for (const content of ['aGVs\nbG8=', 'aGVsbG8', 'aGVsbG9=', 'not base64!!']) {
      const resp = await handleWrite({ path: join(testDir, 'nc.txt'), content })
      expect(resp.status).toBe(400)
    }
    expect(existsSync(join(testDir, 'nc.txt'))).toBe(false)
  })
})

describe('handleUpload (raw streaming upload)', () => {
  const makeReq = (p: string, body: Uint8Array | Buffer, params: Record<string, string> = {}) => {
    const url = new URL('http://box/upload')
    url.searchParams.set('path', p)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    return {
      url,
      request: new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: body as unknown as BodyInit,
      }),
    }
  }

  it('writes raw bytes without base64 (large payload) and reports bytes + sha256', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 9)
    const p = join(testDir, 'raw.bin')
    const { url, request } = makeReq(p, big)
    const resp = await handleUpload(url, request)
    expect(resp.status).toBe(200)
    const data = await json(resp)
    expect(data.bytesWritten).toBe(big.byteLength)
    expect(data.sha256).toBe(createHash('sha256').update(big).digest('hex'))
    expect(readFileSync(p).equals(big)).toBe(true)
  })

  it('creates parent directories when createDirs=true and applies mode', async () => {
    const p = join(testDir, 'a/b/up.bin')
    const { url, request } = makeReq(p, Buffer.from('hi'), { createDirs: 'true', mode: '0600' })
    const resp = await handleUpload(url, request)
    expect(resp.status).toBe(200)
    expect(readFileSync(p).toString()).toBe('hi')
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })

  it('rejects a path outside the allowed roots', async () => {
    const { url, request } = makeReq('/etc/evil', Buffer.from('x'))
    const resp = await handleUpload(url, request)
    expect(resp.status).toBe(400)
    expect(existsSync('/etc/evil')).toBe(false)
  })

  it('rejects an invalid mode and a missing path', async () => {
    const bad = makeReq(join(testDir, 'm.bin'), Buffer.from('x'), { mode: '999' })
    expect((await handleUpload(bad.url, bad.request)).status).toBe(400)
    const url = new URL('http://box/upload')
    const request = new Request(url, { method: 'POST', body: 'x' })
    expect((await handleUpload(url, request)).status).toBe(400)
  })
})

describe('handleMkdir', () => {
  it('creates nested directories recursively', async () => {
    const resp = await handleMkdir({ path: join(testDir, 'a/b/c') })
    expect(resp.status).toBe(200)
    expect((await json(resp)).ok).toBe(true)
    expect(statSync(join(testDir, 'a/b/c')).isDirectory()).toBe(true)
  })

  it('succeeds when the directory already exists', async () => {
    mkdirSync(join(testDir, 'existing'))
    const resp = await handleMkdir({ path: join(testDir, 'existing') })
    expect(resp.status).toBe(200)
  })

  it('rejects paths outside allowed directories', async () => {
    const resp = await handleMkdir({ path: '/etc/evil' })
    expect(resp.status).toBe(500)
    expect((await json(resp)).error).toContain('outside allowed')
  })

  it('rejects ..-escapes out of the allowed prefixes', async () => {
    const resp = await handleMkdir({ path: join(testDir, '../../etc/evil') })
    expect(resp.status).toBe(500)
  })

  it('treats shell metacharacters as literal path bytes — no shell is involved', async () => {
    // Regression guard: core's coding tools call this RPC with agent-controlled
    // paths (the pi SDK's write tool mkdirs the parent before every write). The
    // path must go straight into fs.mkdir as data; $(...)/backticks/; create
    // literally-named directories and execute nothing.
    const evil = join(testDir, '$(touch injected);`id`')
    const resp = await handleMkdir({ path: evil })
    expect(resp.status).toBe(200)
    // The literally-named directory exists...
    expect(statSync(evil).isDirectory()).toBe(true)
    // ...and no command substitution ran (no side-effect file appeared).
    expect(existsSync(join(testDir, 'injected'))).toBe(false)
  })
})

describe('handleStat', () => {
  it('should stat an existing file', async () => {
    writeFileSync(join(testDir, 'test.txt'), 'hello')
    const resp = await handleStat({ path: join(testDir, 'test.txt') })
    const data = await json(resp)
    expect(data.exists).toBe(true)
    expect(data.isDirectory).toBe(false)
    expect(data.size).toBe(5)
  })

  it('should return exists=false for missing file', async () => {
    const resp = await handleStat({ path: join(testDir, 'missing.txt') })
    const data = await json(resp)
    expect(data.exists).toBe(false)
  })

  it('should stat a directory', async () => {
    mkdirSync(join(testDir, 'subdir'))
    const resp = await handleStat({ path: join(testDir, 'subdir') })
    const data = await json(resp)
    expect(data.exists).toBe(true)
    expect(data.isDirectory).toBe(true)
  })
})

describe('handleList', () => {
  it('should list files in a directory', async () => {
    writeFileSync(join(testDir, 'a.txt'), 'a')
    writeFileSync(join(testDir, 'b.txt'), 'b')
    const resp = await handleList({ path: testDir })
    const data = await json(resp)
    expect(data.files.length).toBe(2)
    const names = data.files.map((f: any) => f.path).sort()
    expect(names).toEqual(['a.txt', 'b.txt'])
  })

  it('should list recursively', async () => {
    mkdirSync(join(testDir, 'sub'))
    writeFileSync(join(testDir, 'a.txt'), 'a')
    writeFileSync(join(testDir, 'sub/b.txt'), 'b')
    const resp = await handleList({ path: testDir, recursive: true })
    const data = await json(resp)
    const names = data.files.map((f: any) => f.path).sort()
    expect(names).toContain('a.txt')
    expect(names).toContain('sub')
    expect(names).toContain(join('sub', 'b.txt'))
  })

  it('should return 404 for missing directory', async () => {
    const resp = await handleList({ path: join(testDir, 'nope') })
    expect(resp.status).toBe(404)
  })
})

if (process.platform !== 'linux')
  console.info(
    'SKIP: two attachment descriptor-walk tests require Linux /proc/self/fd; the non-Linux fail-closed invariant is still tested.'
  )

describe('handleMaterializeAttachment', () => {
  it.skipIf(process.platform !== 'linux')('refuses a symlinked chat attachment root', async () => {
    const { handleMaterializeAttachment } = await import('./filesystem')
    const outside = mkdtempSync(join(tmpdir(), 'sandbox-attachment-outside-'))
    symlinkSync(outside, join(testDir, 'chat-attachments'))
    const response = await handleMaterializeAttachment({
      privateRoot: testDir,
      attachmentId: '6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d',
      storedName: 'report.pdf',
      content: Buffer.from('hello').toString('base64'),
    })
    expect(response.status).toBe(500)
    expect(() => readFileSync(join(outside, '6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d', 'report.pdf'))).toThrow()
    rmSync(outside, { recursive: true, force: true })
  })
})

describe('handleDeleteMaterializedAttachment', () => {
  it.skipIf(process.platform !== 'linux')('deletes only the generated canonical attachment file', async () => {
    const { handleDeleteMaterializedAttachment } = await import('./filesystem')
    const id = '6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d'
    const generated = join(testDir, 'chat-attachments', id)
    mkdirSync(generated, { recursive: true })
    writeFileSync(join(generated, 'report.pdf'), 'generated')
    writeFileSync(join(testDir, 'authored.txt'), 'keep')

    const response = await handleDeleteMaterializedAttachment({
      privateRoot: testDir,
      attachmentId: id,
      storedName: 'report.pdf',
    })

    expect(response.status).toBe(200)
    expect(existsSync(join(generated, 'report.pdf'))).toBe(false)
    expect(readFileSync(join(testDir, 'authored.txt'), 'utf8')).toBe('keep')
  })
})

describe('attachment filesystem platform invariant', () => {
  it('accepts Linux and fails closed on Darwin', async () => {
    const { assertLinuxAttachmentFilesystemPlatform } = await import('./filesystem')
    expect(() => assertLinuxAttachmentFilesystemPlatform('linux')).not.toThrow()
    expect(() => assertLinuxAttachmentFilesystemPlatform('darwin')).toThrow(
      'Attachment filesystem requires Linux procfs'
    )
  })
})

describe('verified atomic write transport', () => {
  const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex')
  const identity = (value: Buffer) => ({ bytes: value.byteLength, sha256: digest(value) })
  const request = (path: string, original: Buffer, result: Buffer) => ({
    path,
    content: result.toString('base64'),
    expectedOriginal: identity(original),
    expectedResult: identity(result),
  })
  const handleVerified = async (body: unknown): Promise<Response> => {
    const module = await import('./filesystem')
    const handler = (module as unknown as { handleVerifiedWrite?: (request: unknown) => Promise<Response> })
      .handleVerifiedWrite
    return handler ? handler(body) : Response.json({ error: 'VERIFIED_WRITE_HANDLER_MISSING_FOR_TDD' }, { status: 501 })
  }
  const expectSafeError = async (response: Response, forbidden: string[]): Promise<Record<string, unknown>> => {
    const body = (await response.json()) as Record<string, unknown>
    const rendered = JSON.stringify(body)
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(512)
    for (const value of forbidden) expect(rendered).not.toContain(value)
    return body
  }

  it('commits a mandatory-identity write and returns the exact result identity', async () => {
    const path = join(testDir, 'verified-success.txt')
    const original = Buffer.from('ORIGINAL-TRANSPORT')
    const result = Buffer.from('RESULT-TRANSPORT')
    writeFileSync(path, original)

    const response = await handleVerified(request(path, original, result))

    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ bytesWritten: result.byteLength, sha256: digest(result) })
    expect(readFileSync(path)).toEqual(result)
  })

  it('rejects malformed or incomplete mandatory identities with 400 before writing', async () => {
    const path = join(testDir, 'verified-malformed.txt')
    const original = Buffer.from('ORIGINAL-MALFORMED')
    const result = Buffer.from('RESULT-MALFORMED')
    writeFileSync(path, original)
    const base = request(path, original, result)
    const malformed = [
      { ...base, expectedOriginal: { bytes: original.byteLength } },
      { ...base, expectedResult: { bytes: -1, sha256: digest(result) } },
      { ...base, expectedResult: { bytes: result.byteLength, sha256: 'A'.repeat(64) } },
    ]

    for (const body of malformed) {
      const response = await handleVerified(body)
      await expectSafeError(response, ['ORIGINAL-MALFORMED', 'RESULT-MALFORMED', path, '.tmp'])
      expect(response.status).toBe(400)
      expect(readFileSync(path)).toEqual(original)
    }
  })

  it('rejects malformed and decodable non-canonical base64 with 400 before writing', async () => {
    const path = join(testDir, 'verified-base64.txt')
    const original = Buffer.from('ORIGINAL-BASE64')
    const result = Buffer.from('a')
    writeFileSync(path, original)
    const invalidContent = [
      '!!!!', // malformed garbage
      'YQ', // missing padding; Buffer permissively decodes this to "a"
      'Y Q==', // embedded whitespace; Buffer permissively ignores it
      'YR==', // non-zero pad bits; Buffer permissively decodes this to "a"
      'YQ==junk', // trailing junk after a complete padded value
    ]

    for (const content of invalidContent) {
      if (content !== '!!!!') expect(Buffer.from(content, 'base64')).toEqual(result)
      const response = await handleVerified({ ...request(path, original, result), content })
      await expectSafeError(response, ['ORIGINAL-BASE64', path, '.tmp'])
      expect(response.status).toBe(400)
      expect(readFileSync(path)).toEqual(original)
    }
  })

  it('returns a stable 409 conflict for a stale original and preserves the file', async () => {
    const path = join(testDir, 'verified-conflict.txt')
    const actual = Buffer.from('ACTUAL-CURRENT')
    const stale = Buffer.from('STALE-SNAPSHOT')
    const result = Buffer.from('RESULT-CONFLICT')
    writeFileSync(path, actual)

    const response = await handleVerified(request(path, stale, result))
    const body = await expectSafeError(response, ['ACTUAL-CURRENT', 'STALE-SNAPSHOT', 'RESULT-CONFLICT', path, '.tmp'])

    expect(response.status).toBe(409)
    expect(body.code).toBe('edit-conflict')
    expect(readFileSync(path)).toEqual(actual)
  })

  it('rejects a result-identity mismatch with 500 and preserves the file', async () => {
    const path = join(testDir, 'verified-result-mismatch.txt')
    const original = Buffer.from('ORIGINAL-RESULT')
    const result = Buffer.from('RESULT-BYTES')
    writeFileSync(path, original)
    const body = request(path, original, result)
    body.expectedResult = identity(Buffer.from('DIFFERENT-RESULT'))

    const response = await handleVerified(body)
    const error = await expectSafeError(response, ['ORIGINAL-RESULT', 'RESULT-BYTES', 'DIFFERENT-RESULT', path, '.tmp'])

    expect(response.status).toBe(500)
    expect(error.phase).toBe('pre-publication')
    expect(readFileSync(path)).toEqual(original)
  })

  it('routes legacy writes through verified publication and returns the derived result digest', async () => {
    const path = join(testDir, 'legacy-digest.txt')
    const result = Buffer.from('LEGACY-RESULT')

    const response = await handleWrite({ path, content: result.toString('base64') })

    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ bytesWritten: result.byteLength, sha256: digest(result) })
    expect(readFileSync(path)).toEqual(result)
  })
})
