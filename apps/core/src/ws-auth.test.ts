import { beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { authenticateWsRequest, authorizeSystemLogsRequest, authorizeTerminalRequest } from './index'
import { assignRole, cleanupTestRbac, createTestAdmin, createTestRole, createTestUser } from './test-utils/rbac'

import { agents, db, squads } from './db'
import { inArray } from 'drizzle-orm'
const prefix = `ws-auth-${crypto.randomUUID()}`
const squadId = crypto.randomUUID()
const otherSquadId = crypto.randomUUID()

beforeEach(async () => {
  await db
    .insert(squads)
    .values([squadId, otherSquadId].map((id) => ({ id, name: `${prefix}-${id}`, purpose: 'RBAC scope' })))
})

afterEach(async () => {
  await db.delete(agents).where(inArray(agents.squadId, [squadId, otherSquadId]))
  await cleanupTestRbac(prefix)
  await db.delete(squads).where(inArray(squads.id, [squadId, otherSquadId]))
})

describe('websocket handshake auth', () => {
  test('rejects missing and invalid tokens', async () => {
    expect(await authenticateWsRequest('http://localhost/ws')).toBeNull()
    expect(await authenticateWsRequest('http://localhost/ws?token=invalid')).toBeNull()
  })

  test('resolves valid identity token', async () => {
    const admin = await createTestAdmin({ canonicalAdmin: true, prefix })
    expect(await authenticateWsRequest(`http://localhost/ws?token=${admin.token}`)).toEqual({
      identity: { type: 'user', userId: admin.id },
      deviceTokenId: null,
    })
  })

  test('preserves device provenance for direct and ticket authentication', async () => {
    const { createDeviceToken } = await import('./services/auth/device-tokens')
    const { createWsTicket } = await import('./services/auth/ws-ticket')
    const user = await createTestUser({ prefix })
    const device = await createDeviceToken({ userId: user.id, name: 'CLI', platform: 'cli' })

    const expected = {
      identity: { type: 'user' as const, userId: user.id },
      deviceTokenId: device.id,
    }
    expect(await authenticateWsRequest(`http://localhost/ws?token=${device.token}`)).toEqual(expected)
    const ticket = await createWsTicket(user.id, device.id)
    expect(await authenticateWsRequest(`http://localhost/ws?ticket=${ticket}`)).toEqual(expected)
  })

  test('resolves a single-use ?ticket= to the minting user and rejects reuse', async () => {
    const { createWsTicket } = await import('./services/auth/ws-ticket')
    const user = await createTestUser({ prefix })
    const ticket = await createWsTicket(user.id)
    expect(await authenticateWsRequest(`http://localhost/ws?ticket=${ticket}`)).toEqual({
      identity: { type: 'user', userId: user.id },
      deviceTokenId: null,
    })
    // single-use: the same ticket cannot be replayed
    expect(await authenticateWsRequest(`http://localhost/ws?ticket=${ticket}`)).toBeNull()
  })
})

describe('system logs websocket auth', () => {
  test('rejects missing and invalid tokens', async () => {
    expect(await authorizeSystemLogsRequest('http://localhost/ws/system/logs')).toEqual({ ok: false, status: 401 })
    expect(await authorizeSystemLogsRequest('http://localhost/ws/system/logs?token=invalid')).toEqual({
      ok: false,
      status: 401,
    })
  })

  test('rejects identities without system logs permission', async () => {
    const user = await createTestUser({ prefix })

    expect(await authorizeSystemLogsRequest(`http://localhost/ws/system/logs?token=${user.token}`)).toEqual({
      ok: false,
      status: 403,
    })
  })

  test('rejects squad-scoped sandbox:logs for system logs', async () => {
    const user = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions: ['sandbox:logs'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId })

    expect(await authorizeSystemLogsRequest(`http://localhost/ws/system/logs?token=${user.token}`)).toEqual({
      ok: false,
      status: 403,
    })
  })

  test('allows admins and users with system logs permission at system scope', async () => {
    const admin = await createTestAdmin({ canonicalAdmin: true, prefix })
    const user = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions: ['system:logs'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })

    await expect(
      authorizeSystemLogsRequest(`http://localhost/ws/system/logs?token=${admin.token}`)
    ).resolves.toMatchObject({
      ok: true,
      identity: { type: 'user', userId: admin.id },
      authContext: { identity: { type: 'user', userId: admin.id }, deviceTokenId: null },
    })
    await expect(
      authorizeSystemLogsRequest(`http://localhost/ws/system/logs?token=${user.token}`)
    ).resolves.toMatchObject({
      ok: true,
      identity: { type: 'user', userId: user.id },
      authContext: { identity: { type: 'user', userId: user.id }, deviceTokenId: null },
    })
  })
})

describe('terminal websocket auth', () => {
  test('rejects missing and invalid tokens', async () => {
    expect(await authorizeTerminalRequest(`http://localhost/ws/terminal?sandboxId=squad_${squadId}`)).toEqual({
      ok: false,
      status: 401,
    })
    expect(
      await authorizeTerminalRequest(`http://localhost/ws/terminal?sandboxId=squad_${squadId}&token=invalid`)
    ).toEqual({
      ok: false,
      status: 401,
    })
  })

  test('rejects identities without terminal access for the target squad', async () => {
    const user = await createTestUser({ prefix })

    expect(
      await authorizeTerminalRequest(`http://localhost/ws/terminal?sandboxId=squad_${squadId}&token=${user.token}`)
    ).toEqual({ ok: false, status: 403 })
  })

  test('rejects identities with terminal access on another squad', async () => {
    const user = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions: ['terminal:access'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: otherSquadId })

    expect(
      await authorizeTerminalRequest(`http://localhost/ws/terminal?sandboxId=squad_${squadId}&token=${user.token}`)
    ).toEqual({ ok: false, status: 403 })
  })

  test('allows admins and users with terminal access on the target squad', async () => {
    const admin = await createTestAdmin({ canonicalAdmin: true, prefix })
    const user = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions: ['terminal:access'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId })

    await expect(
      authorizeTerminalRequest(`http://localhost/ws/terminal?sandboxId=squad_${squadId}&token=${admin.token}`)
    ).resolves.toMatchObject({ ok: true, params: { sandboxId: `squad_${squadId}`, sessionId: null } })
    await expect(
      authorizeTerminalRequest(`http://localhost/ws/terminal?sandboxId=squad_${squadId}&token=${user.token}`)
    ).resolves.toMatchObject({ ok: true, params: { sandboxId: `squad_${squadId}`, sessionId: null } })
  })

  test('requires system-scope terminal access when sandbox squad cannot be resolved', async () => {
    const admin = await createTestAdmin({ canonicalAdmin: true, prefix })
    const user = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions: ['terminal:access'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId })

    expect(
      await authorizeTerminalRequest(`http://localhost/ws/terminal?sandboxId=unknown-runtime&token=${user.token}`)
    ).toEqual({ ok: false, status: 403 })
    await expect(
      authorizeTerminalRequest(`http://localhost/ws/terminal?sandboxId=unknown-runtime&token=${admin.token}`)
    ).resolves.toMatchObject({ ok: true, params: { sandboxId: 'unknown-runtime', sessionId: null } })
  })
})

describe('terminal websocket auth for an agent’s own box', () => {
  test('resolves the agent from its row and applies the private-area rule', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId }).returning()
    const sandboxId = `agent_${agent!.id}`
    const admin = await createTestAdmin({ canonicalAdmin: true, prefix })
    const operator = await createTestUser({ prefix })
    const operatorRole = await createTestRole({ prefix, permissions: ['agents:private-access', 'terminal:access'] })
    await assignRole({ userId: operator.id, roleId: operatorRole.id, scope: 'squad', squadId })
    const terminalOnly = await createTestUser({ prefix })
    const terminalRole = await createTestRole({ prefix, permissions: ['terminal:access'] })
    await assignRole({ userId: terminalOnly.id, roleId: terminalRole.id, scope: 'system' })
    const elsewhere = await createTestUser({ prefix })
    await assignRole({ userId: elsewhere.id, roleId: operatorRole.id, scope: 'squad', squadId: otherSquadId })

    const url = (token: string, id = sandboxId) => `http://localhost/ws/terminal?sandboxId=${id}&token=${token}`
    await expect(authorizeTerminalRequest(url(admin.token))).resolves.toMatchObject({ ok: true, params: { sandboxId } })
    await expect(authorizeTerminalRequest(url(operator.token))).resolves.toMatchObject({ ok: true })
    // Instance-wide terminal access is not enough for an agent's private box.
    expect(await authorizeTerminalRequest(url(terminalOnly.token))).toEqual({ ok: false, status: 403 })
    expect(await authorizeTerminalRequest(url(elsewhere.token))).toEqual({ ok: false, status: 403 })
    expect(await authorizeTerminalRequest(url(admin.token, `agent_${crypto.randomUUID()}`))).toEqual({
      ok: false,
      status: 403,
    })
    expect(await authorizeTerminalRequest(url(admin.token, 'agent_whatever'))).toEqual({ ok: false, status: 403 })
  })
})
