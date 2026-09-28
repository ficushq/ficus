import { afterAll as maintenanceAfterAll, beforeAll as maintenanceBeforeAll } from 'bun:test'
import { acquireMaintenanceTestIsolation } from '../test-utils/maintenance-test-isolation'

let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
maintenanceBeforeAll(async () => (releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()))
maintenanceAfterAll(() => releaseMaintenanceIsolation?.())

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, spyOn } from 'bun:test'
import { createHash } from 'crypto'
import { and, eq, gte, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { agentsRouter } from './agents'
import * as sandboxFactory from '../services/sandbox/factory'
import { AgentType } from '../entities/AgentType'
import {
  db,
  agents,
  agentExtraScopes,
  agentTypes,
  chatSendReceipts,
  executions,
  executionAdmissionReservations,
  inbox,
  messages as messagesTable,
  squads,
  sandboxProvisionRecoveries,
  deviceTokens,
} from '../db'
import { Agent, setAgentSelectedModel } from '../entities/Agent'
import { listen } from '../lib/infra/local-events'
import { Squad } from '../entities/Squad'
import { Execution } from '../entities/Execution'
import { Image } from '../entities/Image'
import { ARTIFACT_BUILDER_AGENT_TYPE_ID } from '../entities/agent-runners/constants'
import { identityMiddleware } from '../middleware/identity'
import { jsonBodyErrorHandler, jsonBodyErrorMiddleware } from '../middleware/json-body-errors'
import { insertMachine, deleteMachine } from '../services/machines/queries'
import * as agentWarmup from '../services/sandbox/agent-warmup'
import { PROVISION_RECOVERY_MAX_ATTEMPTS } from '../services/sandbox/k8s/provision-recovery-store'
import { wsManager } from '../services/ws/manager'
import {
  createTestAdmin,
  authHeaders,
  cleanupTestRbac,
  createTestUser,
  createTestRole,
  assignRole,
  type TestUser,
} from '../test-utils'
import { deviceConnectionRegistry } from '../services/auth/device-connection-registry'
import { createDeviceToken, revokeDeviceToken } from '../services/auth/device-tokens'
import { proxyWorkerSSE, type ProxyWorkerSSE } from '../services/streaming/sse-proxy'
import { createControlledWorkerSSE } from '../services/streaming/controlled-worker-sse.test-helper'

const app = new Hono()
app.use('*', jsonBodyErrorMiddleware)
app.onError(jsonBodyErrorHandler)
app.use('*', identityMiddleware)
app.route('/api/agents', agentsRouter)

// ── Shared RBAC setup ────────────────────────────────────────────────────────

const rbacPrefix = `agents-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix: rbacPrefix, canonicalAdmin: true })
})

afterAll(async () => {
  await cleanupTestRbac(rbacPrefix)
})

describe('GET /api/agents/:id/stream device revocation', () => {
  let ownedAgent: Agent
  let ownedExecution: Execution
  let controlAgent: Agent
  let controlExecution: Execution
  let typeId: string

  function createStreamApp(scopedProxy: ProxyWorkerSSE): Hono {
    const streamApp = new Hono()
    streamApp.use('*', jsonBodyErrorMiddleware)
    streamApp.onError(jsonBodyErrorHandler)
    streamApp.use('*', async (c, next) => {
      c.set('proxyWorkerSSE', scopedProxy)
      await next()
    })
    streamApp.use('*', identityMiddleware)
    streamApp.route('/api/agents', agentsRouter)
    return streamApp
  }

  async function promiseSettled(promise: Promise<unknown>): Promise<boolean> {
    let settled = false
    void promise.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await Promise.resolve()
    return settled
  }

  beforeEach(async () => {
    typeId = `${rbacPrefix}-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await AgentType.create({
      id: typeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Stream agent',
      systemPrompt: 'Test',
    })
    ownedAgent = await Agent.create({ agentTypeId: typeId })
    ownedExecution = await ownedAgent.queueExecution({ message: 'owned stream' })
    controlAgent = await Agent.create({ agentTypeId: typeId })
    controlExecution = await controlAgent.queueExecution({ message: 'control stream' })
  })

  afterEach(async () => {
    await db.delete(executions).where(eq(executions.agentId, ownedAgent.id))
    await db.delete(executions).where(eq(executions.agentId, controlAgent.id))
    await db.delete(agents).where(eq(agents.id, ownedAgent.id))
    await db.delete(agents).where(eq(agents.id, controlAgent.id))
    await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
  })

  it('revokes only the exact registered device stream and rejects reconnect', async () => {
    const ownedDevice = await createDeviceToken({ userId: admin.id, name: 'Owned CLI', platform: 'cli' })
    const controlDevice = await createDeviceToken({ userId: admin.id, name: 'Control CLI', platform: 'cli' })
    const ownedPath = `/stream/${ownedExecution.id}`
    const controlPath = `/stream/${controlExecution.id}`
    const harness = createControlledWorkerSSE([ownedPath, controlPath])
    const owned = harness.connection(ownedPath)
    const control = harness.connection(controlPath)
    const proxyRuns = new Map<string, Promise<void>>()
    const scopedProxy: ProxyWorkerSSE = (stream, options) => {
      const running = proxyWorkerSSE(stream, options, { fetch: harness.fetch })
      proxyRuns.set(options.workerPath, running)
      return running
    }
    const streamApp = createStreamApp(scopedProxy)
    let ownedResponse: Response | undefined
    let controlResponse: Response | undefined

    try {
      ownedResponse = await streamApp.request(`/api/agents/${ownedAgent.id}/stream`, {
        headers: authHeaders(ownedDevice.token),
      })
      controlResponse = await streamApp.request(`/api/agents/${controlAgent.id}/stream`, {
        headers: authHeaders(controlDevice.token),
      })
      await Promise.all([owned.started, control.started])

      expect(owned.path).toBe(ownedPath)
      expect(control.path).toBe(controlPath)
      expect(owned.signal).toBeInstanceOf(AbortSignal)
      expect(control.signal).toBeInstanceOf(AbortSignal)
      expect(owned.signal).not.toBe(control.signal)
      expect(deviceConnectionRegistry.connectionCount(ownedDevice.id)).toBe(1)
      expect(deviceConnectionRegistry.connectionCount(controlDevice.id)).toBe(1)

      const rows = await db
        .select({ id: deviceTokens.id, userId: deviceTokens.userId, revokedAt: deviceTokens.revokedAt })
        .from(deviceTokens)
        .where(eq(deviceTokens.userId, admin.id))
      const ownedRow = rows.find((row) => row.id === ownedDevice.id)
      const controlRow = rows.find((row) => row.id === controlDevice.id)
      expect(ownedRow).toMatchObject({ id: ownedDevice.id, userId: admin.id, revokedAt: null })
      expect(controlRow).toMatchObject({ id: controlDevice.id, userId: admin.id, revokedAt: null })

      const revoking = revokeDeviceToken(admin.id, ownedDevice.id)
      await owned.cancelStarted
      await revoking

      const [revoked] = await db
        .select({ revokedAt: deviceTokens.revokedAt })
        .from(deviceTokens)
        .where(eq(deviceTokens.id, ownedDevice.id))
      expect(revoked.revokedAt).toBeInstanceOf(Date)
      expect(owned.signal!.aborted).toBe(true)
      expect(control.signal!.aborted).toBe(false)
      expect(deviceConnectionRegistry.connectionCount(ownedDevice.id)).toBe(0)
      expect(deviceConnectionRegistry.connectionCount(controlDevice.id)).toBe(1)
      expect(await promiseSettled(owned.cancelSettled)).toBe(false)
      expect(await promiseSettled(proxyRuns.get(ownedPath)!)).toBe(false)

      owned.releaseCancel()
      await Promise.all([owned.cancelSettled, proxyRuns.get(ownedPath)!, ownedResponse.text()])
      expect(await promiseSettled(control.cancelSettled)).toBe(false)
      expect(await promiseSettled(proxyRuns.get(controlPath)!)).toBe(false)

      const reconnect = await streamApp.request(`/api/agents/${ownedAgent.id}/stream`, {
        headers: authHeaders(ownedDevice.token),
      })
      expect(reconnect.status).toBe(401)

      let admittedControlPath: string | undefined
      const admissionApp = createStreamApp(async (_stream, options) => {
        admittedControlPath = options.workerPath
        expect(options.signal?.aborted).toBe(false)
      })
      const controlReconnect = await admissionApp.request(`/api/agents/${controlAgent.id}/stream`, {
        headers: authHeaders(controlDevice.token),
      })
      expect(controlReconnect.status).toBe(200)
      await controlReconnect.text()
      expect(admittedControlPath).toBe(controlPath)
    } finally {
      await Promise.all([revokeDeviceToken(admin.id, ownedDevice.id), revokeDeviceToken(admin.id, controlDevice.id)])
      owned.releaseCancel()
      control.releaseCancel()
      await Promise.allSettled([
        owned.cancelSettled,
        control.cancelSettled,
        proxyRuns.get(ownedPath),
        proxyRuns.get(controlPath),
        ownedResponse?.text(),
        controlResponse?.text(),
      ])
    }
  })
})

// ── Helper ───────────────────────────────────────────────────────────────────

/** Create a squad and return its id; cleanup is caller's responsibility. */
async function makeSquad(prefix: string): Promise<string> {
  const squad = await Squad.create({ name: `${prefix}-squad`, purpose: 'test' })
  return squad.id
}

// ── Denial helpers ───────────────────────────────────────────────────────────

/** An unprivileged user (no role assignments) */
async function makeUnprivileged(): Promise<TestUser> {
  return createTestUser({ prefix: rbacPrefix })
}

// ── Per-agent extra permission scopes ────────────────────────────────────────

describe('agent scopes endpoints', () => {
  let squadId: string
  let agent: Agent

  beforeEach(async () => {
    squadId = await makeSquad(`${rbacPrefix}-scopes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    agent = await Agent.create({ agentTypeId: 'worker', squadId })
  })

  afterEach(async () => {
    await db.delete(agentExtraScopes).where(eq(agentExtraScopes.agentId, agent.id))
    await db.delete(agents).where(eq(agents.id, agent.id))
    await db.delete(squads).where(eq(squads.id, squadId))
  })

  it('allows an admin to grant and list extra scopes and invalidates access cache', async () => {
    const invalidateSpy = spyOn(wsManager, 'invalidateAccessCache')

    try {
      const grant = await app.request(`/api/agents/${agent.id}/scopes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ permission: 'sandbox:logs' }),
      })
      expect(grant.status).toBe(201)
      const granted = await grant.json()
      expect(granted.permission).toBe('sandbox:logs')
      expect(granted.agentId).toBe(agent.id)

      const list = await app.request(`/api/agents/${agent.id}/scopes`, {
        headers: authHeaders(admin.token),
      })
      expect(list.status).toBe(200)
      const body = await list.json()
      expect(body.scopes).toHaveLength(1)
      expect(body.scopes[0].permission).toBe('sandbox:logs')
      expect(invalidateSpy).toHaveBeenCalledTimes(1)
    } finally {
      invalidateSpy.mockRestore()
    }
  })

  it('denies operators without agents:scopes:manage', async () => {
    const operator = await createTestUser({ prefix: rbacPrefix })
    const role = await createTestRole({
      prefix: rbacPrefix,
      permissions: ['agents:read', 'agents:write', 'agents:update', 'agents:terminate'],
    })
    await assignRole({ userId: operator.id, roleId: role.id, scope: 'system' })

    const res = await app.request(`/api/agents/${agent.id}/scopes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(operator.token) },
      body: JSON.stringify({ permission: 'sandbox:logs' }),
    })

    expect(res.status).toBe(403)
  })

  it('prevents granting permissions the caller does not hold', async () => {
    const limited = await createTestUser({ prefix: rbacPrefix })
    const role = await createTestRole({ prefix: rbacPrefix, permissions: ['agents:scopes:manage'] })
    await assignRole({ userId: limited.id, roleId: role.id, scope: 'system' })

    const res = await app.request(`/api/agents/${agent.id}/scopes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(limited.token) },
      body: JSON.stringify({ permission: 'sandbox:logs' }),
    })

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toContain('Cannot grant a permission you do not hold')
  })

  it('rejects non-grantable wildcard permission', async () => {
    const res = await app.request(`/api/agents/${agent.id}/scopes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ permission: '*' }),
    })

    expect(res.status).toBe(400)
  })

  it('returns conflict when granting a duplicate scope', async () => {
    await db.insert(agentExtraScopes).values({ agentId: agent.id, permission: 'sandbox:logs' })

    const res = await app.request(`/api/agents/${agent.id}/scopes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ permission: 'sandbox:logs' }),
    })

    expect(res.status).toBe(409)
  })

  it('returns not found when deleting a missing scope', async () => {
    const res = await app.request(`/api/agents/${agent.id}/scopes/${encodeURIComponent('sandbox:logs')}`, {
      method: 'DELETE',
      headers: authHeaders(admin.token),
    })

    expect(res.status).toBe(404)
  })

  it('revokes an existing scope and invalidates access cache', async () => {
    await db.insert(agentExtraScopes).values({ agentId: agent.id, permission: 'sandbox:logs' })
    const invalidateSpy = spyOn(wsManager, 'invalidateAccessCache')

    try {
      const res = await app.request(`/api/agents/${agent.id}/scopes/${encodeURIComponent('sandbox:logs')}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true })
      expect(invalidateSpy).toHaveBeenCalledTimes(1)
    } finally {
      invalidateSpy.mockRestore()
    }
  })

  it('rejects grants on system-manager agents', async () => {
    const systemManager = await Agent.create({ agentTypeId: 'system-manager', ownerUserId: admin.id })

    try {
      const res = await app.request(`/api/agents/${systemManager.id}/scopes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ permission: 'sandbox:logs' }),
      })

      expect(res.status).toBe(400)
    } finally {
      await db.delete(agents).where(eq(agents.id, systemManager.id))
    }
  })
})

// ── Owner access for squad-less system-manager agents ────────────────────────

describe('squad-less system-manager owner access', () => {
  let agent: Agent

  beforeEach(async () => {
    agent = await Agent.create({
      agentTypeId: 'system-manager',
      context: { ownerUserId: admin.id },
    })
  })

  afterEach(async () => {
    if (!agent) return
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db.delete(messagesTable).where(eq(messagesTable.agentId, agent.id))
    await db.delete(agents).where(eq(agents.id, agent.id))
  })

  it('allows the owning user to read a squad-less system-manager agent without a system grant', async () => {
    const res = await app.request(`/api/agents/${agent.id}`, {
      headers: authHeaders(admin.token),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(agent.id)
  })

  it('denies a different unprivileged user from reading a squad-less system-manager agent', async () => {
    const other = await makeUnprivileged()

    const res = await app.request(`/api/agents/${agent.id}`, {
      headers: authHeaders(other.token),
    })

    expect(res.status).toBe(403)
  })
})

// ── POST /api/agents/:id/message target validation ───────────────────────────

describe('POST /api/agents/:id/message target validation', () => {
  let squadId: string

  beforeAll(async () => {
    squadId = await makeSquad(`${rbacPrefix}-msg-target`)
  })

  afterAll(async () => {
    await db.delete(squads).where(eq(squads.id, squadId))
  })

  it('rejects artifact builder agents not in waiting-input', async () => {
    const existingType = await AgentType.find(ARTIFACT_BUILDER_AGENT_TYPE_ID)
    if (!existingType) {
      await AgentType.create({
        id: ARTIFACT_BUILDER_AGENT_TYPE_ID,
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Artifact Builder',
        systemPrompt: 'Test',
      })
    }
    // Give the artifact builder a squad so it passes the entity guard
    const agent = await Agent.create({ agentTypeId: ARTIFACT_BUILDER_AGENT_TYPE_ID, persist: true, squadId })

    try {
      const res = await app.request(`/api/agents/${agent.id}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ content: 'Change the artifact' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('request_artifact')
    } finally {
      await db.delete(executions).where(eq(executions.agentId, agent.id))
      await db.delete(agents).where(eq(agents.id, agent.id))
      if (!existingType) await db.delete(agentTypes).where(eq(agentTypes.id, ARTIFACT_BUILDER_AGENT_TYPE_ID))
    }
  })

  it('returns a conflict without accepting messages for terminating or terminated agents', async () => {
    const agent = await Agent.create({ agentTypeId: 'consultant', persist: false, squadId })
    const clientIds = [crypto.randomUUID(), crypto.randomUUID()]
    await db.update(agents).set({ pendingDormancyAt: new Date() }).where(eq(agents.id, agent.id))

    try {
      for (const [index, clientId] of clientIds.entries()) {
        if (index === 1) {
          await db
            .update(agents)
            .set({ status: 'terminated', pendingDormancyAt: null, terminatedAt: new Date() })
            .where(eq(agents.id, agent.id))
        }
        const response = await app.request(`/api/agents/${agent.id}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
          body: JSON.stringify({ content: 'must not be accepted', clientId }),
        })
        expect(response.status).toBe(409)
        const body = await response.json()
        expect(body.code).toBe(index === 0 ? 'AGENT_TARGET_UNAVAILABLE' : 'AGENT_TERMINATED')
        expect(body.error).toContain(index === 0 ? 'terminating or unavailable' : 'terminated and cannot be woken')
      }
      expect(
        await db.select().from(chatSendReceipts).where(inArray(chatSendReceipts.clientId, clientIds))
      ).toHaveLength(0)
      expect(await db.select().from(messagesTable).where(eq(messagesTable.agentId, agent.id))).toHaveLength(0)
      expect(await db.select().from(executions).where(eq(executions.agentId, agent.id))).toHaveLength(0)
    } finally {
      await db.delete(chatSendReceipts).where(inArray(chatSendReceipts.clientId, clientIds))
      await db.delete(executions).where(eq(executions.agentId, agent.id))
      await db.delete(messagesTable).where(eq(messagesTable.agentId, agent.id))
      await db.delete(agents).where(eq(agents.id, agent.id))
    }
  })

  it('accepts an image-only message and rejects a blank message without images', async () => {
    const agent = await Agent.create({ agentTypeId: 'consultant', persist: false, squadId })
    const [image] = await Image.createMany(
      [{ type: 'image', data: Buffer.from('image').toString('base64'), mimeType: 'image/png' }],
      { squadId, uploadedByUserId: admin.id }
    )

    try {
      const imageOnly = await app.request(`/api/agents/${agent.id}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ content: '', imageIds: [image.id], clientId: crypto.randomUUID() }),
      })
      expect(imageOnly.status).toBe(200)
      expect((await Image.find(image.id))?.agentId).toBe(agent.id)

      const blank = await app.request(`/api/agents/${agent.id}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ content: '', imageIds: [] }),
      })
      expect(blank.status).toBe(400)
    } finally {
      await Image.deleteMany([image.id])
      await db.delete(chatSendReceipts).where(eq(chatSendReceipts.agentId, agent.id))
      await db.delete(messagesTable).where(eq(messagesTable.agentId, agent.id))
      await db.delete(executions).where(eq(executions.agentId, agent.id))
      await db.delete(agents).where(eq(agents.id, agent.id))
    }
  })

  it('stamps authenticated sender provenance and ignores client identity fields', async () => {
    const agent = await Agent.create({ agentTypeId: 'consultant', persist: false, squadId })
    try {
      const response = await app.request(`/api/agents/${agent.id}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({
          content: 'authenticated turn',
          sender: { userId: crypto.randomUUID(), name: 'forged' },
          executionId: crypto.randomUUID(),
        }),
      })
      expect(response.status).toBe(200)

      const [row] = await db
        .select()
        .from(messagesTable)
        .where(and(eq(messagesTable.agentId, agent.id), eq(messagesTable.content, 'authenticated turn')))
      const metadata = row.metadata as Record<string, unknown>
      expect(metadata.source).toBe('user_chat')
      expect(metadata.sender).toMatchObject({ userId: admin.id })
      expect(metadata.executionId).not.toBeUndefined()
    } finally {
      await db.delete(messagesTable).where(eq(messagesTable.agentId, agent.id))
      await db.delete(executions).where(eq(executions.agentId, agent.id))
      await db.delete(agents).where(eq(agents.id, agent.id))
    }
  })

  it('returns an accepted image replay after the selected model becomes non-vision', async () => {
    const agent = await Agent.create({ agentTypeId: 'consultant', persist: false, squadId })
    const [image] = await Image.createMany(
      [{ type: 'image', data: Buffer.from('image').toString('base64'), mimeType: 'image/png' }],
      { squadId, uploadedByUserId: admin.id }
    )
    await agent.queueExecution({ message: 'initial turn' })
    const clientId = crypto.randomUUID()
    const request = () =>
      app.request(`/api/agents/${agent.id}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ content: 'accepted image', imageIds: [image.id], clientId }),
      })

    try {
      const accepted = await request()
      expect(accepted.status).toBe(200)
      const beforeMessages = await db.select().from(messagesTable).where(eq(messagesTable.agentId, agent.id))
      const beforeExecutions = await db.select().from(executions).where(eq(executions.agentId, agent.id))
      const [receipt] = await db
        .select()
        .from(chatSendReceipts)
        .where(and(eq(chatSendReceipts.agentId, agent.id), eq(chatSendReceipts.clientId, clientId)))
      expect(receipt?.disposition).toBe('intervention')
      expect(receipt?.requestHash).toBe(
        createHash('sha256')
          .update(
            JSON.stringify({
              v: 3,
              agentId: agent.id,
              clientId,
              content: 'accepted image',
              imageIds: [image.id],
              deliveryMode: 'steer',
            })
          )
          .digest('hex')
      )
      const legacyHash = createHash('sha256')
        .update(
          JSON.stringify({
            v: 2,
            agentId: agent.id,
            content: 'accepted image',
            imageIds: [image.id],
            deliveryMode: 'steer',
          })
        )
        .digest('hex')
      await db
        .update(chatSendReceipts)
        .set({ requestHash: legacyHash })
        .where(and(eq(chatSendReceipts.agentId, agent.id), eq(chatSendReceipts.clientId, clientId)))

      await agent.update({ modelOverride: 'zai:glm-5.2' })
      const replay = await request()
      expect(replay.status).toBe(200)
      expect(await db.select().from(messagesTable).where(eq(messagesTable.agentId, agent.id))).toHaveLength(
        beforeMessages.length
      )
      expect(await db.select().from(executions).where(eq(executions.agentId, agent.id))).toHaveLength(
        beforeExecutions.length
      )
      expect((await Image.find(image.id))?.agentId).toBe(agent.id)
    } finally {
      await Image.deleteMany([image.id])
      await db.delete(chatSendReceipts).where(eq(chatSendReceipts.agentId, agent.id))
      await db.delete(messagesTable).where(eq(messagesTable.agentId, agent.id))
      await db.delete(executions).where(eq(executions.agentId, agent.id))
      await db.delete(agents).where(eq(agents.id, agent.id))
    }
  })

  it('returns 401 without auth token', async () => {
    const existingType = await AgentType.find(ARTIFACT_BUILDER_AGENT_TYPE_ID)
    if (!existingType) {
      await AgentType.create({
        id: ARTIFACT_BUILDER_AGENT_TYPE_ID,
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Artifact Builder',
        systemPrompt: 'Test',
      })
    }
    const agent = await Agent.create({ agentTypeId: ARTIFACT_BUILDER_AGENT_TYPE_ID, persist: true, squadId })
    try {
      const res = await app.request(`/api/agents/${agent.id}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'no auth' }),
      })
      expect(res.status).toBe(401)
    } finally {
      await db.delete(executions).where(eq(executions.agentId, agent.id))
      await db.delete(agents).where(eq(agents.id, agent.id))
      if (!existingType) await db.delete(agentTypes).where(eq(agentTypes.id, ARTIFACT_BUILDER_AGENT_TYPE_ID))
    }
  })
})

// ── Deprecated POST /api/agents/:id/steer and /follow-up ─────────────────────

describe('deprecated inline message routes', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let testAgent: Agent
  let squadId: string

  beforeEach(async () => {
    testPrefix = `inline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`
    squadId = await makeSquad(testPrefix)

    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Inline Test Agent',
      systemPrompt: 'Test',
    })

    testAgent = await Agent.create({ agentTypeId: testAgentTypeId, squadId })
  })

  afterEach(async () => {
    await db.delete(chatSendReceipts).where(eq(chatSendReceipts.agentId, testAgent.id))
    await db.delete(messagesTable).where(eq(messagesTable.agentId, testAgent.id))
    await db.delete(executions).where(eq(executions.agentId, testAgent.id))
    await db.delete(agents).where(eq(agents.id, testAgent.id))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
    await db.delete(squads).where(eq(squads.id, squadId))
  })

  it('queues a steer intent on a non-running agent without returning 400', async () => {
    const res = await app.request(`/api/agents/${testAgent.id}/steer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ message: 'please adjust', imageIds: [] }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, status: 'queued', queued: false })

    const pendingRows = await db
      .select()
      .from(messagesTable)
      .where(and(eq(messagesTable.agentId, testAgent.id), eq(messagesTable.role, 'human')))
    expect(pendingRows.map((m) => m.content)).toEqual(['please adjust'])
    expect(pendingRows[0].metadata).toMatchObject({
      source: 'user_chat',
      sender: { userId: admin.id },
    })
  })

  it('derives queued from acceptance receipts across first-send replay, history, and intervention consumption', async () => {
    const send = async (content: string, clientId: string) => {
      const response = await app.request(`/api/agents/${testAgent.id}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ content, clientId, deliveryMode: 'follow-up' }),
      })
      expect(response.status).toBe(200)
      return response.json()
    }
    expect(await send('first prompt', 'first-client')).toMatchObject({ queued: false, status: 'queued' })
    const execution = (await testAgent.getActiveExecution())!
    await execution.start()
    // Idempotent replay of the first send remains unqueued even though execution is now running.
    expect(await send('first prompt', 'first-client')).toMatchObject({ queued: false, status: 'running' })
    expect(await send('follow up', 'next-client')).toMatchObject({ queued: true, status: 'running' })
    const rows = await db.select().from(messagesTable).where(eq(messagesTable.agentId, testAgent.id))
    const first = rows.find((row) => row.content === 'first prompt')!
    const intervention = rows.find((row) => row.content === 'follow up')!
    expect(first.pending).toBe(true)
    expect(first.metadata).not.toHaveProperty('queued')
    const history = await (
      await app.request(`/api/agents/${testAgent.id}/messages`, { headers: authHeaders(admin.token) })
    ).json()
    expect(history.messages.find((row: { id: string }) => row.id === first.id)).toMatchObject({
      queued: false,
      pending: true,
    })
    expect(history.messages.find((row: { id: string }) => row.id === intervention.id)).toMatchObject({
      queued: true,
      pending: true,
    })
    const detail = await (
      await app.request(`/api/agents/${testAgent.id}/messages/${first.id}`, { headers: authHeaders(admin.token) })
    ).json()
    expect(detail).toMatchObject({ queued: false, pending: true })
    await testAgent.confirmPendingMessage(intervention.id)
    const consumed = await (
      await app.request(`/api/agents/${testAgent.id}/messages/${intervention.id}`, {
        headers: authHeaders(admin.token),
      })
    ).json()
    expect(consumed).toMatchObject({ queued: false, pending: false })
    expect(await send('follow up', 'next-client')).toMatchObject({ queued: false })
  })

  it('returns sendMessage status for a follow-up intent on a running agent', async () => {
    const execution = await testAgent.queueExecution({ message: 'initial' })
    await execution.start()

    const res = await app.request(`/api/agents/${testAgent.id}/follow-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ message: 'after that', imageIds: [] }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, status: 'running', queued: true })

    const pendingRows = await db
      .select()
      .from(messagesTable)
      .where(and(eq(messagesTable.agentId, testAgent.id), eq(messagesTable.content, 'after that')))
    expect(pendingRows).toHaveLength(1)
    expect(pendingRows[0].pending).toBe(true)
    expect((pendingRows[0].metadata as { deliveryMode?: string } | null)?.deliveryMode).toBe('follow-up')
    expect(pendingRows[0].metadata).toMatchObject({
      source: 'user_chat',
      sender: { userId: admin.id },
    })
  })
})

// ── Image input model capability validation ─────────────────────────────────

describe('agent image input model capability validation', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let squadId: string

  beforeEach(async () => {
    testPrefix = `image-gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`
    squadId = await makeSquad(testPrefix)
    await AgentType.create({
      id: testAgentTypeId,
      model: 'zai:glm-5.2',
      name: 'Text-only Agent',
      systemPrompt: 'Test',
    })
  })

  afterEach(async () => {
    const createdAgents = await db.select({ id: agents.id }).from(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    for (const createdAgent of createdAgents) {
      await db.delete(executions).where(eq(executions.agentId, createdAgent.id))
      await db.delete(messagesTable).where(eq(messagesTable.agentId, createdAgent.id))
    }
    await db.delete(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
    await db.delete(squads).where(eq(squads.id, squadId))
  })

  it('GET /api/agents/:id exposes that the selected/effective model does not support images', async () => {
    const agent = await Agent.create({ agentTypeId: testAgentTypeId, persist: true, squadId })

    const res = await app.request(`/api/agents/${agent.id}`, { headers: authHeaders(admin.token) })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.selectedModelSupportsImages).toBe(false)
  })

  it('POST /api/agents/:id/message rejects image IDs for a non-vision selected/effective model', async () => {
    const agent = await Agent.create({ agentTypeId: testAgentTypeId, persist: true, squadId })

    const res = await app.request(`/api/agents/${agent.id}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ content: 'look', imageIds: ['00000000-0000-0000-0000-000000000201'] }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('This model does not support image input. Use a vision-capable model.')
    const persisted = await agent.listMessages()
    expect(persisted.messages).toHaveLength(0)
  })

  it('uses the actually selected model capability instead of a vision-capable configured fallback', async () => {
    const priorityTypeId = `${testPrefix}-priority-type`
    await AgentType.create({
      id: priorityTypeId,
      model: 'anthropic:claude-sonnet-4-5,zai:glm-5.2',
      name: 'Priority Agent',
      systemPrompt: 'Test',
    })
    const agent = await Agent.create({ agentTypeId: priorityTypeId, persist: true, squadId })
    try {
      await setAgentSelectedModel(agent.id, 'zai:glm-5.2')

      const res = await app.request(`/api/agents/${agent.id}`, { headers: authHeaders(admin.token) })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.configuredModel).toBe('anthropic:claude-sonnet-4-5,zai:glm-5.2')
      expect(body.selectedModel).toBe('zai:glm-5.2')
      expect(body.selectedModelSupportsImages).toBe(false)
    } finally {
      await db.delete(executions).where(eq(executions.agentId, agent.id))
      await db.delete(messagesTable).where(eq(messagesTable.agentId, agent.id))
      await db.delete(agents).where(eq(agents.id, agent.id))
      await db.delete(agentTypes).where(eq(agentTypes.id, priorityTypeId))
    }
  })
})

// ── PATCH /api/agents/:id modelOverride ──────────────────────────────────────

describe('PATCH /api/agents/:id modelOverride', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let squadId: string

  beforeEach(async () => {
    testPrefix = `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`
    squadId = await makeSquad(testPrefix)
    await AgentType.create({
      id: testAgentTypeId,
      // priority-list default — override composes onto this
      model: 'anthropic:claude-sonnet-4-5,zai:glm-5.2',
      name: 'Model Override Test Agent',
      systemPrompt: 'Test',
    })
  })

  afterEach(async () => {
    const createdAgents = await db.select({ id: agents.id }).from(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    for (const createdAgent of createdAgents) {
      await db.delete(executions).where(eq(executions.agentId, createdAgent.id))
      await db.delete(messagesTable).where(eq(messagesTable.agentId, createdAgent.id))
    }
    await db.delete(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
    await db.delete(squads).where(eq(squads.id, squadId))
  })

  it('sets a valid model override and reflects it in configuredModel', async () => {
    const agent = await Agent.create({ agentTypeId: testAgentTypeId, persist: true, squadId })

    const res = await app.request(`/api/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ modelOverride: 'zai:glm-5.2:high' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.modelOverride).toBe('zai:glm-5.2:high')
    // override replaces the agent-type default entirely
    expect(body.configuredModel).toBe('zai:glm-5.2:high')

    // persisted across reloads
    const reloaded = await Agent.find(agent.id)
    expect(reloaded?.modelOverride).toBe('zai:glm-5.2:high')
  })

  it('accepts a comma-separated priority list as the override', async () => {
    const agent = await Agent.create({ agentTypeId: testAgentTypeId, persist: true, squadId })

    const res = await app.request(`/api/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ modelOverride: 'zai:glm-5.2:high,anthropic:claude-sonnet-4-5' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.modelOverride).toBe('zai:glm-5.2:high,anthropic:claude-sonnet-4-5')
    expect(body.configuredModel).toBe('zai:glm-5.2:high,anthropic:claude-sonnet-4-5')
  })

  it('rejects an invalid model override with 400 and does not persist it', async () => {
    const agent = await Agent.create({ agentTypeId: testAgentTypeId, persist: true, squadId })

    const res = await app.request(`/api/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ modelOverride: 'fake:not-a-real-model' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain("Unknown provider 'fake'")
    // unchanged
    const reloaded = await Agent.find(agent.id)
    expect(reloaded?.modelOverride).toBeNull()
  })

  it('clears the override when modelOverride is null and falls back to the agent-type default', async () => {
    const agent = await Agent.create({ agentTypeId: testAgentTypeId, persist: true, squadId })
    await agent.update({ modelOverride: 'zai:glm-5.2:high' })
    expect((await Agent.find(agent.id))?.modelOverride).toBe('zai:glm-5.2:high')

    const res = await app.request(`/api/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ modelOverride: null }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.modelOverride).toBeNull()
    // falls back to the agent-type default
    expect(body.configuredModel).toBe('anthropic:claude-sonnet-4-5,zai:glm-5.2')
  })

  it('omitting modelOverride leaves it untouched', async () => {
    const agent = await Agent.create({ agentTypeId: testAgentTypeId, persist: true, squadId })
    await agent.update({ modelOverride: 'zai:glm-5.2:high' })

    const res = await app.request(`/api/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ name: 'renamed-only' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.modelOverride).toBe('zai:glm-5.2:high')
  })
})

// ── POST /api/agents/:id/abort-tool ──────────────────────────────────────────

describe('POST /api/agents/:id/abort-tool', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let testAgent: Agent
  let testAgentId: string
  let squadId: string

  beforeEach(async () => {
    testPrefix = `abort-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`
    squadId = await makeSquad(testPrefix)

    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent',
      systemPrompt: 'Test',
    })

    testAgent = await Agent.create({ agentTypeId: testAgentTypeId, squadId })
    testAgentId = testAgent.id
  })

  afterEach(async () => {
    await db.delete(executions).where(eq(executions.agentId, testAgentId))
    await db.delete(agents).where(eq(agents.id, testAgentId))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
    await db.delete(squads).where(eq(squads.id, squadId))
  })

  it('returns 404 for non-existent agent', async () => {
    const res = await app.request('/api/agents/00000000-0000-0000-0000-000000000000/abort-tool', {
      method: 'POST',
      headers: authHeaders(admin.token),
    })
    // 403 from guard (null squadId for non-existent agent)
    expect([403, 404]).toContain(res.status)
  })

  it('returns 404 when no active execution', async () => {
    const res = await app.request(`/api/agents/${testAgentId}/abort-tool`, {
      method: 'POST',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('No active execution')
  })

  it('returns 400 when execution is not running (queued)', async () => {
    await testAgent.queueExecution({ message: 'test' })

    const res = await app.request(`/api/agents/${testAgentId}/abort-tool`, {
      method: 'POST',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('not running')
  })

  it('POST /api/agents/:id/pause returns 410', async () => {
    const res = await app.request(`/api/agents/${testAgent.id}/pause`, {
      method: 'POST',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(410)
  })

  it('POST /api/agents/:id/resume returns 410', async () => {
    const res = await app.request(`/api/agents/${testAgent.id}/resume`, {
      method: 'POST',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(410)
  })

  it('returns 200 and sends signal when execution is running', async () => {
    const execution = await testAgent.queueExecution({ message: 'test' })
    await execution.start()

    // Listen for the control signal
    const received: string[] = []
    const unlisten = await listen('agent_control', (payload) => {
      received.push(payload)
    })

    try {
      const res = await app.request(`/api/agents/${testAgentId}/abort-tool`, {
        method: 'POST',
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)

      // Wait for async notification delivery
      await new Promise((r) => setTimeout(r, 300))

      expect(received.length).toBe(1)
      const parsed = JSON.parse(received[0])
      expect(parsed.action).toBe('abort-tool')
      expect(parsed.agentId).toBe(testAgentId)
    } finally {
      await unlisten()
    }
  })

  it('returns 403 for unprivileged identity', async () => {
    const unprivileged = await makeUnprivileged()
    const res = await app.request(`/api/agents/${testAgentId}/abort-tool`, {
      method: 'POST',
      headers: authHeaders(unprivileged.token),
    })
    expect(res.status).toBe(403)
  })

  it('returns 403 for cross-squad identity', async () => {
    const otherSquadId = await makeSquad(`${testPrefix}-other`)
    const otherSquadUser = await createTestUser({ prefix: rbacPrefix })
    const operatorRole = await createTestRole({ permissions: ['agents:run'], prefix: rbacPrefix })
    await assignRole({ userId: otherSquadUser.id, roleId: operatorRole.id, scope: 'squad', squadId: otherSquadId })

    try {
      const res = await app.request(`/api/agents/${testAgentId}/abort-tool`, {
        method: 'POST',
        headers: authHeaders(otherSquadUser.token),
      })
      expect(res.status).toBe(403)
    } finally {
      await db.delete(squads).where(eq(squads.id, otherSquadId))
    }
  })
})

// ── POST /api/agents/:id/force-stop ──────────────────────────────────────────

describe('POST /api/agents/:id/force-stop', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let testAgent: Agent
  let squadId: string

  beforeEach(async () => {
    testPrefix = `force-stop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`
    squadId = await makeSquad(testPrefix)

    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent',
      systemPrompt: 'Test',
    })

    testAgent = await Agent.create({ agentTypeId: testAgentTypeId, squadId })
  })

  afterEach(async () => {
    await db.delete(inbox).where(eq(inbox.recipientId, testAgent.id))
    await db.delete(executions).where(eq(executions.agentId, testAgent.id))
    await db.delete(agents).where(eq(agents.id, testAgent.id))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
    await db.delete(squads).where(eq(squads.id, squadId))
  })

  it('accepts an absent optional force-stop body', async () => {
    const execution = await testAgent.queueExecution({ message: 'initial' })
    await execution.start()
    const response = await app.request(`/api/agents/${testAgent.id}/force-stop`, {
      method: 'POST',
      headers: authHeaders(admin.token),
    })
    expect(response.status).toBe(200)
  })

  it('rejects malformed optional force-stop JSON before the action', async () => {
    const execution = await testAgent.queueExecution({ message: 'initial' })
    await execution.start()
    const response = await app.request(`/api/agents/${testAgent.id}/force-stop`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: '{',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' })
    expect((await testAgent.getActiveExecution())?.id).toBe(execution.id)
  })

  it('normalizes malformed required scope-grant JSON', async () => {
    const response = await app.request(`/api/agents/${testAgent.id}/scopes`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: '{',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' })
  })

  it('rejects malformed optional compaction JSON', async () => {
    const response = await app.request(`/api/agents/${testAgent.id}/compact`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: '{',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' })
  })

  it('does not retry inbox delivery when force-stopping an execution', async () => {
    const execution = await testAgent.queueExecution({ message: 'initial' })
    await execution.start()

    const [message] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: testAgent.id,
        senderType: 'system',
        senderId: null,
        subject: 'Preserve me',
        content: 'This should stay undelivered after force-stop',
        deliveryMode: 'follow-up',
      })
      .returning()

    const res = await app.request(`/api/agents/${testAgent.id}/force-stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ reason: 'test force-stop' }),
    })

    expect(res.status).toBe(200)

    await new Promise((resolve) => setTimeout(resolve, 50))

    const [updated] = await db.select().from(inbox).where(eq(inbox.id, message.id))
    expect(updated.deliveredAt).toBeNull()

    const active = await testAgent.getActiveExecution()
    expect(active).toBeNull()
  })
})

// ── Agent.getSandboxId ────────────────────────────────────────────────────────

describe('Agent.getSandboxId', () => {
  let testPrefix: string
  let testAgentTypeId: string

  beforeEach(async () => {
    testPrefix = `sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`

    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent',
      systemPrompt: 'Test',
    })
  })

  afterEach(async () => {
    await db.delete(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
  })

  it('returns agent_<id> for non-squad agents', async () => {
    const agent = await Agent.create({ agentTypeId: testAgentTypeId })
    expect(await agent.getSandboxId()).toBe(`agent_${agent.id}`)
  })

  it('returns agent_<id> for squad agents (not squad_<id>)', async () => {
    const squad = await Squad.create({ name: `${testPrefix}-squad`, purpose: 'test' })
    const agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
    expect(await agent.getSandboxId()).toBe(`agent_${agent.id}`)
    // Clean up
    await db.delete(agents).where(eq(agents.id, agent.id))
    await db.delete(squads).where(eq(squads.id, squad.id))
  })

  it('returns agent_<id> for consultant agents (not consultant_channel_<channelId>)', async () => {
    // Ensure the shared consultant agent type exists without racing other test files.
    await AgentType.upsert({
      id: 'consultant',
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Consultant',
      systemPrompt: 'Test',
    })

    const channelId = 'test-channel-123'
    const agent = await Agent.create({
      agentTypeId: 'consultant',
      context: { channelInstance: { id: channelId } },
    })
    expect(await agent.getSandboxId()).toBe(`agent_${agent.id}`)

    // Clean up
    await db.delete(agents).where(eq(agents.id, agent.id))
    // Don't delete consultant type — it may be shared
  })

  it('returns agent_<id> for consultant agents without channelInstance', async () => {
    const agent = await Agent.create({
      agentTypeId: 'consultant',
      context: {},
    })
    expect(await agent.getSandboxId()).toBe(`agent_${agent.id}`)
    await db.delete(agents).where(eq(agents.id, agent.id))
  })
})

// ── GET /api/agents/:id/sandbox/status ───────────────────────────────────────

describe('GET /api/agents/:id/sandbox/status', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let testAgent: Agent
  let squadId: string

  beforeEach(async () => {
    testPrefix = `sbstatus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`
    squadId = await makeSquad(testPrefix)

    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent',
      systemPrompt: 'Test',
    })

    testAgent = await Agent.create({ agentTypeId: testAgentTypeId, squadId })
  })

  afterEach(async () => {
    await db.delete(agents).where(eq(agents.id, testAgent.id))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
    await db.delete(squads).where(eq(squads.id, squadId))
  })

  it('returns 404 for non-existent agent (admin passes system-scope check, handler returns 404)', async () => {
    const res = await app.request('/api/agents/00000000-0000-0000-0000-000000000000/sandbox/status', {
      headers: authHeaders(admin.token),
    })
    // With the null-squad fix, a non-existent agent (null squadId) passes system-scope check for admins,
    // and the handler then returns 404 (agent not found). Unprivileged callers still get 403.
    expect(res.status).toBe(404)
  })

  it('returns sandbox status for existing squad agent', async () => {
    const res = await app.request(`/api/agents/${testAgent.id}/sandbox/status`, {
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    // In Docker mode (test env), sandbox is not_found since no sandbox is running
    expect(body.status).toBe('not_found')
  })

  it('adds provisioning diagnostics for K8s agent status', async () => {
    const remoteSpy = spyOn(sandboxFactory, 'isRemoteSandboxRuntime').mockReturnValue(true)
    const k8sSpy = spyOn(sandboxFactory, 'isK8sRuntime').mockReturnValue(true)
    const vmSpy = spyOn(sandboxFactory, 'isVmRuntime').mockReturnValue(false)
    const managerSpy = spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue({
      getSandboxStatus: async () => ({ status: 'pending' }),
      getProvisionDiagnostics: async () => ({ state: 'open', retryAfterMs: 5000, inFlight: 4, localWaiters: 2 }),
    } as any)
    try {
      const body = await (
        await app.request(`/api/agents/${testAgent.id}/sandbox/status`, { headers: authHeaders(admin.token) })
      ).json()
      expect(body.runtime).toBe('k8s')
      expect(body.provisioning).toMatchObject({ state: 'open', inFlight: 4, localWaiters: 2 })
    } finally {
      remoteSpy.mockRestore()
      k8sSpy.mockRestore()
      vmSpy.mockRestore()
      managerSpy.mockRestore()
    }
  })

  it('returns 401 without auth', async () => {
    const res = await app.request(`/api/agents/${testAgent.id}/sandbox/status`)
    expect(res.status).toBe(401)
  })

  it('returns 403 for unprivileged identity', async () => {
    const unprivileged = await makeUnprivileged()
    const res = await app.request(`/api/agents/${testAgent.id}/sandbox/status`, {
      headers: authHeaders(unprivileged.token),
    })
    expect(res.status).toBe(403)
  })
})

// ── Agent sandbox controllable flag + stop/restart ───────────────────────────

describe('agent sandbox stop/restart', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let squadId: string
  let squadAgent: Agent
  let soloAgent: Agent
  let parentAgent: Agent
  let subAgent: Agent

  beforeEach(async () => {
    testPrefix = `sbctl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`
    squadId = await makeSquad(testPrefix)
    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent',
      systemPrompt: 'Test',
    })
    // On the per-agent-workspace stack every non-subagent owns its box; only a
    // subagent inherits its parent's box, so it is not individually controllable.
    soloAgent = await Agent.create({ agentTypeId: testAgentTypeId })
    squadAgent = await Agent.create({ agentTypeId: testAgentTypeId, squadId })
    parentAgent = await Agent.create({ agentTypeId: testAgentTypeId })
    subAgent = await Agent.create({ agentTypeId: testAgentTypeId, parentAgentId: parentAgent.id })
  })

  afterEach(async () => {
    for (const a of [subAgent, parentAgent, squadAgent, soloAgent]) {
      await db.delete(agents).where(eq(agents.id, a.id))
    }
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
    await db.delete(squads).where(eq(squads.id, squadId))
  })

  it('marks an own-box agent controllable and a subagent (inherited parent box) not', async () => {
    for (const owner of [soloAgent, squadAgent]) {
      const res = await app.request(`/api/agents/${owner.id}/sandbox/status`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      expect((await res.json()).controllable).toBe(true)
    }

    const sub = await app.request(`/api/agents/${subAgent.id}/sandbox/status`, {
      headers: authHeaders(admin.token),
    })
    expect(sub.status).toBe(200)
    expect((await sub.json()).controllable).toBe(false)
  })

  it("manages an own-box agent's processes and refuses one that shares its parent's box", async () => {
    const signalled: unknown[][] = []
    const client = {
      listProcesses: async () => ({ pressure: null, processes: [], containers: { available: false, reason: 'x' } }),
      signalProcess: async (pid: number, signal: string) => {
        signalled.push([pid, signal])
        return { pid, signal, command: 'sleep 60' }
      },
    }
    const managerSpy = spyOn(sandboxFactory, 'getSandboxManager').mockReturnValue({
      getOrAttachClient: async () => client,
    } as never)
    try {
      const listed = await app.request(`/api/agents/${soloAgent.id}/sandbox/processes`, {
        headers: authHeaders(admin.token),
      })
      expect(listed.status).toBe(200)
      expect((await listed.json()).processes).toEqual([])
      const sent = await app.request(`/api/agents/${soloAgent.id}/sandbox/processes/4242/signal`, {
        method: 'POST',
        headers: authHeaders(admin.token),
      })
      expect(sent.status).toBe(200)
      expect(signalled).toEqual([[4242, 'TERM']])

      const shared = await app.request(`/api/agents/${subAgent.id}/sandbox/processes`, {
        headers: authHeaders(admin.token),
      })
      expect(shared.status).toBe(403)
      expect((await shared.json()).error).toContain('manage its processes through the squad')
    } finally {
      managerSpy.mockRestore()
    }
  })

  it('stops a solo agent sandbox', async () => {
    const res = await app.request(`/api/agents/${soloAgent.id}/sandbox/stop`, {
      method: 'POST',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('stops a squad agent sandbox (it owns its own box on the stack)', async () => {
    const res = await app.request(`/api/agents/${squadAgent.id}/sandbox/stop`, {
      method: 'POST',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('refuses to stop a subagent (inherited parent box)', async () => {
    const res = await app.request(`/api/agents/${subAgent.id}/sandbox/stop`, {
      method: 'POST',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(403)
  })

  it('refuses to restart a subagent (inherited parent box)', async () => {
    const res = await app.request(`/api/agents/${subAgent.id}/sandbox/restart`, {
      method: 'POST',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(403)
  })

  it('restart re-provisions a squad agent WITH its squad context (not solo)', async () => {
    // Regression: the restart route used to call ensureWorkspaceSandbox({ sandboxId })
    // with no squadId, so a squad member's box came back SOLO — missing the
    // /workspace/<squadId> and /memory/<squadId> mounts. It must go through
    // ensureAgentSandbox(agent), the single source of truth that applies the same
    // squad-vs-solo mounts + skills the runners use.
    const spy = spyOn(agentWarmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
    try {
      const res = await app.request(`/api/agents/${squadAgent.id}/sandbox/restart`, {
        method: 'POST',
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      expect(spy).toHaveBeenCalledTimes(1)
      // The agent passed through carries the squadId, so squad mounts are provisioned.
      const passedAgent = spy.mock.calls[0][0] as Agent
      expect(passedAgent.id).toBe(squadAgent.id)
      expect(passedAgent.squadId).toBe(squadId)
    } finally {
      spy.mockRestore()
    }
  })

  it('returns 404 when stopping a non-existent agent', async () => {
    const res = await app.request('/api/agents/00000000-0000-0000-0000-000000000000/sandbox/stop', {
      method: 'POST',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(404)
  })

  it('returns 403 for an unprivileged stop', async () => {
    const unprivileged = await makeUnprivileged()
    const res = await app.request(`/api/agents/${soloAgent.id}/sandbox/stop`, {
      method: 'POST',
      headers: authHeaders(unprivileged.token),
    })
    expect(res.status).toBe(403)
  })

  // On the host runtime the agent has no box: stop/restart would only forget an
  // in-memory record, so reject before touching the manager.
  describe('host runtime', () => {
    let prevRuntime: string | undefined

    beforeEach(() => {
      prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
      process.env.FICUS_SANDBOX_RUNTIME = 'host'
    })

    afterEach(() => {
      if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
    })

    const post = (path: string) =>
      app.request(`/api/agents/${soloAgent.id}/sandbox/${path}`, {
        method: 'POST',
        headers: authHeaders(admin.token),
      })

    it.each(['stop', 'restart'])('rejects POST /sandbox/%s with 400 and an explanation', async (action) => {
      const res = await post(action)
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe(
        'Not applicable on the host runtime: agents run directly on this machine and there is no sandbox to start or stop.'
      )
    })

    // An unknown id is an unknown id on every runtime — answering "not
    // applicable on host" for an agent that does not exist hides the real
    // mistake, so the guard runs BELOW the entity lookup.
    it.each(['stop', 'restart'])('still 404s an unknown agent on POST /sandbox/%s', async (action) => {
      const res = await app.request(`/api/agents/00000000-0000-0000-0000-000000000000/sandbox/${action}`, {
        method: 'POST',
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(404)
    })

    // There is no devbox on host, so a squad's declared toolchain must not
    // decorate the payload with the status of a thing that cannot exist.
    it('GET /sandbox/status carries no toolchain decoration even when the squad declares one', async () => {
      await Squad.update(squadId, { metadata: { sandbox: { toolchain: { packages: ['jq@latest'] } } } })
      try {
        const res = await app.request(`/api/agents/${squadAgent.id}/sandbox/status`, {
          headers: authHeaders(admin.token),
        })
        const body = await res.json()
        expect(body.runtime).toBe('host')
        expect(body).not.toHaveProperty('toolchain')

        process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
        const docker = await (
          await app.request(`/api/agents/${squadAgent.id}/sandbox/status`, { headers: authHeaders(admin.token) })
        ).json()
        expect(docker).toHaveProperty('toolchain')
      } finally {
        await Squad.update(squadId, { metadata: { sandbox: { toolchain: null } } })
      }
    })

    it('leaves the docker runtime behaviour unchanged', async () => {
      process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
      expect((await post('stop')).status).toBe(200)
    })
  })
})

// ── POST /api/agents/:id/stop on queued execution ────────────────────────────

describe('POST /api/agents/:id/stop on queued execution', () => {
  let testAgentTypeId: string
  let testAgent: Agent
  let testAgentId: string
  let squadId: string

  beforeEach(async () => {
    testAgentTypeId = `queued-stop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    squadId = await makeSquad(testAgentTypeId)
    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent',
      systemPrompt: 'Test',
    })
    testAgent = await Agent.create({ agentTypeId: testAgentTypeId, squadId })
    testAgentId = testAgent.id
  })

  afterEach(async () => {
    await db.delete(executions).where(eq(executions.agentId, testAgentId))
    await db.delete(agents).where(eq(agents.id, testAgentId))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
    await db.delete(squads).where(eq(squads.id, squadId))
  })

  it('stops a queued execution without losing pending messages', async () => {
    const exec = await testAgent.queueExecution({ message: 'queued one' })
    await testAgent.recordMessage({
      role: 'human',
      content: 'pending follow-up',
      metadata: { deliveryMode: 'follow-up' },
      pending: true,
    })

    const res = await app.request(`/api/agents/${testAgentId}/stop`, {
      method: 'POST',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(200)

    const reloaded = await Execution.find(exec.id)
    expect(reloaded?.status).toBe('stopped')

    const pendingRows = await db
      .select()
      .from(messagesTable)
      .where(
        and(eq(messagesTable.agentId, testAgentId), eq(messagesTable.role, 'human'), eq(messagesTable.pending, true))
      )
    expect(pendingRows.length).toBe(2)
  })

  it('returns 403 for cross-squad identity on stop', async () => {
    const otherSquadId = await makeSquad(`${testAgentTypeId}-other`)
    const otherUser = await createTestUser({ prefix: rbacPrefix })
    const operatorRole = await createTestRole({ permissions: ['agents:run'], prefix: rbacPrefix })
    await assignRole({ userId: otherUser.id, roleId: operatorRole.id, scope: 'squad', squadId: otherSquadId })

    try {
      const res = await app.request(`/api/agents/${testAgentId}/stop`, {
        method: 'POST',
        headers: authHeaders(otherUser.token),
      })
      expect(res.status).toBe(403)
    } finally {
      await db.delete(squads).where(eq(squads.id, otherSquadId))
    }
  })
})

// ── GET / filtered list ───────────────────────────────────────────────────────

describe('GET /api/agents (filtered list)', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let squadId: string
  let squadAgent: Agent
  let squadlessAgent: Agent

  beforeEach(async () => {
    testPrefix = `list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`
    squadId = await makeSquad(testPrefix)

    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent',
      systemPrompt: 'Test',
    })

    squadAgent = await Agent.create({ agentTypeId: testAgentTypeId, squadId })
    squadlessAgent = await Agent.create({ agentTypeId: testAgentTypeId })
  })

  afterEach(async () => {
    await db.delete(agents).where(eq(agents.id, squadAgent.id))
    await db.delete(agents).where(eq(agents.id, squadlessAgent.id))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
    await db.delete(squads).where(eq(squads.id, squadId))
  })

  it('returns 401 without auth', async () => {
    const res = await app.request('/api/agents')
    expect(res.status).toBe(401)
  })

  it('admin sees all agents (including squad-less)', async () => {
    const res = await app.request(`/api/agents?agentTypeId=${testAgentTypeId}`, {
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    const ids = body.map((a: any) => a.id)
    expect(ids).toContain(squadAgent.id)
    expect(ids).toContain(squadlessAgent.id)
  })

  it('squad-scoped operator sees only their squad agents, not squad-less', async () => {
    const squadUser = await createTestUser({ prefix: rbacPrefix })
    const readerRole = await createTestRole({ permissions: ['agents:read'], prefix: rbacPrefix })
    await assignRole({ userId: squadUser.id, roleId: readerRole.id, scope: 'squad', squadId })

    const res = await app.request(`/api/agents?agentTypeId=${testAgentTypeId}`, {
      headers: authHeaders(squadUser.token),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    const ids = body.map((a: any) => a.id)
    expect(ids).toContain(squadAgent.id)
    expect(ids).not.toContain(squadlessAgent.id)
  })
})

// ── GET /api/agents/:id for squad-less agents ─────────────────────────────────

describe('GET /api/agents/:id — squad-less agent access', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let squadlessAgent: Agent

  beforeEach(async () => {
    testPrefix = `squadless-get-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`

    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent',
      systemPrompt: 'Test',
    })

    // Squad-less agent: no squadId (null). Represents system-manager / artifact-builder style agents.
    squadlessAgent = await Agent.create({ agentTypeId: testAgentTypeId })
  })

  afterEach(async () => {
    await db.delete(agents).where(eq(agents.id, squadlessAgent.id))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
  })

  it('admin (canonical *) can read a squad-less agent → 200', async () => {
    const res = await app.request(`/api/agents/${squadlessAgent.id}`, {
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(squadlessAgent.id)
  })

  it('unprivileged identity cannot read a squad-less agent → 403', async () => {
    const unprivileged = await makeUnprivileged()
    const res = await app.request(`/api/agents/${squadlessAgent.id}`, {
      headers: authHeaders(unprivileged.token),
    })
    expect(res.status).toBe(403)
  })
})

describe('GET /api/agents subagent visibility', () => {
  it('excludes subagents by default (top-level-only)', async () => {
    const fixtureStartedAt = new Date()
    const fixtureId = crypto.randomUUID()
    const agentTypeId = `subagent-visibility-${fixtureId}`
    const neighborTypeId = `subagent-visibility-neighbor-${fixtureId}`
    let parent: Agent | undefined
    let child: Agent | undefined
    let neighbor: Agent | undefined
    let ownedSquadId: string | undefined

    const ownedRows = () =>
      db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.agentTypeId, agentTypeId),
            eq(agents.squadId, ownedSquadId!),
            gte(agents.createdAt, fixtureStartedAt)
          )
        )

    try {
      await AgentType.create({
        id: agentTypeId,
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Subagent Visibility Test',
        systemPrompt: 'Test',
      })
      await AgentType.create({
        id: neighborTypeId,
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Visibility Neighbor',
        systemPrompt: 'Test',
      })
      ownedSquadId = await makeSquad(`subagent-visibility-${fixtureId}`)
      expect(await ownedRows()).toEqual([])
      parent = await Agent.create({ agentTypeId, squadId: ownedSquadId, persist: true })
      child = await Agent.create({ agentTypeId, squadId: ownedSquadId, persist: false, parentAgentId: parent.id })
      neighbor = await Agent.create({ agentTypeId: neighborTypeId, squadId: null, persist: true })

      const [childFixture] = await db
        .select({ parentAgentId: agents.parentAgentId })
        .from(agents)
        .where(eq(agents.id, child.id))
      expect(childFixture?.parentAgentId).toBe(parent.id)

      const res = await app.request('/api/agents', { headers: authHeaders(admin.token) })
      expect(res.status).toBe(200)
      const ids = ((await res.json()) as Array<{ id: string }>).map((agent) => agent.id)
      expect(ids).toContain(parent.id)
      expect(ids).not.toContain(child.id)
      expect(ids).toContain(neighbor.id)
    } finally {
      if (child) await db.delete(agents).where(eq(agents.id, child.id))
      if (parent) await db.delete(agents).where(eq(agents.id, parent.id))
      await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
      if (ownedSquadId) await db.delete(squads).where(eq(squads.id, ownedSquadId))
      try {
        if (neighbor) {
          expect(await db.select({ id: agents.id }).from(agents).where(eq(agents.id, neighbor.id))).toHaveLength(1)
        }
      } finally {
        if (neighbor) await db.delete(agents).where(eq(agents.id, neighbor.id))
        await db.delete(agentTypes).where(eq(agentTypes.id, neighborTypeId))
      }
    }

    expect(parent).toBeDefined()
    expect(child).toBeDefined()
    expect(await ownedRows()).toEqual([])
    expect(neighbor).toBeDefined()
    expect(await db.select({ id: agents.id }).from(agents).where(eq(agents.id, parent!.id))).toEqual([])
    expect(await db.select({ id: agents.id }).from(agents).where(eq(agents.id, child!.id))).toEqual([])
    expect(await db.select({ id: agents.id }).from(agents).where(eq(agents.id, neighbor!.id))).toEqual([])
  })

  it("returns only a parent's children when parentAgentId is set", async () => {
    const agentTypeId = `subagent-children-${crypto.randomUUID()}`
    let parent: Agent | undefined
    let child: Agent | undefined

    try {
      await AgentType.create({
        id: agentTypeId,
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Subagent Children Test',
        systemPrompt: 'Test',
      })
      parent = await Agent.create({ agentTypeId, squadId: null, persist: true })
      child = await Agent.create({ agentTypeId, squadId: null, persist: false, parentAgentId: parent.id })

      const res = await app.request(`/api/agents?parentAgentId=${parent.id}`, { headers: authHeaders(admin.token) })
      expect(res.status).toBe(200)
      const ids = ((await res.json()) as Array<{ id: string }>).map((agent) => agent.id)
      expect(ids).toContain(child.id)
      expect(ids).not.toContain(parent.id)
    } finally {
      if (child) await db.delete(agents).where(eq(agents.id, child.id))
      if (parent) await db.delete(agents).where(eq(agents.id, parent.id))
      await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
    }

    expect(parent).toBeDefined()
    expect(child).toBeDefined()
    expect(await db.select({ id: agents.id }).from(agents).where(eq(agents.id, parent!.id))).toEqual([])
    expect(await db.select({ id: agents.id }).from(agents).where(eq(agents.id, child!.id))).toEqual([])
  })

  it('does not leak children when parentAgentId belongs to an inaccessible squad', async () => {
    const testPrefix = `subagent-cross-squad-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const agentTypeId = `${testPrefix}-type`
    const accessibleSquadId = await makeSquad(`${testPrefix}-allowed`)
    const inaccessibleSquadId = await makeSquad(`${testPrefix}-denied`)
    const reader = await createTestUser({ prefix: rbacPrefix })
    const readerRole = await createTestRole({ permissions: ['agents:read'], prefix: rbacPrefix })
    await assignRole({ userId: reader.id, roleId: readerRole.id, scope: 'squad', squadId: accessibleSquadId })

    await AgentType.create({
      id: agentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Subagent Cross-Squad Test',
      systemPrompt: 'Test',
    })
    const accessibleParent = await Agent.create({ agentTypeId, squadId: accessibleSquadId, persist: true })
    const accessibleChild = await Agent.create({
      agentTypeId,
      squadId: accessibleSquadId,
      persist: false,
      parentAgentId: accessibleParent.id,
    })
    const inaccessibleParent = await Agent.create({ agentTypeId, squadId: inaccessibleSquadId, persist: true })
    const inaccessibleChild = await Agent.create({
      agentTypeId,
      squadId: inaccessibleSquadId,
      persist: false,
      parentAgentId: inaccessibleParent.id,
    })

    try {
      const accessibleRes = await app.request(`/api/agents?parentAgentId=${accessibleParent.id}`, {
        headers: authHeaders(reader.token),
      })
      expect(accessibleRes.status).toBe(200)
      const accessibleIds = ((await accessibleRes.json()) as Array<{ id: string }>).map((a) => a.id)
      expect(accessibleIds).toContain(accessibleChild.id)

      const inaccessibleRes = await app.request(`/api/agents?parentAgentId=${inaccessibleParent.id}`, {
        headers: authHeaders(reader.token),
      })
      expect(inaccessibleRes.status).toBe(200)
      const inaccessibleIds = ((await inaccessibleRes.json()) as Array<{ id: string }>).map((a) => a.id)
      expect(inaccessibleIds).not.toContain(inaccessibleChild.id)
      expect(inaccessibleIds).toHaveLength(0)
    } finally {
      await db.delete(agents).where(eq(agents.id, accessibleChild.id))
      await db.delete(agents).where(eq(agents.id, inaccessibleChild.id))
      await db.delete(agents).where(eq(agents.id, accessibleParent.id))
      await db.delete(agents).where(eq(agents.id, inaccessibleParent.id))
      await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
      await db.delete(squads).where(eq(squads.id, accessibleSquadId))
      await db.delete(squads).where(eq(squads.id, inaccessibleSquadId))
    }
  })
})

// ── Machine pin setter (POST /:id/machine + PATCH machineId) ────────────────
describe('agent machine pin', () => {
  const machinePrefix = `agent-pin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  async function makeReadyMachine(suffix = ''): Promise<string> {
    const m = await insertMachine({
      name: `${machinePrefix}-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
      provider: 'ssh',
      sshHost: '10.0.0.9',
      sshUser: 'tau',
      sshKeyId: `secret-${Math.random().toString(36).slice(2, 8)}`,
      sshPublicKey: 'ssh-ed25519 AAAA test',
      status: 'ready',
    })
    return m.id
  }

  async function reloadMachineId(agentId: string): Promise<string | null> {
    const [row] = await db.select({ machineId: agents.machineId }).from(agents).where(eq(agents.id, agentId))
    return row?.machineId ?? null
  }

  let agent: Agent
  const createdMachineIds: string[] = []

  beforeEach(async () => {
    agent = await Agent.create({ agentTypeId: 'worker', ownerUserId: admin.id })
  })

  afterEach(async () => {
    await db.delete(agents).where(eq(agents.id, agent.id))
    for (const id of createdMachineIds.splice(0)) await deleteMachine(id)
  })

  it('POST /:id/machine pins the agent to a ready machine (row written)', async () => {
    const machineId = await makeReadyMachine('pin')
    createdMachineIds.push(machineId)

    const res = await app.request(`/api/agents/${agent.id}/machine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ machineId }),
    })
    expect(res.status).toBe(200)
    expect(await reloadMachineId(agent.id)).toBe(machineId)
  })

  it('POST /:id/machine with null unpins (row cleared → placement default next ensure)', async () => {
    const machineId = await makeReadyMachine('unpin')
    createdMachineIds.push(machineId)
    await agent.update({ machineId })
    expect(await reloadMachineId(agent.id)).toBe(machineId)

    const res = await app.request(`/api/agents/${agent.id}/machine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ machineId: null }),
    })
    expect(res.status).toBe(200)
    expect(await reloadMachineId(agent.id)).toBeNull()
  })

  it('POST /:id/machine rejects an absent machineId key with 400 (no silent unpin)', async () => {
    // A pinned agent; a body MISSING the machineId key must not be read as an
    // implicit unpin (which would silently migrate the box off its pinned machine).
    const machineId = await makeReadyMachine('absent-key')
    createdMachineIds.push(machineId)
    await agent.update({ machineId })
    expect(await reloadMachineId(agent.id)).toBe(machineId)

    const res = await app.request(`/api/agents/${agent.id}/machine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ notMachineId: machineId }),
    })
    expect(res.status).toBe(400)
    // The pin is untouched — no silent unpin.
    expect(await reloadMachineId(agent.id)).toBe(machineId)
  })

  it('POST /:id/machine rejects a malformed JSON body with 400 (no silent unpin)', async () => {
    const machineId = await makeReadyMachine('malformed')
    createdMachineIds.push(machineId)
    await agent.update({ machineId })
    expect(await reloadMachineId(agent.id)).toBe(machineId)

    const res = await app.request(`/api/agents/${agent.id}/machine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: '{not json',
    })
    expect(res.status).toBe(400)
    expect(await reloadMachineId(agent.id)).toBe(machineId)
  })

  it('POST /:id/machine rejects a non-existent machine with 400', async () => {
    const res = await app.request(`/api/agents/${agent.id}/machine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ machineId: '00000000-0000-0000-0000-000000000000' }),
    })
    expect(res.status).toBe(400)
    expect(await reloadMachineId(agent.id)).toBeNull()
  })

  it('POST /:id/machine rejects a not-ready machine with 400', async () => {
    const m = await insertMachine({
      name: `${machinePrefix}-notready-${Math.random().toString(36).slice(2, 8)}`,
      provider: 'ssh',
      sshHost: '10.0.0.9',
      sshUser: 'tau',
      sshKeyId: `secret-${Math.random().toString(36).slice(2, 8)}`,
      sshPublicKey: 'ssh-ed25519 AAAA test',
      status: 'bootstrapping',
    })
    createdMachineIds.push(m.id)

    const res = await app.request(`/api/agents/${agent.id}/machine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ machineId: m.id }),
    })
    expect(res.status).toBe(400)
    expect(await reloadMachineId(agent.id)).toBeNull()
  })

  it('POST /:id/machine requires machines:write (unprivileged → 403)', async () => {
    const machineId = await makeReadyMachine('rbac')
    createdMachineIds.push(machineId)
    const unprivileged = await makeUnprivileged()

    const res = await app.request(`/api/agents/${agent.id}/machine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(unprivileged.token) },
      body: JSON.stringify({ machineId }),
    })
    expect(res.status).toBe(403)
    expect(await reloadMachineId(agent.id)).toBeNull()
  })

  it('PATCH /:id writes machineId (attribute write) and rejects a bad pin with 400', async () => {
    const machineId = await makeReadyMachine('patch')
    createdMachineIds.push(machineId)

    const ok = await app.request(`/api/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ machineId }),
    })
    expect(ok.status).toBe(200)
    expect(await reloadMachineId(agent.id)).toBe(machineId)

    const bad = await app.request(`/api/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ machineId: '00000000-0000-0000-0000-000000000000' }),
    })
    expect(bad.status).toBe(400)
    // The failed validation left the prior pin intact.
    expect(await reloadMachineId(agent.id)).toBe(machineId)
  })
})

describe('GET /api/agents/:id/active admission observability', () => {
  it('reports raw duplicate active rows while returning the admission owner', async () => {
    const typeId = `active-admission-${crypto.randomUUID()}`
    await AgentType.create({
      id: typeId,
      name: 'Active admission',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'test',
    })
    const agent = await Agent.create({ agentTypeId: typeId })
    try {
      const [older, owner] = await db
        .insert(executions)
        .values([
          { agentId: agent.id, status: 'running', startedAt: new Date(Date.now() - 1_000) },
          { agentId: agent.id, status: 'running', startedAt: new Date() },
        ])
        .returning()
      await db
        .insert(executionAdmissionReservations)
        .values({ executionId: owner.id, agentId: agent.id, state: 'queued' })

      const response = await app.request(`/api/agents/${agent.id}/active`, { headers: authHeaders(admin.token) })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        active: true,
        executionId: owner.id,
        activeRowCount: 2,
        invariantViolation: true,
      })
      expect(older.id).not.toBe(owner.id)
    } finally {
      await db.delete(executionAdmissionReservations).where(eq(executionAdmissionReservations.agentId, agent.id))
      await db.delete(executions).where(eq(executions.agentId, agent.id))
      await db.delete(agents).where(eq(agents.id, agent.id))
      await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
    }
  })
})

describe('GET /api/agents/:id/active sandbox recovery status', () => {
  it('returns only sanitized retry status for a waiting execution', async () => {
    const typeId = `active-recovery-${crypto.randomUUID()}`
    let agent: Agent | undefined
    let agentId: string | undefined
    try {
      await AgentType.create({
        id: typeId,
        name: 'Recovery',
        model: 'anthropic:claude-sonnet-4-5',
        systemPrompt: 'test',
      })
      agent = await Agent.create({ agentTypeId: typeId })
      agentId = agent.id
      const execution = await agent.queueExecution({ message: 'wait' })
      await execution.update({ status: 'waiting-sandbox' })
      const nextAttemptAt = new Date(Date.now() + 5_000)
      const deadlineAt = new Date(Date.now() + 60_000)
      await db.insert(sandboxProvisionRecoveries).values({
        executionId: execution.id,
        agentId: agent.id,
        scope: 'scope-secret',
        sandboxKey: 'box-secret',
        circuitVersion: 9,
        refusalId: crypto.randomUUID(),
        status: 'waiting',
        errorCode: 'SANDBOX_PROVISION_BUSY',
        reasonCode: 'unschedulable_capacity',
        attemptCount: 1,
        nextAttemptAt,
        deadlineAt,
      })

      const response = await app.request(`/api/agents/${agent.id}/active`, { headers: authHeaders(admin.token) })
      const body = await response.json()
      expect(response.status).toBe(200)
      expect(body).toMatchObject({
        active: true,
        executionId: execution.id,
        status: 'waiting-sandbox',
        sandboxRecovery: {
          reason: 'capacity',
          attemptCount: 1,
          maxAttempts: PROVISION_RECOVERY_MAX_ATTEMPTS,
          nextAttemptAt: nextAttemptAt.toISOString(),
          deadlineAt: deadlineAt.toISOString(),
        },
      })
      expect(JSON.stringify(body)).not.toMatch(/scope-secret|box-secret|circuitVersion|refusalId/)
    } finally {
      if (agent) {
        await db.delete(sandboxProvisionRecoveries).where(eq(sandboxProvisionRecoveries.agentId, agent.id))
        await db.delete(executions).where(eq(executions.agentId, agent.id))
        await db.delete(agents).where(eq(agents.id, agent.id))
      }
      await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
    }

    expect(agentId).toBeDefined()
    expect(await db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId!))).toEqual([])
    expect(await db.select({ id: agentTypes.id }).from(agentTypes).where(eq(agentTypes.id, typeId))).toEqual([])
  })
})
