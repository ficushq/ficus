import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { db } from '../db'
import { agentFileAttachments, agents, messages } from '../db/schema'
import { identityMiddleware } from '../middleware'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from '../test-utils'
import { agentFilesRouter } from './agent-files'
import { AgentFileAttachment } from '../entities/AgentFileAttachment'
import { getSettingsStore } from '../services/settings'

function buildApp() {
  const app = new Hono()
  app.use('/api/*', identityMiddleware)
  app.route('/api/agents', agentFilesRouter)
  return app
}

let admin: TestUser
let agentId: string
let home: string
const originalHome = process.env.HOME_DIR

beforeAll(async () => {
  admin = await createTestAdmin({ prefix: 'agent-files' })
})
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-files-route-'))
  process.env.HOME_DIR = home
  ;[{ id: agentId }] = await db.insert(agents).values({ agentTypeId: 'engineer' }).returning({ id: agents.id })
})
afterEach(async () => {
  await db.delete(messages).where(eq(messages.agentId, agentId))
  await db.delete(agentFileAttachments).where(eq(agentFileAttachments.agentId, agentId))
  await db.delete(agents).where(eq(agents.id, agentId))
  await rm(home, { recursive: true, force: true })
})
afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = originalHome
  await cleanupTestRbac('agent-files')
})

async function upload(id: string = crypto.randomUUID(), name = 'quarterly report.pdf') {
  const form = new FormData()
  form.append('attachmentId', id)
  form.append('file', new File([new TextEncoder().encode('hello')], name, { type: 'application/pdf' }))
  return buildApp().request(`/api/agents/${agentId}/files`, {
    method: 'POST',
    headers: authHeaders(admin.token),
    body: form,
  })
}

describe('agent file routes', () => {
  // The composer inserts the returned path verbatim and the agent opens it, so
  // it must be the path the file actually has ON THE ACTIVE RUNTIME: `/private`
  // is a real mount only inside a container.
  test('returns the container-mount path on a container runtime', async () => {
    const id = crypto.randomUUID()
    const body = (await (await upload(id)).json()) as { path: string }
    expect(process.env.FICUS_SANDBOX_RUNTIME).toBe('docker-socket')
    expect(body.path).toBe(`/private/chat-attachments/${id}/quarterly_report.pdf`)
  })

  test('returns the real host path on the host runtime', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    try {
      const id = crypto.randomUUID()
      const body = (await (await upload(id)).json()) as { path: string }
      const storagePath = join(home, 'private', `agent_${agentId}`, 'chat-attachments', id, 'quarterly_report.pdf')
      expect(body.path).toBe(storagePath)
      expect(await readFile(storagePath, 'utf8')).toBe('hello')
    } finally {
      process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
    }
  })

  // A private mount whose path cannot be expressed as an `@token` (a space, a
  // quote, an `@`) would produce a reference the core can never link back to
  // its row: the upload would "succeed" and the composer would insert a token
  // that silently does nothing. Refuse it before anything is stored.
  test('refuses an upload whose agent-visible path is not referencable', async () => {
    const spaced = join(home, 'my home')
    await mkdir(spaced, { recursive: true })
    process.env.HOME_DIR = spaced
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    try {
      const id = crypto.randomUUID()
      const response = await upload(id)
      // 422, not 500: the request is unprocessable (this HOST_DIR cannot name
      // the file), not a core failure the client should retry.
      expect(response.status).toBe(422)
      expect(((await response.json()) as { error: string }).error).toBe(
        'Attachment path is not referencable on this host (path contains characters the reference syntax cannot express)'
      )
      expect(await AgentFileAttachment.findById(id)).toBeNull()
      expect(await readdir(join(spaced, 'private', `agent_${agentId}`)).catch(() => [])).toEqual([])
    } finally {
      process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
      process.env.HOME_DIR = home
    }
  })

  // Re-dropping a file the agent already has must be an ordinary new upload:
  // a fresh id, a fresh directory, and no interference from the first copy.
  test('accepts the same file again under a new attachment id', async () => {
    const first = await upload(crypto.randomUUID(), 'new service.json')
    const second = await upload(crypto.randomUUID(), 'new service.json')
    expect([first.status, second.status]).toEqual([200, 200])
    const paths = [((await first.json()) as { path: string }).path, ((await second.json()) as { path: string }).path]
    expect(paths[0]).not.toBe(paths[1])
    const attachmentsDir = join(home, 'private', `agent_${agentId}`, 'chat-attachments')
    expect((await readdir(attachmentsDir)).sort()).toEqual(paths.map((path) => path.split('/').at(-2)!).sort())
    for (const path of paths) {
      expect(await readFile(join(attachmentsDir, path.split('/').at(-2)!, 'new_service.json'), 'utf8')).toBe('hello')
    }
  })

  test('uploads to private storage and downloads verified immutable bytes', async () => {
    const id = crypto.randomUUID()
    const response = await upload(id)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { path: string }
    expect(body.path).toBe(`/private/chat-attachments/${id}/quarterly_report.pdf`)
    expect(
      await readFile(join(home, 'private', `agent_${agentId}`, 'chat-attachments', id, 'quarterly_report.pdf'), 'utf8')
    ).toBe('hello')

    const download = await buildApp().request(`/api/agents/${agentId}/files/${id}`, {
      headers: authHeaders(admin.token),
    })
    expect(download.status).toBe(200)
    expect(await download.text()).toBe('hello')
    expect(download.headers.get('X-Content-Type-Options')).toBe('nosniff')
    const deleted = await buildApp().request(`/api/agents/${agentId}/files/${id}`, {
      method: 'DELETE',
      headers: authHeaders(admin.token),
    })
    expect(deleted.status).toBe(204)
    expect(
      await readFile(join(home, 'private', `agent_${agentId}`, 'chat-attachments', id, 'quarterly_report.pdf')).catch(
        () => null
      )
    ).toBeNull()
  })

  test('handles concurrent identical uploads without deleting the winner', async () => {
    const id = crypto.randomUUID()
    const [first, second] = await Promise.all([upload(id), upload(id)])
    expect([first.status, second.status]).toEqual([200, 200])
    const download = await buildApp().request(`/api/agents/${agentId}/files/${id}`, {
      headers: authHeaders(admin.token),
    })
    expect(download.status).toBe(200)
    expect(await download.text()).toBe('hello')
  })

  test('rejects arbitrary fields and malformed attachment ids', async () => {
    const form = new FormData()
    form.append('attachmentId', crypto.randomUUID())
    form.append('path', '/private/secret')
    form.append('file', new File(['x'], 'x.txt'))
    expect(
      (
        await buildApp().request(`/api/agents/${agentId}/files`, {
          method: 'POST',
          headers: authHeaders(admin.token),
          body: form,
        })
      ).status
    ).toBe(400)
    expect((await upload('../outside')).status).toBe(400)
  })

  test('rejects streamed over-limit multipart bytes even without a trustworthy content length', async () => {
    await getSettingsStore().set('INBOX_MAX_ATTACHMENT_BYTES', '4')
    const boundary = 'tau-boundary'
    const body = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="attachmentId"\r\n\r\n${crypto.randomUUID()}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.txt"\r\n\r\n0123456789\r\n--${boundary}--\r\n`
    )
    const response = await buildApp().request(`/api/agents/${agentId}/files`, {
      method: 'POST',
      headers: {
        ...authHeaders(admin.token),
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': '1',
      },
      body,
    })
    expect(response.status).toBe(413)
    expect(await db.select().from(agentFileAttachments).where(eq(agentFileAttachments.agentId, agentId))).toEqual([])
    await getSettingsStore().set('INBOX_MAX_ATTACHMENT_BYTES', String(10 * 1024 * 1024))
  })

  test('does not expose an uploading reservation to download or delete', async () => {
    const id = crypto.randomUUID()
    await db.insert(agentFileAttachments).values({
      id,
      agentId,
      sandboxId: `agent_${agentId}`,
      uploadedByType: 'user',
      uploadedById: admin.id,
      originalName: 'reserved.txt',
      storedName: 'reserved.txt',
      privatePath: `/private/chat-attachments/${id}/reserved.txt`,
      contentType: 'text/plain',
      byteSize: 1,
      sha256: '0'.repeat(64),
      status: 'uploading',
    })
    const download = await buildApp().request(`/api/agents/${agentId}/files/${id}`, {
      headers: authHeaders(admin.token),
    })
    const deletion = await buildApp().request(`/api/agents/${agentId}/files/${id}`, {
      method: 'DELETE',
      headers: authHeaders(admin.token),
    })
    expect(download.status).toBe(404)
    expect(await download.json()).toEqual({ error: 'Attachment not found' })
    expect(deletion.status).toBe(404)
    expect(await deletion.json()).toEqual({ error: 'Attachment not found' })
  })

  test('recovers a stale uploading reservation and replaces partial copies', async () => {
    const id = crypto.randomUUID()
    const sandboxId = `agent_${agentId}`
    await db.insert(agentFileAttachments).values({
      id,
      agentId,
      sandboxId,
      uploadedByType: 'user',
      uploadedById: admin.id,
      originalName: 'quarterly report.pdf',
      storedName: 'quarterly_report.pdf',
      privatePath: `/private/chat-attachments/${id}/quarterly_report.pdf`,
      contentType: 'application/pdf',
      byteSize: 5,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      status: 'uploading',
      createdAt: new Date(Date.now() - 10 * 60_000),
    })
    const blobDir = join(home, 'agent-file-attachments', agentId)
    const privateDir = join(home, 'private', sandboxId, 'chat-attachments', id)
    await mkdir(blobDir, { recursive: true })
    await mkdir(privateDir, { recursive: true })
    await writeFile(join(blobDir, id), 'partial')
    await writeFile(join(privateDir, 'quarterly_report.pdf'), 'partial')
    expect((await upload(id)).status).toBe(200)
    expect(await readFile(join(blobDir, id), 'utf8')).toBe('hello')
    expect(await readFile(join(privateDir, 'quarterly_report.pdf'), 'utf8')).toBe('hello')
    expect((await AgentFileAttachment.findById(id))?.status).toBe('pending')
  })

  test('returns 409 when the target private workspace binding is stale', async () => {
    const id = crypto.randomUUID()
    expect((await upload(id)).status).toBe(200)
    await db.update(agentFileAttachments).set({ sandboxId: 'agent_stale' }).where(eq(agentFileAttachments.id, id))
    const response = await buildApp().request(`/api/agents/${agentId}/files/${id}`, {
      headers: authHeaders(admin.token),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Attachment belongs to a previous private workspace' })
  })

  test('keeps unknown attachment downloads uniform', async () => {
    const response = await buildApp().request(`/api/agents/${agentId}/files/${crypto.randomUUID()}`, {
      headers: authHeaders(admin.token),
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Attachment not found' })
  })
})

describe('agent file route ownership matrix', () => {
  let owner: TestUser
  let parentId: string
  let childId: string
  let siblingId: string
  let colocatedManagerId: string
  const ids: string[] = []

  beforeAll(async () => {
    owner = await createTestUser({ prefix: 'agent-files-owner' })
  })
  beforeEach(async () => {
    const [parent] = await db
      .insert(agents)
      .values({ agentTypeId: 'system-manager', ownerUserId: owner.id })
      .returning()
    const [child] = await db
      .insert(agents)
      .values({ agentTypeId: 'engineer', ownerUserId: owner.id, parentAgentId: parent.id })
      .returning()
    const [sibling] = await db
      .insert(agents)
      .values({ agentTypeId: 'engineer', ownerUserId: owner.id, parentAgentId: parent.id })
      .returning()
    const [manager] = await db
      .insert(agents)
      .values({ agentTypeId: 'system-manager', ownerUserId: owner.id })
      .returning()
    parentId = parent.id
    childId = child.id
    siblingId = sibling.id
    colocatedManagerId = manager.id
    ids.push(parentId, childId, siblingId, colocatedManagerId)
  })
  afterEach(async () => {
    await db.delete(agentFileAttachments).where(inArray(agentFileAttachments.agentId, ids))
    for (const id of [...ids].reverse()) await db.delete(agents).where(eq(agents.id, id))
    ids.length = 0
  })
  afterAll(async () => cleanupTestRbac('agent-files-owner'))

  async function ownerUpload(targetId: string, id = crypto.randomUUID()) {
    const form = new FormData()
    form.append('attachmentId', id)
    form.append('file', new File(['owned'], 'owned.txt'))
    const response = await buildApp().request(`/api/agents/${targetId}/files`, {
      method: 'POST',
      headers: authHeaders(owner.token),
      body: form,
    })
    return { id, response }
  }
  async function request(targetId: string, id: string, method = 'GET') {
    return buildApp().request(`/api/agents/${targetId}/files/${id}`, {
      method,
      headers: authHeaders(owner.token),
    })
  }

  test('private owner can upload, download, and delete its exact target file', async () => {
    const { id, response } = await ownerUpload(parentId)
    expect(response.status).toBe(200)
    expect((await request(parentId, id)).status).toBe(200)
    expect((await request(parentId, id, 'DELETE')).status).toBe(204)
  })

  test('child can read ancestor file but cannot delete; parent cannot read child file', async () => {
    const ancestor = await ownerUpload(parentId)
    expect(ancestor.response.status).toBe(200)
    expect((await request(childId, ancestor.id)).status).toBe(200)
    expect(await (await request(childId, ancestor.id, 'DELETE')).json()).toEqual({ error: 'Attachment not found' })
    const child = await ownerUpload(childId)
    expect(child.response.status).toBe(200)
    expect(await (await request(parentId, child.id)).json()).toEqual({ error: 'Attachment not found' })
  })

  test('denies sibling and same-user co-located manager and keeps foreign/unknown uniform', async () => {
    const owned = await ownerUpload(childId)
    expect(owned.response.status).toBe(200)
    const sibling = await request(siblingId, owned.id)
    const colocated = await request(colocatedManagerId, owned.id)
    const unknown = await request(siblingId, crypto.randomUUID())
    expect(sibling.status).toBe(404)
    expect(colocated.status).toBe(404)
    expect(await sibling.json()).toEqual(await unknown.json())
    expect(await colocated.json()).toEqual({ error: 'Attachment not found' })
  })
})
