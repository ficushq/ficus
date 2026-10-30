import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import { agents, db, images, squads, workStreams } from '../db'
import { Image } from '../entities/Image'
import { identityMiddleware } from '../middleware/identity'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from '../test-utils/rbac'
import { workStreamsRouter } from './work-streams'

// Synthetic users, squads, agents and a generated 1x1 PNG only.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)
const app = new Hono().use('*', identityMiddleware).route('/api/workstreams', workStreamsRouter)
const prefix = `ws-asset-routes-${randomUUID()}`
const originalHome = process.env.HOME_DIR
let home: string
let admin: TestUser, outsider: TestUser
let squadId: string, agentId: string
const streams: string[] = []

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
  outsider = await createTestUser({ prefix })
  const [squad] = await db.insert(squads).values({ name: prefix, purpose: 'Asset routes' }).returning()
  squadId = squad!.id
  const [agent] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId }).returning({ id: agents.id })
  agentId = agent!.id
})
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ws-asset-routes-'))
  process.env.HOME_DIR = home
})
afterEach(async () => {
  await db.delete(workStreams).where(inArray(workStreams.id, streams.splice(0)))
  await rm(home, { recursive: true, force: true })
})
afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = originalHome
  await db.delete(images).where(eq(images.agentId, agentId))
  await db.delete(agents).where(eq(agents.id, agentId))
  await db.delete(squads).where(eq(squads.id, squadId))
  await cleanupTestRbac(prefix)
})

async function conversationImage() {
  const [image] = await Image.createMany([{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }], {
    agentId,
  })
  await Image.markManyUsed([image!.id])
  return image!
}
const json = (token: string, body: unknown) => ({
  method: 'POST',
  headers: { ...authHeaders(token), 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

test('attach, list, read, preview headers and remove a stored input over HTTP', async () => {
  const image = await conversationImage()
  const [stream] = await db.insert(workStreams).values({ squadId, title: prefix, status: 'active' }).returning()
  streams.push(stream!.id)
  const base = `/api/workstreams/${stream!.id}/asset-attachments`

  expect((await app.request(base, json(outsider.token, { source: { kind: 'image', imageId: image.id } }))).status).toBe(
    403
  )
  // The typed namespaces: an unknown kind or a non-UUID is rejected as input.
  expect((await app.request(base, json(admin.token, { source: { kind: 'path', path: '/etc/passwd' } }))).status).toBe(
    400
  )
  expect((await app.request(base, json(admin.token, { source: { kind: 'image', imageId: 'x' } }))).status).toBe(400)

  const created = await app.request(base, json(admin.token, { source: { kind: 'image', imageId: image.id } }))
  expect(created.status).toBe(201)
  const share = await created.json()
  expect((await app.request(base, json(admin.token, { source: { kind: 'image', imageId: image.id } }))).status).toBe(
    200
  )

  const listed = await (await app.request(base, { headers: authHeaders(admin.token) })).json()
  expect(listed).toEqual({ inputs: [share], attempts: {} })
  expect((await app.request(base, { headers: authHeaders(outsider.token) })).status).toBe(403)
  const detail = await (
    await app.request(`/api/workstreams/${stream!.id}`, { headers: authHeaders(admin.token) })
  ).json()
  expect(detail.assetAttachments).toEqual([share])
  // The legacy path list is untouched.
  expect(detail.files).toEqual([])

  const bytes = await app.request(`${base}/${share.id}`, { headers: authHeaders(admin.token) })
  expect(bytes.status).toBe(200)
  expect(bytes.headers.get('content-type')).toBe('image/png')
  expect(bytes.headers.get('x-content-type-options')).toBe('nosniff')
  expect(bytes.headers.get('cache-control')).toBe('private, no-store')
  expect(Buffer.from(await bytes.arrayBuffer()).equals(PNG)).toBe(true)
  expect((await app.request(`${base}/${share.id}`, { headers: authHeaders(outsider.token) })).status).toBe(403)
  expect((await app.request(`${base}/${image.id}`, { headers: authHeaders(admin.token) })).status).toBe(404)
  expect((await app.request(`${base}/not-a-uuid`, { headers: authHeaders(admin.token) })).status).toBe(404)

  expect(
    (await app.request(`${base}/${share.id}`, { method: 'DELETE', headers: authHeaders(outsider.token) })).status
  ).toBe(403)
  expect(
    (await app.request(`${base}/${share.id}`, { method: 'DELETE', headers: authHeaders(admin.token) })).status
  ).toBe(200)
  expect((await app.request(`${base}/${share.id}`, { headers: authHeaders(admin.token) })).status).toBe(404)
  // The chat still owns its image.
  expect(await Image.find(image.id)).not.toBeNull()
})

test('a finished stream’s inputs no longer change', async () => {
  const image = await conversationImage()
  const [stream] = await db.insert(workStreams).values({ squadId, title: prefix, status: 'done' }).returning()
  streams.push(stream!.id)
  const response = await app.request(
    `/api/workstreams/${stream!.id}/asset-attachments`,
    json(admin.token, { source: { kind: 'image', imageId: image.id } })
  )
  expect(response.status).toBe(409)
})

test('creation refuses an unshareable reference before anything is created', async () => {
  const before = await db.select({ id: workStreams.id }).from(workStreams).where(eq(workStreams.squadId, squadId))
  const response = await app.request(
    '/api/workstreams',
    json(admin.token, {
      squadId,
      title: `${prefix} create`,
      assetReferences: [{ kind: 'image', imageId: randomUUID() }],
    })
  )
  expect(response.status).toBe(404)
  expect((await response.json()).error).toBe('Image or file not found, or you cannot share it')
  expect(await db.select({ id: workStreams.id }).from(workStreams).where(eq(workStreams.squadId, squadId))).toEqual(
    before
  )
})

test('creation installs references before the first assignment is written', async () => {
  const { spyOn } = await import('bun:test')
  const { Agent } = await import('../entities/Agent')
  const { inbox } = await import('../db')
  const { like } = await import('drizzle-orm')
  const { WorkflowSync } = await import('../services/config-sync/workflow-sync')
  const definition = new WorkflowSync().parse(
    await Bun.file(new URL('../../../../config/workflows/solo.yaml', import.meta.url)).text()
  ).definition
  const { agentTypes } = await import('../db')
  const workerType = `${prefix}-worker`
  await db.insert(agentTypes).values({ id: workerType, name: 'Asset route worker', model: 'x', systemPrompt: 'Test.' })
  for (const participant of Object.values(definition.participants)) participant.agentTypeId = workerType
  const send = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({
    success: true,
    status: 'queued',
    queued: true,
  })
  const image = await conversationImage()
  try {
    const response = await app.request(
      '/api/workstreams',
      json(admin.token, {
        squadId,
        title: `${prefix} create`,
        workflow: { kind: 'inline', definition },
        assetReferences: [{ kind: 'image', imageId: image.id }],
      })
    )
    const created = await response.json()
    expect({ status: response.status, error: created.error }).toEqual({ status: 201, error: undefined })
    streams.push(created.id)
    const [assignment] = await db
      .select()
      .from(inbox)
      .where(like(inbox.idempotencyKey, `flow:${created.id}:%`))
    expect(assignment!.content).toContain('Stored inputs:')
    expect(assignment!.content).toContain('"kind":"workstream-asset"')
    const listed = await (
      await app.request(`/api/workstreams/${created.id}/asset-attachments`, { headers: authHeaders(admin.token) })
    ).json()
    expect(listed.inputs.map((entry: { source: unknown }) => entry.source)).toEqual([
      { kind: 'image', imageId: image.id },
    ])
    await db.delete(inbox).where(eq(inbox.id, assignment!.id))
  } finally {
    send.mockRestore()
    const spawned = await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, squadId))
    await db.delete(workStreams).where(inArray(workStreams.id, streams.splice(0)))
    const extra = spawned.map((row) => row.id).filter((id) => id !== agentId)
    if (extra.length) {
      await db.delete(inbox).where(inArray(inbox.recipientId, extra))
      await db.delete(agents).where(inArray(agents.id, extra))
    }
    await db.delete(agentTypes).where(eq(agentTypes.id, workerType))
  }
})
