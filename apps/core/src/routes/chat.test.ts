import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { createHash } from 'crypto'
import { eq, and, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { chatRouter } from './chat'
import { identityMiddleware } from '../middleware/identity'
import { Agent } from '../entities/Agent'
import { AgentType } from '../entities/AgentType'
import { Squad } from '../entities/Squad'
import {
  db,
  agents,
  agentTypes,
  chatSendReceipts,
  executionAdmissionReservations,
  executions,
  messages,
  squads,
} from '../db'
import { Image } from '../entities/Image'
import { ARTIFACT_BUILDER_AGENT_TYPE_ID, ARTIFACT_BUILDER_RUNNER_TYPE } from '../entities/agent-runners/constants'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from '../test-utils'
import { deviceConnectionRegistry } from '../services/auth/device-connection-registry'
import { createDeviceToken, revokeDeviceToken } from '../services/auth/device-tokens'
import { proxyWorkerSSE, type ProxyWorkerSSE } from '../services/streaming/sse-proxy'
import {
  createControlledWorkerSSE,
  type ControlledWorkerSSEConnection,
} from '../services/streaming/controlled-worker-sse.test-helper'

const rbacPrefix = `chat-rbac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser

function workerSseResponse(): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: done\ndata: {"type":"done"}\n\n'))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )
}

function createChatTestApp(
  scopedProxy: ProxyWorkerSSE = (stream, options) =>
    proxyWorkerSSE(stream, options, { fetch: async () => workerSseResponse() })
): Hono {
  const testApp = new Hono()
  testApp.use('*', async (c, next) => {
    c.set('proxyWorkerSSE', scopedProxy)
    await next()
  })
  testApp.use('*', identityMiddleware)
  testApp.route('/api/chat', chatRouter)
  return testApp
}

const app = createChatTestApp()

async function readSseEvents(res: Response): Promise<Array<{ event: string; data: unknown }>> {
  const text = await res.text()
  const events: Array<{ event: string; data: unknown }> = []

  for (const chunk of text.split('\n\n')) {
    const event = chunk
      .split('\n')
      .find((line) => line.startsWith('event: '))
      ?.slice('event: '.length)
    const data = chunk
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length)

    if (event && data) {
      events.push({ event, data: JSON.parse(data) })
    }
  }

  return events
}

describe('POST /api/chat', () => {
  let createdArtifactBuilderType = false
  let agent: Agent

  beforeEach(async () => {
    admin = await createTestAdmin({ prefix: rbacPrefix, canonicalAdmin: true })
    const existingType = await AgentType.find(ARTIFACT_BUILDER_AGENT_TYPE_ID)
    if (!existingType) {
      await AgentType.create({
        id: ARTIFACT_BUILDER_AGENT_TYPE_ID,
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Artifact Builder',
        systemPrompt: 'Build artifacts',
      })
      createdArtifactBuilderType = true
    }

    agent = await Agent.create({ agentTypeId: ARTIFACT_BUILDER_AGENT_TYPE_ID, context: {} })
  })

  afterEach(async () => {
    await db.delete(messages).where(eq(messages.agentId, agent.id))
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db.delete(agents).where(eq(agents.id, agent.id))
    if (createdArtifactBuilderType) {
      await db.delete(agentTypes).where(eq(agentTypes.id, ARTIFACT_BUILDER_AGENT_TYPE_ID))
      createdArtifactBuilderType = false
    }
    await cleanupTestRbac(rbacPrefix)
  })

  it('closes an admitted device-authenticated stream on revoke and rejects reconnect', async () => {
    const device = await createDeviceToken({ userId: admin.id, name: 'CLI', platform: 'cli' })
    let connection: ControlledWorkerSSEConnection | undefined
    let releaseProxy!: () => void
    let rejectProxy!: (error: Error) => void
    const proxySelected = new Promise<void>((resolve, reject) => {
      releaseProxy = resolve
      rejectProxy = reject
    })
    let proxyCompletion: Promise<void> | undefined
    const scopedProxy: ProxyWorkerSSE = async (stream, options) => {
      try {
        const expectedExecution = await agent.getActiveExecution()
        if (!expectedExecution) throw new Error('Expected an active chat execution before worker proxy selection')
        const expectedPath = `/stream/${expectedExecution.id}`
        if (options.workerPath !== expectedPath) {
          throw new Error(`Unexpected chat worker SSE path: ${options.workerPath}; expected ${expectedPath}`)
        }
        const harness = createControlledWorkerSSE([expectedPath])
        connection = harness.connection(expectedPath)
        proxyCompletion = proxyWorkerSSE(stream, options, { fetch: harness.fetch })
        await connection.started
        releaseProxy()
        return proxyCompletion
      } catch (error) {
        rejectProxy(error instanceof Error ? error : new Error(String(error)))
        throw error
      }
    }
    const scopedApp = createChatTestApp(scopedProxy)
    let admitted: Response | undefined

    try {
      admitted = await scopedApp.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(device.token) },
        body: JSON.stringify({ agentId: agent.id, message: 'Continue artifact work' }),
      })
      await proxySelected
      const execution = await agent.getActiveExecution()
      expect(execution).not.toBeNull()
      expect(connection?.path).toBe(`/stream/${execution!.id}`)
      await connection!.started
      expect(connection?.signal).toBeInstanceOf(AbortSignal)
      expect(deviceConnectionRegistry.connectionCount(device.id)).toBe(1)

      const revoking = revokeDeviceToken(admin.id, device.id)
      await connection!.cancelStarted
      await revoking
      expect(connection!.signal!.aborted).toBe(true)
      expect(deviceConnectionRegistry.connectionCount(device.id)).toBe(0)

      let proxySettled = false
      void proxyCompletion!.then(() => {
        proxySettled = true
      })
      await Promise.resolve()
      expect(proxySettled).toBe(false)

      connection!.releaseCancel()
      await Promise.all([connection!.cancelSettled, proxyCompletion!])
      const body = await admitted.text()
      expect(body).toContain('event: agent')

      const reconnect = await scopedApp.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(device.token) },
        body: JSON.stringify({ agentId: agent.id, message: 'Try again' }),
      })
      expect(reconnect.status).toBe(401)
    } finally {
      await revokeDeviceToken(admin.id, device.id)
      connection?.releaseCancel()
      await Promise.allSettled([connection?.cancelSettled, proxyCompletion, admitted?.text()])
    }
  })

  it('returns 401 without identity', async () => {
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: agent.id, message: 'Continue artifact work' }),
    })

    expect(res.status).toBe(401)
  })

  it('denies users without chat permission', async () => {
    const user = await createTestUser({ prefix: rbacPrefix })
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(user.token) },
      body: JSON.stringify({ agentId: agent.id, message: 'Continue artifact work' }),
    })

    expect(res.status).toBe(403)
  })

  it('records the authenticated user as owner when creating a squad-less system-manager agent', async () => {
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ message: 'Start system manager chat' }),
    })

    expect(res.status).toBe(200)
    const events = await readSseEvents(res)
    const agentEvent = events.find((event) => event.event === 'agent')
    const agentId = (agentEvent?.data as { agentId?: string } | undefined)?.agentId
    expect(agentId).toBeString()

    const createdAgent = await Agent.find(agentId!)
    expect(createdAgent?.squadId).toBeNull()
    expect(createdAgent?.ownerUserId).toBe(admin.id)

    await db.delete(messages).where(eq(messages.agentId, agentId!))
    await db.delete(executions).where(eq(executions.agentId, agentId!))
    await db.delete(agents).where(eq(agents.id, agentId!))
  })

  it('rejects image IDs before queueing when the target agent model does not support images', async () => {
    const textOnlyAgent = await Agent.create({
      agentTypeId: ARTIFACT_BUILDER_AGENT_TYPE_ID,
      modelOverride: 'zai:glm-5.2',
    })
    try {
      const res = await app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({
          agentId: textOnlyAgent.id,
          message: 'Look at this',
          imageIds: ['00000000-0000-0000-0000-000000000301'],
        }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('This model does not support image input. Use a vision-capable model.')
      const queued = await db.select().from(executions).where(eq(executions.agentId, textOnlyAgent.id))
      expect(queued).toHaveLength(0)
    } finally {
      await db.delete(messages).where(eq(messages.agentId, textOnlyAgent.id))
      await db.delete(executions).where(eq(executions.agentId, textOnlyAgent.id))
      await db.delete(agents).where(eq(agents.id, textOnlyAgent.id))
    }
  })

  it('emits artifact-builder scope in the initial agent SSE event for artifact-builder agents without context scope', async () => {
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ agentId: agent.id, message: 'Continue artifact work' }),
    })

    expect(res.status).toBe(200)
    const events = await readSseEvents(res)
    const agentEvent = events.find((event) => event.event === 'agent')

    expect(agentEvent?.data).toMatchObject({
      type: 'agent',
      agentId: agent.id,
      scope: { type: ARTIFACT_BUILDER_RUNNER_TYPE },
    })
  })

  it('overrides stale context scope in the initial agent SSE event for artifact-builder agents', async () => {
    await agent.update({ context: { scope: { type: 'task', id: 'stale-task-id' } } })

    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ agentId: agent.id, message: 'Continue artifact work' }),
    })

    expect(res.status).toBe(200)
    const events = await readSseEvents(res)
    const agentEvent = events.find((event) => event.event === 'agent')

    expect(agentEvent?.data).toMatchObject({
      type: 'agent',
      agentId: agent.id,
      scope: { type: ARTIFACT_BUILDER_RUNNER_TYPE },
    })
  })
})

// ── consultant scope ──────────────────────────────────────────────────────────

const consultantApp = new Hono()
consultantApp.use('*', identityMiddleware)
consultantApp.route('/api/chat', chatRouter)

const prefix = `chat-consultant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let consultantAdmin: TestUser
let consultantSquad: Squad
const consultantImageIds: string[] = []

beforeAll(async () => {
  consultantAdmin = await createTestAdmin({ prefix, canonicalAdmin: true })
  consultantSquad = await Squad.create({ name: `${prefix}-sq`, purpose: 'test', squadPresetId: undefined })
})

afterEach(async () => {
  await Image.deleteMany(consultantImageIds.splice(0))
  const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, consultantSquad.id))
  const ids = rows.map((row) => row.id)
  if (ids.length) {
    await db.delete(chatSendReceipts).where(inArray(chatSendReceipts.agentId, ids))
    await db.delete(executionAdmissionReservations).where(inArray(executionAdmissionReservations.agentId, ids))
    await db.delete(messages).where(inArray(messages.agentId, ids))
    await db.delete(executions).where(inArray(executions.agentId, ids))
    await db.delete(agents).where(inArray(agents.id, ids))
  }
})

afterAll(async () => {
  await db.delete(squads).where(eq(squads.id, consultantSquad.id))
  await cleanupTestRbac(prefix)
})

describe('POST /api/chat clientId idempotency', () => {
  let idempotencyAgent: Agent
  const idemPrefix = `chat-idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let idemAdmin: TestUser

  beforeAll(async () => {
    idemAdmin = await createTestAdmin({ prefix: idemPrefix, canonicalAdmin: true })
    idempotencyAgent = await Agent.create({ agentTypeId: ARTIFACT_BUILDER_AGENT_TYPE_ID, context: {} })
  })

  afterAll(async () => {
    await db.delete(chatSendReceipts).where(eq(chatSendReceipts.agentId, idempotencyAgent.id))
    await db.delete(messages).where(eq(messages.agentId, idempotencyAgent.id))
    await db.delete(executions).where(eq(executions.agentId, idempotencyAgent.id))
    await db.delete(agents).where(eq(agents.id, idempotencyAgent.id))
    await cleanupTestRbac(idemPrefix)
  })

  it('two POSTs with the same clientId result in a single human row', async () => {
    const clientId = `test-client-id-${Date.now()}`

    const res1 = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(idemAdmin.token) },
      body: JSON.stringify({ agentId: idempotencyAgent.id, message: 'hello', clientId }),
    })
    expect(res1.status).toBe(200)
    await res1.text()

    const res2 = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(idemAdmin.token) },
      body: JSON.stringify({ agentId: idempotencyAgent.id, message: 'hello', clientId }),
    })
    expect(res2.status).toBe(200)
    await res2.text()

    const allMessages = await db.select().from(messages).where(eq(messages.agentId, idempotencyAgent.id))
    const humanRows = allMessages.filter((m) => m.role === 'human')
    expect(humanRows).toHaveLength(1)
    expect((humanRows[0].metadata as any)?.clientId).toBe(clientId)
    const [receipt] = await db
      .select()
      .from(chatSendReceipts)
      .where(and(eq(chatSendReceipts.agentId, idempotencyAgent.id), eq(chatSendReceipts.clientId, clientId)))
    expect(receipt?.requestHash).toBe(
      createHash('sha256')
        .update(
          JSON.stringify({
            v: 3,
            agentId: idempotencyAgent.id,
            clientId,
            content: 'hello',
            imageIds: [],
            deliveryMode: 'steer',
          })
        )
        .digest('hex')
    )
  })
})

describe('POST /api/chat attachment acceptance atomicity', () => {
  const atomicPrefix = `chat-attachment-atomic-${Date.now()}`
  let atomicAdmin: TestUser
  let atomicSquad: Squad
  let atomicAgent: Agent
  const createdImageIds: string[] = []

  beforeAll(async () => {
    atomicAdmin = await createTestAdmin({ prefix: atomicPrefix, canonicalAdmin: true })
    atomicSquad = await Squad.create({ name: atomicPrefix, purpose: 'test', squadPresetId: undefined })
    atomicAgent = await Agent.create({ agentTypeId: 'consultant', squadId: atomicSquad.id, persist: false })
  })

  afterEach(async () => {
    await atomicAgent.update({ modelOverride: null })
    await Image.deleteMany(createdImageIds.splice(0))
    await db.delete(chatSendReceipts).where(eq(chatSendReceipts.agentId, atomicAgent.id))
    await db.delete(executionAdmissionReservations).where(eq(executionAdmissionReservations.agentId, atomicAgent.id))
    await db.delete(messages).where(eq(messages.agentId, atomicAgent.id))
    await db.delete(executions).where(eq(executions.agentId, atomicAgent.id))
  })

  afterAll(async () => {
    await db.delete(agents).where(eq(agents.id, atomicAgent.id))
    await db.delete(squads).where(eq(squads.id, atomicSquad.id))
    await cleanupTestRbac(atomicPrefix)
  })

  async function stagedImage(): Promise<string> {
    const [image] = await Image.createMany(
      [{ type: 'image', data: Buffer.from(crypto.randomUUID()).toString('base64'), mimeType: 'image/png' }],
      { squadId: atomicSquad.id, uploadedByUserId: atomicAdmin.id }
    )
    createdImageIds.push(image.id)
    return image.id
  }

  it('does not bind an extra image when the receipt payload conflicts', async () => {
    const firstImageId = await stagedImage()
    const extraImageId = await stagedImage()
    const clientId = crypto.randomUUID()
    const send = (message: string, imageIds: string[]) =>
      app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(atomicAdmin.token) },
        body: JSON.stringify({ agentId: atomicAgent.id, message, imageIds, clientId }),
      })

    const first = await send('first', [firstImageId])
    expect(first.status).toBe(200)
    await first.text()
    const conflict = await send('different', [extraImageId])
    expect(conflict.status).toBeGreaterThanOrEqual(400)
    expect((await Image.find(extraImageId))?.agentId).toBeNull()
  })

  it('returns an accepted image replay even when the current model no longer supports images', async () => {
    const imageId = await stagedImage()
    const clientId = crypto.randomUUID()
    const request = () =>
      app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(atomicAdmin.token) },
        body: JSON.stringify({
          agentId: atomicAgent.id,
          message: 'accepted image',
          imageIds: [imageId],
          clientId,
        }),
      })

    const accepted = await request()
    expect(accepted.status).toBe(200)
    await accepted.text()
    const beforeMessages = await db.select().from(messages).where(eq(messages.agentId, atomicAgent.id))
    const beforeExecutions = await db.select().from(executions).where(eq(executions.agentId, atomicAgent.id))
    const [legacyReceipt] = await db
      .select()
      .from(chatSendReceipts)
      .where(and(eq(chatSendReceipts.agentId, atomicAgent.id), eq(chatSendReceipts.clientId, clientId)))
    expect(legacyReceipt?.disposition).toBe('turn')
    const legacyHash = createHash('sha256')
      .update(
        JSON.stringify({
          v: 2,
          agentId: atomicAgent.id,
          content: 'accepted image',
          imageIds: [imageId],
          deliveryMode: 'steer',
        })
      )
      .digest('hex')
    await db
      .update(chatSendReceipts)
      .set({ requestHash: legacyHash })
      .where(and(eq(chatSendReceipts.agentId, atomicAgent.id), eq(chatSendReceipts.clientId, clientId)))

    await atomicAgent.update({ modelOverride: 'zai:glm-5.2' })
    const replay = await request()
    expect(replay.status).toBe(200)
    await replay.text()

    expect(await db.select().from(messages).where(eq(messages.agentId, atomicAgent.id))).toHaveLength(
      beforeMessages.length
    )
    expect(await db.select().from(executions).where(eq(executions.agentId, atomicAgent.id))).toHaveLength(
      beforeExecutions.length
    )
    expect((await Image.find(imageId))?.agentId).toBe(atomicAgent.id)
    await atomicAgent.update({ modelOverride: null })
  })

  it('rolls back an image claim when queue acceptance fails', async () => {
    await atomicAgent.queueExecution({ message: 'already active' })
    const imageId = await stagedImage()
    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(atomicAdmin.token) },
      body: JSON.stringify({
        agentId: atomicAgent.id,
        message: 'cannot queue',
        imageIds: [imageId],
        clientId: crypto.randomUUID(),
      }),
    })

    expect(response.status).toBe(500)
    expect((await Image.find(imageId))?.agentId).toBeNull()
  })
})

describe('POST /api/chat sender metadata', () => {
  let senderAgent: Agent
  const senderPrefix = `chat-sender-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let senderAdmin: TestUser

  beforeAll(async () => {
    senderAdmin = await createTestAdmin({ prefix: senderPrefix, canonicalAdmin: true })
    senderAgent = await Agent.create({ agentTypeId: ARTIFACT_BUILDER_AGENT_TYPE_ID, context: {} })
  })

  afterAll(async () => {
    await db.delete(chatSendReceipts).where(eq(chatSendReceipts.agentId, senderAgent.id))
    await db.delete(messages).where(eq(messages.agentId, senderAgent.id))
    await db.delete(executions).where(eq(executions.agentId, senderAgent.id))
    await db.delete(agents).where(eq(agents.id, senderAgent.id))
    await cleanupTestRbac(senderPrefix)
  })

  it('attaches the sending user as sender metadata on the queued message', async () => {
    const clientId = `sender-meta-${Date.now()}`
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(senderAdmin.token) },
      body: JSON.stringify({ agentId: senderAgent.id, message: 'who am i', clientId, pagePath: '/squads/tau' }),
    })
    expect(res.status).toBe(200)
    await res.text()

    const allMessages = await db.select().from(messages).where(eq(messages.agentId, senderAgent.id))
    const row = allMessages.find((m) => m.role === 'human' && (m.metadata as any)?.clientId === clientId)
    expect(row).toBeDefined()
    expect((row!.metadata as any)?.sender).toEqual({ userId: senderAdmin.id, name: senderAdmin.displayName })
    expect(row!.content).toBe('who am i')
    expect(row!.metadata).toMatchObject({ pagePath: '/squads/tau' })
  })
})

describe('POST /api/chat consultant scope', () => {
  async function stageConsultantImage(): Promise<string> {
    const [image] = await Image.createMany(
      [{ type: 'image', data: Buffer.from(crypto.randomUUID()).toString('base64'), mimeType: 'image/png' }],
      { squadId: consultantSquad.id, uploadedByUserId: consultantAdmin.id }
    )
    consultantImageIds.push(image.id)
    return image.id
  }

  it('reuses one consultant and accepted send for concurrent identical create requests', async () => {
    const imageId = await stageConsultantImage()
    const clientId = crypto.randomUUID()
    const request = () =>
      app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(consultantAdmin.token) },
        body: JSON.stringify({
          message: '',
          imageIds: [imageId],
          clientId,
          scope: { type: 'consultant', id: consultantSquad.id },
        }),
      })

    const [first, second] = await Promise.all([request(), request()])
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    await Promise.all([first.text(), second.text()])

    const consultants = await db
      .select()
      .from(agents)
      .where(and(eq(agents.squadId, consultantSquad.id), eq(agents.agentTypeId, 'consultant')))
    expect(consultants).toHaveLength(1)
    expect(consultants[0]!.context).toMatchObject({
      scope: { type: 'consultant', id: consultantSquad.id },
      origin: 'user',
    })
    const humanRows = await db
      .select()
      .from(messages)
      .where(and(eq(messages.agentId, consultants[0]!.id), eq(messages.role, 'human')))
    expect(humanRows).toHaveLength(1)
    expect((await Image.find(imageId))?.agentId).toBe(consultants[0]!.id)
  })

  it('rejects an image-bearing consultant create without a client ID', async () => {
    const imageId = await stageConsultantImage()
    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(consultantAdmin.token) },
      body: JSON.stringify({
        message: '',
        imageIds: [imageId],
        scope: { type: 'consultant', id: consultantSquad.id },
      }),
    })

    expect(response.status).toBe(400)
    expect((await Image.find(imageId))?.agentId).toBeNull()
  })

  it('returns a conflict without claiming a different payload under the same create key', async () => {
    const firstImageId = await stageConsultantImage()
    const conflictingImageId = await stageConsultantImage()
    const clientId = crypto.randomUUID()
    const send = (message: string, imageId: string) =>
      app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(consultantAdmin.token) },
        body: JSON.stringify({
          message,
          imageIds: [imageId],
          clientId,
          scope: { type: 'consultant', id: consultantSquad.id },
        }),
      })

    const accepted = await send('first', firstImageId)
    expect(accepted.status).toBe(200)
    await accepted.text()
    const conflict = await send('different', conflictingImageId)
    expect(conflict.status).toBe(409)
    expect((await Image.find(conflictingImageId))?.agentId).toBeNull()
  })

  it('creates a fresh squad-bound consultant each time, persist=false, no owner', async () => {
    const body = JSON.stringify({ message: 'hi', scope: { type: 'consultant', id: consultantSquad.id } })
    // The consultant agent row is created BEFORE queueExecution, and the SSE body is
    // never read, so this resolves promptly. Tolerate any queueExecution error in the
    // test env (no worker/sandbox) — we assert on DB state, not the HTTP response.
    const send = async () => {
      try {
        await consultantApp.request('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(consultantAdmin.token) },
          body,
        })
      } catch {
        /* agent row already committed before queueExecution; ignore */
      }
    }
    await send()
    await send()

    const consultants = await db
      .select()
      .from(agents)
      .where(and(eq(agents.squadId, consultantSquad.id), eq(agents.agentTypeId, 'consultant')))

    expect(consultants.length).toBe(2) // always-new: two requests → two agents
    for (const c of consultants) {
      expect(c.persist).toBe(false)
      expect(c.ownerUserId).toBeNull()
      expect(c.context).toMatchObject({ origin: 'user' })
    }
  })
})
