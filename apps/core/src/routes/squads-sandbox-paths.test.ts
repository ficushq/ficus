import { requestBodyLimits } from '../middleware/request-body-limits'
import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test'
import { Hono } from 'hono'
import { existsSync } from 'fs'
import { tmpdir } from 'os'

// Every sandbox-backed squad (VM, Kubernetes) proxies workspace reads and writes through this
// client. Record each path it is asked to touch so the test can prove none escape the mount.
let uploadWasStream = false
const touched: string[] = []
const downloads: Array<{ path: string; range?: string; archive?: boolean; exclude?: string[] }> = []
// Per-test overrides for the streaming download transport.
let statOverride: { exists: boolean; size: number; isDirectory: boolean } | undefined
let downloadImpl: ((request: { path: string; range?: string }) => Promise<unknown>) | undefined
let listOverride: Array<{ path: string; isDirectory: boolean; size: number }> | undefined
let archiveImpl: ((request: { path: string; exclude?: string[] }) => Promise<unknown>) | undefined
// Box commands run in a real local bash unless a test answers them itself.
const bashCommands: string[] = []
let bashImpl: ((command: string) => { stdout: string; exitCode: number }) | undefined
function runBash(command: string): { stdout: string; exitCode: number } {
  const result = Bun.spawnSync(['bash', '-c', command])
  return { stdout: result.stdout.toString(), exitCode: result.exitCode ?? 1 }
}
const fakeClient = {
  bash: ({ command }: { command: string }) => {
    bashCommands.push(command)
    const listeners: Record<string, Array<(arg?: unknown) => void>> = {}
    const stream = {
      on(event: string, listener: (arg?: never) => void) {
        ;(listeners[event] ??= []).push(listener as (arg?: unknown) => void)
        return stream
      },
    }
    queueMicrotask(() => {
      const { stdout, exitCode } = (bashImpl ?? runBash)(command)
      for (const listener of listeners.data ?? [])
        listener({ stdout: Buffer.from(stdout).toString('base64'), exitCode })
      for (const listener of listeners.end ?? []) listener()
    })
    return stream
  },
  list: async ({ path }: { path: string }) => {
    touched.push(path)
    return { files: listOverride ?? [] }
  },
  read: async ({ path }: { path: string }) => {
    touched.push(path)
    return { content: Buffer.from('inside').toString('base64'), isBinary: false, totalSize: 6 }
  },
  stat: async ({ path }: { path: string }) => {
    touched.push(path)
    return statOverride ?? { exists: true, size: 6, isDirectory: false }
  },
  download: async (request: { path: string; range?: string }) => {
    touched.push(request.path)
    downloads.push({ path: request.path, range: request.range })
    if (downloadImpl) return downloadImpl(request)
    return { status: 200, headers: new Headers({ 'content-length': '6' }), body: new Response('inside').body! }
  },
  downloadArchive: async (request: { path: string; exclude?: string[] }) => {
    const { path } = request
    touched.push(path)
    downloads.push({ path, archive: true, ...(request.exclude ? { exclude: request.exclude } : {}) })
    if (archiveImpl) return archiveImpl(request)
    return {
      status: 200,
      headers: new Headers({ 'content-type': 'application/gzip' }),
      body: new Response('tgz').body!,
    }
  },
  upload: async ({ path, content }: { path: string; content: unknown }) => {
    touched.push(path)
    uploadWasStream = content instanceof ReadableStream
    const bytes = await new Response(content as BodyInit).arrayBuffer()
    return { bytesWritten: bytes.byteLength }
  },
  write: async ({ path }: { path: string }) => {
    touched.push(path)
  },
}
mock.module('../services/squad/client', () => ({ getSquadClient: async () => fakeClient }))

const { squadsRouter } = await import('./squads')
const { Squad } = await import('../entities/Squad')
const { identityMiddleware } = await import('../middleware/identity')
const { resolveWorkspaceLayout } = await import('../services/sandbox/workspace-layout')
const { createTestAdmin, cleanupTestRbac, authHeaders } = await import('../test-utils')
const { SandboxDownloadRouteMissingError } = await import('../services/sandbox/client/http-client')

const app = new Hono()
app.use('*', identityMiddleware)
app.use('*', requestBodyLimits)
app.route('/api/squads', squadsRouter)

const prefix = `sq-sbx-paths-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let token: string
let squadId: string
let mount: string

beforeAll(async () => {
  token = (await createTestAdmin({ prefix })).token
  squadId = (await Squad.create({ name: `${prefix} Sandbox Paths`, purpose: 'boundary' })).id
  mount = resolveWorkspaceLayout({ squadId }).workspaceMount
})

afterAll(async () => {
  await cleanupTestRbac(prefix)
})

const escapes = ['../../etc/passwd', 'docs/../../secrets.txt', '..', '/../etc/passwd']
const insideMount = () => touched.every((path) => path === mount || path.startsWith(`${mount}/`))

async function get(route: string, path: string) {
  return app.request(`/api/squads/${squadId}/workspace/${route}?path=${encodeURIComponent(path)}`, {
    headers: authHeaders(token),
  })
}

async function upload(dir: string, relativePath: string) {
  const form = new FormData()
  form.append('file', new File(['payload'], 'payload.txt'))
  form.append('path_file', relativePath)
  return app.request(`/api/squads/${squadId}/workspace/upload?dir=${encodeURIComponent(dir)}&overwrite=true`, {
    method: 'POST',
    headers: authHeaders(token),
    body: form,
  })
}

describe('sandbox-backed workspace routes stay inside the workspace mount', () => {
  for (const route of ['tree', 'file', 'download'] as const) {
    it(`${route} rejects paths that escape the mount`, async () => {
      for (const path of escapes) {
        touched.length = 0
        const res = await get(route, path)
        expect(res.status).toBe(400)
        expect(touched).toEqual([])
      }
    })

    it(`${route} still serves workspace-relative paths, with or without a leading slash`, async () => {
      for (const path of ['docs/design.md', '/docs/design.md']) {
        touched.length = 0
        const res = await get(route, path)
        expect(res.status).toBe(200)
        expect(touched.length).toBeGreaterThan(0)
        expect(insideMount()).toBe(true)
        expect(touched).toContain(`${mount}/docs/design.md`)
      }
    })
  }

  it('upload refuses to write outside the mount, via the file path or the target dir', async () => {
    for (const [dir, relativePath] of [
      ['', '../../home/agent/.bashrc'],
      ['../..', 'etc/cron.d/job'],
      ['docs', '../../../escape.txt'],
    ]) {
      touched.length = 0
      const res = await upload(dir, relativePath)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.uploaded).toBe(0)
      expect(body.results[0].status).toBe('error')
      expect(touched).toEqual([])
    }
  })

  it('upload still writes inside the mount', async () => {
    touched.length = 0
    const res = await upload('docs', 'notes/payload.txt')
    expect(res.status).toBe(200)
    expect((await res.json()).uploaded).toBe(1)
    expect(touched).toContain(`${mount}/docs/notes/payload.txt`)
    expect(insideMount()).toBe(true)
  })
})

describe('sandbox-backed workspace download streams through /download', () => {
  function reset() {
    touched.length = 0
    downloads.length = 0
    statOverride = undefined
    downloadImpl = undefined
  }

  it('forwards the client Range header and returns the box 206', async () => {
    reset()
    downloadImpl = async () => ({
      status: 206,
      headers: new Headers({ 'content-length': '3', 'content-range': 'bytes 3-5/6' }),
      body: new Response('ide').body!,
    })
    const res = await app.request(`/api/squads/${squadId}/workspace/download?path=docs/a.bin`, {
      headers: { ...authHeaders(token), range: 'bytes=3-' },
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 3-5/6')
    expect(res.headers.get('content-disposition')).toContain('filename="a.bin"')
    expect(await res.text()).toBe('ide')
    expect(downloads).toEqual([{ path: `${mount}/docs/a.bin`, range: 'bytes=3-' }])
  })

  it('streams a directory as tar.gz and rejects zip on sandbox runtimes', async () => {
    reset()
    statOverride = { exists: true, size: 4096, isDirectory: true }
    const res = await app.request(`/api/squads/${squadId}/workspace/download?path=docs`, {
      headers: authHeaders(token),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('filename="docs.tar.gz"')
    expect(res.headers.get('x-ficus-archive')).toBe('tar.gz')
    expect(await res.text()).toBe('tgz')

    const zip = await app.request(`/api/squads/${squadId}/workspace/download?path=docs&archive=zip`, {
      headers: authHeaders(token),
    })
    expect(zip.status).toBe(400)
    const bogus = await app.request(`/api/squads/${squadId}/workspace/download?path=docs&archive=rar`, {
      headers: authHeaders(token),
    })
    expect(bogus.status).toBe(400)
  })

  it('falls back to /read under 64 MiB and answers 503 above it on an outdated bundle', async () => {
    reset()
    downloadImpl = async () => {
      throw new SandboxDownloadRouteMissingError(405)
    }
    const small = await app.request(`/api/squads/${squadId}/workspace/download?path=docs/small.txt`, {
      headers: authHeaders(token),
    })
    expect(small.status).toBe(200)
    expect(await small.text()).toBe('inside')

    statOverride = { exists: true, size: 64 * 1024 * 1024 + 1, isDirectory: false }
    const large = await app.request(`/api/squads/${squadId}/workspace/download?path=docs/large.bin`, {
      headers: authHeaders(token),
    })
    expect(large.status).toBe(503)
    expect(((await large.json()) as { code: string }).code).toBe('SANDBOX_BUNDLE_OUTDATED')
  })
})

it('workspace upload sends a staged file stream instead of a buffer', async () => {
  const response = await upload('', 'streamed.txt')
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.results).toEqual([{ path: 'streamed.txt', status: 'created' }])
  expect(uploadWasStream).toBe(true)
})

it('workspace transfers disable their per-request idle timeout after authorization', async () => {
  const calls: number[] = []
  const server = {
    timeout(_request: Request, seconds: number) {
      calls.push(seconds)
    },
  }
  const form = new FormData()
  form.append('file', new File(['payload'], 'file'))
  await app.request(
    `/api/squads/${squadId}/workspace/upload?overwrite=true`,
    { method: 'POST', headers: authHeaders(token), body: form },
    server
  )
  await app.request(`/api/squads/${squadId}/workspace/download?path=file`, { headers: authHeaders(token) }, server)
  expect(calls).toEqual([0, 0])
})

for (const refusal of ['malformed', 'count', 'bytes'])
  it(`multipart ${refusal} fails before publishing any earlier file`, async () => {
    touched.length = 0
    const head = '--test\r\nContent-Disposition: form-data; name="first"; filename="first.txt"\r\n\r\ncomplete\r\n'
    let tail = ''
    if (refusal === 'malformed')
      tail =
        '--test\r\nBroken-header\r\nContent-Disposition: form-data; name="last"; filename="last.txt"\r\n\r\nlast\r\n'
    if (refusal === 'count')
      for (let i = 0; i < 257; i++)
        tail += '--test\r\nContent-Disposition: form-data; name="extra' + i + '"\r\n\r\nx\r\n'
    if (refusal === 'bytes')
      tail = '--test\r\nContent-Disposition: form-data; name="extra"\r\n\r\n' + 'x'.repeat(4 * 1024 ** 2) + '\r\n'
    const response = await app.request(`/api/squads/${squadId}/workspace/upload`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'multipart/form-data; boundary=test' },
      body: head + tail + '--test--\r\n',
    })
    expect(response.status).toBe(refusal === 'bytes' ? 413 : 400)
    if (refusal === 'bytes')
      expect(await response.json()).toMatchObject({ code: 'REQUEST_BODY_TOO_LARGE', maxBytes: 4 * 1024 ** 2 })
    expect(touched).toEqual([])
  })

it('publishes every file when a later part exceeds the former hidden header thresholds', async () => {
  touched.length = 0
  const body =
    '--test\r\nContent-Disposition: form-data; name="first"; filename="first.txt"\r\n\r\none\r\n--test\r\nX-Padding: ' +
    'x'.repeat(82 * 1024) +
    '\r\n' +
    Array.from({ length: 2001 }, (_, i) => `X-${i}: x\r\n`).join('') +
    'Content-Disposition: form-data; name="last"; filename="last.txt"\r\n\r\ntwo\r\n--test--\r\n'
  const response = await app.request(`/api/squads/${squadId}/workspace/upload?overwrite=true`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'multipart/form-data; boundary=test' },
    body,
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    uploaded: 2,
    results: [
      { path: 'first.txt', status: 'created' },
      { path: 'last.txt', status: 'created' },
    ],
  })
  expect(touched.filter((p) => p.endsWith('last.txt'))).toHaveLength(2)
})

describe('sandbox-backed workspace routes never expose the workspace settings directory', () => {
  function reset() {
    touched.length = 0
    downloads.length = 0
    bashCommands.length = 0
    statOverride = undefined
    downloadImpl = undefined
    listOverride = undefined
    archiveImpl = undefined
    bashImpl = undefined
  }

  // file and download also accept the box's absolute mount-prefixed spelling; tree never has.
  const settingsPaths = (route: 'tree' | 'file' | 'download') => [
    '.ficus',
    '.ficus/',
    '.ficus/.env',
    './.ficus/.env',
    '/.ficus/.env',
    '//.ficus///.env',
    'docs/../.ficus/.env',
    '.FICUS/.env',
    '.ficus./.env',
    '.ficus/monitors/m1/token',
    ...(route === 'tree' ? [] : [`${mount}/.ficus/.env`, `${mount}//.ficus/monitors`]),
  ]

  for (const route of ['tree', 'file', 'download'] as const) {
    it(`${route} answers not found for every spelling of the settings directory without reading it`, async () => {
      for (const path of settingsPaths(route)) {
        reset()
        const res = await get(route, path)
        expect([path, res.status]).toEqual([path, 404])
        expect(await res.text()).not.toContain('inside')
        expect(touched).toEqual([])
      }
    })

    it(`${route} answers not found for a link that resolves into the settings directory`, async () => {
      reset()
      bashImpl = () => ({ stdout: `${mount}\0${mount}/.ficus/.env\0`, exitCode: 0 })
      const res = await get(route, 'docs/innocent-link')
      expect(res.status).toBe(404)
      expect(touched).toEqual([])
      expect(bashCommands.length).toBe(1)
      expect(bashCommands[0]).toContain(`'${mount}/docs/innocent-link'`)
    })

    it(`${route} refuses a link that resolves outside the workspace`, async () => {
      reset()
      bashImpl = () => ({ stdout: `${mount}\0/home/other/secret.txt\0`, exitCode: 0 })
      const res = await get(route, 'docs/outside-link')
      expect(res.status).toBe(400)
      expect(touched).toEqual([])
    })

    it(`${route} fails closed when the box cannot resolve the path`, async () => {
      reset()
      bashImpl = () => ({ stdout: '', exitCode: 3 })
      const res = await get(route, 'docs/design.md')
      expect(res.status).toBe(500)
      expect(touched).toEqual([])
    })
  }

  it('tree omits the settings directory from a root listing and keeps nested ones', async () => {
    reset()
    listOverride = [
      { path: '.ficus', isDirectory: true, size: 0 },
      { path: '.FICUS.', isDirectory: true, size: 0 },
      { path: 'docs', isDirectory: true, size: 0 },
      { path: '.env', isDirectory: false, size: 3 },
      { path: 'readme.md', isDirectory: false, size: 3 },
    ]
    const res = await get('tree', '')
    expect(res.status).toBe(200)
    const names = ((await res.json()) as { children: Array<{ name: string }> }).children.map((child) => child.name)
    expect(names).toEqual(['docs', '.env', 'readme.md'])

    reset()
    listOverride = [{ path: '.ficus', isDirectory: true, size: 0 }]
    const nested = await get('tree', 'docs')
    expect(nested.status).toBe(200)
    expect(touched).toEqual([`${mount}/docs`])
  })

  it('download asks the box to leave the settings directory out of a root archive', async () => {
    reset()
    statOverride = { exists: true, size: 4096, isDirectory: true }
    archiveImpl = async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/gzip', 'x-ficus-archive-excluded': '.ficus' }),
      body: new Response('tgz-without-settings').body!,
    })
    for (const path of ['.', '/', mount]) {
      downloads.length = 0
      const res = await get('download', path)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('tgz-without-settings')
      expect(downloads).toEqual([{ path: mount, archive: true, exclude: ['.ficus'] }])
    }

    // A subdirectory archive needs no exclusion.
    downloads.length = 0
    const sub = await get('download', 'docs')
    expect(sub.status).toBe(200)
    expect(downloads).toEqual([{ path: `${mount}/docs`, archive: true }])
  })

  it('download refuses a root archive from a box that cannot leave the settings directory out', async () => {
    reset()
    statOverride = { exists: true, size: 4096, isDirectory: true }
    const res = await get('download', '.')
    expect(res.status).toBe(503)
    const body = await res.text()
    expect(body).toContain('SANDBOX_BUNDLE_OUTDATED')
    expect(body).not.toContain('tgz')
  })

  it('search quotes the query and drops anything under the settings directory', async () => {
    reset()
    const marker = `${tmpdir()}/sandbox-search-marker-${Date.now()}`
    const res = await app.request(
      `/api/squads/${squadId}/workspace/search?q=${encodeURIComponent(`'; touch ${marker}; echo '`)}`,
      { headers: authHeaders(token) }
    )
    expect(res.status).toBe(200)
    expect(existsSync(marker)).toBe(false)
    expect(bashCommands[0]).toContain(`-path '${mount}/.ficus' -prune`)

    reset()
    bashImpl = () => ({
      stdout: [
        `${mount}/.ficus/.env`,
        `${mount}/.FICUS/x`,
        `${mount}/docs/.ficus/kept.json`,
        `${mount}/env.md`,
        '',
      ].join('\n'),
      exitCode: 0,
    })
    const filtered = await app.request(`/api/squads/${squadId}/workspace/search?q=env`, { headers: authHeaders(token) })
    expect(((await filtered.json()) as { files: string[] }).files).toEqual(['docs/.ficus/kept.json', 'env.md'])
  })

  it('still serves an ordinary file after the settings checks', async () => {
    reset()
    const res = await get('file', 'docs/design.md')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { content: string }).content).toBe('inside')
    expect(touched).toEqual([`${mount}/docs/design.md`])
  })
})
