import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test'
import { Hono } from 'hono'

// Every sandbox-backed squad (VM, Kubernetes) proxies workspace reads and writes through this
// client. Record each path it is asked to touch so the test can prove none escape the mount.
const touched: string[] = []
const fakeClient = {
  list: async ({ path }: { path: string }) => {
    touched.push(path)
    return { files: [] }
  },
  read: async ({ path }: { path: string }) => {
    touched.push(path)
    return { content: Buffer.from('inside').toString('base64'), isBinary: false, totalSize: 6 }
  },
  stat: async ({ path }: { path: string }) => {
    touched.push(path)
    return { exists: true, size: 6, isDirectory: false }
  },
  upload: async ({ path }: { path: string }) => {
    touched.push(path)
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

const app = new Hono()
app.use('*', identityMiddleware)
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
