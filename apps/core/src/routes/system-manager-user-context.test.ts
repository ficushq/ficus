import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, agents, inbox, squads, users, systemInboxReads, roleAssignments } from '../db'
import { Agent } from '../entities/Agent'
import { User } from '../entities/User'
import { identityMiddleware } from '../middleware/identity'
import { inboxRouter } from './inbox'
import { notificationConfigRouter } from './notification-config'
import { resolveActingUser } from '../services/rbac'
import { SYSTEM_RECIPIENT_ID, workspaceVoiceRecipientId } from '@ficus/shared'
import {
  assignRole,
  createTestRole,
  authHeaders,
  cleanupTestRbac,
  createTestAgentToken,
  createTestUser,
} from '../test-utils'

const prefix = `acting-user-${randomUUID()}`
const agentIds: string[] = []
const recipientIds: string[] = []
const squadIds: string[] = []
const messageIds: string[] = []
const app = new Hono().use('*', identityMiddleware)
app.route('/api/inbox', inboxRouter)
app.route('/api/notification-config', notificationConfigRouter)
afterEach(async () => {
  if (messageIds.length) await db.delete(inbox).where(inArray(inbox.id, messageIds.splice(0)))
  if (recipientIds.length) await db.delete(inbox).where(inArray(inbox.recipientId, recipientIds.splice(0)))
  if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds.splice(0)))
  if (squadIds.length) await db.delete(squads).where(inArray(squads.id, squadIds.splice(0)))
  await cleanupTestRbac(prefix)
})
async function fixture() {
  const owner = await createTestUser({ prefix })
  const other = await createTestUser({ prefix })
  const manager = await Agent.create({ agentTypeId: 'system-manager', ownerUserId: owner.id, context: {} })
  agentIds.push(manager.id)
  recipientIds.push(owner.id, other.id, workspaceVoiceRecipientId(owner.id), workspaceVoiceRecipientId(other.id))
  // An old token need not contain the owner: the live agent row is authoritative.
  const token = await createTestAgentToken({ agentId: manager.id, squadId: null })
  const identity = { type: 'agent' as const, agentId: manager.id, squadId: null }
  return { owner, other, manager, token: token.token, identity }
}
test('system manager lists its owner inbox with me and limit; other personal inboxes stay private', async () => {
  const { owner, other, token } = await fixture()
  await db.insert(inbox).values({
    recipientType: 'user',
    recipientId: owner.id,
    senderType: 'system',
    senderId: 'system',
    content: 'Owner message',
  })
  const res = await app.request('/api/inbox/user/me?limit=50', { headers: authHeaders(token) })
  expect(res.status).toBe(200)
  expect((await res.json()).items.map((m: { content: string }) => m.content)).toEqual(['Owner message'])
  expect((await app.request(`/api/inbox/user/${other.id}`, { headers: authHeaders(token) })).status).toBe(403)
  expect(
    (
      await app.request(`/api/inbox/voice_assistant/${workspaceVoiceRecipientId(other.id)}`, {
        headers: authHeaders(token),
      })
    ).status
  ).toBe(403)
  expect((await app.request('/api/inbox/voice_assistant/workspace', { headers: authHeaders(token) })).status).toBe(200)
})
test('personal preferences read and update the owner without granting global settings access', async () => {
  const { owner, token } = await fixture()
  const res = await app.request('/api/notification-config/me', {
    method: 'PUT',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ pushEnabled: false }),
  })
  expect(res.status).toBe(200)
  const personal = await app.request('/api/notification-config/me', { headers: authHeaders(owner.token) })
  expect((await personal.json()).pushEnabled).toBe(false)
  expect((await app.request('/api/notification-config', { headers: authHeaders(token) })).status).toBe(403)
})
test('ownership mismatch, disabled owners, and terminated managers fail closed', async () => {
  const { owner, other, manager, identity } = await fixture()
  expect(await resolveActingUser(identity)).toEqual({ type: 'user', userId: owner.id })
  expect(await resolveActingUser({ ...identity, userId: other.id })).toBeNull()
  await (await User.findById(owner.id))!.disable()
  expect(await resolveActingUser(identity)).toBeNull()
  await db.update(users).set({ disabledAt: null }).where(eq(users.id, owner.id))
  expect(await resolveActingUser(identity)).toEqual({ type: 'user', userId: owner.id })
  await db.update(agents).set({ status: 'terminated' }).where(eq(agents.id, manager.id))
  expect(await resolveActingUser(identity)).toBeNull()
})
test('ordinary squad agents cannot become users through token owner hints', async () => {
  const { owner } = await fixture()
  const [squad] = await db
    .insert(squads)
    .values({ name: `${prefix}-squad`, purpose: 'test' })
    .returning()
  squadIds.push(squad.id)
  const agent = await Agent.create({ agentTypeId: 'manager', squadId: squad.id, context: {} })
  agentIds.push(agent.id)
  const token = await createTestAgentToken({ agentId: agent.id, squadId: squad.id, userId: owner.id })
  expect((await app.request('/api/inbox/user/me', { headers: authHeaders(token.token) })).status).toBe(403)
})

test('system inbox read state belongs to the owner and access follows current roles', async () => {
  const { owner, other, token } = await fixture()
  const role = await createTestRole({ prefix, permissions: ['inbox:system'] })
  await assignRole({ userId: owner.id, roleId: role.id, scope: 'system' })
  const [message] = await db
    .insert(inbox)
    .values({ recipientType: 'system', recipientId: SYSTEM_RECIPIENT_ID, senderType: 'system', content: prefix })
    .returning()
  messageIds.push(message.id)
  expect(
    (await app.request(`/api/inbox/${message.id}/read`, { method: 'POST', headers: authHeaders(token) })).status
  ).toBe(200)
  const reads = await db.select().from(systemInboxReads).where(eq(systemInboxReads.messageId, message.id))
  expect(reads.map((read) => read.userId)).toEqual([owner.id])
  expect(reads.some((read) => read.userId === other.id)).toBe(false)
  await db.delete(roleAssignments).where(eq(roleAssignments.roleId, role.id))
  expect((await app.request('/api/inbox/system/system', { headers: authHeaders(token) })).status).toBe(403)
})

test('delegated system-manager children resolve the same owner', async () => {
  const { owner, manager } = await fixture()
  const child = await Agent.create({ agentTypeId: 'subagent', parentAgentId: manager.id, context: {} })
  agentIds.push(child.id)
  expect(await resolveActingUser({ type: 'agent', agentId: child.id, squadId: null })).toEqual({
    type: 'user',
    userId: owner.id,
  })
})
