import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, agents, inbox, systemInboxReads, squads } from '../db'
import { Agent } from '../entities/Agent'
import { identityMiddleware } from '../middleware/identity'
import { inboxRouter } from './inbox'
import { SYSTEM_RECIPIENT_ID, workspaceVoiceRecipientId } from '@ficus/shared'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestAgentToken,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/inbox', inboxRouter)

const rbacPrefix = `inbox-rbac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix: rbacPrefix, canonicalAdmin: true })
})

afterAll(async () => {
  await cleanupTestRbac(rbacPrefix)
})

describe('inbox routes', () => {
  let agent: Agent

  beforeEach(async () => {
    agent = await Agent.create({ agentTypeId: 'system-manager', context: {} })
  })

  afterEach(async () => {
    await db.delete(inbox).where(eq(inbox.recipientId, agent.id))
    await db.delete(inbox).where(eq(inbox.recipientId, SYSTEM_RECIPIENT_ID))
    await db.delete(agents).where(eq(agents.id, agent.id))
  })

  it('authors as the caller (user) and ignores any client-supplied sender', async () => {
    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType: 'agent',
        recipientId: agent.id,
        // Attempt to spoof another sender — must be ignored; sender is derived from the identity.
        senderType: 'agent',
        senderId: 'some-other-agent',
        content: 'hi',
      }),
    })
    expect(res.ok).toBe(true)
    const [msg] = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
    expect(msg.senderType).toBe('user')
    expect(msg.senderId).toBe(admin.id)
  })

  it("sends as the caller's voice assistant when asVoiceAssistant is set", async () => {
    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType: 'agent',
        recipientId: agent.id,
        asVoiceAssistant: true,
        content: 'hi from voice',
      }),
    })
    expect(res.ok).toBe(true)
    const [msg] = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
    expect(msg.senderType).toBe('voice_assistant')
    expect(msg.senderId).toBe(workspaceVoiceRecipientId(admin.id))
  })

  it('returns 401 without identity', async () => {
    const res = await app.request(`/api/inbox/agent/${agent.id}`)
    expect(res.status).toBe(401)
  })

  it('denies unresolved agent inboxes for authenticated callers', async () => {
    const missingAgentId = '11111111-1111-4111-8111-111111111111'
    const res = await app.request(`/api/inbox/agent/${missingAgentId}`, {
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(403)
  })

  it('denies unresolved messages for authenticated callers', async () => {
    const missingMessageId = '22222222-2222-4222-8222-222222222222'
    const res = await app.request(`/api/inbox/${missingMessageId}/read`, {
      method: 'POST',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(403)
  })

  it('denies users without inbox permission', async () => {
    const user = await createTestUser({ prefix: rbacPrefix })
    const res = await app.request(`/api/inbox/agent/${agent.id}`, {
      headers: authHeaders(user.token),
    })
    expect(res.status).toBe(403)
  })

  it('allows admins to list an agent inbox', async () => {
    const res = await app.request(`/api/inbox/agent/${agent.id}`, {
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('returns cursor-paginated system inbox pages when limit is provided', async () => {
    const rows = await db
      .insert(inbox)
      .values([
        {
          recipientType: 'system',
          recipientId: SYSTEM_RECIPIENT_ID,
          senderType: 'system',
          content: 'newest system',
          createdAt: new Date('2026-06-03T00:00:00Z'),
        },
        {
          recipientType: 'system',
          recipientId: SYSTEM_RECIPIENT_ID,
          senderType: 'system',
          content: 'middle system',
          createdAt: new Date('2026-06-02T00:00:00Z'),
        },
        {
          recipientType: 'system',
          recipientId: SYSTEM_RECIPIENT_ID,
          senderType: 'system',
          content: 'oldest system',
          createdAt: new Date('2026-06-01T00:00:00Z'),
        },
      ])
      .returning({ id: inbox.id })

    await db
      .insert(systemInboxReads)
      .values({ messageId: rows[1].id, userId: admin.id, readAt: new Date('2026-06-05T00:00:00Z') })

    const unreadRes = await app.request(`/api/inbox/system/system?limit=2&readState=unread`, {
      headers: authHeaders(admin.token),
    })
    expect(unreadRes.status).toBe(200)
    const unreadPage = await unreadRes.json()
    expect(unreadPage.items.map((m: { content: string }) => m.content)).toEqual(['newest system', 'oldest system'])
    expect(unreadPage.totalCount).toBe(2)

    const readRes = await app.request(`/api/inbox/system/system?limit=2&readState=read`, {
      headers: authHeaders(admin.token),
    })
    expect(readRes.status).toBe(200)
    const readPage = await readRes.json()
    expect(
      readPage.items.map((m: { content: string; readAt: string | null }) => [m.content, Boolean(m.readAt)])
    ).toEqual([['middle system', true]])
    expect(readPage.totalCount).toBe(1)
  })

  it('returns cursor-paginated inbox pages when limit is provided', async () => {
    await db.insert(inbox).values([
      {
        recipientType: 'agent',
        recipientId: agent.id,
        senderType: 'system',
        content: 'newest unread',
        createdAt: new Date('2026-06-03T00:00:00Z'),
      },
      {
        recipientType: 'agent',
        recipientId: agent.id,
        senderType: 'system',
        content: 'middle unread',
        createdAt: new Date('2026-06-02T00:00:00Z'),
      },
      {
        recipientType: 'agent',
        recipientId: agent.id,
        senderType: 'system',
        content: 'oldest unread',
        createdAt: new Date('2026-06-01T00:00:00Z'),
      },
      {
        recipientType: 'agent',
        recipientId: agent.id,
        senderType: 'system',
        content: 'read message',
        readAt: new Date('2026-06-04T00:00:00Z'),
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
    ])

    const firstRes = await app.request(`/api/inbox/agent/${agent.id}?limit=2&readState=unread`, {
      headers: authHeaders(admin.token),
    })
    expect(firstRes.status).toBe(200)
    const first = await firstRes.json()
    expect(first.items.map((m: { content: string }) => m.content)).toEqual(['newest unread', 'middle unread'])
    expect(first.hasMore).toBe(true)
    expect(first.totalCount).toBe(3)
    expect(first.nextCursor).toBe(first.items[1].id)

    const secondRes = await app.request(
      `/api/inbox/agent/${agent.id}?limit=2&readState=unread&cursor=${first.nextCursor}`,
      {
        headers: authHeaders(admin.token),
      }
    )
    const second = await secondRes.json()
    expect(second.items.map((m: { content: string }) => m.content)).toEqual(['oldest unread'])
    expect(second.hasMore).toBe(false)
  })
})

describe('inherited agent inbox permissions', () => {
  it('allows an agent identity with inherited user inbox:read-squad permission to list a teammate agent inbox in an allowed squad', async () => {
    const owner = await createTestUser({ prefix: rbacPrefix })
    const role = await createTestRole({ permissions: ['inbox:read-squad'], prefix: rbacPrefix })
    const [allowedSquad] = await db
      .insert(squads)
      .values({ name: `${rbacPrefix}-inherited-allowed`, purpose: 'test' })
      .returning()
    // Production shape (#1223): a system-manager is a squad-less agent ROW owned
    // by its user, with a squad-less token — permissions resolve through the
    // owner. A squad-bound token on a squad-less row fails closed.
    const systemManager = await Agent.create({ agentTypeId: 'system-manager', ownerUserId: owner.id, context: {} })
    const targetAgent = await Agent.create({ agentTypeId: 'engineer', squadId: allowedSquad.id, context: {} })
    const token = await createTestAgentToken({ agentId: systemManager.id, squadId: null, userId: owner.id })

    try {
      await assignRole({ userId: owner.id, roleId: role.id, scope: 'squad', squadId: allowedSquad.id })
      await db.insert(inbox).values({
        recipientType: 'agent',
        recipientId: targetAgent.id,
        senderType: 'system',
        content: 'visible through inherited squad inbox permission',
      })

      const res = await app.request(`/api/inbox/agent/${targetAgent.id}`, {
        headers: authHeaders(token.token),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.map((m: { content: string }) => m.content)).toEqual([
        'visible through inherited squad inbox permission',
      ])
    } finally {
      await db.delete(inbox).where(eq(inbox.recipientId, targetAgent.id))
      await db.delete(agents).where(eq(agents.id, targetAgent.id))
      await db.delete(agents).where(eq(agents.id, systemManager.id))
      await db.delete(squads).where(eq(squads.id, allowedSquad.id))
    }
  })

  it('denies inherited agent inbox reads outside the owning user squad scope', async () => {
    const owner = await createTestUser({ prefix: rbacPrefix })
    const role = await createTestRole({ permissions: ['inbox:read-squad'], prefix: rbacPrefix })
    const [allowedSquad, deniedSquad] = await db
      .insert(squads)
      .values([
        { name: `${rbacPrefix}-inherited-scope-allowed`, purpose: 'test' },
        { name: `${rbacPrefix}-inherited-scope-denied`, purpose: 'test' },
      ])
      .returning()
    const systemManager = await Agent.create({ agentTypeId: 'system-manager', context: {} })
    const targetAgent = await Agent.create({ agentTypeId: 'engineer', squadId: deniedSquad.id, context: {} })
    const token = await createTestAgentToken({ agentId: systemManager.id, squadId: allowedSquad.id, userId: owner.id })

    try {
      await assignRole({ userId: owner.id, roleId: role.id, scope: 'squad', squadId: allowedSquad.id })

      const res = await app.request(`/api/inbox/agent/${targetAgent.id}`, {
        headers: authHeaders(token.token),
      })

      expect(res.status).toBe(403)
    } finally {
      await db.delete(agents).where(eq(agents.id, targetAgent.id))
      await db.delete(agents).where(eq(agents.id, systemManager.id))
      await db.delete(squads).where(eq(squads.id, deniedSquad.id))
      await db.delete(squads).where(eq(squads.id, allowedSquad.id))
    }
  })

  it('keeps regular agent identities restricted to their own inbox', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `${rbacPrefix}-regular-agent-own-only`, purpose: 'test' })
      .returning()
    const callerAgent = await Agent.create({ agentTypeId: 'engineer', squadId: squad.id, context: {} })
    const targetAgent = await Agent.create({ agentTypeId: 'engineer', squadId: squad.id, context: {} })
    const token = await createTestAgentToken({ agentId: callerAgent.id, squadId: squad.id })

    try {
      const denied = await app.request(`/api/inbox/agent/${targetAgent.id}`, {
        headers: authHeaders(token.token),
      })
      expect(denied.status).toBe(403)

      const own = await app.request(`/api/inbox/agent/${callerAgent.id}`, {
        headers: authHeaders(token.token),
      })
      expect(own.status).toBe(200)
      expect(await own.json()).toEqual([])
    } finally {
      await db.delete(agents).where(eq(agents.id, targetAgent.id))
      await db.delete(agents).where(eq(agents.id, callerAgent.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })
})

describe('squad-scoped cross-agent inbox reads (inbox:read-squad)', () => {
  beforeAll(async () => {
    await createTestRole({
      slug: 'default-manager',
      name: 'Squad Manager',
      permissions: ['inbox:read', 'inbox:write', 'inbox:read-squad', 'agents:read'],
      isSystem: true,
    })
    await createTestRole({
      slug: 'default-worker',
      name: 'Squad Worker',
      permissions: ['inbox:read', 'inbox:write'],
      isSystem: true,
    })
  })

  it('allows a manager agent to read a teammate inbox in its own squad', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `${rbacPrefix}-manager-cross-agent`, purpose: 'test' })
      .returning()
    const managerAgent = await Agent.create({ agentTypeId: 'manager', squadId: squad.id, context: {} })
    const workerAgent = await Agent.create({ agentTypeId: 'engineer', squadId: squad.id, context: {} })
    const token = await createTestAgentToken({ agentId: managerAgent.id, squadId: squad.id })

    try {
      await db.insert(inbox).values({
        recipientType: 'agent',
        recipientId: workerAgent.id,
        senderType: 'system',
        content: 'manager can see this teammate inbox message',
      })

      const res = await app.request(`/api/inbox/agent/${workerAgent.id}`, {
        headers: authHeaders(token.token),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.map((m: { content: string }) => m.content)).toContain('manager can see this teammate inbox message')
    } finally {
      await db.delete(inbox).where(eq(inbox.recipientId, workerAgent.id))
      await db.delete(agents).where(eq(agents.id, workerAgent.id))
      await db.delete(agents).where(eq(agents.id, managerAgent.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })

  it('allows a consultant agent to read a teammate inbox through the default-manager role', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `${rbacPrefix}-consultant-cross-agent`, purpose: 'test' })
      .returning()
    const consultantAgent = await Agent.create({ agentTypeId: 'consultant', squadId: squad.id, context: {} })
    const workerAgent = await Agent.create({ agentTypeId: 'engineer', squadId: squad.id, context: {} })
    const token = await createTestAgentToken({ agentId: consultantAgent.id, squadId: squad.id })

    try {
      await db.insert(inbox).values({
        recipientType: 'agent',
        recipientId: workerAgent.id,
        senderType: 'system',
        content: 'consultant can see this teammate inbox message',
      })

      const res = await app.request(`/api/inbox/agent/${workerAgent.id}`, {
        headers: authHeaders(token.token),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.map((m: { content: string }) => m.content)).toContain(
        'consultant can see this teammate inbox message'
      )
    } finally {
      await db.delete(inbox).where(eq(inbox.recipientId, workerAgent.id))
      await db.delete(agents).where(eq(agents.id, workerAgent.id))
      await db.delete(agents).where(eq(agents.id, consultantAgent.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })

  it('allows a user-backed system-manager agent to read a teammate inbox with inbox:read-squad', async () => {
    const owner = await createTestUser({ prefix: rbacPrefix })
    const role = await createTestRole({ permissions: ['inbox:read-squad'], prefix: rbacPrefix })
    const [squad] = await db
      .insert(squads)
      .values({ name: `${rbacPrefix}-system-manager-cross-agent`, purpose: 'test' })
      .returning()
    // Production shape (#1223): squad-less owned row + squad-less token (see above).
    const systemManager = await Agent.create({ agentTypeId: 'system-manager', ownerUserId: owner.id, context: {} })
    const targetAgent = await Agent.create({ agentTypeId: 'engineer', squadId: squad.id, context: {} })
    const token = await createTestAgentToken({ agentId: systemManager.id, squadId: null, userId: owner.id })

    try {
      await assignRole({ userId: owner.id, roleId: role.id, scope: 'squad', squadId: squad.id })
      await db.insert(inbox).values({
        recipientType: 'agent',
        recipientId: targetAgent.id,
        senderType: 'system',
        content: 'system manager can see this teammate inbox message',
      })

      const res = await app.request(`/api/inbox/agent/${targetAgent.id}`, {
        headers: authHeaders(token.token),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.map((m: { content: string }) => m.content)).toContain(
        'system manager can see this teammate inbox message'
      )
    } finally {
      await db.delete(inbox).where(eq(inbox.recipientId, targetAgent.id))
      await db.delete(agents).where(eq(agents.id, targetAgent.id))
      await db.delete(agents).where(eq(agents.id, systemManager.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })

  it('denies a worker agent from reading a teammate inbox without inbox:read-squad', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `${rbacPrefix}-worker-cross-agent-denied`, purpose: 'test' })
      .returning()
    const workerA = await Agent.create({ agentTypeId: 'engineer', squadId: squad.id, context: {} })
    const workerB = await Agent.create({ agentTypeId: 'engineer', squadId: squad.id, context: {} })
    const token = await createTestAgentToken({ agentId: workerA.id, squadId: squad.id })

    try {
      const res = await app.request(`/api/inbox/agent/${workerB.id}`, {
        headers: authHeaders(token.token),
      })

      expect(res.status).toBe(403)
    } finally {
      await db.delete(agents).where(eq(agents.id, workerB.id))
      await db.delete(agents).where(eq(agents.id, workerA.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })

  it('denies a manager agent from marking a teammate inbox message read', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `${rbacPrefix}-manager-cross-agent-write-denied`, purpose: 'test' })
      .returning()
    const managerAgent = await Agent.create({ agentTypeId: 'manager', squadId: squad.id, context: {} })
    const workerAgent = await Agent.create({ agentTypeId: 'engineer', squadId: squad.id, context: {} })
    const token = await createTestAgentToken({ agentId: managerAgent.id, squadId: squad.id })

    try {
      const [message] = await db
        .insert(inbox)
        .values({
          recipientType: 'agent',
          recipientId: workerAgent.id,
          senderType: 'system',
          content: 'manager must not mark this read',
        })
        .returning()

      const res = await app.request(`/api/inbox/${message.id}/read`, {
        method: 'POST',
        headers: authHeaders(token.token),
      })

      expect(res.status).toBe(403)
    } finally {
      await db.delete(inbox).where(eq(inbox.recipientId, workerAgent.id))
      await db.delete(agents).where(eq(agents.id, workerAgent.id))
      await db.delete(agents).where(eq(agents.id, managerAgent.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })

  it('denies a manager from reading an agent inbox in an unrelated squad', async () => {
    const [squadA, squadB] = await db
      .insert(squads)
      .values([
        { name: `${rbacPrefix}-manager-cross-squad-a`, purpose: 'test' },
        { name: `${rbacPrefix}-manager-cross-squad-b`, purpose: 'test' },
      ])
      .returning()
    const managerAgent = await Agent.create({ agentTypeId: 'manager', squadId: squadA.id, context: {} })
    const targetAgent = await Agent.create({ agentTypeId: 'engineer', squadId: squadB.id, context: {} })
    const token = await createTestAgentToken({ agentId: managerAgent.id, squadId: squadA.id })

    try {
      const res = await app.request(`/api/inbox/agent/${targetAgent.id}`, {
        headers: authHeaders(token.token),
      })

      expect(res.status).toBe(403)
    } finally {
      await db.delete(agents).where(eq(agents.id, targetAgent.id))
      await db.delete(agents).where(eq(agents.id, managerAgent.id))
      await db.delete(squads).where(eq(squads.id, squadB.id))
      await db.delete(squads).where(eq(squads.id, squadA.id))
    }
  })
})

describe('recipient validation', () => {
  it.each(['user', 'me'])("rejects '%s' user self-shorthand from agent callers", async (recipientId) => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `${rbacPrefix}-recipient-validation`, purpose: 'test' })
      .returning()
    const agentWithToken = await Agent.create({ agentTypeId: 'system-manager', squadId: squad.id, context: {} })
    const token = await createTestAgentToken({ agentId: agentWithToken.id, squadId: squad.id })

    try {
      const res = await app.request('/api/inbox', {
        method: 'POST',
        headers: { ...authHeaders(token.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipientType: 'user',
          recipientId,
          content: 'test',
        }),
      })

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toContain('self-reference shorthand')
    } finally {
      await db.delete(inbox).where(eq(inbox.senderId, agentWithToken.id))
      await db.delete(agents).where(eq(agents.id, agentWithToken.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })

  it('rejects nonexistent user recipient IDs', async () => {
    const nonexistentId = '33333333-3333-4333-8333-333333333333'

    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType: 'user',
        recipientId: nonexistentId,
        content: 'test',
      }),
    })

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('not found')
  })

  it('accepts a valid user recipient ID', async () => {
    const user = await createTestUser({ prefix: rbacPrefix })

    try {
      const res = await app.request('/api/inbox', {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipientType: 'user',
          recipientId: user.id,
          content: 'test message',
        }),
      })

      expect(res.status).toBe(201)
    } finally {
      await db.delete(inbox).where(eq(inbox.recipientId, user.id))
    }
  })

  it('accepts system recipient shorthand and normalizes the ID', async () => {
    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType: 'system',
        recipientId: 'system',
        content: 'system test',
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.recipientId).toBe(SYSTEM_RECIPIENT_ID)
    await db.delete(inbox).where(eq(inbox.recipientId, SYSTEM_RECIPIENT_ID))
  })
})
